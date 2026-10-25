/*
 * Exports:
 * - default WorkbenchGitRepository: own Git processes, object decoding, paths, snapshots and atomic publication for one repository.
 * - GitCommitPathChange/GitHeadMovement/GitRefUpdate/GitResolvedBlob/GitResolvedCommit/GitResolvedCommitRef/GitTreeFile/GitWorktreeMergeResult/GitWorktreeSnapshot: typed history, object, file, merge, snapshot and publication facts.
 * - GitCommitIdentity/GitCommitBatch/GitBlobBatch: parsed metadata and per-object batch results.
 * - GIT_STATE_GENERATION_REF: per-worktree mutation generation ref.
 * Notable members: normalizeCommitActor lets Git canonicalise actor dates; listFirstParentRange expands `base..tip`;
 * firstParentRange walks only from HEAD back to the amend target; currentHead and readCommitMessage read through the operation's object stream;
 * object writes, tree-to-tree path changes and writeTreeWithPathSources run in-process (GitObjectWriter/GitTreeObjects);
 * readCheckoutBytes materialises selected tree entries through Git's checkout filters in one disposable temporary index,
 * and checkoutInto writes them straight into a directory the same way;
 * readCommitRef finds a commit's ref through GitCommitRefLocator, which every ref writer here keeps current;
 * allAncestors checks containment in one walk; worktree snapshots seed temporary indexes from the real index so only
 * changed files are re-hashed, and scoped worktree reads pass literal pathspecs; listRefsContaining finds refs holding a commit in one walk;
 * buildFileChanges/buildChangeTotals/buildFileChangeSummaries list changed files in-process, then diff them in pathspec batches
 * that fit the command line, with at most four Git processes in flight. listIgnoredWorktreePaths walks wholly-ignored
 * folders itself so oversized ignored scopes fail fast. Git children never take optional index locks;
 * real-index writers (resetMixedPaths, writeIndexTree, restorePaths, restoreWorktree, checkoutTreeTransition) first clear
 * provably orphaned locks; checkoutTreeTransition moves index and worktree between two commits' trees like a checkout.
 * Machine worktrees run Git against their internal Git dir; their whole-worktree reads cover tracked files only,
 * oversized scope sets batch pathspecs instead of walking the machine, and scopes inside nested repositories are walked
 * and staged by Workbench (machine-git-boundaries) because Git stops at their `.git`.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import GitArcPathSet from "workbench-shared/workbench/git/GitArcPathSet";
import WorkbenchTemporaryDirectory from "../WorkbenchTemporaryDirectory";
import GitCommitRefLocator from "./GitCommitRefLocator";
import GitIndexLock from "./GitIndexLock";
import GitObjectReadSession from "./GitObjectReadSession";
import GitObjectWriter from "./GitObjectWriter";
import { gitProcesses, GitProcessError } from "./GitProcessHost";
import GitTreeObjects, { type GitTreeEdit } from "./GitTreeObjects";
import parseGitFileChangeOutput, { parseGitChangeTotalsOutput } from "./git-file-change-output";
import { BoundaryWalkLimitError, listBoundaryFiles, nestedRepositoryScopes } from "./machine-git-boundaries";
import { isMachineGitWorktree, machineGitEnvironment, readMachineKnownPaths } from "./machine-git-worktrees";
import { comparablePath, isPathInside as isWithinRoot } from "../../comparable-path";
import type { GitCheckpointFileChange } from "workbench-shared/workbench/git/checkpoint-contracts";

const GIT_MAX_BUFFER = 32 * 1024 * 1024;
const COMMIT_PATTERN = /^[a-f0-9]{7,64}$/iu;
export const GIT_STATE_GENERATION_REF = "refs/worktree/workbench/state-generation";

/** Each worktree's real index path never moves, so resolve it once per root. */
const realIndexPaths = new Map<string, Promise<string>>();
/** A directory's repository root only changes if the repository is removed, which `open` re-checks on every hit. */
const repositoryRoots = new Map<string, string>();
// Windows command lines cap near 32k characters; larger pathspec sets are batched or listed unscoped and filtered.
const PATHSPEC_ARGUMENT_BUDGET = 16_000;
/** Git processes one diff read keeps in flight; each spawn blocks the event loop briefly, so fan-out stays small. */
const GIT_DIFF_CONCURRENCY = 4;
/** More ignored files than this under edit scopes means dependency or build trees, which no edit means to rewrite. */
const IGNORED_FILE_LIMIT = 50_000;

type GitProcessLimit = <T>(work: () => Promise<T>) => Promise<T>;

/** Admits at most GIT_DIFF_CONCURRENCY Git processes from one read at a time, in request order. */
function gitProcessLimit(): GitProcessLimit {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async (work) => {
    if (active >= GIT_DIFF_CONCURRENCY) await new Promise<void>(resolve => waiting.push(resolve));
    else active += 1;
    try {
      return await work();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active -= 1;
    }
  };
}

/**
 * Reads never opportunistically lock the real index; explicit index writers are unaffected by this setting.
 * Machine worktrees also point Git at their internal Git dir.
 */
function processEnvironment(root: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...env, GIT_OPTIONAL_LOCKS: "0", ...machineGitEnvironment(root) };
}

function isStdoutCapacityError(error: unknown) {
  return error instanceof Error && "code" in error
    && error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" && error.message.startsWith("stdout ");
}

function halves<T>(values: readonly T[]) {
  const middle = Math.ceil(values.length / 2);
  return [values.slice(0, middle), values.slice(middle)] as const;
}

function realIndexPath(repository: WorkbenchGitRepository) {
  let resolved = realIndexPaths.get(repository.root);
  if (!resolved) {
    resolved = repository.run(["rev-parse", "--path-format=absolute", "--git-path", "index"]).then(output => output.trim());
    // Callers still receive the rejection; a failed lookup is just never cached.
    resolved.catch(() => realIndexPaths.delete(repository.root));
    realIndexPaths.set(repository.root, resolved);
  }
  return resolved;
}

export interface GitHeadMovement {
  changedPaths: string[];
  currentHead: string | null;
  kind: "fast-forward" | "incompatible" | "same";
}

export interface GitWorktreeMergeResult {
  conflictedPaths: string[];
  tree: string;
  unsupportedConflictTypes: string[];
}

export interface GitCommitPathChange {
  changedPaths: string[];
  commit: string;
  subject: string;
}

export interface GitRefUpdate {
  newValue: string;
  oldValue?: string | null;
  ref: string;
}

export interface GitCommitIdentity {
  authorDate: string;
  authorEmail: string;
  authorName: string;
  committerDate: string;
  committerEmail: string;
  committerName: string;
  message: string;
  parents: string[];
  signed: boolean;
  tree: string;
}

export interface GitCommitBatch {
  commits: Map<string, GitCommitIdentity>;
  errors: Map<string, string>;
}

export interface GitBlobBatch {
  blobs: Map<string, GitResolvedBlob | null>;
  errors: Map<string, string>;
}

interface GitObject {
  contents: Buffer;
  objectId: string;
  type: string;
}

export interface GitResolvedBlob {
  blob: string;
  contents: string;
}

export interface GitResolvedCommit {
  commit: string;
  identity: GitCommitIdentity;
}

export type GitResolvedCommitRef = GitResolvedCommit & { ref: string };

/** One file's exact blob bytes and Git mode. */
export interface GitTreeFile {
  bytes: Buffer;
  mode: string;
}

export interface GitWorktreeSnapshot {
  head: string | null;
  tree: string;
}

async function gitDirectoryExists(root: string) {
  if (isMachineGitWorktree(root)) return true;
  try {
    await fs.stat(path.join(root, ".git"));
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

function parseNullPaths(output: string) {
  return output.split("\0").filter(Boolean);
}

function filterPathsByScopes(candidates: string[], scopes: readonly string[]) {
  if (!scopes.length || scopes.includes(".")) return candidates;
  const selection = new GitArcPathSet(scopes);
  return candidates.filter((candidate) => selection.covers(candidate));
}

function pathspecInput(paths: readonly string[]) {
  return `${paths.map((candidate) => `:(top,literal)${candidate}`).join("\0")}\0`;
}

function parseCommitActor(line: string, label: string) {
  const match = /^(.*) <([^<>]*)> (\d+) ([+-]\d{4})$/u.exec(line);
  if (!match) throw new Error(`Git commit ${label} metadata is invalid.`);
  return { date: `${match[3]} ${match[4]}`, email: match[2]!, name: match[1]! };
}

function parseRawCommit(contents: Buffer): GitCommitIdentity {
  const separator = contents.indexOf("\n\n");
  if (separator < 0) throw new Error("Git commit headers are invalid.");
  const headers = contents.subarray(0, separator).toString("utf8").split("\n");
  const value = (name: string) => headers.find((line) => line.startsWith(`${name} `))?.slice(name.length + 1) ?? "";
  const tree = value("tree");
  const parents = headers.filter((line) => line.startsWith("parent ")).map((line) => line.slice(7));
  const author = parseCommitActor(value("author"), "author");
  const committer = parseCommitActor(value("committer"), "committer");
  if (!tree) throw new Error("Git commit tree metadata is invalid.");
  return {
    authorDate: author.date,
    authorEmail: author.email,
    authorName: author.name,
    committerDate: committer.date,
    committerEmail: committer.email,
    committerName: committer.name,
    message: contents.subarray(separator + 2).toString("utf8"),
    parents,
    signed: headers.some((line) => line.startsWith("gpgsig ") || line.startsWith("gpgsig-sha256 ")),
    tree,
  };
}

export default class WorkbenchGitRepository {
  static async tryOpen(cwd: string) {
    try {
      return await WorkbenchGitRepository.open(cwd);
    } catch (error) {
      const stderr = error instanceof Error && "stderr" in error && typeof error.stderr === "string" ? error.stderr : "";
      if (/not a git repository/u.test(stderr)) return null;
      throw error;
    }
  }

  static async open(cwd: string) {
    const key = path.resolve(cwd);
    const cached = repositoryRoots.get(key);
    if (cached && await gitDirectoryExists(cached)) return new WorkbenchGitRepository(cached);
    const repoRoot = (await WorkbenchGitRepository.runAt(cwd, ["rev-parse", "--show-toplevel"])).trim();
    if (!repoRoot) throw new Error("Unable to find Git repository root.");
    const root = path.resolve(repoRoot);
    // Only roots themselves are cached: a subdirectory could later become a nested repository of its own.
    if (comparablePath(root) === comparablePath(key)) repositoryRoots.set(key, root);
    return new WorkbenchGitRepository(root);
  }

  private static async runAt(
    cwd: string,
    args: string[],
    env: NodeJS.ProcessEnv = process.env,
    signal?: AbortSignal,
  ) {
    return await gitProcesses.runText({
      args, cwd, env: processEnvironment(cwd, env), maxBuffer: GIT_MAX_BUFFER, ...(signal ? { signal } : {}),
    });
  }

  readonly root: string;
  /** Machine worktrees track only arc-scoped paths, so whole-worktree reads never walk untracked files. */
  readonly machine: boolean;
  private readonly objects: GitObjectWriter;
  private readonly trees: GitTreeObjects;

  constructor(repoRoot: string, private readonly platform: NodeJS.Platform = process.platform) {
    this.root = path.resolve(repoRoot);
    this.machine = isMachineGitWorktree(this.root);
    this.objects = new GitObjectWriter(this.root);
    this.trees = new GitTreeObjects(this.root, this.objects);
  }

  async run(args: string[], env: NodeJS.ProcessEnv = process.env, signal?: AbortSignal) {
    return await WorkbenchGitRepository.runAt(this.root, args, env, signal);
  }

  private async runWithInputResult(
    args: string[],
    input: string,
    env: NodeJS.ProcessEnv,
    acceptedExitCodes: readonly number[],
    signal?: AbortSignal,
  ) {
    try {
      const { stdout } = await gitProcesses.run({
        args, cwd: this.root, env: processEnvironment(this.root, env), input, ...(signal ? { signal } : {}),
      });
      return { exitCode: 0, stdout: stdout.toString("utf8") };
    } catch (error) {
      if (!(error instanceof GitProcessError) || typeof error.code !== "number") throw error;
      if (acceptedExitCodes.includes(error.code)) return { exitCode: error.code, stdout: error.stdout };
      throw new Error(error.stderr.trim() || `git ${args[0] ?? "command"} failed with exit code ${error.code}.`);
    }
  }

  async runWithInput(args: string[], input: string, env: NodeJS.ProcessEnv = process.env, signal?: AbortSignal) {
    return (await this.runWithInputResult(args, input, env, [0], signal)).stdout;
  }

  async runBufferWithInput(args: string[], input: string, env: NodeJS.ProcessEnv = process.env) {
    try {
      return (await gitProcesses.run({ args, cwd: this.root, env: processEnvironment(this.root, env), input })).stdout;
    } catch (error) {
      if (!(error instanceof GitProcessError) || typeof error.code !== "number") throw error;
      throw new Error(error.stderr.trim() || `git ${args[0] ?? "command"} failed with exit code ${error.code}.`);
    }
  }

  async succeeds(args: string[]) {
    try {
      await this.run(args);
      return true;
    } catch {
      return false;
    }
  }

  normalizeCommit(commit: string) {
    const normalized = String(commit ?? "").trim();
    if (!COMMIT_PATTERN.test(normalized)) throw new Error("Invalid checkpoint commit.");
    return normalized;
  }

  normalizePaths(paths: string[]) {
    if (!Array.isArray(paths) || !paths.length) throw new Error("At least one checkpoint path is required.");
    const normalized = paths.map((candidate) => {
      const value = String(candidate ?? "").trim();
      if (!value) throw new Error("Checkpoint paths must not be empty.");
      const absolute = path.isAbsolute(value) ? path.resolve(value) : path.resolve(this.root, value);
      if (!isWithinRoot(absolute, this.root, this.platform)) throw new Error("Checkpoint paths must stay inside the Git repository.");
      const relative = path.relative(this.root, absolute).replace(/\\/g, "/");
      if (!relative || relative.startsWith("../")) {
        throw new Error("Checkpoint paths must identify content inside the Git repository.");
      }
      return relative;
    });
    return [...new Set(normalized)].sort((left, right) => left.localeCompare(right));
  }

  async listIgnoredPaths(paths: string[]) {
    if (!paths.length) return [];
    const normalized = this.normalizePaths(paths);
    const result = await this.runWithInputResult(
      ["check-ignore", "-z", "--stdin"],
      `${normalized.join("\0")}\0`,
      process.env,
      [0, 1],
    );
    if (result.exitCode === 1) return [];
    const ignoredPaths = parseNullPaths(result.stdout);
    const stagedDeletedPaths = new GitArcPathSet(parseNullPaths(await this.run([
      "diff", "--cached", "--name-only", "-z", "--diff-filter=D", "--no-renames", "--",
    ])));
    return ignoredPaths.filter((ignoredPath) => !stagedDeletedPaths.has(ignoredPath) && !stagedDeletedPaths.contains(ignoredPath));
  }

  literalPathspec(relativePath: string) {
    return `:(top,literal)${relativePath}`;
  }

  resolvePath(relativePath: string) {
    const absolute = path.resolve(this.root, relativePath);
    if (!isWithinRoot(absolute, this.root, this.platform)) throw new Error("Git path must stay inside the repository.");
    return absolute;
  }

  async currentHead() {
    const [object] = await GitObjectReadSession.read(this.root, ["HEAD^{commit}"], "info");
    if (!object || object.type !== "commit") throw new Error("Git HEAD does not resolve to a commit.");
    return object.objectId;
  }

  async headOrNull(): Promise<string | null> {
    return (await this.readHead())?.commit ?? null;
  }

  async readHead(): Promise<GitResolvedCommit | null> {
    const head = await this.readCommitAt("HEAD");
    if (head) return head;
    const branch = (await this.run(["symbolic-ref", "-q", "HEAD"])).trim();
    const refs = (await this.run(["for-each-ref", "--format=%(refname)", branch])).trim().split(/\r?\n/u);
    if (!branch.startsWith("refs/heads/") || refs.includes(branch)) {
      throw new Error("Git HEAD is missing but the repository is not on an unborn branch.");
    }
    return null;
  }

  private async contentBase(treeish: string | null): Promise<string> {
    if (treeish === "HEAD") return await this.contentBase(await this.headOrNull());
    return treeish ?? await this.trees.emptyTree();
  }

  async symbolicHead() {
    // Arc operations move HEAD along its branch but never switch branches, so one read serves until refs are republished.
    return await GitObjectReadSession.memo(`${this.refMemoPrefix()}head-name`, async () => {
      try {
        return (await this.run(["symbolic-ref", "-q", "HEAD"])).trim() || null;
      } catch {
        return null;
      }
    });
  }

  async resolveCommit(commit: string) {
    const [object] = await GitObjectReadSession.read(this.root, [`${this.normalizeCommit(commit)}^{commit}`], "info");
    if (!object || object.type !== "commit") throw new Error("Git object does not resolve to a commit.");
    return object.objectId;
  }

  async resolveTree(treeish: string | null) {
    const [object] = await GitObjectReadSession.read(this.root, [`${await this.contentBase(treeish)}^{tree}`], "info");
    if (!object || object.type !== "tree") throw new Error("Git object does not resolve to a tree.");
    return object.objectId;
  }

  async resolveParent(commit: string) {
    return (await this.readCommit(commit)).parents[0] ?? null;
  }

  async isAncestor(ancestor: string, descendant: string) {
    return await this.succeeds(["merge-base", "--is-ancestor", ancestor, descendant]);
  }

  async readCommit(commit: string): Promise<GitCommitIdentity> {
    const batch = await this.readCommits([commit]);
    const metadata = batch.commits.get(commit);
    if (metadata) return metadata;
    throw new Error(batch.errors.get(commit) ?? `Unable to read commit metadata for ${commit}.`);
  }

  async readBlobAtRef(ref: string): Promise<GitResolvedBlob | null> {
    const object = await this.readObject(ref);
    if (!object) return null;
    if (object.type !== "blob") throw new Error(`Git ref ${ref} does not resolve to a blob.`);
    return { blob: object.objectId, contents: object.contents.toString("utf8") };
  }

  async readCommitAt(commitish: string): Promise<GitResolvedCommit | null> {
    const object = await this.readObject(commitish);
    if (!object) return null;
    if (object.type !== "commit") throw new Error(`Git object ${commitish} is not a commit.`);
    return { commit: object.objectId, identity: parseRawCommit(object.contents) };
  }

  async readCommits(commits: string[]): Promise<GitCommitBatch> {
    const batch = await this.readObjects(commits);
    const result: GitCommitBatch = { commits: new Map(), errors: batch.errors };
    for (const [requestedCommit, object] of batch.objects) {
      if (!object || object.type !== "commit") {
        result.errors.set(requestedCommit, object
          ? `Git object ${object.objectId} is not a commit.`
          : `Git object ${requestedCommit} is missing.`);
        continue;
      }
      try {
        result.commits.set(requestedCommit, parseRawCommit(object.contents));
      } catch (error) {
        result.errors.set(requestedCommit, error instanceof Error ? error.message : String(error));
      }
    }
    return result;
  }

  /** The smallest-named ref in `namespaces` naming a full commit id, with its commit; null when none does or the object is missing. */
  async readCommitRef(commit: string, ...namespaces: string[]): Promise<GitResolvedCommitRef | null> {
    const normalized = this.normalizeCommit(commit);
    const ref = await GitCommitRefLocator.for(this.root, namespaces).locate(normalized, {
      scan: async () => await this.listRefsWithValues(...namespaces),
      verify: async candidate => await this.readRef(candidate),
    });
    if (!ref) return null;
    const resolved = await this.readCommitAt(normalized);
    return resolved ? { commit: resolved.commit, identity: resolved.identity, ref } : null;
  }

  async readBlobs(refs: string[]): Promise<GitBlobBatch> {
    const batch = await this.readObjects(refs);
    const result: GitBlobBatch = { blobs: new Map(), errors: batch.errors };
    for (const [ref, object] of batch.objects) {
      if (object && object.type !== "blob") {
        result.errors.set(ref, `Git ref ${ref} does not resolve to a blob.`);
      } else {
        result.blobs.set(ref, object ? { blob: object.objectId, contents: object.contents.toString("utf8") } : null);
      }
    }
    return result;
  }

  /** The message exactly as `git show -s --format=%B` prints it: raw message plus the format terminator. */
  async readCommitMessage(commit: string) {
    const resolved = await this.readCommitAt(commit);
    if (!resolved) throw new Error(`Git object ${commit} is missing.`);
    return `${resolved.identity.message}\n`;
  }

  async refsPointingAt(commit: string, ...namespaces: string[]) {
    const output = await this.run([
      "for-each-ref", "--format=%(refname)", "--points-at", commit, ...namespaces,
    ]);
    return output.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean);
  }

  async listRefsContaining(commit: string, namespace: string) {
    const output = await this.run(["for-each-ref", "--contains", commit, "--format=%(refname)", namespace]);
    return output.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean);
  }

  async listRefs(namespace: string) {
    const output = await this.run(["for-each-ref", "--format=%(refname)", namespace]);
    return output.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean);
  }

  /** The object a ref names, or null when it is absent (a ref naming a missing object reads as absent too). */
  async readRef(ref: string) {
    const [object] = await GitObjectReadSession.read(this.root, [ref], "info");
    return object?.objectId ?? null;
  }

  async writeBlob(contents: string) {
    return await this.objects.writeObject("blob", Buffer.from(contents, "utf8"));
  }

  async readBlob(blob: string) {
    const object = await this.readBlobAtRef(blob);
    if (!object) throw new Error(`Git object ${blob} is missing.`);
    return object.contents;
  }

  private async zeroObjectId() {
    return "0".repeat(await this.objects.objectIdLength());
  }

  async updateRef(ref: string, newValue: string, oldValue?: string | null) {
    const expected = oldValue === null ? await this.zeroObjectId() : oldValue;
    try {
      await this.run(["update-ref", ref, newValue, ...(expected !== undefined ? [expected] : [])]);
      GitCommitRefLocator.observe(this.root, [{ newValue, ref }], []);
    } finally {
      GitObjectReadSession.forget(this.refMemoPrefix());
    }
  }

  async deleteRef(ref: string, oldValue?: string) {
    try {
      await this.run(["update-ref", "-d", ref, ...(oldValue !== undefined ? [oldValue] : [])]);
      GitCommitRefLocator.observe(this.root, [], [{ ref }]);
    } finally {
      GitObjectReadSession.forget(this.refMemoPrefix());
    }
  }

  async updateRefs(
    updates: GitRefUpdate[],
    deletes: Array<{ oldValue?: string; ref: string }> = [],
    options: { expectedStateGeneration?: string | null } = {},
  ) {
    const updatesGeneration = updates.some(({ ref }) => ref === GIT_STATE_GENERATION_REF);
    const deletesGeneration = deletes.some(({ ref }) => ref === GIT_STATE_GENERATION_REF);
    const advancesGeneration = !updatesGeneration && !deletesGeneration && (updates.length > 0 || deletes.length > 0);
    const generationValue = advancesGeneration
      ? await this.writeBlob(`workbench-git-state-generation-v1 ${randomUUID()}\n`)
      : null;
    const expectsMissing = updates.some(({ oldValue }) => oldValue === null)
      || options.expectedStateGeneration === null;
    const missingObjectId = expectsMissing ? await this.zeroObjectId() : undefined;
    const encodeExpected = (value: string | null | undefined) => value === null ? missingObjectId! : value;
    const lines = ["start"];
    for (const update of updates) {
      const oldValue = encodeExpected(update.oldValue);
      lines.push(`update ${update.ref} ${update.newValue}${oldValue !== undefined ? ` ${oldValue}` : ""}`);
    }
    for (const deletion of deletes) {
      lines.push(`delete ${deletion.ref}${deletion.oldValue !== undefined ? ` ${deletion.oldValue}` : ""}`);
    }
    if (generationValue) {
      const expected = options.expectedStateGeneration === undefined
        ? ""
        : ` ${encodeExpected(options.expectedStateGeneration)}`;
      lines.push(`update ${GIT_STATE_GENERATION_REF} ${generationValue}${expected}`);
    }
    lines.push("prepare", "commit", "");
    try {
      await this.runWithInput(["update-ref", "--stdin"], lines.join("\n"));
      GitCommitRefLocator.observe(this.root, updates, deletes);
    } finally {
      // Even a rejected transaction may race other writers, so ref-derived memos never outlive a publication attempt.
      GitObjectReadSession.forget(this.refMemoPrefix());
    }
  }

  /** Memo keys for facts derived from this repository's refs; ref publication invalidates them. */
  refMemoPrefix() {
    return WorkbenchGitRepository.refMemoPrefix(this.root);
  }

  static refMemoPrefix(root: string) {
    return `refs:${path.resolve(root)}:`;
  }

  /** Drops the operation's ref-derived facts, e.g. after other writers may have run while a long operation yielded its gate. */
  static forgetRefFacts(root: string) {
    GitObjectReadSession.forget(WorkbenchGitRepository.refMemoPrefix(root));
  }

  async withTemporaryIndex<T>(callback: (indexPath: string, directory: string) => Promise<T>) {
    const temporaryDirectory = await WorkbenchTemporaryDirectory.create("workbench-git-index-");
    try {
      return await callback(path.join(temporaryDirectory.path, "index"), temporaryDirectory.path);
    } finally {
      await temporaryDirectory.dispose();
    }
  }

  /**
   * Write selected tree files under `directory` exactly as Git would check them out, without touching the real index or
   * worktree. Git replaces whatever stands in a file's place, including non-directory leading components, never writing through them.
   */
  async checkoutInto(treeish: string, directory: string, paths: readonly string[], signal?: AbortSignal) {
    if (!paths.length) return;
    const selected = this.normalizePaths([...paths]);
    await this.withTemporaryIndex(async (indexPath) => await this.checkoutWithIndex(indexPath, treeish, directory, selected, signal));
  }

  private async checkoutWithIndex(indexPath: string, treeish: string, directory: string, selected: readonly string[], signal?: AbortSignal) {
    const env = { ...process.env, GIT_INDEX_FILE: indexPath };
    await fs.mkdir(directory, { recursive: true });
    await this.run(["read-tree", await this.contentBase(treeish)], env, signal);
    await this.runWithInput([
      "checkout-index",
      "--force",
      `--prefix=${directory.replace(/\\/gu, "/")}/`,
      "-z",
      "--stdin",
    ], `${selected.join("\0")}\0`, env, signal);
  }

  /** Materialise selected tree files exactly as Git would check them out, without touching the real index or worktree. */
  async readCheckoutBytes(treeish: string, paths: readonly string[]) {
    if (!paths.length) return new Map<string, Buffer>();
    const selected = this.normalizePaths([...paths]);
    return await this.withTemporaryIndex(async (indexPath, directory) => {
      const checkoutDirectory = path.join(directory, "checkout");
      await this.checkoutWithIndex(indexPath, treeish, checkoutDirectory, selected);
      return new Map(await Promise.all(selected.map(async (relative) => {
        const file = path.join(checkoutDirectory, relative);
        const stat = await fs.lstat(file);
        const contents = stat.isSymbolicLink()
          ? Buffer.from(await fs.readlink(file, { encoding: "buffer" }))
          : await fs.readFile(file);
        return [relative, contents] as const;
      })));
    });
  }

  /**
   * Load `base` into a temporary index that starts as a copy of the repository's real index. `read-tree --reset` keeps
   * stat info only for entries whose blob matches `base`, so a following `add` re-hashes just the changed files instead
   * of the whole worktree. The real index is only ever read.
   */
  private async seedTemporaryIndex(indexPath: string, baseTreeish: string | null, env: NodeJS.ProcessEnv, signal?: AbortSignal) {
    const base = await this.contentBase(baseTreeish);
    const realIndex = await realIndexPath(this);
    try {
      await fs.copyFile(realIndex, indexPath);
    } catch (error) {
      // Repositories without a real index yet (fresh or unborn) simply have no stat cache to reuse.
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
      await this.run(["read-tree", base], env, signal);
      return;
    }
    try {
      await this.run(["read-tree", "--reset", base], env, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      console.warn(`[git] stat-seeded snapshot unavailable for ${path.basename(this.root)}; hashing the full worktree: ${
        (error instanceof Error ? error.message : String(error)).slice(0, 200)}`);
      await fs.rm(indexPath, { force: true });
      await this.run(["read-tree", base], env, signal);
    }
  }

  async writeWorktreeTree(baseTreeish: string | null = "HEAD", signal?: AbortSignal) {
    return await this.withTemporaryIndex(async (indexPath) => {
      const env = { ...process.env, GIT_INDEX_FILE: indexPath };
      await this.seedTemporaryIndex(indexPath, baseTreeish, env, signal);
      if (this.machine) {
        // Tracked files plus paths arcs requested, which may be new and untracked; an empty index rejects a `.` pathspec.
        await this.run(["add", "-u"], env, signal);
        const known = await readMachineKnownPaths(this.root);
        if (known.length) await this.stageScopedPaths(known, env, signal);
      } else {
        await this.run(["add", "-A", "--", "."], env, signal);
      }
      return (await this.run(["write-tree"], env, signal)).trim();
    });
  }

  async writeWorktreeSnapshot(signal?: AbortSignal): Promise<GitWorktreeSnapshot> {
    const head = await this.headOrNull();
    return {
      head,
      tree: await this.writeWorktreeTree(head, signal),
    };
  }

  async listWorktreePaths(
    scopes: readonly string[] = [],
    env: NodeJS.ProcessEnv = process.env,
    signal?: AbortSignal,
  ) {
    const [outputs, boundary] = await Promise.all([
      Promise.all(this.scopeBatches(scopes).map(async (pathspecs) => await this.run([
        "ls-files", "-z", "--cached", ...this.walksUntracked(pathspecs) ? ["--others", "--exclude-standard"] : [], ...pathspecs,
      ], env, signal))),
      this.listBoundaryPaths(scopes),
    ]);
    const candidates = [...new Set([...outputs.flatMap(parseNullPaths), ...boundary])].sort((left, right) => left.localeCompare(right));
    return filterPathsByScopes(candidates, scopes);
  }

  /** Machine worktrees: files under scopes inside nested repositories, which Git cannot walk itself. */
  private async listBoundaryPaths(scopes: readonly string[]) {
    if (!this.machine || !scopes.length) return [];
    return (await listBoundaryFiles(this.root, await nestedRepositoryScopes(this.root, scopes))).map(file => file.path);
  }

  /** Stage machine files inside nested repositories, where `git add` silently stages nothing; missing paths are removed. */
  private async stageBoundaryFiles(paths: readonly string[], env: NodeJS.ProcessEnv, signal?: AbortSignal) {
    const present = await listBoundaryFiles(this.root, paths);
    const found = new Set(present.map(file => file.path));
    const regular = present.filter(file => file.mode !== "120000");
    const ids = regular.length
      ? (await this.runWithInput(["hash-object", "-w", "--stdin-paths"], `${regular.map(file => file.path).join("\n")}\n`, env, signal))
        .trim().split(/\r?\n/u)
      : [];
    const links = await Promise.all(present.filter(file => file.mode === "120000").map(async file => ({
      ...file,
      id: await this.objects.writeObject("blob", await fs.readlink(path.join(this.root, ...file.path.split("/")), { encoding: "buffer" })),
    })));
    const records = [
      ...regular.map((file, index) => `${file.mode} ${ids[index]}\t${file.path}`),
      ...links.map(file => `${file.mode} ${file.id}\t${file.path}`),
    ];
    if (records.length) await this.runWithInput(["update-index", "-z", "--index-info"], `${records.join("\0")}\0`, env, signal);
    const removed = paths.filter(filePath => !found.has(filePath));
    if (removed.length) await this.runWithInput(["update-index", "-z", "--force-remove", "--stdin"], `${removed.join("\0")}\0`, env, signal);
  }

  /** Literal pathspecs that let Git walk only the selected scopes; none (walk everything, then filter) when too many. */
  scopePathspecs(scopes: readonly string[]) {
    if (!scopes.length || scopes.includes(".")) return [];
    const pathspecs = scopes.map(scope => this.literalPathspec(scope));
    return pathspecs.reduce((total, pathspec) => total + pathspec.length + 1, 0) > PATHSPEC_ARGUMENT_BUDGET ? [] : ["--", ...pathspecs];
  }

  /**
   * Pathspec argument lists covering the scopes; `[]` means one unscoped walk. Machine worktrees batch oversized scope
   * sets instead, since an unscoped walk there would cross the whole machine.
   */
  private scopeBatches(scopes: readonly string[]): string[][] {
    const pathspecs = this.scopePathspecs(scopes);
    if (pathspecs.length || !this.machine || !scopes.length || scopes.includes(".")) return [pathspecs];
    const batches: string[][] = [];
    let current: string[] = [];
    let size = 0;
    for (const pathspec of scopes.map(scope => this.literalPathspec(scope))) {
      if (current.length && size + pathspec.length + 1 > PATHSPEC_ARGUMENT_BUDGET) {
        batches.push(["--", ...current]);
        current = [];
        size = 0;
      }
      current.push(pathspec);
      size += pathspec.length + 1;
    }
    if (current.length) batches.push(["--", ...current]);
    return batches;
  }

  /** Untracked files are only listed where Git walks a bounded tree: anywhere in a project, only within scopes on a machine. */
  private walksUntracked(pathspecs: readonly string[]) {
    return !this.machine || pathspecs.length > 0;
  }

  async listWorktreeChangedPaths(
    baseTreeish: string | null,
    scopes: readonly string[] = [],
    signal?: AbortSignal,
  ) {
    return await this.withTemporaryIndex(async (indexPath) => {
      const env = { ...process.env, GIT_INDEX_FILE: indexPath };
      const base = await this.contentBase(baseTreeish);
      await this.run(["read-tree", base], env, signal);
      const [outputs, boundary] = await Promise.all([
        Promise.all(this.scopeBatches(scopes).flatMap((pathspecs) => [
          this.run(["diff", "--name-only", "-z", "--no-renames", ...pathspecs.length ? pathspecs : ["--"]], env, signal),
          ...this.walksUntracked(pathspecs)
            ? [this.run(["ls-files", "-z", "--others", "--exclude-standard", ...pathspecs.length ? pathspecs : ["--"]], env, signal)]
            : [],
        ])),
        this.listBoundaryPaths(scopes),
      ]);
      // Git diffs tracked boundary files itself; only files the base never held are new.
      const known = boundary.length ? new Set(await this.listTreePaths(base, boundary)) : new Set<string>();
      const changedPaths = [...new Set([...outputs.flatMap(parseNullPaths), ...boundary.filter(filePath => !known.has(filePath))])]
        .sort((left, right) => left.localeCompare(right));
      return filterPathsByScopes(changedPaths, scopes);
    });
  }

  async writeScopedWorktreeTree(paths: string[], baseTreeish: string | null = "HEAD", signal?: AbortSignal) {
    return await this.withTemporaryIndex(async (indexPath) => {
      const env = { ...process.env, GIT_INDEX_FILE: indexPath };
      await this.seedTemporaryIndex(indexPath, baseTreeish, env, signal);
      await this.stageScopedPaths(paths, env, signal);
      return (await this.run(["write-tree"], env, signal)).trim();
    });
  }

  /** Stages current content beneath scopes into the index `env` names, walking untracked files only inside them. */
  private async stageScopedPaths(paths: readonly string[], env: NodeJS.ProcessEnv, signal?: AbortSignal) {
    const matchedPaths = await this.listWorktreePaths(paths, env, signal);
    const boundary = new Set(this.machine ? await nestedRepositoryScopes(this.root, matchedPaths) : []);
    const added = matchedPaths.filter(filePath => !boundary.has(filePath));
    if (added.length) {
      await this.runWithInput([
        "add", "-A", "-f", "--pathspec-from-file=-", "--pathspec-file-nul",
      ], pathspecInput(added), env, signal);
    }
    if (boundary.size) await this.stageBoundaryFiles([...boundary], env, signal);
  }

  async writeTreeWithPathsFromSource(baseTreeish: string | null, sourceTreeish: string, paths: string[]) {
    return (await this.writeTreeWithPathSources(baseTreeish, [{ paths, source: sourceTreeish }])).tree;
  }

  /**
   * `base` with each source's paths taken from that source, in order, through one temporary index. Also reports, per
   * source, the paths that actually differed from `base` (and were therefore swapped).
   */
  async writeTreeWithPathSources(baseTreeish: string | null, sources: ReadonlyArray<{ paths: string[]; source: string | null }>) {
    return await GitObjectReadSession.run(async () => {
      const base = await this.resolveTree(baseTreeish);
      const resolved = await Promise.all(sources.map(async ({ paths, source }) => {
        const tree = await this.resolveTree(source);
        return { changedPaths: await this.listChangedPaths(base, tree, paths), tree };
      }));
      // Later sources win where selections overlap, as successive index swaps did.
      const edits = new Map<string, GitTreeEdit>();
      for (const swap of resolved) {
        for (const [filePath, entry] of await this.trees.entriesAt(swap.tree, swap.changedPaths)) edits.set(filePath, entry);
      }
      return { changedPaths: resolved.map(swap => swap.changedPaths), tree: edits.size ? await this.trees.withEdits(base, edits) : base };
    });
  }

  /** `base` with each file path set to the given bytes and mode, or removed when null; writes loose objects only. */
  async writeTreeWithFiles(baseTreeish: string | null, files: ReadonlyMap<string, GitTreeFile | null>) {
    return await GitObjectReadSession.run(async () => {
      const base = await this.resolveTree(baseTreeish);
      const edits = new Map<string, GitTreeEdit>();
      for (const [filePath, file] of files) {
        edits.set(filePath, file ? { id: await this.objects.writeObject("blob", file.bytes), mode: file.mode } : null);
      }
      return await this.trees.withEdits(base, edits);
    });
  }

  /** Raw blob bytes and modes at file paths of a tree; null where the tree holds no file. */
  async readTreeFiles(treeish: string | null, paths: readonly string[]) {
    return await GitObjectReadSession.run(async () => {
      const entries = await this.trees.entriesAt(await this.resolveTree(treeish), paths);
      const ids = [...new Set([...entries.values()].flatMap(entry => entry ? [entry.id] : []))];
      const objects = ids.length ? await GitObjectReadSession.read(this.root, ids) : [];
      const bytesById = new Map(ids.map((id, index) => [id, objects[index]?.contents ?? null]));
      return new Map(paths.map((filePath): [string, GitTreeFile | null] => {
        const entry = entries.get(filePath);
        const bytes = entry ? bytesById.get(entry.id) : null;
        return [filePath, entry && bytes ? { bytes, mode: entry.mode } : null];
      }));
    });
  }

  /**
   * Untracked files Git ignores beneath the scopes, file by file. Git lists wholly-ignored folders collapsed (`--directory`), and Workbench walks
   * them and scopes already inside them (where Git's `--directory` fails), so the walk can stop past `limit`.
   */
  async listIgnoredWorktreePaths(scopes: readonly string[], options: { limit?: number; signal?: AbortSignal } = {}) {
    const { limit = IGNORED_FILE_LIMIT, signal } = options;
    const ignoredScopes = await this.listPatternIgnoredScopes(scopes, signal);
    const ignored = new Set(ignoredScopes);
    const gitScopes = scopes.filter(scope => !ignored.has(scope));
    const batches = scopes.length && !gitScopes.length ? []
      : this.scopeBatches(gitScopes).filter(pathspecs => this.walksUntracked(pathspecs));
    const entries = (await Promise.all(batches.map(async (pathspecs) => await this.run([
      "ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory", ...pathspecs,
    ], process.env, signal)))).flatMap(parseNullPaths);
    const files = entries.filter(entry => !entry.endsWith("/"));
    const folders = filterPathsByScopes(entries.filter(entry => entry.endsWith("/")).map(entry => entry.slice(0, -1)), gitScopes);
    const tooMany = (stoppedAt: string) => new Error(`includeIgnored roots hold more than ${limit} ignored files (stopped at ${stoppedAt}). `
      + "Narrow roots to the ignored files or folders you mean.");
    if (files.length > limit) throw tooMany(files[limit]!);
    let walked;
    try {
      walked = await listBoundaryFiles(this.root, [...ignoredScopes, ...folders], { limit: limit - files.length, signal });
    } catch (error) {
      if (error instanceof BoundaryWalkLimitError) throw tooMany(error.path);
      throw error;
    }
    // Force-added files inside ignored folders are tracked, never ignored.
    const tracked = new Set(ignoredScopes.length
      ? parseNullPaths(await this.run(["ls-files", "-z", "--cached", ...this.scopePathspecs(ignoredScopes)], process.env, signal))
      : []);
    const candidates = [...new Set([...files, ...walked.map(file => file.path).filter(filePath => !tracked.has(filePath))])]
      .sort((left, right) => left.localeCompare(right));
    return filterPathsByScopes(candidates, scopes);
  }

  /** Scopes Git's ignore patterns exclude, regardless of the index; Git's own ignored walk cannot start inside them. */
  private async listPatternIgnoredScopes(scopes: readonly string[], signal?: AbortSignal) {
    const candidates = scopes.filter(scope => scope && scope !== ".");
    if (!candidates.length) return [];
    const result = await this.runWithInputResult(
      ["check-ignore", "-z", "--no-index", "--stdin"], `${candidates.join("\0")}\0`, process.env, [0, 1], signal,
    );
    return result.exitCode === 1 ? [] : parseNullPaths(result.stdout);
  }

  /** Whether every commit is reachable from `descendant`, in one walk; unreadable commits are never proven reachable. */
  async allAncestors(commits: readonly string[], descendant: string) {
    if (!commits.length) return true;
    try {
      return !(await this.run(["rev-list", "--max-count=1", ...commits, "--not", descendant])).trim();
    } catch (error) {
      // A missing commit (rewritten or pruned history) fails the walk exactly like `merge-base --is-ancestor` did.
      if (error instanceof Error && /bad revision|unknown revision|bad object/iu.test(error.message)) return false;
      throw error;
    }
  }

  async createCommitFromTree(
    tree: string,
    parent: string | string[] | null,
    message: string,
    /** Supplied actor fields override Git's defaults; omitted ones keep them. */
    identity?: Partial<Omit<GitCommitIdentity, "message" | "parents" | "signed" | "tree">>,
  ) {
    const parents = parent === null ? [] : Array.isArray(parent) ? parent : [parent];
    const written = await GitObjectReadSession.run(async () => await this.objects.writeCommit(tree, parents, message, identity));
    if (written) return written;
    const overrides = identity ? Object.fromEntries(Object.entries({
      GIT_AUTHOR_DATE: identity.authorDate,
      GIT_AUTHOR_EMAIL: identity.authorEmail,
      GIT_AUTHOR_NAME: identity.authorName,
      GIT_COMMITTER_DATE: identity.committerDate,
      GIT_COMMITTER_EMAIL: identity.committerEmail,
      GIT_COMMITTER_NAME: identity.committerName,
    }).filter(([, value]) => value !== undefined)) : {};
    const env = identity ? { ...process.env, ...overrides } : process.env;
    return (await this.runWithInput([
      "commit-tree", tree, "--no-gpg-sign", ...parents.flatMap((candidate) => ["-p", candidate]), "-F", "-",
    ], message, env)).trim();
  }

  /** Lets Git validate and canonicalise supplied actor fields; unsupplied fields are omitted from the result. */
  async normalizeCommitActor(kind: "author" | "committer", actor: { date?: string; email?: string; name?: string }) {
    const prefix = kind === "author" ? "GIT_AUTHOR" : "GIT_COMMITTER";
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      [`${prefix}_EMAIL`]: actor.email ?? "workbench@localhost",
      [`${prefix}_NAME`]: actor.name ?? "workbench",
    };
    if (actor.date === undefined) delete env[`${prefix}_DATE`];
    else env[`${prefix}_DATE`] = actor.date;
    const output = await this.run(["var", `${prefix}_IDENT`], env);
    const parsed = parseCommitActor(output.trim(), kind);
    return {
      ...(actor.date === undefined ? {} : { date: parsed.date }),
      ...(actor.email === undefined ? {} : { email: parsed.email }),
      ...(actor.name === undefined ? {} : { name: parsed.name }),
    };
  }

  /** First-parent commits in a Git revision range such as `base..tip`, oldest first. */
  async listFirstParentRange(range: string) {
    if (!range.includes("..") || range.startsWith("-")) throw new Error(`Invalid commit range: ${range}`);
    return (await this.run(["rev-list", "--reverse", "--first-parent", range, "--"]))
      .split(/\r?\n/u).map((value) => value.trim()).filter(Boolean);
  }

  async mergeTree(base: string, left: string, right: string) {
    try {
      const output = await this.run(["merge-tree", "--write-tree", `--merge-base=${base}`, left, right]);
      return output.trim().split(/\r?\n/u)[0] ?? "";
    } catch (error) {
      throw new Error(`Commit rewrite conflicts while merging changes after ${base}.`, { cause: error });
    }
  }

  async mergeWorktreeTrees(
    baseTreeish: string | null,
    currentTreeish: string | null,
    stashedTreeish: string,
  ): Promise<GitWorktreeMergeResult> {
    const [base, current, stashed] = await Promise.all([
      this.resolveTree(baseTreeish),
      this.resolveTree(currentTreeish),
      this.resolveTree(stashedTreeish),
    ]);
    const result = await this.runWithInputResult([
      "merge-tree", "--write-tree", "--name-only", "--messages", "-z", `--merge-base=${base}`, current, stashed,
    ], "", { ...process.env, LC_ALL: "C" }, [0, 1]);
    const fields = result.stdout.split("\0");
    const tree = fields.shift()?.trim() ?? "";
    if (!COMMIT_PATTERN.test(tree)) throw new Error("Git did not return a merged worktree tree.");
    if (result.exitCode === 0) return { conflictedPaths: [], tree, unsupportedConflictTypes: [] };

    const conflictedPaths: string[] = [];
    while (fields.length && fields[0]) conflictedPaths.push(fields.shift()!);
    if (fields[0] === "") fields.shift();
    const conflictTypes: string[] = [];
    while (fields.length && fields[0]) {
      const pathCount = Number(fields.shift());
      if (!Number.isSafeInteger(pathCount) || pathCount < 0 || fields.length < pathCount + 2) {
        throw new Error("Git returned invalid merge conflict metadata.");
      }
      fields.splice(0, pathCount);
      const conflictType = fields.shift()!;
      const message = fields.shift()!;
      if (conflictType.startsWith("CONFLICT")) conflictTypes.push(conflictType);
      if (message.includes("Cannot merge binary files:")) conflictTypes.push("CONFLICT (binary)");
    }
    const supported = new Set(["CONFLICT (content)", "CONFLICT (contents)", "CONFLICT (add/add)"]);
    return {
      conflictedPaths: [...new Set(conflictedPaths)].sort((left, right) => left.localeCompare(right)),
      tree,
      unsupportedConflictTypes: [...new Set(conflictTypes.filter((type) => !supported.has(type)))].sort(),
    };
  }

  /** `target` through `head` along first parents; the walk stops at the target's parents instead of the root. */
  async firstParentRange(target: string, head: string) {
    const { parents } = await this.readCommit(target);
    const commits = (await this.run(["rev-list", "--reverse", "--first-parent", head, ...parents.length ? ["--not", ...parents] : [], "--"]))
      .split(/\r?\n/u).map((value) => value.trim()).filter(Boolean);
    if (commits[0] !== target) throw new Error("Amend target is not on the current branch's first-parent chain.");
    return commits;
  }

  /** Refs under the namespaces with their values and object types; shared within an operation until it publishes refs. */
  async listRefsWithValues(...namespaces: string[]) {
    return [...await GitObjectReadSession.memo(`${this.refMemoPrefix()}list:${namespaces.join("\0")}`, () => this.readRefsWithValues(namespaces))];
  }

  private async readRefsWithValues(namespaces: readonly string[]) {
    const output = await this.runWithInput(
      ["for-each-ref", "--stdin", "--format=%(refname)%00%(objectname)"],
      namespaces.length ? `${namespaces.join("\n")}\n` : "",
    );
    const refs = output.split(/\r?\n/u).filter(Boolean).map((line) => {
      const [ref = "", value = ""] = line.split("\0");
      return { ref, value };
    });
    const values = [...new Set(refs.map(({ value }) => value).filter(Boolean))];
    if (!values.length) return [];
    const objects = await GitObjectReadSession.read(this.root, values, "info");
    const types = new Map(values.map((value, index) => [value, objects[index]?.type ?? "missing"]));
    return refs.map(({ ref, value }) => ({ objectType: types.get(value) ?? "missing", ref, value }));
  }

  async listChangedPaths(from: string | null, to: string | null, paths: string[], signal?: AbortSignal) {
    return await this.listTreeChanges(from, to, paths, signal);
  }

  async listAllChangedPaths(from: string | null, to: string | null, signal?: AbortSignal) {
    return await this.listTreeChanges(from, to, [], signal);
  }

  /** Tree-to-tree changes, read in-process through the operation's object reader and pruned to `scopes`. */
  private async listTreeChanges(from: string | null, to: string | null, scopes: readonly string[], signal?: AbortSignal) {
    return await GitObjectReadSession.run(async () => {
      const [fromTree, toTree] = await Promise.all([this.resolveTree(from), this.resolveTree(to)]);
      signal?.throwIfAborted();
      const changed = await this.trees.changedPaths(fromTree, toTree, scopes.includes(".") ? [] : scopes);
      signal?.throwIfAborted();
      return filterPathsByScopes(changed, scopes).sort((left, right) => left.localeCompare(right));
    });
  }

  async listPathsModifiedSince(paths: readonly string[], modifiedSince: number) {
    if (!Number.isFinite(modifiedSince) || modifiedSince < 0) {
      throw new Error("Git workspace dirt timestamp must be a finite non-negative number.");
    }
    const matches = await Promise.all(paths.map(async (candidate) => {
      try {
        const stats = await fs.lstat(this.resolvePath(candidate));
        return stats.mtimeMs >= modifiedSince ? candidate : null;
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
        throw error;
      }
    }));
    return matches.filter((candidate): candidate is string => candidate !== null);
  }

  async listFirstParentCommitPathChanges(fromExclusive: string | null, toInclusive: string | null, paths: string[]): Promise<GitCommitPathChange[]> {
    if (fromExclusive === toInclusive || !toInclusive || !paths.length) return [];
    const commits = (await this.run([
      "rev-list", "--reverse", "--first-parent", fromExclusive ? `${fromExclusive}..${toInclusive}` : toInclusive,
    ])).split(/\r?\n/u).map((value) => value.trim()).filter(Boolean);
    const batch = await this.readCommits(commits);
    return (await Promise.all(commits.map(async (commit): Promise<GitCommitPathChange | null> => {
      const identity = batch.commits.get(commit);
      if (!identity) throw new Error(batch.errors.get(commit) ?? `Unable to read commit metadata for ${commit}.`);
      const parent = identity.parents[0] ?? null;
      const changedPaths = await this.listChangedPaths(parent, commit, paths);
      if (!changedPaths.length) return null;
      return {
        changedPaths,
        commit,
        subject: identity.message.split(/\r?\n/u, 1)[0]?.trim() ?? "",
      };
    }))).filter((change): change is GitCommitPathChange => change !== null);
  }

  async classifyHeadMovement(
    ancestryBaseCommit: string | null,
    paths: string[],
    contentBaseline = ancestryBaseCommit,
    knownCurrentHead?: string | null,
  ): Promise<GitHeadMovement> {
    const currentHead = knownCurrentHead === undefined ? await this.headOrNull() : knownCurrentHead;
    if (currentHead === ancestryBaseCommit) {
      return {
        changedPaths: contentBaseline === currentHead ? [] : await this.listChangedPaths(contentBaseline, currentHead, paths),
        currentHead,
        kind: "same",
      };
    }
    if (currentHead === null) return { changedPaths: [], currentHead, kind: "incompatible" };
    if (ancestryBaseCommit !== null) {
      const commitsOnlyOnBase = (await this.run(["rev-list", "--max-count=1", `${currentHead}..${ancestryBaseCommit}`])).trim();
      if (commitsOnlyOnBase) return { changedPaths: [], currentHead, kind: "incompatible" };
    }
    return {
      changedPaths: await this.listChangedPaths(contentBaseline, currentHead, paths),
      currentHead,
      kind: "fast-forward",
    };
  }

  /** Per-file changes with patches; plain --patch gives binary files Git's header-only stub, never a base85 payload. */
  async buildFileChanges(from: string | null, to: string, paths: string[], signal?: AbortSignal) {
    const base = await this.contentBase(from);
    const changedPaths = await this.listChangedPaths(base, to, paths, signal);
    const limit = gitProcessLimit();
    const changes = (await Promise.all(this.pathspecBatches(changedPaths).map(async batch => (
      await this.diffPatchBatch(base, to, batch, limit, signal)
    )))).flat();
    return changes.sort((left, right) => left.path.localeCompare(right.path));
  }

  /** Per-file totals without patches, for durable summaries; scoped like `buildFileChanges`. */
  async buildChangeTotals(from: string | null, to: string, paths: string[], signal?: AbortSignal) {
    if (!paths.length) return [];
    const base = await this.contentBase(from);
    const changedPaths = await this.listChangedPaths(base, to, paths, signal);
    const limit = gitProcessLimit();
    const totals = (await Promise.all(this.pathspecBatches(changedPaths).map(async batch => (
      await this.diffTotalsBatch(base, to, batch, limit, signal)
    )))).flat();
    return totals.sort((left, right) => left.path.localeCompare(right.path));
  }

  /** `buildFileChanges` without patch text (`diff` is empty), for callers that only show which files changed and by how much. */
  async buildFileChangeSummaries(from: string | null, to: string, paths: string[], signal?: AbortSignal): Promise<GitCheckpointFileChange[]> {
    return (await this.buildChangeTotals(from, to, paths, signal)).map(({ additions, deletions, kind, path: filePath }) => ({
      additions, deletions, diff: "",
      kind: kind === "add" ? { type: "add" } : kind === "delete" ? { type: "delete" } : { move_path: null, type: "update" },
      path: filePath,
    }));
  }

  /** Exact changed files grouped so each Git invocation's literal pathspecs stay inside the command-line budget. */
  private pathspecBatches(changedPaths: readonly string[]) {
    const batches: string[][] = [];
    let current: string[] = [];
    let size = 0;
    for (const filePath of changedPaths) {
      const length = this.literalPathspec(filePath).length + 1;
      if (current.length && size + length > PATHSPEC_ARGUMENT_BUDGET) {
        batches.push(current);
        current = [];
        size = 0;
      }
      current.push(filePath);
      size += length;
    }
    if (current.length) batches.push(current);
    return batches;
  }

  private async diffTotalsBatch(
    from: string, to: string, batch: string[], limit: GitProcessLimit, signal?: AbortSignal,
  ): Promise<ReturnType<typeof parseGitChangeTotalsOutput>> {
    try {
      return parseGitChangeTotalsOutput(await limit(() => this.run([
        "diff", "--raw", "--numstat", "-z", "--no-renames", from, to, "--", ...batch.map(filePath => this.literalPathspec(filePath)),
      ], process.env, signal)));
    } catch (error) {
      if (!isStdoutCapacityError(error) || batch.length < 2) throw error;
      const [left, right] = halves(batch);
      return [...await this.diffTotalsBatch(from, to, left, limit, signal), ...await this.diffTotalsBatch(from, to, right, limit, signal)];
    }
  }

  /** One batch's patches; overflowing output splits the batch, and gitlinks inspect their files singly. */
  private async diffPatchBatch(
    from: string, to: string, batch: string[], limit: GitProcessLimit, signal?: AbortSignal,
  ): Promise<GitCheckpointFileChange[]> {
    let output: string;
    try {
      output = await limit(() => this.run([
        "diff", "--raw", "--numstat", "--patch", "-z", "--no-renames", from, to,
        "--", ...batch.map(filePath => this.literalPathspec(filePath)),
      ], process.env, signal));
    } catch (error) {
      if (!isStdoutCapacityError(error)) throw error;
      if (batch.length < 2) return [await this.inspectFileChange(from, to, batch[0]!, limit, signal)];
      const [left, right] = halves(batch);
      return [...await this.diffPatchBatch(from, to, left, limit, signal), ...await this.diffPatchBatch(from, to, right, limit, signal)];
    }
    const parsed = parseGitFileChangeOutput(output);
    if (parsed.kind === "changes") return parsed.changes;
    // Expanded submodule patches can nest headers, so each file in the batch reads on its own.
    return await Promise.all(parsed.paths.map(async filePath => await this.inspectFileChange(from, to, filePath, limit, signal)));
  }

  private async inspectFileChange(
    from: string, to: string, filePath: string, limit: GitProcessLimit, signal?: AbortSignal,
  ): Promise<GitCheckpointFileChange> {
    const inspected = await limit(() => this.run([
      "diff", "--raw", "--numstat", "--patch", "--no-renames", from, to, "--", this.literalPathspec(filePath),
    ], process.env, signal));
    const patchOffset = inspected.indexOf("diff --git ");
    if (patchOffset < 0) throw new Error(`Git did not return a patch for changed path ${filePath}.`);
    const metadata = inspected.slice(0, patchOffset);
    const status = /^:[0-7]{6} [0-7]{6} [a-f0-9]+ [a-f0-9]+ ([A-Z])/mu.exec(metadata)?.[1] ?? "";
    const numstat = /^(\d+|-)\t(\d+|-)\t/mu.exec(metadata);
    if (!status || !numstat) throw new Error(`Git returned invalid change metadata for ${filePath}.`);
    const [, added = "0", deleted = "0"] = numstat;
    return {
      additions: /^\d+$/u.test(added) ? Number(added) : 0,
      deletions: /^\d+$/u.test(deleted) ? Number(deleted) : 0,
      diff: inspected.slice(patchOffset),
      kind: status === "A" ? { type: "add" } : status === "D"
        ? { type: "delete" }
        : { move_path: null, type: "update" },
      path: filePath,
    };
  }

  async listTreePaths(treeish: string | null, paths?: string[]) {
    const scopes = paths?.length && !paths.includes(".") ? this.normalizePaths(paths) : [];
    return filterPathsByScopes(parseNullPaths(await this.run([
      "ls-tree", "-r", "--name-only", "-z", await this.contentBase(treeish),
    ])), scopes);
  }

  /** Every real-index writer calls this first, so a lock stranded by a dead writer never needs manual removal. */
  async clearOrphanedIndexLock() {
    return await GitIndexLock.clearOrphan(await realIndexPath(this));
  }

  async resetMixedPaths(commit: string, paths: string[]) {
    if (!paths.length) return;
    await this.clearOrphanedIndexLock();
    await this.runWithInput([
      "reset", "--mixed", "--quiet", "--pathspec-from-file=-", "--pathspec-file-nul", commit,
    ], pathspecInput(paths));
  }

  /**
   * Move the real index and worktree from one commit's tree to another's, touching only paths that differ.
   * Git refuses before writing when a differing path is dirty or an untracked file would be overwritten.
   */
  async checkoutTreeTransition(from: string, to: string) {
    await this.clearOrphanedIndexLock();
    await this.run(["read-tree", "-m", "-u", this.normalizeCommit(from), this.normalizeCommit(to)]);
  }

  async writeIndexTree() {
    await this.clearOrphanedIndexLock();
    return (await this.run(["write-tree"])).trim();
  }

  async publishRefsAfterIndexNormalization({
    deletes = [],
    expectedStateGeneration,
    indexCommit,
    paths,
    updates,
  }: {
    deletes?: Array<{ oldValue?: string; ref: string }>;
    expectedStateGeneration?: string | null;
    indexCommit: string;
    paths: string[];
    updates: GitRefUpdate[];
  }) {
    const previousIndexTree = await this.writeIndexTree();
    await this.resetMixedPaths(indexCommit, paths);
    try {
      await this.updateRefs(updates, deletes, { expectedStateGeneration });
    } catch (publicationError) {
      try {
        await this.resetMixedPaths(previousIndexTree, paths);
      } catch (rollbackError) {
        throw new AggregateError(
          [publicationError, rollbackError],
          "Git ref publication failed and the selected index paths could not be restored.",
        );
      }
      throw publicationError;
    }
  }

  async restorePaths(source: string | null, paths: string[]) {
    if (!paths.length) return;
    // `restore --worktree` still locks the index to refresh restored entries' stat info.
    await this.clearOrphanedIndexLock();
    await this.runWithInput([
      "restore", "--source", await this.contentBase(source), "--worktree", "--pathspec-from-file=-", "--pathspec-file-nul",
    ], pathspecInput(paths));
  }

  async restoreWorktree(source: string) {
    await this.clearOrphanedIndexLock();
    await this.run(["restore", "--source", source, "--worktree", "--", "."]);
  }

  async remotes() {
    return await GitObjectReadSession.memo(`remotes:${this.root}`, async () => (await this.run(["remote"]))
      .split(/\r?\n/u)
      .map((value) => value.trim())
      .filter(Boolean));
  }

  async fetchRemotes() {
    await this.run(["fetch", "--all", "--prune", "--quiet"]);
  }

  private async readObject(objectish: string) {
    const normalized = String(objectish ?? "").trim();
    const batch = await this.readObjects([normalized]);
    const error = batch.errors.get(normalized);
    if (error) throw new Error(error);
    return batch.objects.get(normalized) ?? null;
  }

  private async readObjects(objectishes: string[]) {
    const requested = [...new Set(objectishes)];
    const objects = new Map<string, GitObject | null>();
    const errors = new Map<string, string>();
    if (!requested.length) return { objects, errors };
    if (requested.some((value) => !value.trim() || /[\r\n]/u.test(value))) {
      throw new Error("A valid Git object expression is required.");
    }
    const results = await GitObjectReadSession.read(this.root, requested);
    results.forEach((object, index) => {
      objects.set(requested[index]!, object ? {
        contents: object.contents!, objectId: object.objectId, type: object.type,
      } : null);
    });
    return { objects, errors };
  }
}
