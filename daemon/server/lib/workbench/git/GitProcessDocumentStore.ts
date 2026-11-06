/*
 * Exports:
 * - default GitProcessDocumentStore: keep one thread's process documents out of commits through its own `info/exclude` block,
 *   back them up as a parentless ref chain outside branch history, and restore them from it.
 */
import fs from "node:fs/promises";
import path from "node:path";

import GitArcPathSet from "workbench-shared/workbench/git/GitArcPathSet";
import { processDocumentsRef, type GitArcHarness } from "workbench-shared/workbench/git/git-arc-storage";
import { syncGitInfoExclude } from "../../git";
import GitArcRegistry, { getGitArcLiveClaimPaths } from "./GitArcRegistry";
import { passthroughGitArcThreadIdentityResolver, type GitArcThreadIdentityResolver } from "./git-arc-thread-identity";
import type WorkbenchGitRepository from "./WorkbenchGitRepository";
import type { GitTreeFile } from "./WorkbenchGitRepository";

const BACKUP_MESSAGE = "workbench process documents backup";
const FILE_MODE = "100644";

interface Identity { harness: GitArcHarness; threadId: string }

export default class GitProcessDocumentStore {
  constructor(
    private readonly repository: WorkbenchGitRepository,
    private readonly resolveThreadIdentity: GitArcThreadIdentityResolver = passthroughGitArcThreadIdentityResolver,
  ) {}

  private async canonicalThreadId(identity: Identity) {
    const resolved = await this.resolveThreadIdentity({ ...identity, repositoryRoot: this.repository.root });
    if (!resolved) throw new Error("The process document owner identity is unavailable.");
    return resolved.threadId;
  }

  private relative(paths: readonly string[]) {
    return paths.length ? this.repository.normalizePaths([...paths]) : [];
  }

  /** Each thread owns one block, so a document two threads list stays hidden until both drop it. Machine repositories have nothing to hide from. */
  private async hide(threadId: string, relativePaths: readonly string[]) {
    if (!this.repository.machine) await syncGitInfoExclude(this.repository.root, `process documents ${threadId}`, relativePaths);
  }

  /** `info/exclude` cannot hide tracked files and a claim is a route into a commit, so both refuse rather than quietly stay committable. */
  private async assertListable(relativePaths: readonly string[]) {
    if (this.repository.machine || !relativePaths.length) return;
    const tracked = (await this.repository.run([
      "ls-files", "-z", "--cached", "--", ...relativePaths.map(candidate => this.repository.literalPathspec(candidate)),
    ])).split("\0").filter(Boolean);
    if (tracked.length) throw new Error(`Tracked files cannot be process documents, since Git cannot ignore them: ${tracked.join(", ")}.`);
    const claims = new GitArcPathSet((await new GitArcRegistry(this.repository, this.resolveThreadIdentity).list()).flatMap(getGitArcLiveClaimPaths));
    const claimed = relativePaths.filter(candidate => claims.covers(candidate));
    if (claimed.length) throw new Error(`Claimed files cannot be process documents until released: ${claimed.join(", ")}.`);
  }

  /** The thread's complete list in this repository: replaces its block, so anything left out becomes committable again. */
  async admit(identity: Identity, paths: readonly string[]) {
    const relativePaths = this.relative(paths);
    await this.assertListable(relativePaths);
    await this.hide(await this.canonicalThreadId(identity), relativePaths);
  }

  /** Commits the documents on the previous backup when their contents changed; returns the new commit, or null when nothing changed. */
  async backup(identity: Identity, paths: readonly string[]) {
    const threadId = await this.canonicalThreadId(identity);
    const relativePaths = this.relative(paths);
    await this.hide(threadId, relativePaths);
    const files = new Map<string, GitTreeFile>();
    for (const relativePath of relativePaths) {
      const bytes = await fs.readFile(this.repository.resolvePath(relativePath)).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (bytes) files.set(relativePath, { bytes, mode: FILE_MODE });
    }
    const ref = processDocumentsRef(identity.harness, threadId);
    const tip = await this.repository.readRef(ref);
    const tree = await this.repository.writeTreeWithFiles(null, files);
    if (tip ? (await this.repository.readCommit(tip)).tree === tree : !files.size) return null;
    const commit = await this.repository.createCommitFromTree(tree, tip, BACKUP_MESSAGE);
    await this.repository.updateRef(ref, commit, tip);
    return commit;
  }

  /** Writes the selected documents back from a backup. Paths no longer ignored were unlisted and may hold committed work, so they refuse. */
  async restore(identity: Identity, revision: number, paths: readonly string[]) {
    const threadId = await this.canonicalThreadId(identity);
    const relativePaths = this.relative(paths);
    const ref = processDocumentsRef(identity.harness, threadId);
    if (!await this.repository.readRef(ref)) throw new Error("This thread has no process document backups here.");
    const commit = await this.repository.run(["rev-parse", "-q", "--verify", `${ref}~${revision}^{commit}`]).then(output => output.trim())
      .catch(() => { throw new Error(`This thread has no process document backup ${revision} before its latest.`); });
    if (!this.repository.machine) {
      const ignored = new Set(await this.repository.listIgnoredPaths(relativePaths));
      const unlisted = relativePaths.filter(candidate => !ignored.has(candidate));
      if (unlisted.length) throw new Error(`Not listed as process documents: ${unlisted.join(", ")}.`);
    }
    const files = await this.repository.readTreeFiles(commit, relativePaths);
    const absent = relativePaths.filter(candidate => !files.get(candidate));
    if (absent.length) throw new Error(`Not in that process document backup: ${absent.join(", ")}.`);
    for (const relativePath of relativePaths) {
      const absolute = this.repository.resolvePath(relativePath);
      await fs.mkdir(path.dirname(absolute), { recursive: true });
      await fs.writeFile(absolute, files.get(relativePath)!.bytes);
    }
    return {
      checkpointCommit: commit, checkpointRef: ref, intentName: null, repoRoot: this.repository.root,
      restored: true as const, restoredPaths: relativePaths, scopePaths: relativePaths,
    };
  }
}
