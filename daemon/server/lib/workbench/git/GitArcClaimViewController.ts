/*
 * Exports:
 * - GitArcClaimViewInput: owner and hold-own choice for a build view.
 * - default GitArcClaimViewController: write the worktree as one owner builds it (every other live owner's dirty claims at
 *   their arc baselines, swapped through one index) and mirror selected paths of a view into an ignored directory,
 *   rewriting only files whose content differs (stat-cached per directory).
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
  threadId: string;
}

interface MirroredFile {
  blob: string;
  mode: string;
}

interface MirroredStat {
  blob: string;
  mtimeMs: number;
  size: number;
}

/** One mirror at a time per directory; parallel builds of one owner must not interleave writes. */
const mirrorTails = new Map<string, Promise<void>>();
/**
 * Blob ids of files this daemon generation wrote or hashed, per mirror directory. A file whose size and mtime still
 * match skips re-hashing; mirrors belong to Workbench, so an outside edit keeping both is not worth a full re-hash.
 */
const mirrorStats = new Map<string, Map<string, MirroredStat>>();

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

  /** Build the view from the live worktree and registry; callers hold the repository's read gate around this only. */
  async readClaimView(input: GitArcClaimViewInput): Promise<GitArcClaimView> {
    return await GitObjectReadSession.run(async () => {
      const repository = await WorkbenchGitRepository.open(input.cwd);
      const store = new GitCheckpointStore(repository, this.resolveThreadIdentity);
      const caller = normalizeThreadId(input.threadId);
      const [snapshot, entries] = await Promise.all([
        repository.writeWorktreeSnapshot(),
        new GitArcRegistry(repository, this.resolveThreadIdentity).list(),
      ]);
      const owners = (await Promise.all(entries.map(async (entry) => {
        if (!input.holdOwn && entry.harness === input.harness && entry.threadId === caller) return null;
        const claimed = getGitArcLiveClaimPaths(entry);
        const arc = entry.phase === "plan" ? entry.retainedArc : entry;
        if (!claimed.length || !arc) return null;
        const checkpoint = await store.readCheckpoint(entry.harness as GitArcHarness, entry.threadId, arc.checkpointCommit);
        // The same stack-aware baseline `arc diff` measures this owner's work from.
        const baseline = await this.proposals.logicalBaseline({
          checkpointCommit: checkpoint.checkpointCommit, checkpointParent: checkpoint.parent,
          cwd: repository.root, entry, harness: entry.harness, repository, threadId: entry.threadId,
        });
        return { baseline, claimed, threadId: entry.threadId };
      }))).filter(owner => owner !== null);
      // Swapped paths are exactly the claimed paths that differ from each owner's baseline.
      const { changedPaths, tree } = await repository.writeTreeWithPathSources(
        snapshot.tree, owners.map(({ baseline, claimed }) => ({ paths: claimed, source: baseline })),
      );
      const held = owners.flatMap(({ threadId }, index) => changedPaths[index]!.length ? [{ paths: changedPaths[index]!, threadId }] : []);
      return { head: snapshot.head, held, repoRoot: repository.root, tree };
    });
  }

  /**
   * Mirror a view tree's `paths` into an ignored directory. Trees are immutable and the directory is outside Git's
   * reach, so this runs after the read gate is released; mirrors into one directory still run one at a time.
   */
  async mirrorClaimView(input: { into: string; paths: string[]; repoRoot: string; tree: string }) {
    return await GitObjectReadSession.run(async () => {
      const repository = await WorkbenchGitRepository.open(input.repoRoot);
      const mirror = await this.resolveMirror(repository, input.into);
      const scopes = input.paths.length ? repository.normalizePaths(input.paths) : [];
      const key = process.platform === "win32" ? mirror.toLowerCase() : mirror;
      return await exclusive(key, async () => await this.mirror(repository, input.tree, mirror, key, scopes));
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
  private async mirror(repository: WorkbenchGitRepository, tree: string, directory: string, key: string, scopes: string[]) {
    const stats = mirrorStats.get(key) ?? new Map<string, MirroredStat>();
    mirrorStats.set(key, stats);
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
    const currentBlob = async (relative: string) => {
      const file = path.join(directory, relative);
      const stat = await fs.lstat(file);
      if (!stat.isFile()) return null;
      const cached = stats.get(relative);
      if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.blob;
      const blob = blobId(await fs.readFile(file), algorithm);
      stats.set(relative, { blob, mtimeMs: stat.mtimeMs, size: stat.size });
      return blob;
    };
    for (let offset = 0; offset < present.length; offset += 64) {
      await Promise.all(present.slice(offset, offset + 64).map(async (relative) => {
        const want = wanted.get(relative);
        if (!want) {
          await fs.rm(path.join(directory, relative), { force: true });
          stats.delete(relative);
          deleted += 1;
        } else if (await currentBlob(relative) === want.blob) {
          wanted.delete(relative);
        }
      }));
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
      const written = await fs.lstat(file);
      stats.set(relative, { blob, mtimeMs: written.mtimeMs, size: written.size });
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
