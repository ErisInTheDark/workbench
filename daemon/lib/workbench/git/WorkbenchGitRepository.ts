/*
 * Exports:
 * - default WorkbenchGitRepository: own raw Git process, stdin pathspec transport, ignored-path classification and tracked traversal, snapshot, path, tree, ref, worktree timestamps, index-normalized publication, and ancestry mechanics for one repository. Keywords: git, repository, pathspec, ignore, staged deletion, tracked path, stdin, argv, large path set, snapshot, ref, mtime, index, transaction.
 * - GitCommitPathChange/GitHeadMovement/GitRefUpdate/GitResolvedBlob/GitResolvedCommit/GitWorktreeSnapshot: typed Git history, ancestry, object-read, worktree-snapshot, and atomic ref-update inputs. Keywords: git, commit, paths, head, object, snapshot, ref, transaction.
 * - GitCommitIdentity/GitCommitBatch: parsed commit metadata and batched read results.
 * - GIT_STATE_GENERATION_REF: per-worktree mutation generation ref.
 */
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import WorkbenchTemporaryDirectory from "../WorkbenchTemporaryDirectory";
import type { GitCheckpointFileChange } from "workbench-shared/workbench/git/checkpoint-contracts";

const execFileAsync = promisify(execFile);
const GIT_MAX_BUFFER = 32 * 1024 * 1024;
const COMMIT_PATTERN = /^[a-f0-9]{7,64}$/iu;
const WORKBENCH_TRANSCRIPT_EXCLUSION = ":(top,glob,exclude).workbench/transcripts/**";
export const GIT_STATE_GENERATION_REF = "refs/worktree/workbench/state-generation";

export interface GitHeadMovement {
  changedPaths: string[];
  currentHead: string;
  kind: "fast-forward" | "incompatible" | "same";
}

export interface GitCommitPathChange {
  changedPaths: string[];
  commit: string;
  subject: string;
}

export interface GitRefUpdate {
  newValue: string;
  oldValue?: string;
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

export interface GitResolvedBlob {
  blob: string;
  contents: string;
}

export interface GitResolvedCommit {
  commit: string;
  identity: GitCommitIdentity;
}

export interface GitWorktreeSnapshot {
  head: string;
  tree: string;
}

function isWithinRoot(candidatePath: string, rootPath: string, platform: NodeJS.Platform) {
  const comparable = (value: string) => {
    const normalized = path.resolve(value).replace(/\\/g, "/");
    return platform === "win32" ? normalized.toLowerCase() : normalized;
  };
  const candidate = comparable(candidatePath);
  const root = comparable(rootPath);
  return candidate === root || candidate.startsWith(`${root}/`);
}

function parseNullPaths(output: string) {
  return output.split("\0").filter(Boolean);
}

function filterPathsByScopes(candidates: string[], scopes: readonly string[]) {
  if (!scopes.length || scopes.includes(".")) return candidates;
  const scopeSet = new Set(scopes);
  return candidates.filter((candidate) => {
    if (scopeSet.has(candidate)) return true;
    let separator = candidate.lastIndexOf("/");
    while (separator > 0) {
      if (scopeSet.has(candidate.slice(0, separator))) return true;
      separator = candidate.lastIndexOf("/", separator - 1);
    }
    return false;
  });
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
    const repoRoot = (await WorkbenchGitRepository.runAt(cwd, ["rev-parse", "--show-toplevel"])).trim();
    if (!repoRoot) throw new Error("Unable to find Git repository root.");
    return new WorkbenchGitRepository(path.resolve(repoRoot));
  }

  private static async runAt(
    cwd: string,
    args: string[],
    env: NodeJS.ProcessEnv = process.env,
    signal?: AbortSignal,
  ) {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
      env,
      maxBuffer: GIT_MAX_BUFFER,
      signal,
      windowsHide: true,
    });
    return stdout;
  }

  readonly root: string;

  constructor(repoRoot: string, private readonly platform: NodeJS.Platform = process.platform) {
    this.root = path.resolve(repoRoot);
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
    return await new Promise<{ exitCode: number; stdout: string }>((resolve, reject) => {
      const child = spawn("git", args, {
        cwd: this.root,
        env,
        signal,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => { stdout += chunk; });
      child.stderr.on("data", (chunk: string) => { stderr += chunk; });
      child.once("error", reject);
      child.once("close", (code) => {
        if (code !== null && acceptedExitCodes.includes(code)) resolve({ exitCode: code, stdout });
        else reject(new Error(stderr.trim() || `git ${args[0] ?? "command"} failed with exit code ${code}.`));
      });
      child.stdin.end(input);
    });
  }

  async runWithInput(args: string[], input: string, env: NodeJS.ProcessEnv = process.env, signal?: AbortSignal) {
    return (await this.runWithInputResult(args, input, env, [0], signal)).stdout;
  }

  async runBufferWithInput(args: string[], input: string, env: NodeJS.ProcessEnv = process.env) {
    return await new Promise<Buffer>((resolve, reject) => {
      const child = spawn("git", args, {
        cwd: this.root,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      const stdout: Buffer[] = [];
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => { stdout.push(chunk); });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => { stderr += chunk; });
      child.once("error", reject);
      child.once("close", (code) => {
        if (code === 0) resolve(Buffer.concat(stdout));
        else reject(new Error(stderr.trim() || `git ${args[0] ?? "command"} failed with exit code ${code}.`));
      });
      child.stdin.end(input);
    });
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
    const stagedDeletedPaths = parseNullPaths(await this.run([
      "diff", "--cached", "--name-only", "-z", "--diff-filter=D", "--no-renames", "--",
    ]));
    return ignoredPaths.filter((ignoredPath) => !stagedDeletedPaths.some((deletedPath) => (
      deletedPath === ignoredPath || deletedPath.startsWith(`${ignoredPath}/`)
    )));
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
    return (await this.run(["rev-parse", "HEAD"])).trim();
  }

  async symbolicHead() {
    try {
      return (await this.run(["symbolic-ref", "-q", "HEAD"])).trim() || null;
    } catch {
      return null;
    }
  }

  async resolveCommit(commit: string) {
    return (await this.run(["rev-parse", "--verify", `${this.normalizeCommit(commit)}^{commit}`])).trim();
  }

  async resolveTree(treeish: string) {
    return (await this.run(["rev-parse", `${treeish}^{tree}`])).trim();
  }

  async resolveParent(commit: string) {
    return (await this.run(["rev-parse", `${commit}^`])).trim();
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
    const requested = [...new Set(commits)];
    const result: GitCommitBatch = { commits: new Map(), errors: new Map() };
    if (!requested.length) return result;
    const output = await this.runBufferWithInput(["cat-file", "--batch"], `${requested.join("\n")}\n`);
    let offset = 0;
    for (const requestedCommit of requested) {
      const headerEnd = output.indexOf(0x0a, offset);
      if (headerEnd < 0) {
        result.errors.set(requestedCommit, "Git cat-file batch output ended before its object header.");
        break;
      }
      const header = output.subarray(offset, headerEnd).toString("utf8");
      offset = headerEnd + 1;
      const missing = /^([a-f0-9]+) missing$/iu.exec(header);
      if (missing) {
        result.errors.set(requestedCommit, `Git object ${missing[1]} is missing.`);
        continue;
      }
      const match = /^([a-f0-9]+) (\S+) (\d+)$/iu.exec(header);
      if (!match) {
        result.errors.set(requestedCommit, `Git cat-file returned an invalid object header: ${header}`);
        continue;
      }
      const size = Number(match[3]);
      const objectEnd = offset + size;
      if (!Number.isSafeInteger(size) || size < 0 || objectEnd > output.length) {
        result.errors.set(requestedCommit, `Git object ${match[1]} has an invalid size.`);
        break;
      }
      const contents = output.subarray(offset, objectEnd);
      offset = objectEnd + 1;
      if (match[2] !== "commit") {
        result.errors.set(requestedCommit, `Git object ${match[1]} is not a commit.`);
        continue;
      }
      try {
        result.commits.set(requestedCommit, parseRawCommit(contents));
      } catch (error) {
        result.errors.set(requestedCommit, error instanceof Error ? error.message : String(error));
      }
    }
    return result;
  }

  async readCommitMessage(commit: string) {
    return await this.run(["show", "-s", "--format=%B", commit]);
  }

  async refsPointingAt(commit: string, ...namespaces: string[]) {
    const output = await this.run([
      "for-each-ref", "--format=%(refname)", "--points-at", commit, ...namespaces,
    ]);
    return output.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean);
  }

  async listRefs(namespace: string) {
    const output = await this.run(["for-each-ref", "--format=%(refname)", namespace]);
    return output.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean);
  }

  async readRef(ref: string) {
    try {
      return (await this.run(["rev-parse", "--verify", ref])).trim() || null;
    } catch {
      return null;
    }
  }

  async writeBlob(contents: string) {
    return (await this.runWithInput(["hash-object", "-w", "--stdin"], contents)).trim();
  }

  async readBlob(blob: string) {
    return await this.run(["cat-file", "blob", blob]);
  }

  async updateRef(ref: string, newValue: string, oldValue?: string) {
    await this.run(["update-ref", ref, newValue, ...(oldValue !== undefined ? [oldValue] : [])]);
  }

  async deleteRef(ref: string, oldValue?: string) {
    await this.run(["update-ref", "-d", ref, ...(oldValue !== undefined ? [oldValue] : [])]);
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
    const lines = ["start"];
    for (const update of updates) {
      lines.push(`update ${update.ref} ${update.newValue}${update.oldValue !== undefined ? ` ${update.oldValue}` : ""}`);
    }
    for (const deletion of deletes) {
      lines.push(`delete ${deletion.ref}${deletion.oldValue !== undefined ? ` ${deletion.oldValue}` : ""}`);
    }
    if (generationValue) {
      const expected = options.expectedStateGeneration === undefined
        ? ""
        : ` ${options.expectedStateGeneration ?? "0".repeat(40)}`;
      lines.push(`update ${GIT_STATE_GENERATION_REF} ${generationValue}${expected}`);
    }
    lines.push("prepare", "commit", "");
    await this.runWithInput(["update-ref", "--stdin"], lines.join("\n"));
  }

  async withTemporaryIndex<T>(callback: (indexPath: string, directory: string) => Promise<T>) {
    const temporaryDirectory = await WorkbenchTemporaryDirectory.create("workbench-git-index-");
    try {
      return await callback(path.join(temporaryDirectory.path, "index"), temporaryDirectory.path);
    } finally {
      await temporaryDirectory.dispose();
    }
  }

  async writeWorktreeTree(baseTreeish = "HEAD", signal?: AbortSignal) {
    return await this.withTemporaryIndex(async (indexPath) => {
      const env = { ...process.env, GIT_INDEX_FILE: indexPath };
      await this.run(["read-tree", baseTreeish], env, signal);
      const transcriptIsIgnored = await this.succeeds([
        "check-ignore", "-q", "--no-index", ".workbench/transcripts",
      ]);
      await this.run([
        "add", "-A", "--", ".", ...(transcriptIsIgnored ? [] : [WORKBENCH_TRANSCRIPT_EXCLUSION]),
      ], env, signal);
      return (await this.run(["write-tree"], env, signal)).trim();
    });
  }

  async writeWorktreeSnapshot(signal?: AbortSignal): Promise<GitWorktreeSnapshot> {
    const head = await this.currentHead();
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
    const candidates = [...new Set(parseNullPaths(await this.run([
      "ls-files", "-z", "--cached", "--others", "--exclude-standard",
    ], env, signal)))].sort((left, right) => left.localeCompare(right));
    return filterPathsByScopes(candidates, scopes);
  }

  async listWorktreeChangedPaths(
    baseTreeish: string,
    scopes: readonly string[] = [],
    signal?: AbortSignal,
  ) {
    return await this.withTemporaryIndex(async (indexPath) => {
      const env = { ...process.env, GIT_INDEX_FILE: indexPath };
      await this.run(["read-tree", baseTreeish], env, signal);
      const [tracked, untracked] = await Promise.all([
        this.run(["diff", "--name-only", "-z", "--no-renames", "--"], env, signal),
        this.run(["ls-files", "-z", "--others", "--exclude-standard", "--"], env, signal),
      ]);
      const changedPaths = [...new Set([...parseNullPaths(tracked), ...parseNullPaths(untracked)])]
        .sort((left, right) => left.localeCompare(right));
      return filterPathsByScopes(changedPaths, scopes);
    });
  }

  async writeScopedWorktreeTree(paths: string[], baseTreeish = "HEAD", signal?: AbortSignal) {
    return await this.withTemporaryIndex(async (indexPath) => {
      const env = { ...process.env, GIT_INDEX_FILE: indexPath };
      await this.run(["read-tree", baseTreeish], env, signal);
      const matchedPaths = await this.listWorktreePaths(paths, env, signal);
      if (matchedPaths.length) {
        await this.runWithInput([
          "add", "-A", "-f", "--pathspec-from-file=-", "--pathspec-file-nul",
        ], pathspecInput(matchedPaths), env, signal);
      }
      return (await this.run(["write-tree"], env, signal)).trim();
    });
  }

  async writeTreeWithPathsFromSource(baseTreeish: string, sourceTreeish: string, paths: string[]) {
    return await this.withTemporaryIndex(async (indexPath) => {
      const env = { ...process.env, GIT_INDEX_FILE: indexPath };
      await this.run(["read-tree", baseTreeish], env);
      const changedPaths = await this.listChangedPaths(baseTreeish, sourceTreeish, paths);
      if (changedPaths.length) {
        await this.runWithInput([
          "restore", "--source", sourceTreeish, "--staged",
          "--pathspec-from-file=-", "--pathspec-file-nul",
        ], pathspecInput(changedPaths), env);
      }
      return (await this.run(["write-tree"], env)).trim();
    });
  }

  async createCommitFromTree(
    tree: string,
    parent: string | string[],
    message: string,
    identity?: Omit<GitCommitIdentity, "message" | "parents" | "signed" | "tree">,
  ) {
    const parents = Array.isArray(parent) ? parent : [parent];
    const env = identity ? {
      ...process.env,
      GIT_AUTHOR_DATE: identity.authorDate,
      GIT_AUTHOR_EMAIL: identity.authorEmail,
      GIT_AUTHOR_NAME: identity.authorName,
      GIT_COMMITTER_DATE: identity.committerDate,
      GIT_COMMITTER_EMAIL: identity.committerEmail,
      GIT_COMMITTER_NAME: identity.committerName,
    } : process.env;
    return (await this.runWithInput([
      "commit-tree", tree, "--no-gpg-sign", ...parents.flatMap((candidate) => ["-p", candidate]), "-F", "-",
    ], message, env)).trim();
  }

  async mergeTree(base: string, left: string, right: string) {
    try {
      const output = await this.run(["merge-tree", "--write-tree", `--merge-base=${base}`, left, right]);
      return output.trim().split(/\r?\n/u)[0] ?? "";
    } catch (error) {
      throw new Error(`Commit rewrite conflicts while merging changes after ${base}.`, { cause: error });
    }
  }

  async firstParentRange(target: string, head: string) {
    const commits = (await this.run(["rev-list", "--reverse", "--first-parent", head]))
      .split(/\r?\n/u).map((value) => value.trim()).filter(Boolean);
    const targetIndex = commits.indexOf(target);
    if (targetIndex < 0) throw new Error("Amend target is not on the current branch's first-parent chain.");
    return commits.slice(targetIndex);
  }

  async listRefsWithValues(...namespaces: string[]) {
    const output = await this.run(["for-each-ref", "--format=%(refname)%00%(objectname)", ...namespaces]);
    const refs = output.split(/\r?\n/u).filter(Boolean).map((line) => {
      const [ref = "", value = ""] = line.split("\0");
      return { ref, value };
    });
    const values = [...new Set(refs.map(({ value }) => value).filter(Boolean))];
    if (!values.length) return [];
    const typeOutput = await this.runWithInput(
      ["cat-file", "--batch-check=%(objectname) %(objecttype)"],
      `${values.join("\n")}\n`,
    );
    const types = new Map<string, string>();
    for (const line of typeOutput.split(/\r?\n/u).filter(Boolean)) {
      const match = /^([a-f0-9]+) (\S+)$/iu.exec(line);
      if (match) types.set(match[1]!, match[2]!);
    }
    return refs.map(({ ref, value }) => ({ objectType: types.get(value) ?? "missing", ref, value }));
  }

  async listChangedPaths(from: string, to: string, paths: string[], signal?: AbortSignal) {
    return filterPathsByScopes(await this.listAllChangedPaths(from, to, signal), paths);
  }

  async listAllChangedPaths(from: string, to: string, signal?: AbortSignal) {
    return parseNullPaths(await this.run([
      "diff", "--name-only", "-z", "--no-renames", from, to,
    ], process.env, signal)).sort((left, right) => left.localeCompare(right));
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

  async listFirstParentCommitPathChanges(fromExclusive: string, toInclusive: string, paths: string[]): Promise<GitCommitPathChange[]> {
    if (fromExclusive === toInclusive || !paths.length) return [];
    const commits = (await this.run([
      "rev-list", "--reverse", "--first-parent", `${fromExclusive}..${toInclusive}`,
    ])).split(/\r?\n/u).map((value) => value.trim()).filter(Boolean);
    const batch = await this.readCommits(commits);
    return (await Promise.all(commits.map(async (commit): Promise<GitCommitPathChange | null> => {
      const identity = batch.commits.get(commit);
      if (!identity) throw new Error(batch.errors.get(commit) ?? `Unable to read commit metadata for ${commit}.`);
      const parent = identity.parents[0];
      if (!parent) throw new Error(`Intervening Git commit ${commit} does not have a first parent.`);
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
    ancestryBaseCommit: string,
    paths: string[],
    contentBaseline = ancestryBaseCommit,
    knownCurrentHead?: string,
  ): Promise<GitHeadMovement> {
    const currentHead = knownCurrentHead ?? await this.currentHead();
    if (currentHead === ancestryBaseCommit) {
      return {
        changedPaths: contentBaseline === currentHead ? [] : await this.listChangedPaths(contentBaseline, currentHead, paths),
        currentHead,
        kind: "same",
      };
    }
    const commitsOnlyOnBase = (await this.run(["rev-list", "--max-count=1", `${currentHead}..${ancestryBaseCommit}`])).trim();
    if (commitsOnlyOnBase) return { changedPaths: [], currentHead, kind: "incompatible" };
    return {
      changedPaths: await this.listChangedPaths(contentBaseline, currentHead, paths),
      currentHead,
      kind: "fast-forward",
    };
  }

  async buildFileChanges(from: string, to: string, paths: string[]) {
    const changedPaths = await this.listChangedPaths(from, to, paths);
    return await Promise.all(changedPaths.map(async (filePath): Promise<GitCheckpointFileChange> => {
      const pathspec = this.literalPathspec(filePath);
      const inspected = await this.run([
        "diff", "--raw", "--numstat", "--binary", "--no-renames", from, to, "--", pathspec,
      ]);
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
    }));
  }

  async listTreePaths(treeish: string, paths?: string[]) {
    const scopes = paths?.length && !paths.includes(".") ? this.normalizePaths(paths) : [];
    return parseNullPaths(await this.run([
      "ls-tree", "-r", "--name-only", "-z", treeish,
      ...(scopes.length ? ["--", ...scopes.map((scope) => this.literalPathspec(scope))] : []),
    ]));
  }

  async resetMixedPaths(commit: string, paths: string[]) {
    if (!paths.length) return;
    await this.runWithInput([
      "reset", "--mixed", "--quiet", "--pathspec-from-file=-", "--pathspec-file-nul", commit,
    ], pathspecInput(paths));
  }

  async writeIndexTree() {
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

  async restorePaths(source: string, paths: string[]) {
    if (!paths.length) return;
    await this.runWithInput([
      "restore", "--source", source, "--worktree", "--pathspec-from-file=-", "--pathspec-file-nul",
    ], pathspecInput(paths));
  }

  async remotes() {
    return (await this.run(["remote"]))
      .split(/\r?\n/u)
      .map((value) => value.trim())
      .filter(Boolean);
  }

  async fetchRemotes() {
    await this.run(["fetch", "--all", "--prune", "--quiet"]);
  }

  async refContainsCommit(ref: string, commit: string) {
    return await this.succeeds(["merge-base", "--is-ancestor", commit, ref]);
  }

  private async readObject(objectish: string) {
    const normalized = String(objectish ?? "").trim();
    if (!normalized || /[\r\n]/u.test(normalized)) throw new Error("A valid Git object expression is required.");
    const output = await this.runBufferWithInput(["cat-file", "--batch"], `${normalized}\n`);
    const headerEnd = output.indexOf(0x0a);
    if (headerEnd < 0) throw new Error("Git cat-file batch output ended before its object header.");
    const header = output.subarray(0, headerEnd).toString("utf8");
    if (/ missing$/u.test(header)) return null;
    const match = /^([a-f0-9]+) (\S+) (\d+)$/iu.exec(header);
    if (!match) throw new Error(`Git cat-file returned an invalid object header: ${header}`);
    const size = Number(match[3]);
    const contentsStart = headerEnd + 1;
    const contentsEnd = contentsStart + size;
    if (!Number.isSafeInteger(size) || size < 0 || contentsEnd > output.length) {
      throw new Error(`Git object ${match[1]} has an invalid size.`);
    }
    return {
      contents: output.subarray(contentsStart, contentsEnd),
      objectId: match[1]!,
      type: match[2]!,
    };
  }
}
