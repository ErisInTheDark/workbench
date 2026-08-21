/*
 * Exports:
 * - default WorkbenchGitCheckpointController: route plan and proposal owners while owning active claim mutation, compare, diff, and restore orchestration. Keywords: git, checkpoint, arc, claims, restore.
 * - GitArcActiveClaim/GitArcPlanState/GitArcProposalStatus: expose active-claim, inactive-plan, and proposal lifecycle for thread-state projection. Keywords: git, arc, claim, plan, proposal, status.
 * - GitCheckpointDirtyPathsError: identify paths that must be clean before an arc operation. Keywords: git, checkpoint, dirty paths.
 * - GitCheckpointCreateResult/GitCheckpointCompareResult/GitCheckpointDiffResult/GitCheckpointProposalReceipt/GitArcMoveResult: typed controller operation results. Keywords: git, checkpoint, arc, move, proposal, result.
 */
import { execFile, spawn } from "node:child_process";
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
import GitArcRegistry, { type GitArcRegistryEntry } from "./GitArcRegistry";
import GitArcPathMover, { type GitArcResolvedMove } from "./GitArcPathMover";
import GitArcPlanController, { GitCheckpointDirtyPathsError, type GitArcPlanState } from "./GitArcPlanController";
import GitArcProposalController, {
  type GitArcLifecycleState,
  type GitCheckpointProposalReceipt,
} from "./GitArcProposalController";
import GitCheckpointStore from "./GitCheckpointStore";
import WorkbenchGitRepository from "./WorkbenchGitRepository";
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
  normalizeCommit,
  normalizeThreadId,
  parseMarkedMetadata,
} from "./git-arc-storage";

export type { GitArcProposalStatus } from "./git-arc-storage";
export { GitCheckpointDirtyPathsError } from "./GitArcPlanController";
export type { GitArcPlanState } from "./GitArcPlanController";
export type { GitArcLifecycleState, GitCheckpointProposalReceipt } from "./GitArcProposalController";

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

interface HeadMovement {
  changedPaths: string[];
  currentHead: string;
  kind: "fast-forward" | "incompatible" | "same";
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
  return await new GitCheckpointStore(repository).readOutcome(harness, threadId, sourceCheckpoint);
}

async function prepareArcOutcome(
  repository: WorkbenchGitRepository,
  harness: GitArcHarness,
  threadId: string,
  outcome: ArcOutcome,
) {
  return await new GitCheckpointStore(repository).prepareOutcome(harness, threadId, outcome);
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

async function checkpointRefName(repoRoot: string, harness: GitArcHarness, threadId: string, commit: string) {
  return await new GitCheckpointStore(new WorkbenchGitRepository(repoRoot)).checkpointRefName(harness, threadId, commit);
}

async function readCheckpoint(repoRoot: string, harness: GitArcHarness, threadId: string, rawCommit: string): Promise<ReadCheckpointResult> {
  return await new GitCheckpointStore(new WorkbenchGitRepository(repoRoot)).readCheckpoint(harness, threadId, rawCommit);
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

export default class WorkbenchGitCheckpointController {
  private readonly plans = new GitArcPlanController();
  private readonly proposals = new GitArcProposalController();

  private async requireActiveArc({ cwd, harness: rawHarness, threadId }: ControllerInput) {
    const repository = await WorkbenchGitRepository.open(cwd);
    const harness = normalizeHarness(rawHarness);
    const registry = new GitArcRegistry(repository);
    const active = await registry.find({ harness, threadId });
    if (!active || active.phase !== "active") throw new Error("This thread does not own an active Git arc.");
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

  private async requireMutableActiveArc(input: ControllerInput) {
    const activeArc = await this.requireActiveArc(input);
    await this.proposals.requireNoAcceptedReceipts({
      checkpointCommit: activeArc.active.checkpointCommit,
      cwd: activeArc.repository.root,
      harness: activeArc.harness,
      threadId: input.threadId,
    });
    return activeArc;
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
    const proposalUpdates = await this.proposals.prepareUnavailableUpdates({
      cwd: repository.root,
      harness,
      proposalIds: active.proposalIds ?? (active.proposalId ? [active.proposalId] : []),
      reason: "Implementation continued after this proposal was created.",
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
      ...proposalUpdates,
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
    const store = new GitCheckpointStore(repository);
    const entries = (await new GitArcRegistry(repository).list()).filter((entry) => entry.phase === "active" && entry.claimedPaths.length > 0);
    return await Promise.all(entries.map(async (entry) => ({
      ...entry,
      proposalStatus: entry.proposalId
        ? (await store.readProposal(normalizeHarness(entry.harness), entry.threadId, entry.proposalId)).metadata.status
        : null,
    })));
  }

  async findActiveClaim({ cwd, harness: rawHarness, threadId }: ControllerInput): Promise<GitArcActiveClaim | null> {
    const repository = await WorkbenchGitRepository.tryOpen(cwd);
    if (!repository) return null;
    const harness = normalizeHarness(rawHarness);
    const store = new GitCheckpointStore(repository);
    const entry = await new GitArcRegistry(repository).find({ harness, threadId });
    if (!entry || entry.phase !== "active" || !entry.claimedPaths.length) return null;
    return {
      ...entry,
      proposalStatus: entry.proposalId
        ? (await store.readProposal(harness, threadId, entry.proposalId)).metadata.status
        : null,
    };
  }

  async listLifecycleStates({ cwd }: { cwd: string }): Promise<GitArcLifecycleState[]> {
    return await this.proposals.listLifecycleStates({ cwd });
  }

  async findLifecycleState(input: ControllerInput): Promise<GitArcLifecycleState | null> {
    return await this.proposals.findLifecycleState(input);
  }

  async listPlanStates({ cwd }: { cwd: string }): Promise<GitArcPlanState[]> {
    return await this.plans.listPlanStates({ cwd });
  }

  async findPlanState(input: ControllerInput): Promise<GitArcPlanState | null> {
    return await this.plans.findPlanState(input);
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
    adoptPaths,
    cwd,
    harness: rawHarness,
    intentName,
    intentDescription = "",
    paths: rawPaths,
    threadId,
  }: ControllerInput & { adoptPaths?: string[]; intentDescription?: string; intentName: string; paths: string[] }): Promise<GitCheckpointCreateResult> {
    return await this.plans.createPlan({ adoptPaths, cwd, harness: rawHarness, intentDescription, intentName, paths: rawPaths, threadId });
  }

  async addToPlan(input: ControllerInput & { paths: string[] }) {
    return await this.plans.addToPlan(input);
  }

  async adoptIntoPlan(input: ControllerInput & { paths: string[] }) {
    return await this.plans.adoptIntoPlan(input);
  }

  async removeFromPlan(input: ControllerInput & { paths: string[] }) {
    return await this.plans.removeFromPlan(input);
  }

  async createAndStartPlan(input: ControllerInput & { adoptPaths?: string[]; intentDescription?: string; intentName: string; paths: string[] }) {
    return await this.plans.createAndStartPlan(input);
  }

  async startArc({ checkpointCommit, cwd, harness: rawHarness, threadId }: ControllerInput & { checkpointCommit?: string }): Promise<GitCheckpointCompareResult> {
    return await this.plans.startArc({ checkpointCommit, cwd, harness: rawHarness, threadId });
  }

  async continueArc({ checkpointCommit: observedCheckpoint, cwd, harness: rawHarness, threadId }: CheckpointInput): Promise<GitCheckpointCreateResult> {
    const repoRoot = await resolveRepoRoot(cwd);
    const harness = normalizeHarness(rawHarness);
    const repository = new WorkbenchGitRepository(repoRoot);
    const registry = new GitArcRegistry(repository);
    const registered = await registry.find({ harness, threadId });
    let checkpointCommit = observedCheckpoint;
    let resolvedForward = false;
    if (registered?.phase !== "plan" && registered?.checkpointCommit !== observedCheckpoint) {
      let cursor = registered.checkpointCommit;
      for (let depth = 0; depth < 100; depth += 1) {
        const candidate = await readCheckpoint(repoRoot, harness, threadId, cursor);
        if (candidate.metadata?.amendedFrom === observedCheckpoint) {
          checkpointCommit = registered.checkpointCommit;
          resolvedForward = true;
          break;
        }
        if (!candidate.metadata?.amendedFrom) break;
        cursor = candidate.metadata.amendedFrom;
      }
    }
    const source = await readCheckpoint(repoRoot, harness, threadId, checkpointCommit);
    const metadata = requireArcMetadata(source);
    const outcome = await readArcOutcome(repository, harness, threadId, source.checkpointCommit);
    if (outcome?.acceptedProposals?.length) {
      await this.proposals.requireNoAcceptedReceipts({ checkpointCommit: source.checkpointCommit, cwd: repoRoot, harness, threadId });
    }
    if (outcome?.status === "proposed") {
      throw new Error("This pending proposal no longer belongs to the thread's active Git arc.");
    }
    if (outcome?.status === "released") {
      throw new Error("This arc was restored or unclaimed without a commit. Create a new plan before continuing.");
    }
    const active = await registry.find({ harness, threadId });
    if (resolvedForward && active?.phase === "active" && active.checkpointCommit === source.checkpointCommit) {
      return {
        checkpointCommit: source.checkpointCommit,
        checkpointRef: source.checkpointRef,
        intentName: metadata.intentName ?? null,
        kind: "arc",
        repoRoot,
        scopePaths: metadata.scopePaths,
      };
    }
    if (active?.phase === "active" && active.checkpointCommit === source.checkpointCommit) {
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
    const { active, checkpoint, harness, metadata, registry, repository } = await this.requireMutableActiveArc({ cwd, harness: rawHarness, threadId });
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
    const { active, checkpoint, harness, metadata, registry, repository } = await this.requireMutableActiveArc({ cwd, harness: rawHarness, threadId });
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
    const activeArc = await this.requireMutableActiveArc({ cwd, harness: rawHarness, threadId });
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
      const proposalUpdates = await this.proposals.prepareUnavailableUpdates({
        cwd: repository.root,
        harness,
        proposalIds: active.proposalIds ?? [],
        reason: "The active Git arc was unclaimed without committing this proposal.",
        threadId,
      });
      const registryMutation = await registry.prepareSet({ ...active, claimedPaths: [], phase: "resolved" }, active.checkpointCommit);
      const previousOutcome = await readArcOutcome(repository, harness, threadId, checkpoint.checkpointCommit);
      const outcomeUpdate = await prepareArcOutcome(repository, harness, threadId, {
        acceptedProposals: previousOutcome?.acceptedProposals ?? [],
        committedSha: previousOutcome?.committedSha ?? null,
        proposalId: previousOutcome?.proposalId ?? null,
        sourceCheckpoint: checkpoint.checkpointCommit,
        status: "released",
        successorCheckpoint: null,
        version: 1,
      });
      await repository.updateRefs([
        ...proposalUpdates,
        outcomeUpdate,
        ...(registryMutation.update ? [registryMutation.update] : []),
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
    const { active, checkpoint, harness, metadata, registry, repository } = await this.requireMutableActiveArc({ cwd, harness: rawHarness, threadId });
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
    const { checkpoint, harness, metadata, repository } = await this.requireActiveArc({ cwd, harness: rawHarness, threadId });
    const paths = rawPaths?.length ? repository.normalizePaths(rawPaths) : repository.normalizePaths(metadata.scopePaths);
    const baseline = await this.proposals.logicalBaseline({
      checkpointCommit: checkpoint.checkpointCommit,
      cwd: repository.root,
      fallbackHead: checkpoint.parent,
      harness,
      threadId,
    });
    const currentTree = await repository.writeScopedWorktreeTree(paths, baseline);
    return {
      changes: await repository.buildFileChanges(baseline, currentTree, paths),
      checkpointCommit: checkpoint.checkpointCommit,
      checkpointRef: checkpoint.checkpointRef,
      intentName: metadata.intentName ?? null,
      repoRoot: repository.root,
      scopePaths: metadata.scopePaths,
    };
  }

  async diff(input: ControllerInput & { checkpointCommit?: string; paths?: string[] }): Promise<GitCheckpointDiffResult> {
    if (input.checkpointCommit) {
      const repoRoot = await resolveRepoRoot(input.cwd);
      const harness = normalizeHarness(input.harness);
      const checkpoint = await readCheckpoint(repoRoot, harness, input.threadId, input.checkpointCommit);
      const metadata = checkpoint.metadata;
      if (!metadata || metadata.kind !== "plan") throw new Error("Explicit arc diff refs must identify an inactive or historical plan.");
      const paths = input.paths?.length ? normalizePaths(repoRoot, input.paths) : metadata.scopePaths;
      const currentTree = await writeScopedWorktreeTree(repoRoot, paths);
      const changes = await buildFileChanges(repoRoot, checkpoint.checkpointCommit, currentTree, paths);
      return {
        changes,
        checkpointCommit: checkpoint.checkpointCommit,
        checkpointRef: checkpoint.checkpointRef,
        diff: changes.map((change) => change.diff).join(""),
        intentName: metadata.intentName ?? null,
        repoRoot,
        scopePaths: metadata.scopePaths,
      };
    }
    const result = await this.compare(input);
    return {
      ...result,
      diff: result.changes.map((change) => change.diff).join(""),
    };
  }

  async createProposal({
    amend,
    amendProposalId,
    cwd,
    description,
    harness: rawHarness,
    paths: rawPaths,
    replaceProposalId,
    threadId,
    title,
  }: ControllerInput & {
    amend?: boolean;
    amendProposalId?: string;
    description: string;
    paths?: string[];
    replaceProposalId?: string;
    title: string;
  }): Promise<GitCheckpointProposalReceipt> {
    return await this.proposals.createProposal({
      amend,
      amendProposalId,
      cwd,
      description,
      harness: rawHarness,
      paths: rawPaths,
      replaceProposalId,
      threadId,
      title,
    });
  }

  async getProposal({
    cwd,
    harness: rawHarness,
    includeNewer,
    proposalId,
    threadId,
  }: ControllerInput & { includeNewer: boolean; proposalId: string }): Promise<GitCheckpointProposal> {
    return await this.proposals.getProposal({ cwd, harness: rawHarness, includeNewer, proposalId, threadId });
  }

  async rescindProposal(input: ControllerInput & { proposalId: string }) {
    return await this.proposals.rescindProposal(input);
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
    return await this.proposals.commitProposal({ cwd, description, harness: rawHarness, includeNewer, proposalId, threadId, title });
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
      const repository = new WorkbenchGitRepository(repoRoot);
      const registry = new GitArcRegistry(repository);
      const active = await registry.find({ harness, threadId });
      const owningArc = active?.phase === "active" ? active : null;
      const checkpoint = owningArc
        ? await readCheckpoint(repoRoot, harness, threadId, checkpointCommit)
        : await readRestorableCheckpoint(repoRoot, harness, threadId, checkpointCommit);
      if (owningArc && owningArc.checkpointCommit !== checkpoint.checkpointCommit) {
        const activeCheckpoint = await readCheckpoint(repoRoot, harness, threadId, owningArc.checkpointCommit);
        if (activeCheckpoint.metadata?.amendedFrom === checkpoint.checkpointCommit) {
          return await this.restore({
            checkpointCommit: owningArc.checkpointCommit,
            confirmRestore: true,
            cwd: repoRoot,
            harness,
            paths: owningArc.claimedPaths,
            threadId,
          });
        }
        throw new Error("This thread owns a different active Git arc. Restore that arc or release it before restoring historical work.");
      }
      const metadata = requireArcMetadata(checkpoint);
      if (owningArc) {
        return await this.restore({
          checkpointCommit,
          confirmRestore: true,
          cwd: repoRoot,
          harness,
          paths: owningArc.claimedPaths,
          threadId,
        });
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
      const outcomeUpdate = await prepareArcOutcome(repository, harness, threadId, {
        committedSha: null,
        proposalId: null,
        sourceCheckpoint: checkpoint.checkpointCommit,
        status: "released",
        successorCheckpoint: null,
        version: 1,
      });
      await repository.updateRefs([outcomeUpdate]);
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
      if (releasingArc.metadata.amendedFrom !== checkpointCommit) {
        throw new Error("The restore ref does not match this thread's active Git arc.");
      }
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
    const metadata = releasingArc?.metadata ?? checkpoint.metadata;
    if (!metadata?.scopePaths.length) throw new Error("This checkpoint does not contain a restorable file set.");
    const restoreSource = releasingArc
      ? await this.proposals.logicalBaseline({
        checkpointCommit: checkpoint.checkpointCommit,
        cwd: repoRoot,
        fallbackHead: checkpoint.parent,
        harness,
        threadId,
      })
      : checkpoint.checkpointCommit;
    const headMovement = await classifyHeadMovement(
      repoRoot,
      releasingArc ? restoreSource : checkpoint.parent,
      paths,
      restoreSource,
    );
    if (headMovement.kind === "incompatible") {
      throw new Error("Repository HEAD moved incompatibly after this checkpoint. Ask the user before restoring selected paths.");
    }
    if (headMovement.changedPaths.length) {
      throw new Error(`Selected restore paths no longer match the arc baseline: ${headMovement.changedPaths.join(", ")}`);
    }
    const currentTree = await writeScopedWorktreeTree(repoRoot, paths, restoreSource);
    const changedPaths = await listChangedPaths(repoRoot, restoreSource, currentTree, paths);
    const checkpointPaths = new Set(parseNullPaths(await runGit(repoRoot, [
      "ls-tree", "-r", "--name-only", "-z", restoreSource, "--", ...paths.map(literalPathspec),
    ])));
    const addedPaths = changedPaths.filter((filePath) => !checkpointPaths.has(filePath));
    const sourcePaths = changedPaths.filter((filePath) => checkpointPaths.has(filePath));
    await Promise.all(addedPaths.map(async (filePath) => {
      const absolute = path.resolve(repoRoot, filePath);
      if (isWithinRoot(absolute, repoRoot)) await fs.rm(absolute, { force: true, recursive: true });
    }));
    if (sourcePaths.length) {
      await runGit(repoRoot, [
        "restore", "--source", restoreSource, "--worktree", "--", ...sourcePaths.map(literalPathspec),
      ]);
    }
    if (releasingArc) {
      const proposalUpdates = await this.proposals.prepareUnavailableUpdates({
        cwd: releasingArc.repository.root,
        harness,
        proposalIds: releasingArc.active.proposalIds ?? [],
        reason: "The active Git arc was restored and unclaimed without committing this proposal.",
        threadId,
      });
      const registryMutation = await releasingArc.registry.prepareSet({
        ...releasingArc.active,
        claimedPaths: [],
        phase: "resolved",
      }, releasingArc.active.checkpointCommit);
      const previousOutcome = await readArcOutcome(releasingArc.repository, harness, threadId, checkpoint.checkpointCommit);
      const outcomeUpdate = await prepareArcOutcome(releasingArc.repository, harness, threadId, {
        acceptedProposals: previousOutcome?.acceptedProposals ?? [],
        committedSha: previousOutcome?.committedSha ?? null,
        proposalId: previousOutcome?.proposalId ?? null,
        sourceCheckpoint: checkpoint.checkpointCommit,
        status: "released",
        successorCheckpoint: null,
        version: 1,
      });
      await releasingArc.repository.updateRefs([
        ...proposalUpdates,
        outcomeUpdate,
        ...(registryMutation.update ? [registryMutation.update] : []),
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
