/*
 * Exports:
 * - default WorkbenchGitCheckpointController: own scoped checkpoint creation, comparison, proposals, and Git commit transitions. Keywords: git, checkpoint, scope, proposal, commit.
 * - GitCheckpointDirtyPathsError: identify implementation paths that must be clean before checkpoint creation. Keywords: git, checkpoint, dirty paths.
 * - GitCheckpointCreateResult/GitCheckpointCompareResult/GitCheckpointDiffResult/GitCheckpointProposalReceipt: typed controller operation results. Keywords: git, checkpoint, proposal, result.
 */
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { projectRoot } from "../../project";
import type {
  GitCheckpointFileChange,
  GitCheckpointProposal,
} from "./checkpoint-contracts";

const execFileAsync = promisify(execFile);
const GIT_MAX_BUFFER = 32 * 1024 * 1024;
const CHECKPOINT_COMMIT_PATTERN = /^[a-f0-9]{7,64}$/iu;
const CHECKPOINT_METADATA_MARKER = "workbench-git-checkpoint-v1";
const PROPOSAL_METADATA_MARKER = "workbench-git-checkpoint-proposal-v1";
const CHECKPOINT_DIFF_ARTIFACT_PATTERN = /^[a-f0-9]{64}$/u;

type CheckpointKind = "implement" | "plan";
type ProposalStatus = "committed" | "proposed" | "unavailable";

interface CheckpointMetadata {
  amendedFrom: string | null;
  kind: CheckpointKind;
  scopePaths: string[];
  version: 1;
}

interface ProposalMetadata {
  baseCommit: string;
  committedSha: string | null;
  description: string;
  paths: string[];
  proposalId: string;
  sourceCheckpoint: string;
  status: ProposalStatus;
  title: string;
  unavailableReason: string | null;
  version: 1;
}

interface ControllerInput {
  cwd: string;
  threadId: string;
}

interface CheckpointInput extends ControllerInput {
  checkpointCommit: string;
}

interface ScopedCheckpointInput extends CheckpointInput {
  paths: string[];
}

export interface GitCheckpointCreateResult {
  checkpointCommit: string;
  checkpointRef: string;
  kind: CheckpointKind;
  repoRoot: string;
  scopePaths: string[];
}

export interface GitCheckpointCompareResult {
  changes: GitCheckpointFileChange[];
  checkpointCommit: string;
  checkpointRef: string;
  repoRoot: string;
}

export interface GitCheckpointDiffResult extends GitCheckpointCompareResult {
  diff: string;
}

export interface GitCheckpointProposalReceipt {
  baseCommit: string;
  description: string;
  paths: string[];
  proposalId: string;
  title: string;
}

interface ReadCheckpointResult {
  checkpointCommit: string;
  checkpointRef: string;
  metadata: CheckpointMetadata | null;
}

interface ReadProposalResult {
  metadata: ProposalMetadata;
  proposalCommit: string;
  proposalRef: string;
}

interface HeadMovement {
  changedPaths: string[];
  currentHead: string;
  kind: "fast-forward" | "incompatible" | "same";
}

export class GitCheckpointDirtyPathsError extends Error {
  readonly dirtyPaths: string[];

  constructor(dirtyPaths: string[]) {
    super(`Implementation checkpoint paths must be clean: ${dirtyPaths.join(", ")}`);
    this.name = "GitCheckpointDirtyPathsError";
    this.dirtyPaths = dirtyPaths;
  }
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

async function runGitWithInput(cwd: string, args: string[], input: string) {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
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

async function resolveRepoRoot(cwd: string) {
  const repoRoot = (await runGit(cwd, ["rev-parse", "--show-toplevel"])).trim();
  if (!repoRoot) throw new Error("Unable to find Git repository root.");
  return path.resolve(repoRoot);
}

function normalizeThreadId(threadId: string) {
  const normalized = String(threadId ?? "")
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!normalized) throw new Error("A checkpoint thread id is required.");
  return normalized;
}

function checkpointNamespace(threadId: string) {
  return `refs/worktree/agents/${normalizeThreadId(threadId)}/checkpoints`;
}

function proposalNamespace(threadId: string) {
  return `refs/worktree/agents/${normalizeThreadId(threadId)}/checkpoint-proposals`;
}

function normalizeCommit(commit: string) {
  const normalized = String(commit ?? "").trim();
  if (!CHECKPOINT_COMMIT_PATTERN.test(normalized)) throw new Error("Invalid checkpoint commit.");
  return normalized;
}

function isWithinRoot(candidatePath: string, rootPath: string) {
  const candidate = path.resolve(candidatePath).replace(/\\/g, "/").toLowerCase();
  const root = path.resolve(rootPath).replace(/\\/g, "/").toLowerCase();
  return candidate === root || candidate.startsWith(`${root}/`);
}

function normalizePaths(repoRoot: string, paths: string[]) {
  if (!Array.isArray(paths) || !paths.length) throw new Error("At least one checkpoint path is required.");
  const normalized = paths.map((candidate) => {
    const value = String(candidate ?? "").trim();
    if (!value) throw new Error("Checkpoint paths must not be empty.");
    const absolute = path.isAbsolute(value) ? path.resolve(value) : path.resolve(repoRoot, value);
    if (!isWithinRoot(absolute, repoRoot)) throw new Error("Checkpoint paths must stay inside the Git repository.");
    const relative = path.relative(repoRoot, absolute).replace(/\\/g, "/");
    if (!relative || relative.startsWith("../")) throw new Error("Checkpoint paths must identify content inside the Git repository.");
    return relative;
  });
  return [...new Set(normalized)].sort((left, right) => left.localeCompare(right));
}

function literalPathspec(relativePath: string) {
  return `:(top,literal)${relativePath}`;
}

function parseNullPaths(output: string) {
  return output.split("\0").filter(Boolean);
}

async function withTemporaryIndex<T>(callback: (indexPath: string, directory: string) => Promise<T>) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-checkpoint-index-"));
  try {
    return await callback(path.join(directory, "index"), directory);
  } finally {
    await fs.rm(directory, { force: true, recursive: true });
  }
}

async function writeWorktreeTree(repoRoot: string) {
  return await withTemporaryIndex(async (indexPath) => {
    const env = { ...process.env, GIT_INDEX_FILE: indexPath };
    await runGit(repoRoot, ["read-tree", "HEAD"], env);
    await runGit(repoRoot, ["add", "-A", "--", "."], env);
    return (await runGit(repoRoot, ["write-tree"], env)).trim();
  });
}

async function writeScopedWorktreeTree(repoRoot: string, paths: string[], baseTreeish = "HEAD") {
  return await withTemporaryIndex(async (indexPath) => {
    const env = { ...process.env, GIT_INDEX_FILE: indexPath };
    await runGit(repoRoot, ["read-tree", baseTreeish], env);
    const matchedPaths = [...new Set(parseNullPaths(await runGit(repoRoot, [
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      ...paths.map(literalPathspec),
    ], env)))].sort((left, right) => left.localeCompare(right));
    if (matchedPaths.length) {
      await runGit(repoRoot, ["add", "-A", "--", ...matchedPaths.map(literalPathspec)], env);
    }
    return (await runGit(repoRoot, ["write-tree"], env)).trim();
  });
}

async function writeTreeWithPathsFromSource(
  repoRoot: string,
  baseTreeish: string,
  sourceTreeish: string,
  paths: string[],
) {
  return await withTemporaryIndex(async (indexPath, directory) => {
    const env = { ...process.env, GIT_INDEX_FILE: indexPath };
    const patchPath = path.join(directory, "paths.patch");
    await runGit(repoRoot, ["read-tree", baseTreeish], env);
    const patch = await runGit(repoRoot, [
      "diff", "--binary", "--no-renames", baseTreeish, sourceTreeish, "--", ...paths.map(literalPathspec),
    ]);
    if (patch) {
      await fs.writeFile(patchPath, patch, "utf8");
      await runGit(repoRoot, ["apply", "--cached", "--binary", "--whitespace=nowarn", patchPath], env);
    }
    return (await runGit(repoRoot, ["write-tree"], env)).trim();
  });
}

async function createCommitFromTree(
  repoRoot: string,
  tree: string,
  parent: string,
  message: string,
) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-checkpoint-message-"));
  const messagePath = path.join(directory, "message.txt");
  try {
    await fs.writeFile(messagePath, message, "utf8");
    return (await runGit(repoRoot, ["commit-tree", tree, "-p", parent, "-F", messagePath])).trim();
  } finally {
    await fs.rm(directory, { force: true, recursive: true });
  }
}

function checkpointMessage(metadata: CheckpointMetadata) {
  return `${CHECKPOINT_METADATA_MARKER}\n${JSON.stringify(metadata)}\n`;
}

function proposalMessage(metadata: ProposalMetadata) {
  return `${PROPOSAL_METADATA_MARKER}\n${JSON.stringify(metadata)}\n`;
}

function parseMarkedMetadata<T>(message: string, marker: string): T | null {
  const [firstLine, ...rest] = message.trim().split(/\r?\n/u);
  if (firstLine !== marker || !rest.length) return null;
  try {
    return JSON.parse(rest.join("\n")) as T;
  } catch {
    throw new Error("Checkpoint metadata is invalid.");
  }
}

async function createCheckpointRef(repoRoot: string, threadId: string, commit: string) {
  const timestamp = new Date().toISOString().replace(/[-:.]/g, "");
  const shortCommit = (await runGit(repoRoot, ["rev-parse", "--short", commit])).trim();
  const checkpointRef = `${checkpointNamespace(threadId)}/${timestamp}-${shortCommit}`;
  await runGit(repoRoot, ["update-ref", checkpointRef, commit]);
  return checkpointRef;
}

async function readCheckpoint(repoRoot: string, threadId: string, rawCommit: string): Promise<ReadCheckpointResult> {
  const commit = normalizeCommit(rawCommit);
  const checkpointCommit = (await runGit(repoRoot, ["rev-parse", "--verify", `${commit}^{commit}`])).trim();
  const checkpointRef = (await runGit(repoRoot, [
    "for-each-ref", "--format=%(refname)", "--points-at", checkpointCommit, "--count=1", checkpointNamespace(threadId),
  ])).trim();
  if (!checkpointRef) throw new Error("Checkpoint commit is not in this thread/worktree checkpoint timeline.");
  const message = await runGit(repoRoot, ["show", "-s", "--format=%B", checkpointCommit]);
  return {
    checkpointCommit,
    checkpointRef,
    metadata: parseMarkedMetadata<CheckpointMetadata>(message, CHECKPOINT_METADATA_MARKER),
  };
}

async function readRestorableCheckpoint(repoRoot: string, threadId: string, rawCommit: string) {
  const checkpoint = await readCheckpoint(repoRoot, threadId, rawCommit);
  const checkpointParent = (await runGit(repoRoot, ["rev-parse", `${checkpoint.checkpointCommit}^`])).trim();
  const currentHead = (await runGit(repoRoot, ["rev-parse", "HEAD"])).trim();
  if (checkpointParent !== currentHead) throw new Error("Checkpoint parent differs from current HEAD. Ask the user before overriding.");
  return checkpoint;
}

function diffArtifactPath(threadId: string, artifactId: string) {
  if (!CHECKPOINT_DIFF_ARTIFACT_PATTERN.test(artifactId)) throw new Error("Invalid checkpoint diff artifact id.");
  return path.join(
    projectRoot,
    ".workbench",
    "git-checkpoint-diffs",
    "threads",
    normalizeThreadId(threadId),
    `${artifactId}.diff`,
  );
}

async function listChangedPaths(repoRoot: string, from: string, to: string, paths: string[]) {
  return parseNullPaths(await runGit(repoRoot, [
    "diff", "--name-only", "-z", "--no-renames", from, to, "--", ...paths.map(literalPathspec),
  ])).sort((left, right) => left.localeCompare(right));
}

async function classifyHeadMovement(
  repoRoot: string,
  baseCommit: string,
  paths: string[],
): Promise<HeadMovement> {
  const currentHead = (await runGit(repoRoot, ["rev-parse", "HEAD"])).trim();
  if (currentHead === baseCommit) return { changedPaths: [], currentHead, kind: "same" };
  const commitsOnlyOnBase = (await runGit(repoRoot, [
    "rev-list", "--max-count=1", `${currentHead}..${baseCommit}`,
  ])).trim();
  if (commitsOnlyOnBase) return { changedPaths: [], currentHead, kind: "incompatible" };
  return {
    changedPaths: await listChangedPaths(repoRoot, baseCommit, currentHead, paths),
    currentHead,
    kind: "fast-forward",
  };
}

async function buildFileChanges(repoRoot: string, from: string, to: string, paths: string[]) {
  const changedPaths = await listChangedPaths(repoRoot, from, to, paths);
  return await Promise.all(changedPaths.map(async (filePath): Promise<GitCheckpointFileChange> => {
    const pathspec = literalPathspec(filePath);
    const [statusText, numstat, diff] = await Promise.all([
      runGit(repoRoot, ["diff", "--name-status", "--no-renames", from, to, "--", pathspec]),
      runGit(repoRoot, ["diff", "--numstat", "--no-renames", from, to, "--", pathspec]),
      runGit(repoRoot, ["diff", "--binary", "--no-renames", from, to, "--", pathspec]),
    ]);
    const status = statusText.trim().charAt(0);
    const [added = "0", deleted = "0"] = numstat.trim().split("\t");
    return {
      additions: /^\d+$/u.test(added) ? Number(added) : 0,
      deletions: /^\d+$/u.test(deleted) ? Number(deleted) : 0,
      diff,
      kind: status === "A"
        ? { type: "add" }
        : status === "D"
          ? { type: "delete" }
          : { move_path: null, type: "update" },
      path: filePath,
    };
  }));
}

async function readProposal(repoRoot: string, threadId: string, proposalId: string): Promise<ReadProposalResult> {
  const normalizedProposalId = String(proposalId ?? "").trim();
  if (!/^[A-Za-z0-9._-]+$/u.test(normalizedProposalId)) throw new Error("Invalid checkpoint proposal id.");
  const proposalRef = `${proposalNamespace(threadId)}/${normalizedProposalId}`;
  const proposalCommit = (await runGit(repoRoot, ["rev-parse", "--verify", `${proposalRef}^{commit}`])).trim();
  const message = await runGit(repoRoot, ["show", "-s", "--format=%B", proposalCommit]);
  const metadata = parseMarkedMetadata<ProposalMetadata>(message, PROPOSAL_METADATA_MARKER);
  if (!metadata || metadata.proposalId !== normalizedProposalId) throw new Error("Checkpoint proposal metadata is invalid.");
  return { metadata, proposalCommit, proposalRef };
}

async function transitionProposal(
  repoRoot: string,
  proposal: ReadProposalResult,
  metadata: ProposalMetadata,
  treeish = proposal.proposalCommit,
) {
  const tree = (await runGit(repoRoot, ["rev-parse", `${treeish}^{tree}`])).trim();
  const stateCommit = await createCommitFromTree(
    repoRoot,
    tree,
    metadata.baseCommit,
    proposalMessage(metadata),
  );
  await runGit(repoRoot, ["update-ref", proposal.proposalRef, stateCommit, proposal.proposalCommit]);
  return { ...proposal, metadata, proposalCommit: stateCommit };
}

function commitMessage(title: string, description: string) {
  const normalizedTitle = title.trim();
  if (!normalizedTitle) throw new Error("A commit title is required.");
  return description.trim() ? `${normalizedTitle}\n\n${description.trim()}\n` : `${normalizedTitle}\n`;
}

async function buildProposalResult(
  repoRoot: string,
  metadata: ProposalMetadata,
  target: string,
  includeNewerAvailable = false,
): Promise<GitCheckpointProposal> {
  return {
    baseCommit: metadata.baseCommit,
    changes: await buildFileChanges(repoRoot, metadata.baseCommit, target, metadata.paths),
    committedSha: metadata.committedSha,
    description: metadata.description,
    includeNewerAvailable,
    paths: metadata.paths,
    proposalId: metadata.proposalId,
    status: metadata.status,
    title: metadata.title,
    unavailableReason: metadata.unavailableReason,
  };
}

export default class WorkbenchGitCheckpointController {
  async createPlan({ cwd, threadId }: ControllerInput): Promise<GitCheckpointCreateResult> {
    const repoRoot = await resolveRepoRoot(cwd);
    const tree = await writeWorktreeTree(repoRoot);
    const parent = (await runGit(repoRoot, ["rev-parse", "HEAD"])).trim();
    const metadata: CheckpointMetadata = { amendedFrom: null, kind: "plan", scopePaths: [], version: 1 };
    const checkpointCommit = await createCommitFromTree(repoRoot, tree, parent, checkpointMessage(metadata));
    const checkpointRef = await createCheckpointRef(repoRoot, threadId, checkpointCommit);
    return { checkpointCommit, checkpointRef, kind: "plan", repoRoot, scopePaths: [] };
  }

  async createImplementation({
    amendCheckpoint,
    cwd,
    paths: rawPaths,
    threadId,
  }: ControllerInput & { amendCheckpoint?: string; paths: string[] }): Promise<GitCheckpointCreateResult> {
    const repoRoot = await resolveRepoRoot(cwd);
    const paths = normalizePaths(repoRoot, rawPaths);
    const existing = amendCheckpoint
      ? await readCheckpoint(repoRoot, threadId, amendCheckpoint)
      : null;
    if (existing && existing.metadata?.kind !== "implement") throw new Error("Only an implementation checkpoint can be amended.");
    if (existing?.metadata?.kind === "implement") {
      const overlapping = paths.filter((candidate) => existing.metadata!.scopePaths.some((scopePath) => (
        candidate === scopePath || candidate.startsWith(`${scopePath}/`) || scopePath.startsWith(`${candidate}/`)
      )));
      if (overlapping.length) throw new Error(`Amend paths are already covered by implementation scope: ${overlapping.join(", ")}`);
    }
    const currentTree = existing
      ? await writeScopedWorktreeTree(repoRoot, paths)
      : await writeWorktreeTree(repoRoot);
    const dirtyPaths = await listChangedPaths(repoRoot, "HEAD", currentTree, paths);
    if (dirtyPaths.length) throw new GitCheckpointDirtyPathsError(dirtyPaths);

    let scopePaths = paths;
    let tree = currentTree;
    let amendedFrom: string | null = null;
    let parent = (await runGit(repoRoot, ["rev-parse", "HEAD"])).trim();
    if (existing?.metadata?.kind === "implement") {
      const changedSinceCheckpoint = await listChangedPaths(
        repoRoot,
        existing.checkpointCommit,
        currentTree,
        paths,
      );
      if (changedSinceCheckpoint.length) {
        throw new Error(`Implementation amendment paths changed since checkpoint: ${changedSinceCheckpoint.join(", ")}`);
      }
      amendedFrom = existing.checkpointCommit;
      scopePaths = [...existing.metadata.scopePaths, ...paths].sort((left, right) => left.localeCompare(right));
      tree = (await runGit(repoRoot, ["rev-parse", `${existing.checkpointCommit}^{tree}`])).trim();
      parent = (await runGit(repoRoot, ["rev-parse", `${existing.checkpointCommit}^`])).trim();
    }

    const metadata: CheckpointMetadata = { amendedFrom, kind: "implement", scopePaths, version: 1 };
    const checkpointCommit = await createCommitFromTree(repoRoot, tree, parent, checkpointMessage(metadata));
    const checkpointRef = await createCheckpointRef(repoRoot, threadId, checkpointCommit);
    return { checkpointCommit, checkpointRef, kind: "implement", repoRoot, scopePaths };
  }

  async compare({ checkpointCommit, cwd, paths: rawPaths, threadId }: ScopedCheckpointInput): Promise<GitCheckpointCompareResult> {
    const repoRoot = await resolveRepoRoot(cwd);
    const paths = normalizePaths(repoRoot, rawPaths);
    const checkpoint = await readCheckpoint(repoRoot, threadId, checkpointCommit);
    const currentTree = await writeScopedWorktreeTree(repoRoot, paths);
    return {
      changes: await buildFileChanges(repoRoot, checkpoint.checkpointCommit, currentTree, paths),
      checkpointCommit: checkpoint.checkpointCommit,
      checkpointRef: checkpoint.checkpointRef,
      repoRoot,
    };
  }

  async diff(input: ScopedCheckpointInput): Promise<GitCheckpointDiffResult> {
    const result = await this.compare(input);
    return {
      ...result,
      diff: result.changes.map((change) => change.diff).join(""),
    };
  }

  async createProposal({
    checkpointCommit,
    cwd,
    description,
    paths: rawPaths,
    threadId,
    title,
  }: ScopedCheckpointInput & { description: string; title: string }): Promise<GitCheckpointProposalReceipt> {
    const repoRoot = await resolveRepoRoot(cwd);
    const requestedPaths = normalizePaths(repoRoot, rawPaths);
    const checkpoint = await readCheckpoint(repoRoot, threadId, checkpointCommit);
    const checkpointParent = (await runGit(repoRoot, ["rev-parse", `${checkpoint.checkpointCommit}^`])).trim();
    const headMovement = await classifyHeadMovement(repoRoot, checkpointParent, requestedPaths);
    if (headMovement.kind === "incompatible") {
      throw new Error("Repository HEAD moved incompatibly after the implementation checkpoint. Create a new implementation checkpoint before proposing a commit.");
    }
    if (headMovement.changedPaths.length) {
      throw new Error(`Proposed paths changed in committed history after the implementation checkpoint: ${headMovement.changedPaths.join(", ")}`);
    }
    const baseCommit = headMovement.currentHead;
    const proposalTree = await writeScopedWorktreeTree(repoRoot, requestedPaths, baseCommit);
    const changedPaths = new Set(await listChangedPaths(repoRoot, baseCommit, proposalTree, requestedPaths));
    const unchangedPaths = requestedPaths.filter((filePath) => !changedPaths.has(filePath));
    if (unchangedPaths.length) throw new Error(`Every proposed path must identify an exact changed file: ${unchangedPaths.join(", ")}`);
    const paths = requestedPaths;
    const proposalId = randomUUID();
    const metadata: ProposalMetadata = {
      baseCommit,
      committedSha: null,
      description,
      paths,
      proposalId,
      sourceCheckpoint: checkpoint.checkpointCommit,
      status: "proposed",
      title: title.trim(),
      unavailableReason: null,
      version: 1,
    };
    commitMessage(metadata.title, metadata.description);
    const proposalCommit = await createCommitFromTree(repoRoot, proposalTree, baseCommit, proposalMessage(metadata));
    await runGit(repoRoot, ["update-ref", `${proposalNamespace(threadId)}/${proposalId}`, proposalCommit, ""]);
    return {
      baseCommit,
      description: metadata.description,
      paths: metadata.paths,
      proposalId,
      title: metadata.title,
    } satisfies GitCheckpointProposalReceipt;
  }

  async getProposal({
    cwd,
    includeNewer,
    proposalId,
    threadId,
  }: ControllerInput & { includeNewer: boolean; proposalId: string }): Promise<GitCheckpointProposal> {
    const repoRoot = await resolveRepoRoot(cwd);
    let proposal = await readProposal(repoRoot, threadId, proposalId);
    let currentTree: string | null = null;
    if (proposal.metadata.status === "proposed") {
      const headMovement = await classifyHeadMovement(repoRoot, proposal.metadata.baseCommit, proposal.metadata.paths);
      let unavailableReason: string | null = headMovement.kind === "incompatible"
        ? "The repository HEAD moved incompatibly after this proposal was created."
        : headMovement.changedPaths.length
          ? `Proposed paths changed in committed history: ${headMovement.changedPaths.join(", ")}`
          : null;
      if (!unavailableReason && headMovement.kind === "fast-forward") {
        const rebasedTree = await writeTreeWithPathsFromSource(
          repoRoot,
          headMovement.currentHead,
          proposal.proposalCommit,
          proposal.metadata.paths,
        );
        proposal = await transitionProposal(repoRoot, proposal, {
          ...proposal.metadata,
          baseCommit: headMovement.currentHead,
        }, rebasedTree);
      }
      if (!unavailableReason) {
        currentTree = await writeScopedWorktreeTree(
          repoRoot,
          proposal.metadata.paths,
          proposal.metadata.baseCommit,
        );
        const changedNow = new Set(await listChangedPaths(
          repoRoot,
          proposal.metadata.baseCommit,
          currentTree,
          proposal.metadata.paths,
        ));
        const cleanPath = proposal.metadata.paths.find((filePath) => !changedNow.has(filePath));
        if (cleanPath) unavailableReason = `${cleanPath} no longer has working-tree changes.`;
      }
      if (unavailableReason) {
        proposal = await transitionProposal(repoRoot, proposal, {
          ...proposal.metadata,
          status: "unavailable",
          unavailableReason,
        });
      }
    }

    const includeNewerAvailable = proposal.metadata.status === "proposed"
      && currentTree !== null
      && (await listChangedPaths(repoRoot, proposal.proposalCommit, currentTree, proposal.metadata.paths)).length > 0;
    const target = proposal.metadata.status === "committed" && proposal.metadata.committedSha
      ? proposal.metadata.committedSha
      : includeNewer && includeNewerAvailable && currentTree
        ? currentTree
        : proposal.proposalCommit;
    return await buildProposalResult(repoRoot, proposal.metadata, target, includeNewerAvailable);
  }

  async commitProposal({
    cwd,
    description,
    includeNewer,
    proposalId,
    threadId,
    title,
  }: ControllerInput & {
    description: string;
    includeNewer: boolean;
    proposalId: string;
    title: string;
  }): Promise<GitCheckpointProposal> {
    const repoRoot = await resolveRepoRoot(cwd);
    const currentState = await this.getProposal({ cwd: repoRoot, includeNewer, proposalId, threadId });
    if (currentState.status !== "proposed") throw new Error(currentState.unavailableReason || "Checkpoint proposal is not available to commit.");
    const proposal = await readProposal(repoRoot, threadId, proposalId);
    const message = commitMessage(title, description);
    const targetTree = includeNewer && currentState.includeNewerAvailable
      ? await writeScopedWorktreeTree(repoRoot, proposal.metadata.paths, proposal.metadata.baseCommit)
      : (await runGit(repoRoot, ["rev-parse", `${proposal.proposalCommit}^{tree}`])).trim();
    const committedSha = await createCommitFromTree(repoRoot, targetTree, proposal.metadata.baseCommit, message);
    const committedMetadata: ProposalMetadata = {
      ...proposal.metadata,
      committedSha,
      description: description.trim(),
      status: "committed",
      title: title.trim(),
      unavailableReason: null,
    };
    const stateCommit = await createCommitFromTree(
      repoRoot,
      targetTree,
      proposal.metadata.baseCommit,
      proposalMessage(committedMetadata),
    );
    let headRef = "HEAD";
    try {
      headRef = (await runGit(repoRoot, ["symbolic-ref", "-q", "HEAD"])).trim() || "HEAD";
    } catch {
      // Detached HEAD is still safely updated through the HEAD pseudoref.
    }
    await runGitWithInput(repoRoot, ["update-ref", "--stdin"], [
      "start",
      `update ${headRef} ${committedSha} ${proposal.metadata.baseCommit}`,
      `update ${proposal.proposalRef} ${stateCommit} ${proposal.proposalCommit}`,
      "prepare",
      "commit",
      "",
    ].join("\n"));
    await runGit(repoRoot, ["reset", "--mixed", "--quiet", committedSha, "--", ...proposal.metadata.paths.map(literalPathspec)]);
    return await buildProposalResult(repoRoot, committedMetadata, committedSha);
  }

  async readLegacyDiffArtifact({ artifactId, threadId }: { artifactId: string; threadId: string }) {
    try {
      return await fs.readFile(diffArtifactPath(threadId, artifactId), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("Checkpoint diff artifact not found.");
      throw error;
    }
  }

  async restore({
    checkpointCommit,
    confirmRestore,
    cwd,
    paths: rawPaths,
    threadId,
  }: CheckpointInput & { confirmRestore?: boolean; paths?: string[] }) {
    if (!rawPaths?.length && !confirmRestore) throw new Error("Checkpoint restore requires confirmation or selected paths.");
    const repoRoot = await resolveRepoRoot(cwd);

    if (!rawPaths?.length) {
      const checkpoint = await readRestorableCheckpoint(repoRoot, threadId, checkpointCommit);
      const currentTree = await writeWorktreeTree(repoRoot);
      const changedPaths = parseNullPaths(await runGit(repoRoot, [
        "diff", "--name-only", "-z", "--no-renames", checkpoint.checkpointCommit, currentTree, "--", ".",
      ]));
      const checkpointPaths = new Set(parseNullPaths(await runGit(repoRoot, [
        "ls-tree", "-r", "--name-only", "-z", checkpoint.checkpointCommit,
      ])));
      const addedPaths = changedPaths.filter((filePath) => !checkpointPaths.has(filePath));
      await Promise.all(addedPaths.map(async (filePath) => {
        const absolute = path.resolve(repoRoot, filePath);
        if (isWithinRoot(absolute, repoRoot)) await fs.rm(absolute, { force: true, recursive: true });
      }));
      await runGit(repoRoot, ["restore", "--source", checkpoint.checkpointCommit, "--worktree", "--", "."]);
      return {
        checkpointCommit: checkpoint.checkpointCommit,
        checkpointRef: checkpoint.checkpointRef,
        repoRoot,
        restored: true as const,
      };
    }

    const paths = normalizePaths(repoRoot, rawPaths);
    const checkpoint = await readCheckpoint(repoRoot, threadId, checkpointCommit);
    const checkpointParent = (await runGit(repoRoot, ["rev-parse", `${checkpoint.checkpointCommit}^`])).trim();
    const headMovement = await classifyHeadMovement(repoRoot, checkpointParent, paths);
    if (headMovement.kind === "incompatible") {
      throw new Error("Repository HEAD moved incompatibly after this checkpoint. Ask the user before restoring selected paths.");
    }
    if (headMovement.changedPaths.length) {
      throw new Error(`Selected restore paths changed in committed history after this checkpoint: ${headMovement.changedPaths.join(", ")}`);
    }
    const currentTree = await writeScopedWorktreeTree(repoRoot, paths);
    const changedPaths = await listChangedPaths(repoRoot, checkpoint.checkpointCommit, currentTree, paths);
    const checkpointPaths = new Set(parseNullPaths(await runGit(repoRoot, [
      "ls-tree", "-r", "--name-only", "-z", checkpoint.checkpointCommit, "--", ...paths.map(literalPathspec),
    ])));
    const addedPaths = changedPaths.filter((filePath) => !checkpointPaths.has(filePath));
    const sourcePaths = changedPaths.filter((filePath) => checkpointPaths.has(filePath));
    await Promise.all(addedPaths.map(async (filePath) => {
      const absolute = path.resolve(repoRoot, filePath);
      if (isWithinRoot(absolute, repoRoot)) await fs.rm(absolute, { force: true, recursive: true });
    }));
    if (sourcePaths.length) {
      await runGit(repoRoot, [
        "restore", "--source", checkpoint.checkpointCommit, "--worktree", "--", ...sourcePaths.map(literalPathspec),
      ]);
    }
    return {
      checkpointCommit: checkpoint.checkpointCommit,
      checkpointRef: checkpoint.checkpointRef,
      repoRoot,
      restored: true as const,
      restoredPaths: [...new Set(changedPaths)].sort((left, right) => left.localeCompare(right)),
    };
  }
}
