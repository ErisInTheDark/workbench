/*
 * Exports:
 * - default WorkbenchGitCheckpointController: own scoped plan creation, arc claims, comparison, proposals, and Git commit transitions. Keywords: git, checkpoint, arc, scope, proposal, commit.
 * - GitArcActiveClaim/GitArcProposalStatus: expose resolved active-claim proposal lifecycle for thread-state projection. Keywords: git, arc, claim, proposal, status.
 * - GitCheckpointDirtyPathsError: identify paths that must be clean before an arc operation. Keywords: git, checkpoint, dirty paths.
 * - GitCheckpointCreateResult/GitCheckpointCompareResult/GitCheckpointDiffResult/GitCheckpointProposalReceipt/GitArcMoveResult: typed controller operation results. Keywords: git, checkpoint, arc, move, proposal, result.
 */
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { projectRoot } from "../../project";
import type {
  GitArcMoveRequest,
  GitCheckpointFileChange,
  GitCheckpointProposal,
} from "./checkpoint-contracts";
import GitArcRegistry, { REGISTRY_REF, type GitArcRegistryEntry } from "./GitArcRegistry";
import GitArcPublishState from "./GitArcPublishState";
import GitArcProposalCache from "./GitArcProposalCache";
import GitArcPathMover, { type GitArcResolvedMove } from "./GitArcPathMover";
import GitArcHistoryRewriter from "./GitArcHistoryRewriter";
import WorkbenchGitRepository, { type GitRefUpdate } from "./WorkbenchGitRepository";
import WorkbenchGitHistoryRewriter from "./WorkbenchGitHistoryRewriter";
import {
  type ArcOutcome,
  CHECKPOINT_METADATA_MARKER,
  checkpointMessage,
  checkpointNamespace,
  type CheckpointKind,
  type CheckpointMetadata,
  type GitArcHarness,
  type GitArcProposalStatus,
  legacyCheckpointNamespace,
  legacyProposalNamespace,
  normalizeCommit,
  normalizeThreadId,
  outcomeRef,
  parseMarkedMetadata,
  PROPOSAL_METADATA_MARKER,
  proposalMessage,
  proposalNamespace,
  type ProposalMetadata,
  remapProposalMetadata,
} from "./git-arc-storage";

export type { GitArcProposalStatus } from "./git-arc-storage";

const execFileAsync = promisify(execFile);
const GIT_MAX_BUFFER = 32 * 1024 * 1024;
const CHECKPOINT_DIFF_ARTIFACT_PATTERN = /^[a-f0-9]{64}$/u;

export interface GitArcActiveClaim extends GitArcRegistryEntry {
  proposalStatus: GitArcProposalStatus | null;
}


interface ControllerInput {
  cwd: string;
  harness?: GitArcHarness;
  threadId: string;
}

interface CheckpointInput extends ControllerInput {
  checkpointCommit: string;
}

interface ScopedCheckpointInput extends CheckpointInput {
  paths?: string[];
}

export interface GitCheckpointCreateResult {
  checkpointCommit: string;
  checkpointRef: string;
  intentName: string | null;
  kind: CheckpointKind;
  repoRoot: string;
  scopePaths: string[];
}

export interface GitCheckpointCompareResult {
  changes: GitCheckpointFileChange[];
  checkpointCommit: string;
  checkpointRef: string;
  intentName: string | null;
  repoRoot: string;
  scopePaths: string[];
}

export interface GitCheckpointDiffResult extends GitCheckpointCompareResult {
  diff: string;
}

export interface GitCheckpointProposalReceipt {
  baseCommit: string;
  description: string;
  intentName: string | null;
  paths: string[];
  proposalId: string;
  scopePaths: string[];
  sourceCheckpoint: string;
  title: string;
}

export interface GitArcMoveResult extends GitCheckpointCreateResult {
  additionalClaims: string[];
  mappings: GitArcResolvedMove[];
  matchedPathCount: number;
  mode: "applied" | "preview";
  remainingMatchCount: number;
}

interface ReadCheckpointResult {
  checkpointCommit: string;
  checkpointRef: string;
  metadata: CheckpointMetadata | null;
  parent: string;
}

interface ReadProposalResult {
  metadata: ProposalMetadata;
  proposalCommit: string;
  proposalRef: string;
  tree: string;
}

interface HeadMovement {
  changedPaths: string[];
  currentHead: string;
  kind: "fast-forward" | "incompatible" | "same";
}

export class GitCheckpointDirtyPathsError extends Error {
  readonly dirtyPaths: string[];

  constructor(dirtyPaths: string[], operation = "Plan") {
    super(`${operation} paths must be clean against HEAD: ${dirtyPaths.join(", ")}`);
    this.name = "GitCheckpointDirtyPathsError";
    this.dirtyPaths = dirtyPaths;
  }
}

function isArcMetadata(metadata: CheckpointMetadata | null): metadata is CheckpointMetadata {
  return Boolean(metadata && (metadata.kind === "arc" || metadata.kind === "implement") && metadata.scopePaths.length);
}

function requireArcMetadata(checkpoint: ReadCheckpointResult) {
  if (!isArcMetadata(checkpoint.metadata)) {
    throw new Error("This checkpoint does not contain a claimed file set. Create a new plan with wb git arc plan.");
  }
  return checkpoint.metadata;
}

function pathIsCoveredBy(candidate: string, scopePath: string) {
  return candidate === scopePath || candidate.startsWith(`${scopePath}/`);
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

function normalizeHarness(harness: string | undefined): GitArcHarness {
  const normalized = String(harness ?? "codex").trim().toLowerCase();
  if (normalized === "codex" || normalized === "copilot" || normalized === "opencode") return normalized;
  throw new Error("A valid checkpoint harness is required.");
}

async function readArcOutcome(
  repository: WorkbenchGitRepository,
  harness: GitArcHarness,
  threadId: string,
  sourceCheckpoint: string,
) {
  const ref = outcomeRef(harness, threadId, sourceCheckpoint);
  const resolved = await repository.readBlobAtRef(ref);
  if (!resolved) return null;
  const parsed = JSON.parse(resolved.contents) as Partial<ArcOutcome>;
  if (
    parsed.version !== 1
    || parsed.sourceCheckpoint !== sourceCheckpoint
    || !["committed", "continued", "partial", "proposed", "released"].includes(parsed.status ?? "")
  ) throw new Error("Arc outcome metadata is invalid.");
  return parsed as ArcOutcome;
}

async function prepareArcOutcome(
  repository: WorkbenchGitRepository,
  harness: GitArcHarness,
  threadId: string,
  outcome: ArcOutcome,
) {
  const ref = outcomeRef(harness, threadId, outcome.sourceCheckpoint);
  const previous = await repository.readRef(ref);
  const blob = await repository.writeBlob(`${JSON.stringify(outcome)}\n`);
  return { newValue: blob, oldValue: previous ?? "0".repeat(40), ref };
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
    const transcriptIsIgnored = await runGit(
      repoRoot,
      ["check-ignore", "-q", "--no-index", ".workbench/transcripts"],
    ).then(() => true, () => false);
    await runGit(repoRoot, [
      "add", "-A", "--", ".",
      ...(transcriptIsIgnored ? [] : [":(top,glob,exclude).workbench/transcripts/**"]),
    ], env);
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

async function createCheckpointRef(repoRoot: string, harness: GitArcHarness, threadId: string, commit: string) {
  const checkpointRef = await checkpointRefName(repoRoot, harness, threadId, commit);
  await new WorkbenchGitRepository(repoRoot).updateRefs([
    { newValue: commit, oldValue: "0".repeat(40), ref: checkpointRef },
  ]);
  return checkpointRef;
}

async function checkpointRefName(repoRoot: string, harness: GitArcHarness, threadId: string, commit: string) {
  const timestamp = new Date().toISOString().replace(/[-:.]/g, "");
  const shortCommit = (await runGit(repoRoot, ["rev-parse", "--short", commit])).trim();
  return `${checkpointNamespace(harness, threadId)}/${timestamp}-${shortCommit}`;
}

async function readCheckpoint(repoRoot: string, harness: GitArcHarness, threadId: string, rawCommit: string): Promise<ReadCheckpointResult> {
  const commit = normalizeCommit(rawCommit);
  const repository = new WorkbenchGitRepository(repoRoot);
  let resolved = await repository.readCommitAt(commit);
  if (!resolved) throw new Error(`Git object ${commit} is missing.`);
  let checkpointCommit = resolved.commit;
  let checkpointRef = (await runGit(repoRoot, [
    "for-each-ref", "--format=%(refname)", "--points-at", checkpointCommit, "--count=1",
    checkpointNamespace(harness, threadId), legacyCheckpointNamespace(threadId),
  ])).trim();
  if (!checkpointRef) {
    const remapped = await new GitArcHistoryRewriter(repository).resolveAlias(checkpointCommit);
    if (remapped !== checkpointCommit) {
      resolved = await repository.readCommitAt(remapped);
      if (!resolved) throw new Error(`Git object ${remapped} is missing.`);
      checkpointCommit = resolved.commit;
      checkpointRef = (await runGit(repoRoot, [
        "for-each-ref", "--format=%(refname)", "--points-at", checkpointCommit, "--count=1",
        checkpointNamespace(harness, threadId), legacyCheckpointNamespace(threadId),
      ])).trim();
    }
  }
  if (!checkpointRef) throw new Error("Checkpoint commit is not in this thread/worktree checkpoint timeline.");
  if (resolved.identity.parents.length !== 1) throw new Error("Checkpoint commit parent metadata is invalid.");
  return {
    checkpointCommit,
    checkpointRef,
    metadata: parseMarkedMetadata<CheckpointMetadata>(resolved.identity.message, CHECKPOINT_METADATA_MARKER),
    parent: resolved.identity.parents[0]!,
  };
}

async function readRestorableCheckpoint(repoRoot: string, harness: GitArcHarness, threadId: string, rawCommit: string) {
  const checkpoint = await readCheckpoint(repoRoot, harness, threadId, rawCommit);
  const currentHead = (await runGit(repoRoot, ["rev-parse", "HEAD"])).trim();
  if (checkpoint.parent !== currentHead) throw new Error("Checkpoint parent differs from current HEAD. Ask the user before overriding.");
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
  ancestryBaseCommit: string,
  paths: string[],
  contentBaseline = ancestryBaseCommit,
): Promise<HeadMovement> {
  const currentHead = (await runGit(repoRoot, ["rev-parse", "HEAD"])).trim();
  if (currentHead === ancestryBaseCommit) {
    return {
      changedPaths: contentBaseline === currentHead
        ? []
        : await listChangedPaths(repoRoot, contentBaseline, currentHead, paths),
      currentHead,
      kind: "same",
    };
  }
  const commitsOnlyOnBase = (await runGit(repoRoot, [
    "rev-list", "--max-count=1", `${currentHead}..${ancestryBaseCommit}`,
  ])).trim();
  if (commitsOnlyOnBase) return { changedPaths: [], currentHead, kind: "incompatible" };
  return {
    changedPaths: await listChangedPaths(repoRoot, contentBaseline, currentHead, paths),
    currentHead,
    kind: "fast-forward",
  };
}

async function buildFileChanges(repoRoot: string, from: string, to: string, paths: string[]) {
  return await new WorkbenchGitRepository(repoRoot).buildFileChanges(from, to, paths);
}

async function readProposal(repoRoot: string, harness: GitArcHarness, threadId: string, proposalId: string): Promise<ReadProposalResult> {
  const normalizedProposalId = String(proposalId ?? "").trim();
  if (!/^[A-Za-z0-9._-]+$/u.test(normalizedProposalId)) throw new Error("Invalid checkpoint proposal id.");
  const canonicalRef = `${proposalNamespace(harness, threadId)}/${normalizedProposalId}`;
  const legacyRef = `${legacyProposalNamespace(threadId)}/${normalizedProposalId}`;
  const repository = new WorkbenchGitRepository(repoRoot);
  const canonical = await repository.readCommitAt(canonicalRef);
  const proposalRef = canonical ? canonicalRef : legacyRef;
  const resolved = canonical ?? await repository.readCommitAt(legacyRef);
  if (!resolved) throw new Error("Checkpoint proposal not found.");
  const parsedMetadata = parseMarkedMetadata<ProposalMetadata>(resolved.identity.message, PROPOSAL_METADATA_MARKER);
  if (!parsedMetadata || parsedMetadata.proposalId !== normalizedProposalId) throw new Error("Checkpoint proposal metadata is invalid.");
  const metadata: ProposalMetadata = parsedMetadata.version === 1
    ? {
      ...parsedMetadata,
      amendTargetSha: null,
      liveBaseCommit: parsedMetadata.baseCommit,
      livePaths: parsedMetadata.paths,
      mode: "commit",
      supersededByProposalId: null,
      supersededBySha: null,
    }
    : parsedMetadata;
  return { metadata, proposalCommit: resolved.commit, proposalRef, tree: resolved.identity.tree };
}

async function transitionProposal(
  repoRoot: string,
  proposal: ReadProposalResult,
  metadata: ProposalMetadata,
  treeish?: string,
) {
  const tree = treeish ?? proposal.tree;
  const stateCommit = await createCommitFromTree(
    repoRoot,
    tree,
    metadata.baseCommit,
    proposalMessage(metadata),
  );
  await new WorkbenchGitRepository(repoRoot).updateRefs([
    { newValue: stateCommit, oldValue: proposal.proposalCommit, ref: proposal.proposalRef },
  ]);
  return { ...proposal, metadata, proposalCommit: stateCommit, tree };
}

async function prepareProposalUnavailableUpdate({
  harness,
  proposalId,
  reason,
  repository,
  threadId,
}: {
  harness: GitArcHarness;
  proposalId: string | null;
  reason: string;
  repository: WorkbenchGitRepository;
  threadId: string;
}) {
  if (!proposalId) return null;
  const proposal = await readProposal(repository.root, harness, threadId, proposalId);
  if (proposal.metadata.status !== "proposed") return null;
  const stateCommit = await repository.createCommitFromTree(
    proposal.tree,
    proposal.metadata.baseCommit,
    proposalMessage({
      ...proposal.metadata,
      status: "unavailable",
      unavailableReason: reason,
    }),
  );
  return { newValue: stateCommit, oldValue: proposal.proposalCommit, ref: proposal.proposalRef };
}

function commitMessage(title: string, description: string) {
  const normalizedTitle = title.trim();
  if (!normalizedTitle) throw new Error("A commit title is required.");
  return description.trim() ? `${normalizedTitle}\n\n${description.trim()}\n` : `${normalizedTitle}\n`;
}

function parseCommitMessage(message: string) {
  const [title = "", ...description] = message.trim().split(/\r?\n/u);
  return { description: description.join("\n").trim(), title: title.trim() };
}

async function buildProposalResult(
  repoRoot: string,
  metadata: ProposalMetadata,
  target: string,
  harness: GitArcHarness,
  threadId: string,
  includeNewerAvailable = false,
): Promise<GitCheckpointProposal> {
  return {
    amendTargetSha: metadata.amendTargetSha,
    baseCommit: metadata.baseCommit,
    changes: await buildProposalFileChanges(repoRoot, metadata, target, harness, threadId),
    committedSha: metadata.committedSha,
    description: metadata.description,
    includeNewerAvailable,
    mode: metadata.mode,
    paths: metadata.paths,
    proposalId: metadata.proposalId,
    status: metadata.status,
    supersededByProposalId: metadata.supersededByProposalId,
    supersededBySha: metadata.supersededBySha,
    title: metadata.title,
    unavailableReason: metadata.unavailableReason,
  };
}

async function buildProposalFileChanges(
  repoRoot: string,
  metadata: ProposalMetadata,
  target: string,
  harness: GitArcHarness,
  threadId: string,
) {
  const [baseTree, targetTree] = await Promise.all([
    runGit(repoRoot, ["rev-parse", `${metadata.baseCommit}^{tree}`]).then((value) => value.trim()),
    runGit(repoRoot, ["rev-parse", `${target}^{tree}`]).then((value) => value.trim()),
  ]);
  return await new GitArcProposalCache(repoRoot).readOrBuild({
    baseTree,
    build: async () => await buildFileChanges(repoRoot, metadata.baseCommit, target, metadata.paths),
    harness,
    paths: metadata.paths,
    proposalId: metadata.proposalId,
    targetTree,
    threadId,
  });
}

async function resolveProposalState(
  repoRoot: string,
  harness: GitArcHarness,
  threadId: string,
  proposalId: string,
) {
  let proposal = await readProposal(repoRoot, harness, threadId, proposalId);
  let currentTree: string | null = null;
  if (proposal.metadata.status === "proposed") {
    const headMovement = await classifyHeadMovement(
      repoRoot,
      proposal.metadata.liveBaseCommit,
      proposal.metadata.livePaths,
    );
    let unavailableReason: string | null = headMovement.kind === "incompatible"
      ? "The repository HEAD moved incompatibly after this proposal was created."
      : headMovement.changedPaths.length
        ? `Proposed paths changed in committed history: ${headMovement.changedPaths.join(", ")}`
        : null;
    if (!unavailableReason && proposal.metadata.mode === "amend" && headMovement.kind !== "same") {
      unavailableReason = "Repository HEAD changed after this amend proposal was created.";
    }
    if (!unavailableReason && proposal.metadata.mode === "commit" && headMovement.kind === "fast-forward") {
      const rebasedTree = await writeTreeWithPathsFromSource(
        repoRoot,
        headMovement.currentHead,
        proposal.proposalCommit,
        proposal.metadata.paths,
      );
      proposal = await transitionProposal(repoRoot, proposal, {
        ...proposal.metadata,
        baseCommit: headMovement.currentHead,
        liveBaseCommit: headMovement.currentHead,
      }, rebasedTree);
    }
    if (!unavailableReason) {
      currentTree = await writeScopedWorktreeTree(
        repoRoot,
        proposal.metadata.livePaths,
        proposal.metadata.liveBaseCommit,
      );
      const changedNow = new Set(await listChangedPaths(
        repoRoot,
        proposal.metadata.liveBaseCommit,
        currentTree,
        proposal.metadata.livePaths,
      ));
      const cleanPath = proposal.metadata.livePaths.find((filePath) => !changedNow.has(filePath));
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
    && (await listChangedPaths(repoRoot, proposal.proposalCommit, currentTree, proposal.metadata.livePaths)).length > 0;
  return { currentTree, includeNewerAvailable, proposal };
}

export default class WorkbenchGitCheckpointController {
  private async requireActiveArc({ cwd, harness: rawHarness, threadId }: ControllerInput) {
    const repository = await WorkbenchGitRepository.open(cwd);
    const harness = normalizeHarness(rawHarness);
    const registry = new GitArcRegistry(repository);
    const active = await registry.find({ harness, threadId });
    if (!active) throw new Error("This thread does not own an active Git arc.");
    const checkpoint = await readCheckpoint(repository.root, harness, threadId, active.checkpointCommit);
    const metadata = requireArcMetadata(checkpoint);
    if (
      metadata.scopePaths.length !== active.claimedPaths.length
      || metadata.scopePaths.some((scopePath, index) => scopePath !== active.claimedPaths[index])
    ) {
      throw new Error("The active Git arc registry does not match its checkpoint claim set.");
    }
    return { active, checkpoint, harness, metadata, registry, repository };
  }

  private async createActiveSuccessor({
    active,
    harness,
    metadata,
    parent,
    registry,
    repository,
    scopePaths,
    threadId,
    tree,
    withPublish,
  }: {
    active: GitArcRegistryEntry;
    harness: GitArcHarness;
    metadata: CheckpointMetadata;
    parent: string;
    registry: GitArcRegistry;
    repository: WorkbenchGitRepository;
    scopePaths: string[];
    threadId: string;
    tree: string;
    withPublish?: (publish: () => Promise<void>) => Promise<void>;
  }): Promise<GitCheckpointCreateResult> {
    const nextMetadata: CheckpointMetadata = {
      amendedFrom: active.checkpointCommit,
      ...(active.intentDescription ? { intentDescription: active.intentDescription } : {}),
      ...(metadata.intentName ? { intentName: metadata.intentName } : {}),
      kind: "arc",
      ...(metadata.priorProposalId ? { priorProposalId: metadata.priorProposalId } : {}),
      registryLifecycle: true,
      scopePaths,
      version: 3,
    };
    const checkpointCommit = await repository.createCommitFromTree(tree, parent, checkpointMessage(nextMetadata));
    const checkpointRef = await checkpointRefName(repository.root, harness, threadId, checkpointCommit);
    const proposalUpdate = await prepareProposalUnavailableUpdate({
      harness,
      proposalId: active.proposalId,
      reason: "Implementation continued after this proposal was created.",
      repository,
      threadId,
    });
    const registryMutation = await registry.prepareClaim({
      checkpointCommit,
      claimedPaths: scopePaths,
      harness,
      intentDescription: active.intentDescription,
      intentName: nextMetadata.intentName ?? active.intentName,
      proposalId: null,
      threadId,
    }, { expectedCheckpointCommit: active.checkpointCommit });
    const outcomeUpdate = await prepareArcOutcome(repository, harness, threadId, {
      committedSha: null,
      proposalId: active.proposalId,
      sourceCheckpoint: active.checkpointCommit,
      status: "continued",
      successorCheckpoint: checkpointCommit,
      version: 1,
    });
    const publish = async () => await repository.updateRefs([
      ...(proposalUpdate ? [proposalUpdate] : []),
      { newValue: checkpointCommit, oldValue: "0".repeat(40), ref: checkpointRef },
      outcomeUpdate,
      ...(registryMutation.update ? [registryMutation.update] : []),
    ]);
    if (withPublish) await withPublish(publish);
    else await publish();
    return {
      checkpointCommit,
      checkpointRef,
      intentName: nextMetadata.intentName ?? null,
      kind: "arc",
      repoRoot: repository.root,
      scopePaths,
    };
  }

  async listActiveClaims({ cwd }: { cwd: string }): Promise<GitArcActiveClaim[]> {
    const repository = await WorkbenchGitRepository.tryOpen(cwd);
    if (!repository) return [];
    return await Promise.all((await new GitArcRegistry(repository).list()).map(async (entry) => ({
      ...entry,
      proposalStatus: entry.proposalId
        ? (await readProposal(repository.root, normalizeHarness(entry.harness), entry.threadId, entry.proposalId)).metadata.status
        : null,
    })));
  }

  async findActiveClaim({ cwd, harness: rawHarness, threadId }: ControllerInput): Promise<GitArcActiveClaim | null> {
    const repository = await WorkbenchGitRepository.tryOpen(cwd);
    if (!repository) return null;
    const harness = normalizeHarness(rawHarness);
    const entry = await new GitArcRegistry(repository).find({ harness, threadId });
    if (!entry) return null;
    return {
      ...entry,
      proposalStatus: entry.proposalId
        ? (await readProposal(repository.root, harness, threadId, entry.proposalId)).metadata.status
        : null,
    };
  }

  async releaseActiveClaim({ cwd, harness: rawHarness, threadId }: ControllerInput): Promise<void> {
    const repository = await WorkbenchGitRepository.tryOpen(cwd);
    if (!repository) return;
    const harness = normalizeHarness(rawHarness);
    const registry = new GitArcRegistry(repository);
    const active = await registry.find({ harness, threadId });
    if (!active) return;
    const mutation = await registry.prepareRelease(
      { harness, threadId },
      { expectedCheckpointCommit: active.checkpointCommit },
    );
    if (mutation) await repository.updateRefs([mutation.update]);
  }

  async createPlan({
    cwd,
    harness: rawHarness,
    intentName,
    intentDescription = "",
    paths: rawPaths,
    threadId,
  }: ControllerInput & { intentDescription?: string; intentName: string; paths: string[] }): Promise<GitCheckpointCreateResult> {
    const repoRoot = await resolveRepoRoot(cwd);
    const harness = normalizeHarness(rawHarness);
    const paths = normalizePaths(repoRoot, rawPaths);
    const tree = await writeWorktreeTree(repoRoot);
    const parent = (await runGit(repoRoot, ["rev-parse", "HEAD"])).trim();
    const dirtyPaths = await listChangedPaths(repoRoot, parent, tree, paths);
    if (dirtyPaths.length) throw new GitCheckpointDirtyPathsError(dirtyPaths);
    const metadata: CheckpointMetadata = {
      amendedFrom: null,
      ...(intentDescription.trim() ? { intentDescription: intentDescription.trim() } : {}),
      intentName: intentName.trim(),
      kind: "arc",
      registryLifecycle: true,
      scopePaths: paths,
      version: 3,
    };
    const checkpointCommit = await createCommitFromTree(repoRoot, tree, parent, checkpointMessage(metadata));
    const checkpointRef = await createCheckpointRef(repoRoot, harness, threadId, checkpointCommit);
    return {
      checkpointCommit,
      checkpointRef,
      intentName: metadata.intentName ?? null,
      kind: "arc",
      repoRoot,
      scopePaths: paths,
    };
  }

  async startArc({ checkpointCommit, cwd, harness: rawHarness, threadId }: CheckpointInput): Promise<GitCheckpointCompareResult> {
    const repoRoot = await resolveRepoRoot(cwd);
    const harness = normalizeHarness(rawHarness);
    const checkpoint = await readCheckpoint(repoRoot, harness, threadId, checkpointCommit);
    const metadata = requireArcMetadata(checkpoint);
    const paths = normalizePaths(repoRoot, metadata.scopePaths);
    const currentTree = await writeScopedWorktreeTree(repoRoot, paths);
    const changes = await buildFileChanges(repoRoot, checkpoint.checkpointCommit, currentTree, paths);
    if (metadata.version >= 3 && changes.length) {
      throw new Error(`Arc start paths changed after the plan was created: ${changes.map((change) => change.path).join(", ")}`);
    }
    const repository = new WorkbenchGitRepository(repoRoot);
    await new GitArcRegistry(repository).claim({
      checkpointCommit: checkpoint.checkpointCommit,
      claimedPaths: metadata.scopePaths,
      harness,
      intentDescription: metadata.intentDescription ?? "",
      intentName: metadata.intentName ?? "Unnamed arc",
      proposalId: null,
      threadId,
    });
    return {
      changes,
      checkpointCommit: checkpoint.checkpointCommit,
      checkpointRef: checkpoint.checkpointRef,
      intentName: metadata.intentName ?? null,
      repoRoot,
      scopePaths: metadata.scopePaths,
    };
  }

  async continueArc({ checkpointCommit, cwd, harness: rawHarness, threadId }: CheckpointInput): Promise<GitCheckpointCreateResult> {
    const repoRoot = await resolveRepoRoot(cwd);
    const harness = normalizeHarness(rawHarness);
    const source = await readCheckpoint(repoRoot, harness, threadId, checkpointCommit);
    const metadata = requireArcMetadata(source);
    const repository = new WorkbenchGitRepository(repoRoot);
    const registry = new GitArcRegistry(repository);
    const outcome = await readArcOutcome(repository, harness, threadId, source.checkpointCommit);
    const active = await registry.find({ harness, threadId });
    if (active?.checkpointCommit === source.checkpointCommit) {
      if (
        metadata.scopePaths.length !== active.claimedPaths.length
        || metadata.scopePaths.some((scopePath, index) => scopePath !== active.claimedPaths[index])
      ) {
        throw new Error("The active Git arc registry does not match its checkpoint claim set.");
      }
      const headMovement = await repository.classifyHeadMovement(source.parent, metadata.scopePaths, source.checkpointCommit);
      if (headMovement.kind === "incompatible") {
        throw new Error("Repository HEAD moved incompatibly after this arc began. Create a new plan before continuing.");
      }
      if (headMovement.changedPaths.length) {
        throw new Error(`Claimed paths no longer match the arc baseline: ${headMovement.changedPaths.join(", ")}`);
      }
      const tree = await repository.writeTreeWithPathsFromSource(
        headMovement.currentHead,
        source.checkpointCommit,
        metadata.scopePaths,
      );
      return await this.createActiveSuccessor({
        active,
        harness,
        metadata,
        parent: headMovement.currentHead,
        registry,
        repository,
        scopePaths: metadata.scopePaths,
        threadId,
        tree,
      });
    }
    if (outcome?.status === "proposed") {
      throw new Error("This pending proposal no longer belongs to the thread's active Git arc.");
    }
    if (outcome?.status === "released") {
      throw new Error("This arc was restored or unclaimed without a commit. Create a new plan before continuing.");
    }
    if ((outcome?.status === "continued" || outcome?.status === "partial") && outcome.successorCheckpoint) {
      const successor = await readCheckpoint(repoRoot, harness, threadId, outcome.successorCheckpoint);
      const successorMetadata = requireArcMetadata(successor);
      await new GitArcRegistry(repository).claim({
        checkpointCommit: successor.checkpointCommit,
        claimedPaths: successorMetadata.scopePaths,
        harness,
        intentDescription: successorMetadata.intentDescription ?? "",
        intentName: successorMetadata.intentName ?? "Continued arc",
        proposalId: null,
        threadId,
      });
      return {
        checkpointCommit: successor.checkpointCommit,
        checkpointRef: successor.checkpointRef,
        intentName: successorMetadata.intentName ?? null,
        kind: "arc",
        repoRoot,
        scopePaths: successorMetadata.scopePaths,
      };
    }

    const currentHead = await repository.currentHead();
    const headMovement = await repository.classifyHeadMovement(source.parent, metadata.scopePaths, source.checkpointCommit, currentHead);
    if (!outcome && (headMovement.kind !== "fast-forward" || !headMovement.changedPaths.length)) {
      throw new Error("This arc has no completed commit outcome to continue from.");
    }
    if (outcome?.committedSha && currentHead !== outcome.committedSha) {
      const compatible = await repository.classifyHeadMovement(outcome.committedSha, metadata.scopePaths, outcome.committedSha, currentHead);
      if (compatible.kind === "incompatible" || compatible.changedPaths.length) {
        throw new Error("Repository HEAD no longer matches this arc's committed outcome.");
      }
    }

    const scopedWorktree = await repository.writeScopedWorktreeTree(metadata.scopePaths, currentHead);
    const dirtyPaths = await repository.listChangedPaths(currentHead, scopedWorktree, metadata.scopePaths);
    const scopePaths = dirtyPaths.length ? dirtyPaths : metadata.scopePaths;
    const fullWorktree = await repository.writeWorktreeTree();
    const baselineTree = await repository.writeTreeWithPathsFromSource(fullWorktree, currentHead, scopePaths);
    const nextMetadata: CheckpointMetadata = {
      amendedFrom: source.checkpointCommit,
      ...(metadata.intentDescription ? { intentDescription: metadata.intentDescription } : {}),
      ...(metadata.intentName ? { intentName: metadata.intentName } : {}),
      kind: "arc",
      ...(outcome?.proposalId ? { priorProposalId: outcome.proposalId } : {}),
      registryLifecycle: true,
      scopePaths,
      version: 3,
    };
    const nextCommit = await repository.createCommitFromTree(baselineTree, currentHead, checkpointMessage(nextMetadata));
    const checkpointRef = await checkpointRefName(repoRoot, harness, threadId, nextCommit);
    const registryMutation = await new GitArcRegistry(repository).prepareClaim({
      checkpointCommit: nextCommit,
      claimedPaths: scopePaths,
      harness,
      intentDescription: nextMetadata.intentDescription ?? "",
      intentName: nextMetadata.intentName ?? "Continued arc",
      proposalId: null,
      threadId,
    });
    const outcomeUpdate = await prepareArcOutcome(repository, harness, threadId, {
      committedSha: outcome?.committedSha ?? currentHead,
      proposalId: outcome?.proposalId ?? null,
      sourceCheckpoint: source.checkpointCommit,
      status: "partial",
      successorCheckpoint: nextCommit,
      version: 1,
    });
    await repository.updateRefs([
      { newValue: nextCommit, oldValue: "0".repeat(40), ref: checkpointRef },
      outcomeUpdate,
      ...(registryMutation.update ? [registryMutation.update] : []),
    ]);
    return {
      checkpointCommit: nextCommit,
      checkpointRef,
      intentName: nextMetadata.intentName ?? null,
      kind: "arc",
      repoRoot,
      scopePaths,
    };
  }

  async addToArc({ cwd, harness: rawHarness, paths: rawPaths, threadId }: ControllerInput & { paths: string[] }): Promise<GitCheckpointCreateResult> {
    const { active, checkpoint, harness, metadata, registry, repository } = await this.requireActiveArc({ cwd, harness: rawHarness, threadId });
    if (!rawPaths.length) throw new Error("Arc add requires at least one additional clean path.");
    const paths = repository.normalizePaths(rawPaths);
    const headMovement = await repository.classifyHeadMovement(checkpoint.parent, metadata.scopePaths, checkpoint.checkpointCommit);
    if (headMovement.kind === "incompatible") {
      throw new Error("Repository HEAD moved incompatibly after this arc began. Create a new plan before continuing.");
    }
    if (headMovement.changedPaths.length) {
      throw new Error(`Claimed paths no longer match the arc baseline: ${headMovement.changedPaths.join(", ")}`);
    }

    const overlapping = paths.filter((candidate) => metadata.scopePaths.some((scopePath) => (
      pathIsCoveredBy(candidate, scopePath) || pathIsCoveredBy(scopePath, candidate)
    )));
    if (overlapping.length) throw new Error(`Arc paths are already covered by the claimed set: ${overlapping.join(", ")}`);

    if (paths.length) {
      const currentTree = await repository.writeScopedWorktreeTree(paths);
      const dirtyPaths = await repository.listChangedPaths("HEAD", currentTree, paths);
      if (dirtyPaths.length) throw new GitCheckpointDirtyPathsError(dirtyPaths);
    }

    const scopePaths = [...metadata.scopePaths, ...paths].sort((left, right) => left.localeCompare(right));
    const tree = await repository.writeTreeWithPathsFromSource(
      headMovement.currentHead,
      checkpoint.checkpointCommit,
      metadata.scopePaths,
    );
    return await this.createActiveSuccessor({
      active, harness, metadata, parent: headMovement.currentHead, registry, repository, scopePaths, threadId, tree,
    });
  }

  async adoptIntoArc({ cwd, harness: rawHarness, paths: rawPaths, threadId }: ControllerInput & { paths: string[] }): Promise<GitCheckpointCreateResult> {
    const { active, checkpoint, harness, metadata, registry, repository } = await this.requireActiveArc({ cwd, harness: rawHarness, threadId });
    const paths = repository.normalizePaths(rawPaths);
    const overlapping = paths.filter((candidate) => metadata.scopePaths.some((scopePath) => (
      pathIsCoveredBy(candidate, scopePath) || pathIsCoveredBy(scopePath, candidate)
    )));
    if (overlapping.length) throw new Error(`Arc paths are already covered by the claimed set: ${overlapping.join(", ")}`);

    const headMovement = await repository.classifyHeadMovement(checkpoint.parent, metadata.scopePaths, checkpoint.checkpointCommit);
    if (headMovement.kind === "incompatible") {
      throw new Error("Repository HEAD moved incompatibly after this arc began. Create a new plan before continuing.");
    }
    if (headMovement.changedPaths.length) {
      throw new Error(`Claimed paths no longer match the arc baseline: ${headMovement.changedPaths.join(", ")}`);
    }

    const currentTree = await repository.writeScopedWorktreeTree(paths);
    const changedPaths = await repository.listChangedPaths(headMovement.currentHead, currentTree, paths);
    const cleanSelections = paths.filter((candidate) => !changedPaths.some((changedPath) => pathIsCoveredBy(changedPath, candidate)));
    if (cleanSelections.length) {
      throw new Error(`Arc adopt paths must contain working-tree changes: ${cleanSelections.join(", ")}`);
    }

    const scopePaths = [...metadata.scopePaths, ...paths].sort((left, right) => left.localeCompare(right));
    const tree = await repository.writeTreeWithPathsFromSource(
      headMovement.currentHead,
      checkpoint.checkpointCommit,
      metadata.scopePaths,
    );
    return await this.createActiveSuccessor({
      active, harness, metadata, parent: headMovement.currentHead, registry, repository, scopePaths, threadId, tree,
    });
  }

  async removeFromArc({ cwd, harness: rawHarness, paths: rawPaths, threadId }: ControllerInput & { paths: string[] }): Promise<GitCheckpointCreateResult> {
    const activeArc = await this.requireActiveArc({ cwd, harness: rawHarness, threadId });
    const { active, checkpoint, harness, metadata, registry, repository } = activeArc;
    const paths = repository.normalizePaths(rawPaths);
    const unknownPaths = paths.filter((candidate) => !metadata.scopePaths.includes(candidate));
    if (unknownPaths.length) {
      throw new Error(`Arc remove paths must exactly match claimed entries: ${unknownPaths.join(", ")}`);
    }

    const currentTree = await repository.writeScopedWorktreeTree(paths);
    const dirtyPaths = await repository.listChangedPaths("HEAD", currentTree, paths);
    if (dirtyPaths.length) throw new GitCheckpointDirtyPathsError(dirtyPaths, "Arc remove");

    const removedPaths = new Set(paths);
    const scopePaths = metadata.scopePaths.filter((candidate) => !removedPaths.has(candidate));
    if (!scopePaths.length) {
      const proposalUpdate = await prepareProposalUnavailableUpdate({
        harness,
        proposalId: active.proposalId,
        reason: "The active Git arc was unclaimed without committing this proposal.",
        repository,
        threadId,
      });
      const registryMutation = await registry.prepareRelease(
        { harness, threadId },
        { expectedCheckpointCommit: active.checkpointCommit },
      );
      const outcomeUpdate = await prepareArcOutcome(repository, harness, threadId, {
        committedSha: null,
        proposalId: null,
        sourceCheckpoint: checkpoint.checkpointCommit,
        status: "released",
        successorCheckpoint: null,
        version: 1,
      });
      await repository.updateRefs([
        ...(proposalUpdate ? [proposalUpdate] : []),
        outcomeUpdate,
        ...(registryMutation ? [registryMutation.update] : []),
      ]);
      return {
        checkpointCommit: checkpoint.checkpointCommit,
        checkpointRef: checkpoint.checkpointRef,
        intentName: metadata.intentName ?? null,
        kind: "arc",
        repoRoot: repository.root,
        scopePaths: [],
      };
    }

    const headMovement = await repository.classifyHeadMovement(checkpoint.parent, scopePaths, checkpoint.checkpointCommit);
    if (headMovement.kind === "incompatible") {
      throw new Error("Repository HEAD moved incompatibly after this arc began. Create a new plan before continuing.");
    }
    if (headMovement.changedPaths.length) {
      throw new Error(`Retained paths no longer match the arc baseline: ${headMovement.changedPaths.join(", ")}`);
    }

    const tree = await repository.writeTreeWithPathsFromSource(
      headMovement.currentHead,
      checkpoint.checkpointCommit,
      scopePaths,
    );
    return await this.createActiveSuccessor({
      active, harness, metadata, parent: headMovement.currentHead, registry, repository, scopePaths, threadId, tree,
    });
  }

  async moveInArc({ cwd, harness: rawHarness, move, threadId }: ControllerInput & { move: GitArcMoveRequest }): Promise<GitArcMoveResult> {
    const { active, checkpoint, harness, metadata, registry, repository } = await this.requireActiveArc({ cwd, harness: rawHarness, threadId });
    const headMovement = await repository.classifyHeadMovement(checkpoint.parent, metadata.scopePaths, checkpoint.checkpointCommit);
    if (headMovement.kind === "incompatible") {
      throw new Error("Repository HEAD moved incompatibly after this arc began. Create a new plan before continuing.");
    }
    if (headMovement.changedPaths.length) {
      throw new Error(`Claimed paths no longer match the arc baseline: ${headMovement.changedPaths.join(", ")}`);
    }

    const mover = new GitArcPathMover(repository);
    const resolved = await mover.resolve(move);
    const candidates = [...new Set(resolved.mappings.flatMap(({ destination, source }) => [source, destination]))]
      .sort((left, right) => left.length - right.length || left.localeCompare(right));
    const additionalClaims: string[] = [];
    for (const candidate of candidates) {
      if ([...metadata.scopePaths, ...additionalClaims].some((scopePath) => pathIsCoveredBy(candidate, scopePath))) continue;
      additionalClaims.push(candidate);
    }
    const scopePaths = [...metadata.scopePaths, ...additionalClaims].sort((left, right) => left.localeCompare(right));

    if (move.kind === "regex" && !move.confirm) {
      return {
        additionalClaims,
        checkpointCommit: checkpoint.checkpointCommit,
        checkpointRef: checkpoint.checkpointRef,
        intentName: metadata.intentName ?? null,
        kind: "arc",
        mappings: resolved.mappings,
        matchedPathCount: resolved.matchedPathCount,
        mode: "preview",
        remainingMatchCount: resolved.remainingMatchCount,
        repoRoot: repository.root,
        scopePaths: metadata.scopePaths,
      };
    }

    const tree = await repository.writeTreeWithPathsFromSource(
      headMovement.currentHead,
      checkpoint.checkpointCommit,
      metadata.scopePaths,
    );
    const successor = await this.createActiveSuccessor({
      active, harness, metadata, parent: headMovement.currentHead, registry, repository, scopePaths, threadId, tree,
      withPublish: async (publish) => await mover.apply(resolved.mappings, publish),
    });
    return {
      ...successor,
      additionalClaims,
      mappings: resolved.mappings,
      matchedPathCount: resolved.matchedPathCount,
      mode: "applied",
      remainingMatchCount: resolved.remainingMatchCount,
    };
  }

  async compare({ cwd, harness: rawHarness, paths: rawPaths, threadId }: ControllerInput & { paths?: string[] }): Promise<GitCheckpointCompareResult> {
    const { checkpoint, metadata, repository } = await this.requireActiveArc({ cwd, harness: rawHarness, threadId });
    const paths = rawPaths?.length ? repository.normalizePaths(rawPaths) : repository.normalizePaths(metadata.scopePaths);
    const currentTree = await repository.writeScopedWorktreeTree(paths);
    return {
      changes: await repository.buildFileChanges(checkpoint.checkpointCommit, currentTree, paths),
      checkpointCommit: checkpoint.checkpointCommit,
      checkpointRef: checkpoint.checkpointRef,
      intentName: metadata.intentName ?? null,
      repoRoot: repository.root,
      scopePaths: metadata.scopePaths,
    };
  }

  async diff(input: ControllerInput & { paths?: string[] }): Promise<GitCheckpointDiffResult> {
    const result = await this.compare(input);
    return {
      ...result,
      diff: result.changes.map((change) => change.diff).join(""),
    };
  }

  async createProposal({
    amend,
    cwd,
    description,
    harness: rawHarness,
    paths: rawPaths,
    threadId,
    title,
  }: ControllerInput & { amend?: boolean; description: string; paths?: string[]; title: string }): Promise<GitCheckpointProposalReceipt> {
    const { active, checkpoint, harness, metadata: checkpointMetadata, registry, repository } = await this.requireActiveArc({ cwd, harness: rawHarness, threadId });
    let priorProposal: ReadProposalResult | null = null;
    if (active.proposalId) {
      const activeProposal = await readProposal(repository.root, harness, threadId, active.proposalId);
      if (activeProposal.metadata.status === "proposed") {
        priorProposal = activeProposal;
      }
    }
    const repoRoot = repository.root;
    const requestedPaths = rawPaths?.length
      ? normalizePaths(repoRoot, rawPaths)
      : normalizePaths(repoRoot, checkpointMetadata.scopePaths);
    if (rawPaths?.length) {
      const outsideClaim = requestedPaths.filter((candidate) => (
        !checkpointMetadata.scopePaths.some((scopePath) => pathIsCoveredBy(candidate, scopePath))
      ));
      if (outsideClaim.length) {
        throw new Error(`Proposed paths must stay within the arc's claimed set: ${outsideClaim.join(", ")}`);
      }
    }
    const headMovement = await classifyHeadMovement(
      repoRoot,
      checkpoint.parent,
      requestedPaths,
      checkpoint.checkpointCommit,
    );
    if (headMovement.kind === "incompatible") {
      throw new Error("Repository HEAD moved incompatibly after this arc began. Create a new plan before proposing a commit.");
    }
    if (headMovement.changedPaths.length) {
      throw new Error(`Proposed paths no longer match the arc baseline: ${headMovement.changedPaths.join(", ")}`);
    }
    const liveBaseCommit = headMovement.currentHead;
    if (amend) await new GitArcPublishState(repository).requireAmendableCurrentHead();
    const baseCommit = amend ? await repository.resolveParent(liveBaseCommit) : liveBaseCommit;
    const proposalTree = await writeScopedWorktreeTree(repoRoot, requestedPaths, liveBaseCommit);
    const livePaths = await listChangedPaths(repoRoot, liveBaseCommit, proposalTree, requestedPaths);
    if (!livePaths.length) throw new Error("The selected arc paths do not contain any working-tree changes to propose.");
    const paths = amend
      ? await listChangedPaths(repoRoot, baseCommit, proposalTree, ["."])
      : livePaths;
    const inheritedMessage = amend ? parseCommitMessage(await repository.readCommitMessage(liveBaseCommit)) : null;
    const proposalTitle = title.trim() || inheritedMessage?.title || "";
    const proposalDescription = title.trim() ? description.trim() : inheritedMessage?.description ?? description.trim();
    const proposalId = randomUUID();
    const metadata: ProposalMetadata = {
      amendTargetSha: amend ? liveBaseCommit : null,
      baseCommit,
      committedSha: null,
      description: proposalDescription,
      liveBaseCommit,
      livePaths,
      mode: amend ? "amend" : "commit",
      paths,
      proposalId,
      sourceCheckpoint: checkpoint.checkpointCommit,
      status: "proposed",
      supersededByProposalId: null,
      supersededBySha: null,
      title: proposalTitle,
      unavailableReason: null,
      version: 2,
    };
    commitMessage(metadata.title, metadata.description);
    const proposalCommit = await createCommitFromTree(repoRoot, proposalTree, baseCommit, proposalMessage(metadata));
    await buildProposalFileChanges(repoRoot, metadata, proposalCommit, harness, threadId);
    const outcomeUpdate = await prepareArcOutcome(repository, harness, threadId, {
      committedSha: null,
      proposalId,
      sourceCheckpoint: checkpoint.checkpointCommit,
      status: "proposed",
      successorCheckpoint: null,
      version: 1,
    });
    const registryMutation = await registry.prepareClaim({
      checkpointCommit: checkpoint.checkpointCommit,
      claimedPaths: checkpointMetadata.scopePaths,
      harness,
      intentDescription: active.intentDescription,
      intentName: checkpointMetadata.intentName ?? active.intentName,
      proposalId,
      threadId,
    }, { expectedCheckpointCommit: active.checkpointCommit });
    let supersededProposalUpdate: { newValue: string; oldValue: string; ref: string } | null = null;
    if (priorProposal) {
      const supersededMetadata: ProposalMetadata = {
        ...priorProposal.metadata,
        status: "superseded",
        supersededByProposalId: proposalId,
        supersededBySha: null,
      };
      const supersededState = await repository.createCommitFromTree(
        priorProposal.tree,
        priorProposal.metadata.baseCommit,
        proposalMessage(supersededMetadata),
      );
      supersededProposalUpdate = {
        newValue: supersededState,
        oldValue: priorProposal.proposalCommit,
        ref: priorProposal.proposalRef,
      };
    }
    await repository.updateRefs([
      ...(supersededProposalUpdate ? [supersededProposalUpdate] : []),
      { newValue: proposalCommit, oldValue: "0".repeat(40), ref: `${proposalNamespace(harness, threadId)}/${proposalId}` },
      outcomeUpdate,
      ...(registryMutation.update ? [registryMutation.update] : []),
    ]);
    return {
      baseCommit,
      description: metadata.description,
      intentName: checkpointMetadata.intentName ?? null,
      paths: metadata.paths,
      proposalId,
      scopePaths: checkpointMetadata.scopePaths,
      sourceCheckpoint: checkpoint.checkpointCommit,
      title: metadata.title,
    } satisfies GitCheckpointProposalReceipt;
  }

  async getProposal({
    cwd,
    harness: rawHarness,
    includeNewer,
    proposalId,
    threadId,
  }: ControllerInput & { includeNewer: boolean; proposalId: string }): Promise<GitCheckpointProposal> {
    const repoRoot = await resolveRepoRoot(cwd);
    const harness = normalizeHarness(rawHarness);
    const { currentTree, includeNewerAvailable, proposal } = await resolveProposalState(
      repoRoot,
      harness,
      threadId,
      proposalId,
    );
    const target = (proposal.metadata.status === "committed" || proposal.metadata.status === "superseded") && proposal.metadata.committedSha
      ? proposal.metadata.committedSha
      : includeNewer && includeNewerAvailable && currentTree
        ? currentTree
        : proposal.proposalCommit;
    return await buildProposalResult(repoRoot, proposal.metadata, target, harness, threadId, includeNewerAvailable);
  }

  async commitProposal({
    cwd,
    description,
    harness: rawHarness,
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
    const harness = normalizeHarness(rawHarness);
    const resolved = await resolveProposalState(repoRoot, harness, threadId, proposalId);
    const proposal = resolved.proposal;
    if (proposal.metadata.status !== "proposed") {
      throw new Error(proposal.metadata.unavailableReason || "Checkpoint proposal is not available to commit.");
    }
    const repository = new WorkbenchGitRepository(repoRoot);
    if (proposal.metadata.mode === "amend") {
      const message = commitMessage(title, description);
      const targetTree = includeNewer && resolved.includeNewerAvailable
        ? resolved.currentTree!
        : proposal.tree;
      const source = await readCheckpoint(repoRoot, harness, threadId, proposal.metadata.sourceCheckpoint);
      const sourceMetadata = requireArcMetadata(source);
      const priorProposal = sourceMetadata.priorProposalId
        ? await readProposal(repoRoot, harness, threadId, sourceMetadata.priorProposalId)
        : null;
      const supersededPrior = priorProposal?.metadata.status === "committed"
        && priorProposal.metadata.committedSha === proposal.metadata.amendTargetSha
        ? priorProposal
        : null;
      const oldOutcomeRef = outcomeRef(harness, threadId, source.checkpointCommit);
      let committedMetadata: ProposalMetadata | null = null;
      const rewritten = await new WorkbenchGitHistoryRewriter(repository).amend({
        excludeArcRefs: [
          proposal.proposalRef,
          REGISTRY_REF,
          oldOutcomeRef,
          ...(supersededPrior ? [supersededPrior.proposalRef] : []),
        ],
        expectedHead: proposal.metadata.amendTargetSha,
        message,
        paths: proposal.metadata.livePaths,
        target: proposal.metadata.amendTargetSha,
        targetTree,
        mutatePlan: async ({ amendedCommit, arcPlan }) => {
          const remappedSource = arcPlan.commits.get(source.checkpointCommit) ?? source.checkpointCommit;
          committedMetadata = {
            ...remapProposalMetadata(proposal.metadata, arcPlan.commits),
            amendTargetSha: amendedCommit,
            committedSha: amendedCommit,
            description: description.trim(),
            liveBaseCommit: amendedCommit,
            sourceCheckpoint: remappedSource,
            status: "committed",
            title: title.trim(),
            unavailableReason: null,
          };
          const stateCommit = await repository.createCommitFromTree(
            targetTree,
            committedMetadata.baseCommit,
            proposalMessage(committedMetadata),
          );
          const updates: GitRefUpdate[] = [
            { newValue: stateCommit, oldValue: proposal.proposalCommit, ref: proposal.proposalRef },
          ];
          const replaceRefs = [proposal.proposalRef, REGISTRY_REF];

          if (supersededPrior) {
            const priorMetadata: ProposalMetadata = {
              ...remapProposalMetadata(supersededPrior.metadata, arcPlan.commits),
              committedSha: amendedCommit,
              status: "superseded",
              supersededByProposalId: proposalId,
              supersededBySha: amendedCommit,
            };
            const priorState = await repository.createCommitFromTree(
              supersededPrior.tree,
              priorMetadata.baseCommit,
              proposalMessage(priorMetadata),
            );
            updates.push({ newValue: priorState, oldValue: supersededPrior.proposalCommit, ref: supersededPrior.proposalRef });
            replaceRefs.push(supersededPrior.proposalRef);
          }

          const currentTree = await repository.writeScopedWorktreeTree(sourceMetadata.scopePaths, amendedCommit);
          const remainingPaths = await repository.listChangedPaths(amendedCommit, currentTree, sourceMetadata.scopePaths);
          let successorCommit: string | null = null;
          if (remainingPaths.length) {
            const fullWorktree = await repository.writeWorktreeTree();
            const baselineTree = await repository.writeTreeWithPathsFromSource(fullWorktree, amendedCommit, remainingPaths);
            successorCommit = await repository.createCommitFromTree(baselineTree, amendedCommit, checkpointMessage({
              amendedFrom: remappedSource,
              ...(sourceMetadata.intentDescription ? { intentDescription: sourceMetadata.intentDescription } : {}),
              ...(sourceMetadata.intentName ? { intentName: sourceMetadata.intentName } : {}),
              kind: "arc",
              priorProposalId: proposalId,
              registryLifecycle: true,
              scopePaths: remainingPaths,
              version: 3,
            }));
            updates.push({
              newValue: successorCommit,
              oldValue: "0".repeat(40),
              ref: await checkpointRefName(repoRoot, harness, threadId, successorCommit),
            });
          }
          const registry = new GitArcRegistry(repository);
          const active = await registry.find({ harness, threadId });
          const registryMutation = !active ? null : successorCommit
            ? await registry.prepareClaim({
              checkpointCommit: successorCommit,
              claimedPaths: remainingPaths,
              harness,
              intentDescription: active.intentDescription,
              intentName: sourceMetadata.intentName ?? active.intentName,
              proposalId,
              threadId,
            }, {
              commitRemaps: arcPlan.commits,
              expectedCheckpointCommit: source.checkpointCommit,
            })
            : await registry.prepareRelease({ harness, threadId }, {
              commitRemaps: arcPlan.commits,
              expectedCheckpointCommit: source.checkpointCommit,
            });
          const registryUpdate = registryMutation?.update
            ?? (!active ? await registry.prepareCommitRemap(arcPlan.commits) : null);
          if (registryUpdate) updates.push(registryUpdate);

          const oldOutcome = await repository.readRef(oldOutcomeRef);
          const nextOutcomeRef = outcomeRef(harness, threadId, remappedSource);
          const outcomeBlob = await repository.writeBlob(`${JSON.stringify({
            committedSha: amendedCommit,
            proposalId,
            sourceCheckpoint: remappedSource,
            status: successorCommit ? "partial" : "committed",
            successorCheckpoint: successorCommit,
            version: 1,
          } satisfies ArcOutcome)}\n`);
          updates.push({
            newValue: outcomeBlob,
            oldValue: oldOutcomeRef === nextOutcomeRef ? oldOutcome ?? "0".repeat(40) : "0".repeat(40),
            ref: nextOutcomeRef,
          });
          replaceRefs.push(oldOutcomeRef, nextOutcomeRef);
          return {
            deletes: oldOutcome && oldOutcomeRef !== nextOutcomeRef ? [{ oldValue: oldOutcome, ref: oldOutcomeRef }] : [],
            replaceRefs,
            updates,
          };
        },
      });
      if (!committedMetadata) throw new Error("Amend proposal metadata was not committed.");
      return await buildProposalResult(repoRoot, committedMetadata, rewritten.amendedCommit, harness, threadId);
    }
    const message = commitMessage(title, description);
    const targetTree = includeNewer && resolved.includeNewerAvailable
      ? resolved.currentTree!
      : proposal.tree;
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
    const source = await readCheckpoint(repoRoot, harness, threadId, proposal.metadata.sourceCheckpoint);
    const sourceMetadata = requireArcMetadata(source);
    let supersededProposalUpdate: { newValue: string; oldValue: string; ref: string } | null = null;
    if (sourceMetadata.priorProposalId) {
      const priorProposal = await readProposal(repoRoot, harness, threadId, sourceMetadata.priorProposalId);
      if (
        priorProposal.metadata.status === "committed"
        && priorProposal.metadata.committedSha === proposal.metadata.amendTargetSha
      ) {
        const supersededMetadata: ProposalMetadata = {
          ...priorProposal.metadata,
          status: "superseded",
          supersededByProposalId: proposalId,
          supersededBySha: committedSha,
        };
        const supersededState = await repository.createCommitFromTree(
          priorProposal.tree,
          priorProposal.metadata.baseCommit,
          proposalMessage(supersededMetadata),
        );
        supersededProposalUpdate = {
          newValue: supersededState,
          oldValue: priorProposal.proposalCommit,
          ref: priorProposal.proposalRef,
        };
      }
    }
    const currentTree = await repository.writeScopedWorktreeTree(sourceMetadata.scopePaths, committedSha);
    const remainingPaths = await repository.listChangedPaths(committedSha, currentTree, sourceMetadata.scopePaths);
    let successorCommit: string | null = null;
    let successorRef: string | null = null;
    if (remainingPaths.length) {
      const fullWorktree = await repository.writeWorktreeTree();
      const baselineTree = await repository.writeTreeWithPathsFromSource(
        fullWorktree,
        committedSha,
        sourceMetadata.scopePaths,
      );
      const successorMetadata: CheckpointMetadata = {
        amendedFrom: source.checkpointCommit,
        ...(sourceMetadata.intentDescription ? { intentDescription: sourceMetadata.intentDescription } : {}),
        ...(sourceMetadata.intentName ? { intentName: sourceMetadata.intentName } : {}),
        kind: "arc",
        priorProposalId: proposalId,
        registryLifecycle: true,
        scopePaths: sourceMetadata.scopePaths,
        version: 3,
      };
      successorCommit = await repository.createCommitFromTree(
        baselineTree,
        committedSha,
        checkpointMessage(successorMetadata),
      );
      successorRef = await checkpointRefName(repoRoot, harness, threadId, successorCommit);
    }

    const registry = new GitArcRegistry(repository);
    const active = await registry.find({ harness, threadId });
    const registryMutation = !active
      ? null
      : successorCommit
        ? await registry.prepareClaim({
          checkpointCommit: successorCommit,
          claimedPaths: sourceMetadata.scopePaths,
          harness,
          intentDescription: active.intentDescription,
          intentName: sourceMetadata.intentName ?? active.intentName,
          proposalId,
          threadId,
        }, { expectedCheckpointCommit: source.checkpointCommit })
        : await registry.prepareRelease({ harness, threadId }, { expectedCheckpointCommit: source.checkpointCommit });
    const outcomeUpdate = await prepareArcOutcome(repository, harness, threadId, {
      committedSha,
      proposalId,
      sourceCheckpoint: source.checkpointCommit,
      status: successorCommit ? "partial" : "committed",
      successorCheckpoint: successorCommit,
      version: 1,
    });
    const headRef = await repository.symbolicHead() ?? "HEAD";
    await repository.updateRefs([
      { newValue: committedSha, oldValue: proposal.metadata.liveBaseCommit, ref: headRef },
      { newValue: stateCommit, oldValue: proposal.proposalCommit, ref: proposal.proposalRef },
      outcomeUpdate,
      ...(successorCommit && successorRef
        ? [{ newValue: successorCommit, oldValue: "0".repeat(40), ref: successorRef }]
        : []),
      ...(registryMutation?.update ? [registryMutation.update] : []),
      ...(supersededProposalUpdate ? [supersededProposalUpdate] : []),
    ]);
    await runGit(repoRoot, ["reset", "--mixed", "--quiet", committedSha, "--", ...proposal.metadata.livePaths.map(literalPathspec)]);
    return await buildProposalResult(repoRoot, committedMetadata, committedSha, harness, threadId);
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
    harness: rawHarness,
    paths: rawPaths,
    threadId,
  }: CheckpointInput & { confirmRestore?: boolean; paths?: string[] }) {
    if (!rawPaths?.length && !confirmRestore) throw new Error("Checkpoint restore requires confirmation or selected paths.");
    const repoRoot = await resolveRepoRoot(cwd);
    const harness = normalizeHarness(rawHarness);

    if (!rawPaths?.length) {
      const checkpoint = await readRestorableCheckpoint(repoRoot, harness, threadId, checkpointCommit);
      const metadata = requireArcMetadata(checkpoint);
      const repository = new WorkbenchGitRepository(repoRoot);
      const registry = new GitArcRegistry(repository);
      const active = await registry.find({ harness, threadId });
      if (active && active.checkpointCommit !== checkpoint.checkpointCommit) {
        throw new Error("This thread owns a different active Git arc. Restore that arc or release it before restoring historical work.");
      }
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
      const registryMutation = active
        ? await registry.prepareRelease({ harness, threadId }, { expectedCheckpointCommit: active.checkpointCommit })
        : null;
      const proposalUpdate = active
        ? await prepareProposalUnavailableUpdate({
          harness,
          proposalId: active.proposalId,
          reason: "The active Git arc was restored and unclaimed without committing this proposal.",
          repository,
          threadId,
        })
        : null;
      const outcomeUpdate = await prepareArcOutcome(repository, harness, threadId, {
        committedSha: null,
        proposalId: null,
        sourceCheckpoint: checkpoint.checkpointCommit,
        status: "released",
        successorCheckpoint: null,
        version: 1,
      });
      await repository.updateRefs([
        ...(proposalUpdate ? [proposalUpdate] : []),
        outcomeUpdate,
        ...(registryMutation ? [registryMutation.update] : []),
      ]);
      return {
        checkpointCommit: checkpoint.checkpointCommit,
        checkpointRef: checkpoint.checkpointRef,
        intentName: metadata.intentName ?? null,
        repoRoot,
        restored: true as const,
        scopePaths: metadata.scopePaths,
      };
    }

    const releasingArc = confirmRestore
      ? await this.requireActiveArc({ cwd: repoRoot, harness, threadId })
      : null;
    if (releasingArc && releasingArc.checkpoint.checkpointCommit !== checkpointCommit) {
      throw new Error("The restore ref does not match this thread's active Git arc.");
    }
    const paths = normalizePaths(repoRoot, rawPaths);
    if (releasingArc && (
      paths.length !== releasingArc.active.claimedPaths.length
      || paths.some((filePath, index) => filePath !== releasingArc.active.claimedPaths[index])
    )) {
      throw new Error("Restore & unclaim must select the active arc's complete claimed file set.");
    }
    const checkpoint = releasingArc?.checkpoint
      ?? await readCheckpoint(repoRoot, harness, threadId, checkpointCommit);
    const metadata = releasingArc?.metadata ?? requireArcMetadata(checkpoint);
    const headMovement = await classifyHeadMovement(
      repoRoot,
      checkpoint.parent,
      paths,
      checkpoint.checkpointCommit,
    );
    if (headMovement.kind === "incompatible") {
      throw new Error("Repository HEAD moved incompatibly after this checkpoint. Ask the user before restoring selected paths.");
    }
    if (headMovement.changedPaths.length) {
      throw new Error(`Selected restore paths no longer match the arc baseline: ${headMovement.changedPaths.join(", ")}`);
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
    if (releasingArc) {
      const proposalUpdate = await prepareProposalUnavailableUpdate({
        harness,
        proposalId: releasingArc.active.proposalId,
        reason: "The active Git arc was restored and unclaimed without committing this proposal.",
        repository: releasingArc.repository,
        threadId,
      });
      const registryMutation = await releasingArc.registry.prepareRelease(
        { harness, threadId },
        { expectedCheckpointCommit: releasingArc.active.checkpointCommit },
      );
      const outcomeUpdate = await prepareArcOutcome(releasingArc.repository, harness, threadId, {
        committedSha: null,
        proposalId: null,
        sourceCheckpoint: checkpoint.checkpointCommit,
        status: "released",
        successorCheckpoint: null,
        version: 1,
      });
      await releasingArc.repository.updateRefs([
        ...(proposalUpdate ? [proposalUpdate] : []),
        outcomeUpdate,
        ...(registryMutation ? [registryMutation.update] : []),
      ]);
    }
    return {
      checkpointCommit: checkpoint.checkpointCommit,
      checkpointRef: checkpoint.checkpointRef,
      intentName: metadata.intentName ?? null,
      repoRoot,
      restored: true as const,
      restoredPaths: [...new Set(changedPaths)].sort((left, right) => left.localeCompare(right)),
      scopePaths: metadata.scopePaths,
    };
  }
}
