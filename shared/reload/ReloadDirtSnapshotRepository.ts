/*
 * Exports:
 * - ReloadDirtSnapshotRepositoryPort: Git tree and ref operations for reload dirt reconciliation.
 * - default ReloadDirtSnapshotRepository: compare selected sources and store baselines without touching the real index.
 */
import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import WorkbenchTemporaryDirectory from "../WorkbenchTemporaryDirectory";

const execFileAsync = promisify(execFile);
const GIT_MAX_BUFFER = 32 * 1024 * 1024;
// Leave space for Git's executable, fixed arguments and Windows argument quoting.
const PATH_ARGUMENT_BUDGET = 8_000;
// Reload snapshots are Workbench-internal objects, so their commits must not depend on
// the user having configured a Git identity. Values match the daemon's actor fallback.
const SNAPSHOT_COMMIT_IDENTITY = {
  GIT_AUTHOR_NAME: "workbench",
  GIT_AUTHOR_EMAIL: "workbench@localhost",
  GIT_COMMITTER_NAME: "workbench",
  GIT_COMMITTER_EMAIL: "workbench@localhost",
} as const;

function parseNullPaths(output: string) {
  return output.split("\0").filter(Boolean);
}

function hasExitCode(error: unknown, code: number) {
  return error
    && typeof error === "object"
    && "code" in error
    && error.code === code;
}

function isSilentGitReadFailure(error: unknown) {
  return Boolean(
    error
    && typeof error === "object"
    && "code" in error
    && typeof error.code === "number"
    && "stderr" in error
    && typeof error.stderr === "string"
    && !error.stderr.trim()
    && (!("signal" in error) || error.signal === null),
  );
}

function pathBatches(paths: readonly string[]) {
  const batches: string[][] = [];
  let batch: string[] = [];
  let length = 0;
  for (const sourcePath of new Set(paths)) {
    const argumentLength = sourcePath.length * 2 + 3;
    if (argumentLength > PATH_ARGUMENT_BUDGET) throw new Error("Reload source path exceeds the Git argument budget.");
    if (length + argumentLength > PATH_ARGUMENT_BUDGET) {
      batches.push(batch);
      batch = [];
      length = 0;
    }
    batch.push(sourcePath);
    length += argumentLength;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

export interface ReloadDirtSnapshotRepositoryPort {
  createCommitFromTree(tree: string, parent: string, message: string): Promise<string>;
  listWorktreeChangedPaths(baseTreeish: string, paths: string[], signal?: AbortSignal): Promise<string[]>;
  listWorktreePaths(signal?: AbortSignal): Promise<string[]>;
  /** A text file at a commit, or in the worktree when `treeish` is null; null when absent. */
  readFile(treeish: string | null, sourcePath: string, signal?: AbortSignal): Promise<string | null>;
  readRef(ref: string): Promise<string | null>;
  updateRef(ref: string, newValue: string, oldValue?: string): Promise<void>;
  writeWorktreeTree(): Promise<string>;
}

export default class ReloadDirtSnapshotRepository implements ReloadDirtSnapshotRepositoryPort {
  readonly root: string;

  constructor(
    repoRoot: string,
    private readonly gitExecutable = "git",
    private readonly gitArgumentPrefix: readonly string[] = [],
  ) {
    this.root = path.resolve(repoRoot);
  }

  async createCommitFromTree(tree: string, parent: string, message: string) {
    return (await this.runWithInput([
      "commit-tree", tree, "--no-gpg-sign", "-p", parent, "-F", "-",
    ], message, { ...process.env, ...SNAPSHOT_COMMIT_IDENTITY })).trim();
  }

  async listWorktreeChangedPaths(baseTreeish: string, paths: string[], signal?: AbortSignal) {
    const batches = pathBatches(paths);
    if (!batches.length) return [];
    return await this.withTemporaryIndex(async (indexPath) => {
      const env = { ...process.env, GIT_INDEX_FILE: indexPath, GIT_OPTIONAL_LOCKS: "0" };
      await this.run(["read-tree", baseTreeish], env, signal);
      const changed = new Set<string>();
      for (const batch of batches) {
        const [tracked, untracked] = await Promise.all([
          this.runRead(["--literal-pathspecs", "diff", "--name-only", "-z", "--no-renames", "--", ...batch], env, signal),
          this.runRead(["--literal-pathspecs", "ls-files", "-z", "--others", "--exclude-standard", "--", ...batch], env, signal),
        ]);
        for (const sourcePath of [...parseNullPaths(tracked), ...parseNullPaths(untracked)]) changed.add(sourcePath);
      }
      return [...changed].sort((left, right) => left.localeCompare(right));
    });
  }

  async listWorktreePaths(signal?: AbortSignal) {
    return parseNullPaths(await this.runRead([
      "ls-files", "-z", "--cached", "--others", "--exclude-standard",
    ], process.env, signal)).sort((left, right) => left.localeCompare(right));
  }

  async readFile(treeish: string | null, sourcePath: string, signal?: AbortSignal) {
    if (treeish === null) {
      try { return await fs.readFile(path.join(this.root, sourcePath), { encoding: "utf8", signal }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    }
    try {
      return await this.run(["show", `${treeish}:${sourcePath}`], process.env, signal);
    } catch (error) {
      signal?.throwIfAborted();
      if (hasExitCode(error, 128)) return null;
      throw error;
    }
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

  async writeWorktreeTree() {
    return await this.withTemporaryIndex(async (indexPath) => {
      const env = { ...process.env, GIT_INDEX_FILE: indexPath };
      await this.run(["read-tree", "HEAD"], env);
      await this.run(["add", "-A", "--", "."], env);
      return (await this.run(["write-tree"], env)).trim();
    });
  }

  private async run(args: string[], env: NodeJS.ProcessEnv = process.env, signal?: AbortSignal) {
    const { stdout } = await execFileAsync(this.gitExecutable, [...this.gitArgumentPrefix, ...args], {
      cwd: this.root,
      encoding: "utf8",
      env,
      maxBuffer: GIT_MAX_BUFFER,
      signal,
      windowsHide: true,
    });
    return stdout;
  }

  private async runRead(args: string[], env: NodeJS.ProcessEnv, signal?: AbortSignal) {
    try {
      return await this.run(args, env, signal);
    } catch (error) {
      signal?.throwIfAborted();
      if (!isSilentGitReadFailure(error)) throw error;
      return await this.run(args, env, signal);
    }
  }

  private async runWithInput(
    args: string[],
    input: string,
    env: NodeJS.ProcessEnv = process.env,
    signal?: AbortSignal,
  ) {
    return await new Promise<string>((resolve, reject) => {
      const child = spawn(this.gitExecutable, [...this.gitArgumentPrefix, ...args], {
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
      child.stdin.once("error", reject);
      child.once("close", (code) => {
        if (code === 0) resolve(stdout);
        else reject(new Error(stderr.trim() || `git ${args[0] ?? "command"} failed with exit code ${code}.`));
      });
      child.stdin.end(input);
    });
  }

  private async withTemporaryIndex<TValue>(operation: (indexPath: string) => Promise<TValue>) {
    const temporary = await WorkbenchTemporaryDirectory.create("workbench-reload-index-");
    try {
      return await operation(path.join(temporary.path, "index"));
    } finally {
      await temporary.dispose();
    }
  }
}
