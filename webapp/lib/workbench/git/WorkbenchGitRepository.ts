/*
 * Exports:
 * - default WorkbenchGitRepository: own raw Git process, snapshot, path, tree, ref, and ancestry mechanics for one repository. Keywords: git, repository, snapshot, ref, transaction.
 * - GitHeadMovement/GitRefUpdate: typed Git ancestry and atomic ref-update inputs. Keywords: git, head, ref, transaction.
 */
import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { GitCheckpointFileChange } from "./checkpoint-contracts";

const execFileAsync = promisify(execFile);
const GIT_MAX_BUFFER = 32 * 1024 * 1024;
const COMMIT_PATTERN = /^[a-f0-9]{7,64}$/iu;
const WORKBENCH_TRANSCRIPT_EXCLUSION = ":(top,glob,exclude).workbench/transcripts/**";

export interface GitHeadMovement {
  changedPaths: string[];
  currentHead: string;
  kind: "fast-forward" | "incompatible" | "same";
}

export interface GitRefUpdate {
  newValue: string;
  oldValue?: string;
  ref: string;
}

function isWithinRoot(candidatePath: string, rootPath: string) {
  const candidate = path.resolve(candidatePath).replace(/\\/g, "/").toLowerCase();
  const root = path.resolve(rootPath).replace(/\\/g, "/").toLowerCase();
  return candidate === root || candidate.startsWith(`${root}/`);
}

function parseNullPaths(output: string) {
  return output.split("\0").filter(Boolean);
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

  private static async runAt(cwd: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
      env,
      maxBuffer: GIT_MAX_BUFFER,
      windowsHide: true,
    });
    return stdout;
  }

  readonly root: string;

  constructor(repoRoot: string) {
    this.root = path.resolve(repoRoot);
  }

  async run(args: string[], env: NodeJS.ProcessEnv = process.env) {
    return await WorkbenchGitRepository.runAt(this.root, args, env);
  }

  async runWithInput(args: string[], input: string) {
    return await new Promise<string>((resolve, reject) => {
      const child = spawn("git", args, {
        cwd: this.root,
        env: process.env,
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
        if (code === 0) resolve(stdout);
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
      if (!isWithinRoot(absolute, this.root)) throw new Error("Checkpoint paths must stay inside the Git repository.");
      const relative = path.relative(this.root, absolute).replace(/\\/g, "/");
      if (!relative || relative.startsWith("../")) {
        throw new Error("Checkpoint paths must identify content inside the Git repository.");
      }
      return relative;
    });
    return [...new Set(normalized)].sort((left, right) => left.localeCompare(right));
  }

  literalPathspec(relativePath: string) {
    return `:(top,literal)${relativePath}`;
  }

  resolvePath(relativePath: string) {
    const absolute = path.resolve(this.root, relativePath);
    if (!isWithinRoot(absolute, this.root)) throw new Error("Git path must stay inside the repository.");
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

  async updateRefs(updates: GitRefUpdate[], deletes: Array<{ oldValue?: string; ref: string }> = []) {
    const lines = ["start"];
    for (const update of updates) {
      lines.push(`update ${update.ref} ${update.newValue}${update.oldValue !== undefined ? ` ${update.oldValue}` : ""}`);
    }
    for (const deletion of deletes) {
      lines.push(`delete ${deletion.ref}${deletion.oldValue !== undefined ? ` ${deletion.oldValue}` : ""}`);
    }
    lines.push("prepare", "commit", "");
    await this.runWithInput(["update-ref", "--stdin"], lines.join("\n"));
  }

  async withTemporaryIndex<T>(callback: (indexPath: string, directory: string) => Promise<T>) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-git-index-"));
    try {
      return await callback(path.join(directory, "index"), directory);
    } finally {
      await fs.rm(directory, { force: true, recursive: true });
    }
  }

  async writeWorktreeTree() {
    return await this.withTemporaryIndex(async (indexPath) => {
      const env = { ...process.env, GIT_INDEX_FILE: indexPath };
      await this.run(["read-tree", "HEAD"], env);
      const transcriptIsIgnored = await this.succeeds([
        "check-ignore", "-q", "--no-index", ".workbench/transcripts",
      ]);
      await this.run([
        "add", "-A", "--", ".", ...(transcriptIsIgnored ? [] : [WORKBENCH_TRANSCRIPT_EXCLUSION]),
      ], env);
      return (await this.run(["write-tree"], env)).trim();
    });
  }

  async writeScopedWorktreeTree(paths: string[], baseTreeish = "HEAD") {
    return await this.withTemporaryIndex(async (indexPath) => {
      const env = { ...process.env, GIT_INDEX_FILE: indexPath };
      await this.run(["read-tree", baseTreeish], env);
      const matchedPaths = [...new Set(parseNullPaths(await this.run([
        "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--",
        ...paths.map((candidate) => this.literalPathspec(candidate)),
      ], env)))].sort((left, right) => left.localeCompare(right));
      if (matchedPaths.length) {
        await this.run(["add", "-A", "--", ...matchedPaths.map((candidate) => this.literalPathspec(candidate))], env);
      }
      return (await this.run(["write-tree"], env)).trim();
    });
  }

  async writeTreeWithPathsFromSource(baseTreeish: string, sourceTreeish: string, paths: string[]) {
    return await this.withTemporaryIndex(async (indexPath, directory) => {
      const env = { ...process.env, GIT_INDEX_FILE: indexPath };
      const patchPath = path.join(directory, "paths.patch");
      await this.run(["read-tree", baseTreeish], env);
      const patch = await this.run([
        "diff", "--binary", "--no-renames", baseTreeish, sourceTreeish, "--",
        ...paths.map((candidate) => this.literalPathspec(candidate)),
      ]);
      if (patch) {
        await fs.writeFile(patchPath, patch, "utf8");
        await this.run(["apply", "--cached", "--binary", "--whitespace=nowarn", patchPath], env);
      }
      return (await this.run(["write-tree"], env)).trim();
    });
  }

  async createCommitFromTree(tree: string, parent: string, message: string) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-git-message-"));
    const messagePath = path.join(directory, "message.txt");
    try {
      await fs.writeFile(messagePath, message, "utf8");
      return (await this.run(["commit-tree", tree, "-p", parent, "-F", messagePath])).trim();
    } finally {
      await fs.rm(directory, { force: true, recursive: true });
    }
  }

  async listChangedPaths(from: string, to: string, paths: string[]) {
    return parseNullPaths(await this.run([
      "diff", "--name-only", "-z", "--no-renames", from, to, "--",
      ...paths.map((candidate) => this.literalPathspec(candidate)),
    ])).sort((left, right) => left.localeCompare(right));
  }

  async classifyHeadMovement(ancestryBaseCommit: string, paths: string[], contentBaseline = ancestryBaseCommit): Promise<GitHeadMovement> {
    const currentHead = await this.currentHead();
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
      const [statusText, numstat, diff] = await Promise.all([
        this.run(["diff", "--name-status", "--no-renames", from, to, "--", pathspec]),
        this.run(["diff", "--numstat", "--no-renames", from, to, "--", pathspec]),
        this.run(["diff", "--binary", "--no-renames", from, to, "--", pathspec]),
      ]);
      const status = statusText.trim().charAt(0);
      const [added = "0", deleted = "0"] = numstat.trim().split("\t");
      return {
        additions: /^\d+$/u.test(added) ? Number(added) : 0,
        deletions: /^\d+$/u.test(deleted) ? Number(deleted) : 0,
        diff,
        kind: status === "A" ? { type: "add" } : status === "D"
          ? { type: "delete" }
          : { move_path: null, type: "update" },
        path: filePath,
      };
    }));
  }

  async listTreePaths(treeish: string, paths?: string[]) {
    return parseNullPaths(await this.run([
      "ls-tree", "-r", "--name-only", "-z", treeish,
      ...(paths?.length ? ["--", ...paths.map((candidate) => this.literalPathspec(candidate))] : []),
    ]));
  }

  async resetMixedPaths(commit: string, paths: string[]) {
    await this.run(["reset", "--mixed", "--quiet", commit, "--", ...paths.map((candidate) => this.literalPathspec(candidate))]);
  }

  async restorePaths(source: string, paths: string[]) {
    if (!paths.length) return;
    await this.run(["restore", "--source", source, "--worktree", "--", ...paths.map((candidate) => this.literalPathspec(candidate))]);
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
}
