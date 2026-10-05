/*
 * Exports:
 * - GitArcClaimViewInput: owner, hold-own choice and optional mirror directory/paths.
 * - default GitArcClaimViewController: write the worktree as one owner builds it (every other live owner's dirty claims at
 *   their arc baselines) and mirror selected paths into an ignored directory, rewriting only files whose content differs.
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import type { GitArcClaimView } from "workbench-shared/workbench/git/checkpoint-contracts";
import { type GitArcHarness, normalizeThreadId } from "workbench-shared/workbench/git/git-arc-storage";
import GitArcProposalController from "./GitArcProposalController";
import GitArcRegistry, { getGitArcLiveClaimPaths } from "./GitArcRegistry";
import GitCheckpointStore from "./GitCheckpointStore";
import GitObjectReadSession from "./GitObjectReadSession";
import WorkbenchGitRepository from "./WorkbenchGitRepository";
import { passthroughGitArcThreadIdentityResolver, type GitArcThreadIdentityResolver } from "./git-arc-thread-identity";

export interface GitArcClaimViewInput {
  cwd: string;
  harness: GitArcHarness;
  holdOwn: boolean;
  /** Absolute gitignored directory inside the repository; omitted views only report their tree. */
  into?: string;
  paths: string[];
  threadId: string;
}

interface MirroredFile {
  blob: string;
  mode: string;
}

/** One mirror at a time per directory; parallel builds of one owner must not interleave writes. */
const mirrorTails = new Map<string, Promise<void>>();

async function exclusive<T>(key: string, work: () => Promise<T>) {
  const prior = mirrorTails.get(key) ?? Promise.resolve();
  let release = () => {};
  const tail = prior.then(() => new Promise<void>(resolve => { release = resolve; }));
  mirrorTails.set(key, tail);
  await prior;
  try {
    return await work();
  } finally {
    release();
    if (mirrorTails.get(key) === tail) mirrorTails.delete(key);
  }
}

function isInside(parent: string, child: string) {
  const relative = path.relative(parent, child);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/** The deepest existing ancestor's real path, so symlinked segments cannot escape the repository. */
async function realAncestor(target: string): Promise<string> {
  try {
    return await fs.realpath(target);
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
    const parent = path.dirname(target);
    if (parent === target) throw error;
    return path.join(await realAncestor(parent), path.basename(target));
  }
}

function blobId(contents: Buffer, algorithm: "sha1" | "sha256") {
  return createHash(algorithm).update(`blob ${contents.length}\0`).update(contents).digest("hex");
}

export default class GitArcClaimViewController {
  constructor(
    private readonly proposals: GitArcProposalController,
    private readonly resolveThreadIdentity: GitArcThreadIdentityResolver = passthroughGitArcThreadIdentityResolver,
  ) {}

  async readClaimView(input: GitArcClaimViewInput): Promise<GitArcClaimView> {
    return await GitObjectReadSession.run(async () => {
      const repository = await WorkbenchGitRepository.open(input.cwd);
      const mirror = input.into ? await this.resolveMirror(repository, input.into) : null;
      const store = new GitCheckpointStore(repository, this.resolveThreadIdentity);
      const caller = normalizeThreadId(input.threadId);
      const [snapshot, entries] = await Promise.all([
        repository.writeWorktreeSnapshot(),
        new GitArcRegistry(repository, this.resolveThreadIdentity).list(),
      ]);
      let tree = snapshot.tree;
      const held: GitArcClaimView["held"] = [];
      for (const entry of entries) {
        if (!input.holdOwn && entry.harness === input.harness && entry.threadId === caller) continue;
        const claimed = getGitArcLiveClaimPaths(entry);
        const arc = entry.phase === "plan" ? entry.retainedArc : entry;
        if (!claimed.length || !arc) continue;
        const checkpoint = await store.readCheckpoint(entry.harness as GitArcHarness, entry.threadId, arc.checkpointCommit);
        // The same stack-aware baseline `arc diff` measures this owner's work from.
        const baseline = await this.proposals.logicalBaseline({
          checkpointCommit: checkpoint.checkpointCommit, checkpointParent: checkpoint.parent,
          cwd: repository.root, harness: entry.harness, repository, threadId: entry.threadId,
        });
        const paths = await repository.listChangedPaths(baseline, snapshot.tree, claimed);
        if (!paths.length) continue;
        tree = await repository.writeTreeWithPathsFromSource(tree, baseline, paths);
        held.push({ paths, threadId: entry.threadId });
      }
      const view = { head: snapshot.head, held, repoRoot: repository.root, tree };
      if (!mirror) return view;
      const scopes = input.paths.length ? repository.normalizePaths(input.paths) : [];
      const key = process.platform === "win32" ? mirror.toLowerCase() : mirror;
      return { ...view, ...await exclusive(key, async () => await this.mirror(repository, tree, mirror, scopes)) };
    });
  }

  /** Mirrors may only live in ignored, untracked directories inside the repository. */
  private async resolveMirror(repository: WorkbenchGitRepository, into: string) {
    const target = path.resolve(repository.root, into);
    const [realRoot, realTarget] = await Promise.all([fs.realpath(repository.root), realAncestor(target)]);
    if (!isInside(realRoot, realTarget) || !isInside(repository.root, target)) {
      throw new Error("The mirror directory must be inside the repository, below its root.");
    }
    const relative = path.relative(repository.root, target).replace(/\\/g, "/");
    // Probing a child makes Git treat a not-yet-created mirror as a folder, so folder-only patterns match it.
    const probe = `${relative}/wb-arc-tree-probe`;
    if (!(await repository.listIgnoredPaths([probe])).includes(probe)) {
      throw new Error(`The mirror directory ${relative} must be gitignored so mirroring never touches tracked or claimed work.`);
    }
    if ((await repository.run(["ls-files", "-z", "--", repository.literalPathspec(relative)])).length) {
      throw new Error(`The mirror directory ${relative} contains tracked files.`);
    }
    return target;
  }

  /**
   * Make `directory` hold exactly the tree's files under `scopes`, leaving matching files (and their mtimes) alone.
   * Files outside the scopes belong to other mirror calls and stay untouched.
   */
  private async mirror(repository: WorkbenchGitRepository, tree: string, directory: string, scopes: string[]) {
    const wanted = new Map<string, MirroredFile>();
    const listing = await repository.run([
      "ls-tree", "-r", "-z", "--full-tree", tree, "--", ...scopes.map(scope => repository.literalPathspec(scope)),
    ]);
    for (const record of listing.split("\0")) {
      const tab = record.indexOf("\t");
      if (tab < 0) continue;
      const [mode, type, blob] = record.slice(0, tab).split(" ");
      // Submodule commits have no file content to mirror.
      if (type === "blob" && mode && blob) wanted.set(record.slice(tab + 1), { blob, mode });
    }
    const algorithm = tree.length === 64 ? "sha256" : "sha1";
    await fs.mkdir(directory, { recursive: true });
    const present = (await fs.readdir(directory, { recursive: true, withFileTypes: true }))
      .filter(entry => !entry.isDirectory())
      .map(entry => path.relative(directory, path.join(entry.parentPath, entry.name)).replace(/\\/g, "/"))
      .filter(relative => !scopes.length || scopes.some(scope => relative === scope || relative.startsWith(`${scope}/`)));
    // Removals first, so a stale file never blocks a folder the view needs at its path.
    let deleted = 0;
    for (const relative of present) {
      const want = wanted.get(relative);
      const file = path.join(directory, relative);
      if (!want) {
        await fs.rm(file, { force: true });
        deleted += 1;
      } else if ((await fs.lstat(file)).isFile() && blobId(await fs.readFile(file), algorithm) === want.blob) {
        wanted.delete(relative);
      }
    }
    const contents = await GitObjectReadSession.read(repository.root, [...new Set([...wanted.values()].map(({ blob }) => blob))]);
    const byBlob = new Map(contents.flatMap(object => object?.contents ? [[object.objectId, object.contents] as const] : []));
    for (const [relative, { blob, mode }] of wanted) {
      const data = byBlob.get(blob);
      if (!data) throw new Error(`Git object ${blob} for ${relative} is missing.`);
      const file = path.join(directory, relative);
      // A symlink or folder in the file's place is replaced, never written through.
      const existing = await fs.lstat(file).catch((error: unknown) => {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
        throw error;
      });
      if (existing && !existing.isFile()) await fs.rm(file, { force: true, recursive: true });
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, data);
      if (mode === "100755" && process.platform !== "win32") await fs.chmod(file, 0o755);
    }
    await this.pruneEmptyFolders(directory, directory);
    return { deleted, written: wanted.size };
  }

  private async pruneEmptyFolders(directory: string, root: string): Promise<boolean> {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    let empty = true;
    for (const entry of entries) {
      if (entry.isDirectory() && await this.pruneEmptyFolders(path.join(directory, entry.name), root)) continue;
      empty = false;
    }
    if (empty && directory !== root) await fs.rmdir(directory);
    return empty;
  }
}
