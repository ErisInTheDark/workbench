/*
 * Exports:
 * - GitArcClaimViewInput: owner and hold-own choice for a build view.
 * - default GitArcClaimViewController: write the worktree as one owner builds it (every other live owner's dirty claims at
 *   their arc baselines, swapped through one index) and mirror selected paths of a view into an ignored directory,
 *   rewriting only files whose content differs and removing only files its own record says it wrote.
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import type { GitArcClaimView } from "workbench-shared/workbench/git/checkpoint-contracts";
import { type GitArcHarness, normalizeThreadId } from "workbench-shared/workbench/git/git-arc-storage";
import GitArcPathSet from "workbench-shared/workbench/git/GitArcPathSet";
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

interface WantedFile {
  blob: string;
  mode: string;
}

/**
 * The mirror's record of files it wrote (or adopted as identical), so it never lists the directory: builds run inside
 * mirrors and can leave millions of files there. A file whose size and mtime still match skips re-hashing.
 */
const MANIFEST_NAME = ".wb-arc-tree.json";
const ManifestSchema = z.object({
  version: z.literal(1),
  files: z.record(z.string(), z.object({ blob: z.string(), mtimeMs: z.number(), size: z.number() })),
});
type MirroredStat = z.infer<typeof ManifestSchema>["files"][string];

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

function errorCode(error: unknown) {
  return error && typeof error === "object" && "code" in error ? String(error.code) : null;
}

async function lstatOrNull(file: string) {
  try {
    return await fs.lstat(file);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}

async function readManifest(file: string) {
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return new Map<string, MirroredStat>();
    throw error;
  }
  let parsed: z.infer<typeof ManifestSchema>;
  try {
    parsed = ManifestSchema.parse(JSON.parse(text));
  } catch {
    throw new Error(`The mirror record ${file} is unreadable. Delete it and mirror again; identical files are re-adopted.`);
  }
  return new Map(Object.entries(parsed.files));
}

async function writeManifest(file: string, files: ReadonlyMap<string, MirroredStat>) {
  if (!files.size) {
    await fs.rm(file, { force: true });
    return;
  }
  const temporary = `${file}.tmp`;
  await fs.writeFile(temporary, JSON.stringify({ version: 1, files: Object.fromEntries(files) }));
  await fs.rename(temporary, file);
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
      return await exclusive(key, async () => await this.mirror(repository, input.tree, mirror, scopes));
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
   * Make `directory` hold the tree's files under `scopes`, leaving matching files (and their mtimes) alone. Only files
   * the mirror recorded writing are ever removed; anything else there (build output, other scopes' files) stays.
   */
  private async mirror(repository: WorkbenchGitRepository, tree: string, directory: string, scopes: string[]) {
    const wanted = new Map<string, WantedFile>();
    const scope = new GitArcPathSet(scopes);
    const inScope = (relative: string) => !scopes.length || scope.covers(relative);
    // Scope sets past the command-line budget list the whole tree and filter here instead.
    const listing = await repository.run(["ls-tree", "-r", "-z", "--full-tree", tree, ...repository.scopePathspecs(scopes)]);
    for (const record of listing.split("\0")) {
      const tab = record.indexOf("\t");
      if (tab < 0) continue;
      const [mode, type, blob] = record.slice(0, tab).split(" ");
      const relative = record.slice(tab + 1);
      // Submodule commits have no file content to mirror.
      if (type === "blob" && mode && blob && inScope(relative)) wanted.set(relative, { blob, mode });
    }
    if (wanted.has(MANIFEST_NAME)) throw new Error(`The view contains ${MANIFEST_NAME}, which mirrors reserve for their own record.`);
    const algorithm = tree.length === 64 ? "sha256" : "sha1";
    await fs.mkdir(directory, { recursive: true });
    const manifestPath = path.join(directory, MANIFEST_NAME);
    const recorded = await readManifest(manifestPath);
    const inBatches = async <T>(items: readonly T[], work: (item: T) => Promise<void>) => {
      for (let offset = 0; offset < items.length; offset += 64) await Promise.all(items.slice(offset, offset + 64).map(work));
    };

    // Removals first, so a stale file never blocks a folder the view needs at its path.
    const stale = [...recorded.keys()].filter(relative => inScope(relative) && !wanted.has(relative));
    await inBatches(stale, async (relative) => {
      const file = path.join(directory, relative);
      // Something else replaced the recorded file with a folder; that folder isn't the mirror's to delete.
      if ((await lstatOrNull(file))?.isDirectory() === false) await fs.rm(file, { force: true });
      recorded.delete(relative);
    });
    await this.pruneEmptyParents(directory, stale);

    const outdated: string[] = [];
    await inBatches([...wanted.keys()], async (relative) => {
      const want = wanted.get(relative)!;
      const stat = await lstatOrNull(path.join(directory, relative));
      if (stat?.isFile()) {
        const record = recorded.get(relative);
        if (record && record.size === stat.size && record.mtimeMs === stat.mtimeMs && record.blob === want.blob) return;
        // Unrecorded or edited since: an identical file is adopted as is, so builds keep its mtime.
        if (!record || record.size !== stat.size || record.mtimeMs !== stat.mtimeMs) {
          const blob = blobId(await fs.readFile(path.join(directory, relative)), algorithm);
          if (blob === want.blob) {
            recorded.set(relative, { blob, mtimeMs: stat.mtimeMs, size: stat.size });
            return;
          }
        }
      }
      outdated.push(relative);
    });

    const byPath = await repository.readCheckoutBytes(tree, outdated);
    try {
      for (const relative of outdated) {
        const { blob, mode } = wanted.get(relative)!;
        const data = byPath.get(relative);
        if (!data) throw new Error(`Git object ${blob} for ${relative} is missing.`);
        const file = path.join(directory, relative);
        // A symlink or folder in the file's place is replaced, never written through.
        const existing = await lstatOrNull(file);
        if (existing && !existing.isFile()) await fs.rm(file, { force: true, recursive: true });
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, data);
        if (mode === "100755" && process.platform !== "win32") await fs.chmod(file, 0o755);
        const written = await fs.lstat(file);
        recorded.set(relative, { blob, mtimeMs: written.mtimeMs, size: written.size });
      }
    } finally {
      // A failed pass still records what it changed; unrecorded leftovers are re-adopted by content next time.
      await writeManifest(manifestPath, recorded);
    }
    return { deleted: stale.length, written: outdated.length };
  }

  /** Remove folders left empty by `removed` files, walking up only from those files, never listing the mirror. */
  private async pruneEmptyParents(directory: string, removed: readonly string[]) {
    const folders = new Set<string>();
    for (const relative of removed) {
      for (let folder = path.posix.dirname(relative); folder !== "."; folder = path.posix.dirname(folder)) folders.add(folder);
    }
    const deepestFirst = [...folders].sort((left, right) => right.split("/").length - left.split("/").length);
    for (const folder of deepestFirst) {
      try {
        await fs.rmdir(path.join(directory, folder));
      } catch (error) {
        // Still holding other files (the mirror's or anyone else's), already gone, or not a folder: leave it.
        if (!["ENOTEMPTY", "EEXIST", "ENOENT", "ENOTDIR"].includes(errorCode(error) ?? "")) throw error;
      }
    }
  }
}
