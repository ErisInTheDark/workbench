/*
 * Exports:
 * - WorkbenchThreadGitSelectionResult: selected-path result returned after add or unstage operations. Keywords: git, thread, selection, paths.
 * - WorkbenchThreadGitCommitResult: commit metadata returned after a thread-owned Git commit. Keywords: git, thread, commit, sha.
 * - default WorkbenchThreadGit: own a thread-scoped path selection and commit it through bounded host-side Git commands. Keywords: git, thread, selection, commit, index.
 */
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, type Dirent } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { isPathWithinRoot, normalizeRelativePath } from "../../project";
import { workbenchLibraryRoot } from "../../workbench-library-paths";
import WorkbenchGitHistoryRewriter from "./WorkbenchGitHistoryRewriter";
import WorkbenchGitRepository from "./WorkbenchGitRepository";

const execFileAsync = promisify(execFile);
const GIT_MAX_BUFFER = 32 * 1024 * 1024;
const STALE_TRANSACTION_AGE_MS = 5 * 60 * 1000;

interface WorkbenchThreadGitOptions {
  cwd: string;
  storageRootPath?: string;
  targetWorktree?: string;
  threadId: string;
}

interface SelectedPathMarker {
  path: string;
  version: 1;
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

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function normalizeThreadStorageId(threadId: string) {
  const normalized = threadId
    .trim()
    .replace(/[^A-Za-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    || "thread";
  const identityHash = createHash("sha256").update(threadId).digest("hex").slice(0, 12);
  return `${normalized.slice(0, 80)}-${identityHash}`;
}

function splitNullTerminated(value: string) {
  return value.split("\0").filter(Boolean);
}

function toLiteralPathspec(filePath: string) {
  return filePath === "." ? ":(top)" : `:(top,literal)${filePath}`;
}

function markerFileName(filePath: string) {
  return `${createHash("sha256").update(filePath).digest("hex")}.json`;
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

  private readonly selectedDirectoryPath: string;
  private readonly transactionsDirectoryPath: string;

  private constructor({
    cwd,
    repoRoot,
    selectionRootPath,
    threadId,
  }: {
    cwd: string;
    repoRoot: string;
    selectionRootPath: string;
    threadId: string;
  }) {
    this.cwd = cwd;
    this.repoRoot = repoRoot;
    this.threadId = threadId;
    this.selectedDirectoryPath = path.join(selectionRootPath, "selected");
    this.transactionsDirectoryPath = path.join(selectionRootPath, "transactions");
  }

  static async create({ cwd, storageRootPath = workbenchLibraryRoot, targetWorktree, threadId }: WorkbenchThreadGitOptions) {
    const normalizedThreadId = threadId.trim();
    if (!normalizedThreadId) throw new Error("A managed Workbench thread id is required.");
    const controlCwd = path.resolve(cwd);
    const controlRepoRoot = await resolveRepoRoot(controlCwd);
    const repoRoot = targetWorktree
      ? await resolveRegisteredWorktree(controlRepoRoot, targetWorktree)
      : controlRepoRoot;
    const resolvedCwd = targetWorktree ? repoRoot : controlCwd;
    const worktreeHash = createHash("sha256").update(repoRoot).digest("hex");
    return new WorkbenchThreadGit({
      cwd: resolvedCwd,
      repoRoot,
      selectionRootPath: path.join(
        storageRootPath,
        ".state",
        "thread-git",
        "worktrees",
        worktreeHash,
        "threads",
        normalizeThreadStorageId(normalizedThreadId),
      ),
      threadId: normalizedThreadId,
    });
  }

  async add(requestedPaths: string[]): Promise<WorkbenchThreadGitSelectionResult> {
    await this.recoverStaleTransactions();
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

    await fs.mkdir(this.selectedDirectoryPath, { recursive: true });
    await Promise.all(changedPaths.map(async (filePath) => {
      const markerPath = path.join(this.selectedDirectoryPath, markerFileName(filePath));
      const marker = JSON.stringify({ path: filePath, version: 1 } satisfies SelectedPathMarker);
      try {
        await fs.writeFile(markerPath, marker, { encoding: "utf8", flag: "wx" });
      } catch (error) {
        if (!isNodeError(error, "EEXIST")) throw error;
      }
    }));

    return {
      changedPaths,
      selectedPaths: await this.readSelectedPaths(this.selectedDirectoryPath),
    };
  }

  async unstage(requestedPaths: string[]): Promise<WorkbenchThreadGitSelectionResult> {
    await this.recoverStaleTransactions();
    const normalizedRequests = this.normalizeRequestedPaths(requestedPaths);
    const selectedMarkers = await this.readSelectedMarkers(this.selectedDirectoryPath);
    const removedMarkers = selectedMarkers.filter(({ marker }) => normalizedRequests.some((requestedPath) => (
      requestedPath === "."
      || this.pathsEqual(marker.path, requestedPath)
      || this.pathStartsWith(marker.path, requestedPath)
    )));
    await Promise.all(removedMarkers.map(({ markerPath }) => fs.rm(markerPath, { force: true })));
    await this.removeDirectoryIfEmpty(this.selectedDirectoryPath);
    return {
      changedPaths: removedMarkers.map(({ marker }) => marker.path).sort(),
      selectedPaths: await this.readSelectedPaths(this.selectedDirectoryPath),
    };
  }

  async commit(message: string, amendTarget?: string): Promise<WorkbenchThreadGitCommitResult> {
    const normalizedMessage = message.trim();
    if (!normalizedMessage) throw new Error("A commit message is required.");
    await this.recoverStaleTransactions();
    const claimedDirectoryPath = await this.claimSelection();
    const selectedPaths = await this.readSelectedPaths(claimedDirectoryPath);
    if (!selectedPaths.length) {
      await fs.rm(claimedDirectoryPath, { force: true, recursive: true });
      throw new Error("This thread has no selected files to commit.");
    }

    if (amendTarget) {
      try {
        const result = await new WorkbenchGitHistoryRewriter(new WorkbenchGitRepository(this.repoRoot)).amend({
          message: normalizedMessage,
          paths: selectedPaths,
          target: amendTarget,
        });
        await fs.rm(claimedDirectoryPath, { force: true, recursive: true });
        return { ...result, selectedPaths };
      } catch (error) {
        await this.restoreClaimedSelection(claimedDirectoryPath);
        throw error;
      }
    }

    const temporaryDirectoryPath = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-thread-git-"));
    const pathspecFilePath = path.join(temporaryDirectoryPath, "pathspecs");
    try {
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
      await fs.rm(claimedDirectoryPath, { force: true, recursive: true });
      return {
        commit,
        committedPaths,
        selectedPaths,
      };
    } catch (error) {
      await this.restoreClaimedSelection(claimedDirectoryPath);
      throw error;
    } finally {
      await fs.rm(temporaryDirectoryPath, { force: true, recursive: true });
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

  private async claimSelection() {
    await fs.mkdir(this.transactionsDirectoryPath, { recursive: true });
    const claimedDirectoryPath = path.join(this.transactionsDirectoryPath, `commit-${Date.now()}-${randomUUID()}`);
    try {
      await fs.rename(this.selectedDirectoryPath, claimedDirectoryPath);
      return claimedDirectoryPath;
    } catch (error) {
      if (isNodeError(error, "ENOENT")) throw new Error("This thread has no selected files to commit.");
      throw error;
    }
  }

  private async restoreClaimedSelection(claimedDirectoryPath: string) {
    const markers = await this.readSelectedMarkers(claimedDirectoryPath);
    await fs.mkdir(this.selectedDirectoryPath, { recursive: true });
    await Promise.all(markers.map(async ({ marker, markerPath }) => {
      const destinationPath = path.join(this.selectedDirectoryPath, path.basename(markerPath));
      try {
        await fs.copyFile(markerPath, destinationPath, constants.COPYFILE_EXCL);
      } catch (error) {
        if (!isNodeError(error, "EEXIST")) throw error;
      }
    }));
    await fs.rm(claimedDirectoryPath, { force: true, recursive: true });
  }

  private async recoverStaleTransactions() {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(this.transactionsDirectoryPath, { withFileTypes: true });
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return;
      throw error;
    }
    const now = Date.now();
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const transactionPath = path.join(this.transactionsDirectoryPath, entry.name);
      const stats = await fs.stat(transactionPath);
      if (now - stats.mtimeMs >= STALE_TRANSACTION_AGE_MS) {
        await this.restoreClaimedSelection(transactionPath);
      }
    }
  }

  private async readSelectedPaths(directoryPath: string) {
    return (await this.readSelectedMarkers(directoryPath)).map(({ marker }) => marker.path).sort();
  }

  private async readSelectedMarkers(directoryPath: string) {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(directoryPath, { withFileTypes: true });
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return [];
      throw error;
    }
    const markers = await Promise.all(entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json")).map(async (entry) => {
      const markerPath = path.join(directoryPath, entry.name);
      const parsed = JSON.parse(await fs.readFile(markerPath, "utf8")) as Partial<SelectedPathMarker>;
      if (parsed.version !== 1 || typeof parsed.path !== "string" || !parsed.path) {
        throw new Error("Thread Git selection state is invalid.");
      }
      return { marker: parsed as SelectedPathMarker, markerPath };
    }));
    return markers;
  }

  private async removeDirectoryIfEmpty(directoryPath: string) {
    try {
      if (!(await fs.readdir(directoryPath)).length) await fs.rmdir(directoryPath);
    } catch (error) {
      if (!isNodeError(error, "ENOENT") && !isNodeError(error, "ENOTEMPTY")) throw error;
    }
  }

  private pathsEqual(left: string, right: string) {
    return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
  }

  private pathStartsWith(filePath: string, directoryPath: string) {
    const normalizedFilePath = process.platform === "win32" ? filePath.toLowerCase() : filePath;
    const normalizedDirectoryPath = process.platform === "win32" ? directoryPath.toLowerCase() : directoryPath;
    return normalizedFilePath.startsWith(`${normalizedDirectoryPath}/`);
  }
}
