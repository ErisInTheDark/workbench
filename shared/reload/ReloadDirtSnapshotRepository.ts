/*
 * Exports:
 * - ReloadDirtSnapshotRepositoryPort: narrow Git tree and ref operations required by reload dirt reconciliation. Keywords: reload, Git, snapshot, port.
 * - default ReloadDirtSnapshotRepository: materialize ignored-safe worktree snapshots without touching the real index. Keywords: reload, Git, worktree.
 */
import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const GIT_MAX_BUFFER = 32 * 1024 * 1024;
const WORKBENCH_TRANSCRIPT_EXCLUSION = ":(top,glob,exclude).workbench/transcripts/**";

function parseNullPaths(output: string) {
  return output.split("\0").filter(Boolean);
}

function hasExitCode(error: unknown, code: number) {
  return error
    && typeof error === "object"
    && "code" in error
    && error.code === code;
}

export interface ReloadDirtSnapshotRepositoryPort {
  createCommitFromTree(tree: string, parent: string, message: string): Promise<string>;
  listChangedPaths(from: string, to: string, paths: string[], signal?: AbortSignal): Promise<string[]>;
  listWorktreePaths(signal?: AbortSignal): Promise<string[]>;
  readRef(ref: string): Promise<string | null>;
  updateRef(ref: string, newValue: string, oldValue?: string): Promise<void>;
  writeScopedWorktreeTree(paths: string[], baseTreeish?: string, signal?: AbortSignal): Promise<string>;
  writeWorktreeTree(): Promise<string>;
}

export default class ReloadDirtSnapshotRepository implements ReloadDirtSnapshotRepositoryPort {
  readonly root: string;

  constructor(repoRoot: string) {
    this.root = path.resolve(repoRoot);
  }

  async createCommitFromTree(tree: string, parent: string, message: string) {
    return (await this.runWithInput([
      "commit-tree", tree, "--no-gpg-sign", "-p", parent, "-F", "-",
    ], message)).trim();
  }

  async listChangedPaths(from: string, to: string, paths: string[], signal?: AbortSignal) {
    return parseNullPaths(await this.run([
      "diff", "--name-only", "-z", "--no-renames", from, to, "--",
      ...paths.map((candidate) => this.literalPathspec(candidate)),
    ], process.env, signal)).sort((left, right) => left.localeCompare(right));
  }

  async listWorktreePaths(signal?: AbortSignal) {
    return parseNullPaths(await this.run([
      "ls-files", "-z", "--cached", "--others", "--exclude-standard",
    ], process.env, signal)).sort((left, right) => left.localeCompare(right));
  }

  async readRef(ref: string) {
    try {
      return (await this.run(["rev-parse", "--verify", "--quiet", ref])).trim() || null;
    } catch (error) {
      if (hasExitCode(error, 1)) return null;
      throw error;
    }
  }

  async updateRef(ref: string, newValue: string, oldValue?: string) {
    await this.run(["update-ref", ref, newValue, ...(oldValue !== undefined ? [oldValue] : [])]);
  }

  async writeScopedWorktreeTree(paths: string[], baseTreeish = "HEAD", signal?: AbortSignal) {
    return await this.withTemporaryIndex(async (indexPath) => {
      const env = { ...process.env, GIT_INDEX_FILE: indexPath };
      await this.run(["read-tree", baseTreeish], env, signal);
      const matchedPaths = [...new Set(parseNullPaths(await this.run([
        "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--",
        ...paths.map((candidate) => this.literalPathspec(candidate)),
      ], env, signal)))].sort((left, right) => left.localeCompare(right));
      if (matchedPaths.length) {
        await this.run([
          "add", "-A", "--", ...matchedPaths.map((candidate) => this.literalPathspec(candidate)),
        ], env, signal);
      }
      return (await this.run(["write-tree"], env, signal)).trim();
    });
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

  private literalPathspec(relativePath: string) {
    return `:(top,literal)${relativePath}`;
  }

  private async run(args: string[], env: NodeJS.ProcessEnv = process.env, signal?: AbortSignal) {
    const { stdout } = await execFileAsync("git", args, {
      cwd: this.root,
      encoding: "utf8",
      env,
      maxBuffer: GIT_MAX_BUFFER,
      signal,
      windowsHide: true,
    });
    return stdout;
  }

  private async runWithInput(args: string[], input: string, env: NodeJS.ProcessEnv = process.env) {
    return await new Promise<string>((resolve, reject) => {
      const child = spawn("git", args, {
        cwd: this.root,
        env,
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

  private async succeeds(args: string[]) {
    try {
      await this.run(args);
      return true;
    } catch (error) {
      if (hasExitCode(error, 1)) return false;
      throw error;
    }
  }

  private async withTemporaryIndex<TValue>(operation: (indexPath: string) => Promise<TValue>) {
    const directoryPath = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-reload-index-"));
    try {
      return await operation(path.join(directoryPath, "index"));
    } finally {
      await fs.rm(directoryPath, { force: true, maxRetries: 5, recursive: true, retryDelay: 50 });
    }
  }
}
