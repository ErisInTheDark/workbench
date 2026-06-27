/*
 * Exports:
 * - GitCheckpointPurpose: baseline or diff checkpoint purpose stored in checkpoint commit messages. Keywords: git, checkpoint, purpose.
 * - GitCheckpointCreateResult: created checkpoint commit/ref metadata returned by checkpoint operations. Keywords: git, checkpoint, create.
 * - GitCheckpointDiffResult: checkpoint diff metadata, compact summary, full diff, and artifact id. Keywords: git, checkpoint, diff, artifact.
 * - GitCheckpointFileDiffResult: per-file checkpoint diff metadata and unified diff text. Keywords: git, checkpoint, file diff, pathspec.
 * - createGitCheckpoint: capture the current non-ignored repo worktree in a per-worktree checkpoint ref. Keywords: git, checkpoint, commit-tree.
 * - diffGitCheckpoint: diff the current non-ignored repo worktree against a specific checkpoint. Keywords: git, checkpoint, diff.
 * - diffGitCheckpointFile: diff one repo file in the current non-ignored worktree against a specific checkpoint. Keywords: git, checkpoint, file diff.
 * - readGitCheckpointDiffArtifact: read a stored full checkpoint diff artifact by thread and id. Keywords: git, checkpoint, diff, artifact.
 * - restoreGitCheckpoint: restore a checkpoint commit to the worktree after explicit confirmation. Keywords: git, checkpoint, restore.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { projectRoot } from "./project";

const execFileAsync = promisify(execFile);
const GIT_MAX_BUFFER = 32 * 1024 * 1024;
const CHECKPOINT_COMMIT_PATTERN = /^[a-f0-9]{7,64}$/iu;
const CHECKPOINT_DIFF_ARTIFACT_PATTERN = /^[a-f0-9]{64}$/u;

export type GitCheckpointPurpose = "baseline" | "diff";

export interface GitCheckpointCreateResult {
  checkpointCommit: string;
  checkpointRef: string;
  repoRoot: string;
}

export interface GitCheckpointDiffResult {
  checkpointCommit: string;
  checkpointRef: string;
  diff: string;
  diffArtifactId: string;
  repoRoot: string;
  summary: string;
}

export interface GitCheckpointFileDiffResult {
  checkpointCommit: string;
  checkpointRef: string;
  diff: string;
  filePath: string;
  repoRoot: string;
}

interface GitCheckpointOperationInput {
  cwd: string;
  threadId: string;
}

interface GitCheckpointCreateInput extends GitCheckpointOperationInput {
  purpose: GitCheckpointPurpose;
}

interface GitCheckpointDiffInput extends GitCheckpointOperationInput {
  checkpointCommit: string;
}

interface GitCheckpointRestoreInput extends GitCheckpointOperationInput {
  checkpointCommit: string;
  confirmRestore: boolean;
}

interface GitCheckpointFileDiffInput extends GitCheckpointDiffInput {
  filePath: string;
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

function normalizeCheckpointCommit(checkpointCommit: string) {
  const normalizedCheckpointCommit = String(checkpointCommit ?? "").trim();
  if (!CHECKPOINT_COMMIT_PATTERN.test(normalizedCheckpointCommit)) {
    throw new Error("Invalid checkpoint commit.");
  }

  return normalizedCheckpointCommit;
}

function getCheckpointDiffArtifactDirectory(threadId: string) {
  return path.join(projectRoot, ".workbench", "git-checkpoint-diffs", "threads", normalizeCheckpointThreadId(threadId));
}

function getCheckpointDiffArtifactPath(threadId: string, diffArtifactId: string) {
  if (!CHECKPOINT_DIFF_ARTIFACT_PATTERN.test(diffArtifactId)) {
    throw new Error("Invalid checkpoint diff artifact id.");
  }

  return path.join(getCheckpointDiffArtifactDirectory(threadId), `${diffArtifactId}.diff`);
}

function normalizeGitCheckpointFilePath(repoRoot: string, filePath: string) {
  const trimmedFilePath = String(filePath ?? "").trim();
  if (!trimmedFilePath) {
    throw new Error("A checkpoint file diff path is required.");
  }

  const absolutePath = path.isAbsolute(trimmedFilePath)
    ? path.resolve(trimmedFilePath)
    : path.resolve(repoRoot, trimmedFilePath);
  if (!isPathWithinRoot(absolutePath, repoRoot)) {
    throw new Error("Checkpoint file diff path must stay inside the Git repository.");
  }

  const relativePath = path.relative(repoRoot, absolutePath).replace(/\\/g, "/");
  if (!relativePath || relativePath.startsWith("../")) {
    throw new Error("Checkpoint file diff path must identify a file inside the Git repository.");
  }

  return relativePath;
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

async function readCheckpointCommit(repoRoot: string, threadId: string, checkpointCommit: string) {
  const normalizedCheckpointCommit = normalizeCheckpointCommit(checkpointCommit);
  const checkpointNamespace = getCheckpointNamespace(threadId);
  const resolvedCheckpointCommit = (await runGit(repoRoot, [
    "rev-parse",
    "--verify",
    `${normalizedCheckpointCommit}^{commit}`,
  ])).trim();
  const checkpointRef = (await runGit(repoRoot, [
    "for-each-ref",
    "--format=%(refname)",
    "--points-at",
    resolvedCheckpointCommit,
    "--count=1",
    checkpointNamespace,
  ])).trim();

  if (!checkpointRef) {
    throw new Error("Checkpoint commit is not in this thread/worktree checkpoint timeline.");
  }

  return {
    checkpointCommit: resolvedCheckpointCommit,
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

async function writeGitCheckpointDiffArtifact(threadId: string, diff: string) {
  const diffArtifactId = createHash("sha256")
    .update(diff)
    .digest("hex");
  const artifactDirectory = getCheckpointDiffArtifactDirectory(threadId);
  await fs.mkdir(artifactDirectory, { recursive: true });
  await fs.writeFile(getCheckpointDiffArtifactPath(threadId, diffArtifactId), diff, "utf8");
  return diffArtifactId;
}

function formatCheckpointDiffSummary({
  diffArtifactId,
  nameStatus,
  stat,
}: {
  diffArtifactId: string;
  nameStatus: string;
  stat: string;
}) {
  const changedFiles = nameStatus.trim();
  const statText = stat.trim();
  const lines = [
    "Workbench checkpoint diff summary",
    `Full diff artifact: ${diffArtifactId}`,
    "",
    "Changed files:",
    ...(changedFiles ? changedFiles.split(/\r?\n/) : ["(none)"]),
  ];

  if (statText) {
    lines.push("", "Stat:", ...statText.split(/\r?\n/));
  }

  return `${lines.join("\n")}\n`;
}

export async function diffGitCheckpoint({
  checkpointCommit: rawCheckpointCommit,
  cwd,
  threadId,
}: GitCheckpointDiffInput): Promise<GitCheckpointDiffResult> {
  const repoRoot = await resolveRepoRoot(cwd);
  const { checkpointCommit, checkpointRef } = await readCheckpointCommit(repoRoot, threadId, rawCheckpointCommit);
  const currentTree = await writeCurrentWorktreeTree(repoRoot);
  const diff = await runGit(repoRoot, ["diff", "--find-renames", "--binary", checkpointCommit, currentTree]);
  const [nameStatus, stat] = await Promise.all([
    runGit(repoRoot, ["diff", "--find-renames", "--name-status", checkpointCommit, currentTree]),
    runGit(repoRoot, ["diff", "--find-renames", "--stat", checkpointCommit, currentTree]),
  ]);
  const diffArtifactId = await writeGitCheckpointDiffArtifact(threadId, diff);

  return {
    checkpointCommit,
    checkpointRef,
    diff,
    diffArtifactId,
    repoRoot,
    summary: formatCheckpointDiffSummary({
      diffArtifactId,
      nameStatus,
      stat,
    }),
  };
}

export async function diffGitCheckpointFile({
  checkpointCommit: rawCheckpointCommit,
  cwd,
  filePath,
  threadId,
}: GitCheckpointFileDiffInput): Promise<GitCheckpointFileDiffResult> {
  const repoRoot = await resolveRepoRoot(cwd);
  const normalizedFilePath = normalizeGitCheckpointFilePath(repoRoot, filePath);
  const { checkpointCommit, checkpointRef } = await readCheckpointCommit(repoRoot, threadId, rawCheckpointCommit);
  const currentTree = await writeCurrentWorktreeTree(repoRoot);
  const diff = await runGit(repoRoot, [
    "diff",
    "--find-renames",
    "--binary",
    checkpointCommit,
    currentTree,
    "--",
    normalizedFilePath,
  ]);

  return {
    checkpointCommit,
    checkpointRef,
    diff,
    filePath: normalizedFilePath,
    repoRoot,
  };
}

export async function readGitCheckpointDiffArtifact({
  diffArtifactId,
  threadId,
}: {
  diffArtifactId: string;
  threadId: string;
}) {
  try {
    return await fs.readFile(getCheckpointDiffArtifactPath(threadId, diffArtifactId), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      throw new Error("Checkpoint diff artifact not found.");
    }

    throw error;
  }
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
  const {
    checkpointCommit: resolvedCheckpointCommit,
    checkpointRef,
  } = await readCheckpointCommit(repoRoot, threadId, checkpointCommit);

  const checkpointParent = (await runGit(repoRoot, ["rev-parse", `${resolvedCheckpointCommit}^`])).trim();
  const currentHead = (await runGit(repoRoot, ["rev-parse", "HEAD"])).trim();
  if (checkpointParent !== currentHead) {
    throw new Error("Checkpoint parent differs from current HEAD. Ask the user before overriding.");
  }

  const currentTree = await writeCurrentWorktreeTree(repoRoot);
  const addedPaths = (await runGit(repoRoot, ["diff", "--name-only", "--diff-filter=A", resolvedCheckpointCommit, currentTree]))
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

  await runGit(repoRoot, ["restore", "--source", resolvedCheckpointCommit, "--worktree", "--", "."]);
  return {
    checkpointCommit: resolvedCheckpointCommit,
    checkpointRef,
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
