/*
 * Exports:
 * - GitCheckpointPurpose: baseline or diff checkpoint purpose stored in checkpoint commit messages. Keywords: git, checkpoint, purpose.
 * - GitCheckpointCreateResult: created checkpoint commit/ref metadata returned by checkpoint operations. Keywords: git, checkpoint, create.
 * - createGitCheckpoint: capture the current non-ignored repo worktree in a per-worktree checkpoint ref. Keywords: git, checkpoint, commit-tree.
 * - diffLatestGitCheckpoint: diff the current non-ignored repo worktree against the newest checkpoint. Keywords: git, checkpoint, diff.
 * - restoreGitCheckpoint: restore a checkpoint commit to the worktree after explicit confirmation. Keywords: git, checkpoint, restore.
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const GIT_MAX_BUFFER = 32 * 1024 * 1024;

export type GitCheckpointPurpose = "baseline" | "diff";

export interface GitCheckpointCreateResult {
  checkpointCommit: string;
  checkpointRef: string;
  repoRoot: string;
}

interface GitCheckpointOperationInput {
  cwd: string;
  threadId: string;
}

interface GitCheckpointCreateInput extends GitCheckpointOperationInput {
  purpose: GitCheckpointPurpose;
}

interface GitCheckpointRestoreInput extends GitCheckpointOperationInput {
  checkpointCommit: string;
  confirmRestore: boolean;
}

async function runGit(cwd: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    env,
    maxBuffer: GIT_MAX_BUFFER,
    windowsHide: true,
  });
  return stdout;
}

async function resolveRepoRoot(cwd: string) {
  const repoRoot = (await runGit(cwd, ["rev-parse", "--show-toplevel"])).trim();
  if (!repoRoot) {
    throw new Error("Unable to find Git repository root.");
  }

  return path.resolve(repoRoot);
}

function normalizeCheckpointThreadId(threadId: string) {
  const normalizedThreadId = String(threadId ?? "")
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!normalizedThreadId) {
    throw new Error("A checkpoint thread id is required.");
  }

  return normalizedThreadId;
}

function getCheckpointNamespace(threadId: string) {
  return `refs/worktree/agents/${normalizeCheckpointThreadId(threadId)}/checkpoints`;
}

async function writeCurrentWorktreeTree(repoRoot: string) {
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-agent-index-"));
  const indexPath = path.join(tempDirectory, "index");
  const env = {
    ...process.env,
    GIT_INDEX_FILE: indexPath,
  };

  try {
    await runGit(repoRoot, ["read-tree", "HEAD"], env);
    await runGit(repoRoot, ["add", "-A", "--", "."], env);
    return (await runGit(repoRoot, ["write-tree"], env)).trim();
  } finally {
    await fs.rm(tempDirectory, { force: true, recursive: true });
  }
}

async function findNewestCheckpointRef(repoRoot: string, threadId: string) {
  const checkpointNamespace = getCheckpointNamespace(threadId);
  const checkpointRef = (await runGit(repoRoot, [
    "for-each-ref",
    "--sort=-refname",
    "--format=%(refname)",
    "--count=1",
    checkpointNamespace,
  ])).trim();

  return checkpointRef || null;
}

async function readNewestCheckpointCommit(repoRoot: string, threadId: string) {
  const checkpointRef = await findNewestCheckpointRef(repoRoot, threadId);
  if (!checkpointRef) {
    throw new Error("No git checkpoint exists for this thread/worktree.");
  }

  return {
    checkpointCommit: (await runGit(repoRoot, ["rev-parse", checkpointRef])).trim(),
    checkpointRef,
  };
}

export async function createGitCheckpoint({
  cwd,
  purpose,
  threadId,
}: GitCheckpointCreateInput): Promise<GitCheckpointCreateResult> {
  const repoRoot = await resolveRepoRoot(cwd);
  const tree = await writeCurrentWorktreeTree(repoRoot);
  const checkpointNamespace = getCheckpointNamespace(threadId);
  const timestamp = new Date().toISOString().replace(/[-:.]/g, "");
  const checkpointCommit = (await runGit(repoRoot, [
    "commit-tree",
    tree,
    "-p",
    "HEAD",
    "-m",
    `agent checkpoint: ${purpose}`,
  ])).trim();
  const shortCommit = (await runGit(repoRoot, ["rev-parse", "--short", checkpointCommit])).trim();
  const checkpointRef = `${checkpointNamespace}/${timestamp}-${shortCommit}`;
  await runGit(repoRoot, ["update-ref", checkpointRef, checkpointCommit]);

  return {
    checkpointCommit,
    checkpointRef,
    repoRoot,
  };
}

export async function diffLatestGitCheckpoint({
  cwd,
  threadId,
}: GitCheckpointOperationInput) {
  const repoRoot = await resolveRepoRoot(cwd);
  const { checkpointCommit, checkpointRef } = await readNewestCheckpointCommit(repoRoot, threadId);
  const currentTree = await writeCurrentWorktreeTree(repoRoot);
  const diff = await runGit(repoRoot, ["diff", "--find-renames", "--binary", checkpointCommit, currentTree]);

  return {
    checkpointCommit,
    checkpointRef,
    diff,
    repoRoot,
  };
}

export async function restoreGitCheckpoint({
  checkpointCommit,
  confirmRestore,
  cwd,
  threadId,
}: GitCheckpointRestoreInput) {
  if (!confirmRestore) {
    throw new Error("Checkpoint restore requires confirmRestore=true.");
  }

  const repoRoot = await resolveRepoRoot(cwd);
  const checkpointNamespace = getCheckpointNamespace(threadId);
  const matchingRef = (await runGit(repoRoot, [
    "for-each-ref",
    "--format=%(refname)",
    "--points-at",
    checkpointCommit,
    "--count=1",
    checkpointNamespace,
  ])).trim();
  if (!matchingRef) {
    throw new Error("Checkpoint commit is not in this thread/worktree checkpoint timeline.");
  }

  const checkpointParent = (await runGit(repoRoot, ["rev-parse", `${checkpointCommit}^`])).trim();
  const currentHead = (await runGit(repoRoot, ["rev-parse", "HEAD"])).trim();
  if (checkpointParent !== currentHead) {
    throw new Error("Checkpoint parent differs from current HEAD. Ask the user before overriding.");
  }

  const currentTree = await writeCurrentWorktreeTree(repoRoot);
  const addedPaths = (await runGit(repoRoot, ["diff", "--name-only", "--diff-filter=A", checkpointCommit, currentTree]))
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  for (const relativePath of addedPaths) {
    const absolutePath = path.resolve(repoRoot, relativePath);
    if (!isPathWithinRoot(absolutePath, repoRoot)) {
      continue;
    }

    await fs.rm(absolutePath, { force: true, recursive: true });
  }

  await runGit(repoRoot, ["restore", "--source", checkpointCommit, "--worktree", "--", "."]);
  return {
    checkpointCommit,
    checkpointRef: matchingRef,
    repoRoot,
    restored: true,
  };
}

function isPathWithinRoot(candidatePath: string, rootPath: string) {
  const normalizedCandidatePath = path.resolve(candidatePath).replace(/\\/g, "/").toLowerCase();
  const normalizedRootPath = path.resolve(rootPath).replace(/\\/g, "/").toLowerCase();
  return normalizedCandidatePath === normalizedRootPath
    || normalizedCandidatePath.startsWith(`${normalizedRootPath}/`);
}
