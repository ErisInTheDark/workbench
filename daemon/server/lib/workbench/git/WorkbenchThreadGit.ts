/*
 * Exports:
 * - WorkbenchThreadGitSelectionResult: selected paths after add or unstage.
 * - WorkbenchThreadGitCommitResult: committed paths and history rewrite metadata.
 * - default WorkbenchThreadGit: execute Git against database-owned thread selections.
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { isPathWithinRoot, normalizeRelativePath } from "../../project";
import type WorkbenchDatabaseController from "../../../database/WorkbenchDatabaseController";
import WorkbenchTemporaryDirectory from "../WorkbenchTemporaryDirectory";
import WorkbenchGitHistoryRewriter from "./WorkbenchGitHistoryRewriter";
import WorkbenchGitRepository from "./WorkbenchGitRepository";

const execFileAsync = promisify(execFile);
const GIT_MAX_BUFFER = 32 * 1024 * 1024;

interface WorkbenchThreadGitOptions {
  cwd: string;
  selectionStore: Pick<WorkbenchDatabaseController, "executeThreadGitSelection">;
  targetWorktree?: string;
  threadId: string;
}

export interface WorkbenchThreadGitSelectionResult {
  changedPaths: string[];
  selectedPaths: string[];
}

export interface WorkbenchThreadGitCommitResult {
  amendedCommit?: string;
  commit: string;
  committedPaths: string[];
  rewrittenCommitCount?: number;
  selectedPaths: string[];
  warnings?: string[];
}

function splitNullTerminated(value: string) {
  return value.split("\0").filter(Boolean);
}

function toLiteralPathspec(filePath: string) {
  return filePath === "." ? ":(top)" : `:(top,literal)${filePath}`;
}

async function runGit(cwd: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
      env,
      maxBuffer: GIT_MAX_BUFFER,
      windowsHide: true,
    });
    return stdout;
  } catch (error) {
    const stderr = error instanceof Error && "stderr" in error && typeof error.stderr === "string"
      ? error.stderr.trim()
      : "";
    throw new Error(stderr || (error instanceof Error ? error.message : "Git command failed."), { cause: error });
  }
}

async function resolveRepoRoot(cwd: string) {
  const repoRoot = (await runGit(cwd, ["rev-parse", "--show-toplevel"])).trim();
  if (!repoRoot) throw new Error("Unable to find Git repository root.");
  return path.resolve(repoRoot);
}

function pathsEqual(left: string, right: string) {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

async function resolveRegisteredWorktree(controlRepoRoot: string, targetWorktree: string) {
  if (!path.isAbsolute(targetWorktree)) throw new Error("Explicit Git worktree must be an absolute path.");
  const requestedRoot = path.resolve(targetWorktree);
  const registeredRoots = (await runGit(controlRepoRoot, ["worktree", "list", "--porcelain"]))
    .split(/\r?\n/gu)
    .filter((line) => line.startsWith("worktree "))
    .map((line) => path.resolve(line.slice("worktree ".length)));
  const registeredRoot = registeredRoots.find((candidate) => pathsEqual(candidate, requestedRoot));
  if (!registeredRoot) throw new Error("Explicit Git target is not a registered Git worktree of the control repository.");
  return registeredRoot;
}

export default class WorkbenchThreadGit {
  readonly cwd: string;
  readonly repoRoot: string;
  readonly threadId: string;

  private readonly selectionStore: WorkbenchThreadGitOptions["selectionStore"];

  private constructor({
    cwd,
    repoRoot,
    selectionStore,
    threadId,
  }: {
    cwd: string;
    repoRoot: string;
    selectionStore: WorkbenchThreadGitOptions["selectionStore"];
    threadId: string;
  }) {
    this.cwd = cwd;
    this.repoRoot = repoRoot;
    this.threadId = threadId;
    this.selectionStore = selectionStore;
  }

  static async create({ cwd, selectionStore, targetWorktree, threadId }: WorkbenchThreadGitOptions) {
    const normalizedThreadId = threadId.trim();
    if (!normalizedThreadId) throw new Error("A managed Workbench thread id is required.");
    const controlCwd = path.resolve(cwd);
    const controlRepoRoot = await resolveRepoRoot(controlCwd);
    const repoRoot = targetWorktree
      ? await resolveRegisteredWorktree(controlRepoRoot, targetWorktree)
      : controlRepoRoot;
    const resolvedCwd = targetWorktree ? repoRoot : controlCwd;
    return new WorkbenchThreadGit({
      cwd: resolvedCwd,
      repoRoot,
      selectionStore,
      threadId: normalizedThreadId,
    });
  }

  async add(requestedPaths: string[]): Promise<WorkbenchThreadGitSelectionResult> {
    const pathspecs = this.normalizeRequestedPaths(requestedPaths).map(toLiteralPathspec);
    const changedPaths = this.parseChangedPaths(await runGit(this.repoRoot, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--no-renames",
      "--",
      ...pathspecs,
    ]));
    if (!changedPaths.length) {
      throw new Error("No changed files were found under the requested paths.");
    }

    const result = await this.selectionStore.executeThreadGitSelection({
      kind: "add", scope: this.scope, paths: changedPaths,
    });
    if (result.kind !== "selection") throw new Error("Unexpected Git selection result.");
    return { changedPaths: result.changedPaths, selectedPaths: result.selectedPaths };
  }

  async unstage(requestedPaths: string[]): Promise<WorkbenchThreadGitSelectionResult> {
    const result = await this.selectionStore.executeThreadGitSelection({
      kind: "unstage", scope: this.scope, paths: this.normalizeRequestedPaths(requestedPaths),
    });
    if (result.kind !== "selection") throw new Error("Unexpected Git selection result.");
    return { changedPaths: result.changedPaths, selectedPaths: result.selectedPaths };
  }

  async commit(message: string, amendTarget?: string): Promise<WorkbenchThreadGitCommitResult> {
    const normalizedMessage = message.trim();
    if (!normalizedMessage) throw new Error("A commit message is required.");
    const batch = await this.selectionStore.executeThreadGitSelection({ kind: "claim", scope: this.scope });
    if (batch.kind !== "claimed") throw new Error("Unexpected Git selection claim result.");
    const { batchId, selectedPaths } = batch;

    if (amendTarget) {
      try {
        const result = await new WorkbenchGitHistoryRewriter(new WorkbenchGitRepository(this.repoRoot)).amend({
          message: normalizedMessage,
          paths: selectedPaths,
          target: amendTarget,
        });
        await this.settleBatch(batchId, "committed");
        return { ...result, selectedPaths };
      } catch (error) {
        await this.settleBatch(batchId, "failed");
        throw error;
      }
    }

    let temporaryDirectory: WorkbenchTemporaryDirectory | undefined;
    try {
      temporaryDirectory = await WorkbenchTemporaryDirectory.create("workbench-thread-git-");
      const pathspecFilePath = path.join(temporaryDirectory.path, "pathspecs");
      await fs.writeFile(
        pathspecFilePath,
        Buffer.from(`${selectedPaths.map(toLiteralPathspec).join("\0")}\0`, "utf8"),
      );
      const pathspecArguments = [
        `--pathspec-from-file=${pathspecFilePath}`,
        "--pathspec-file-nul",
      ];
      await runGit(this.repoRoot, ["add", "-A", ...pathspecArguments]);
      await runGit(this.repoRoot, [
        "commit",
        "--only",
        "-m",
        normalizedMessage,
        ...pathspecArguments,
      ]);
      const commit = (await runGit(this.repoRoot, ["rev-parse", "--verify", "HEAD"])).trim();
      const committedPaths = splitNullTerminated(await runGit(this.repoRoot, [
        "diff-tree",
        "--root",
        "--no-commit-id",
        "--name-only",
        "-r",
        "-z",
        commit,
      ])).sort();
      await this.settleBatch(batchId, "committed");
      return {
        commit,
        committedPaths,
        selectedPaths,
      };
    } catch (error) {
      await this.settleBatch(batchId, "failed");
      throw error;
    } finally {
      await temporaryDirectory?.dispose();
    }
  }

  private normalizeRequestedPaths(requestedPaths: string[]) {
    if (!requestedPaths.length) throw new Error("At least one repository path is required.");
    return Array.from(new Set(requestedPaths.map((requestedPath) => {
      const trimmedPath = requestedPath.trim();
      if (!trimmedPath) throw new Error("Repository paths cannot be empty.");
      const absolutePath = path.resolve(this.cwd, trimmedPath);
      if (!isPathWithinRoot(absolutePath, this.repoRoot)) {
        throw new Error(`Git path must stay inside the repository: ${requestedPath}`);
      }
      const relativePath = normalizeRelativePath(path.relative(this.repoRoot, absolutePath));
      return relativePath || ".";
    })));
  }

  private parseChangedPaths(status: string) {
    return Array.from(new Set(splitNullTerminated(status).map((entry) => entry.slice(3)).filter(Boolean))).sort();
  }

  private get scope() {
    return { threadId: this.threadId, worktreeRoot: this.repoRoot };
  }

  private async settleBatch(batchId: string, outcome: "committed" | "failed") {
    await this.selectionStore.executeThreadGitSelection({ kind: "settle", scope: this.scope, batchId, outcome });
  }
}
