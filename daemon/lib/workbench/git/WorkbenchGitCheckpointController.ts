/*
 * Exports:
 * - default WorkbenchGitCheckpointController: route plan, lifecycle and proposal owners; orchestrate inspection, moves and restoration.
 * - GitArcNoopResult: ignored-path no-op result.
 * - GitArcLifecycleState: registered lifecycle projection.
 * - GitArcPlanClaimCollisionResult: inactive-plan collision facts.
 * - GitArcReleaseResult: released ownership result.
 * - GitArcActiveClaim/GitArcPlanState/GitArcProposalStatus: active, planned and proposal state.
 * - GitArcInspectionSnapshot: one shared repository, HEAD, tree and registry view per inspection.
 * - GitCheckpointDirtyPathsError/GitCheckpointIgnoredPathsError: rejected ownership paths.
 * - GitCheckpointCreateResult/GitCheckpointCompareResult/GitCheckpointDiffResult/GitCheckpointProposalReceipt/GitArcMoveResult/GitArcRetentionResult: controller results.
 */
import fs from "node:fs/promises";
import path from "node:path";

import { projectRoot } from "../../project";
import type {
  GitArcMoveRequest,
  GitCheckpointFileChange,
  GitCheckpointProposal,
} from "workbench-shared/workbench/git/checkpoint-contracts";
import { GitArcMissingClaimSetError } from "workbench-shared/workbench/git/git-arc-failures";
import type { GitArcClaimChanges, GitArcPlanningDrift } from "workbench-shared/workbench/git/git-arc-state";
import GitArcLifecycleController from "./GitArcLifecycleController";
import GitArcRegistry, {
  findGitArcCollisions,
  getGitArcLiveClaimPaths,
  GitArcCollisionError,
  type GitArcCollision,
  type GitArcRegistryEntry,
} from "./GitArcRegistry";
import { gitArcPathsOverlap } from "workbench-shared/workbench/git/git-arc-paths";
import { createGitArcDiffPage, type GitArcDiffPage } from "workbench-shared/workbench/git/git-arc-diff-pages";
import GitArcPathMover, { type GitArcResolvedMove } from "./GitArcPathMover";
import GitArcPlanController, {
  createGitArcNoopResult,
  GitCheckpointDirtyPathsError,
  partitionIgnoredGitArcPaths,
  rejectIgnoredGitArcPaths,
  type GitArcNoopResult,
  type GitArcPlanState,
  type GitArcStartResult,
} from "./GitArcPlanController";
import GitArcProposalController, {
  type GitArcLifecycleState,
  type GitCheckpointProposalReceipt,
} from "./GitArcProposalController";
import GitArcRetentionController, { type GitArcRetentionResult } from "./GitArcRetentionController";
import GitCheckpointStore from "./GitCheckpointStore";
import GitObjectReadSession from "./GitObjectReadSession";
import GitArcClaimLossStore from "./GitArcClaimLossStore";
import { collectGitArcDrift } from "./git-arc-drift";
import type { GitArcStatus } from "workbench-shared/workbench/git/git-arc-status";
import WorkbenchGitRepository, { type GitWorktreeSnapshot } from "./WorkbenchGitRepository";
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
} from "workbench-shared/workbench/git/git-arc-storage";

export type { GitArcProposalStatus } from "workbench-shared/workbench/git/git-arc-storage";
export { GitCheckpointDirtyPathsError, GitCheckpointIgnoredPathsError } from "./GitArcPlanController";
export type { GitArcPlanState } from "./GitArcPlanController";
export type { GitArcNoopResult } from "./GitArcPlanController";
export type { GitArcLifecycleState, GitCheckpointProposalReceipt } from "./GitArcProposalController";
export type { GitArcRetentionResult } from "./GitArcRetentionController";

const CHECKPOINT_DIFF_ARTIFACT_PATTERN = /^[a-f0-9]{64}$/u;

export interface GitArcActiveClaim extends GitArcRegistryEntry {
  proposalStatus: GitArcProposalStatus | null;
}

export interface GitArcPlanClaimCollisionResult {
  checkpointCommit: string;
  collisions: GitArcCollision[];
  repoRoot: string;
  scopePaths: string[];
}

export interface GitArcInspectionSnapshot extends GitWorktreeSnapshot {
  entries: GitArcRegistryEntry[];
  repository: WorkbenchGitRepository;
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
  phase?: "plan" | "active" | "resolved";
  checkpointCommit: string;
  checkpointRef: string;
  intentName: string | null;
  kind: CheckpointKind;
  planningDrift?: GitArcPlanningDrift;
  repoRoot: string;
  scopePaths: string[];
  skippedIgnoredPaths?: string[];
}

export interface GitArcReleaseResult extends GitCheckpointCreateResult {
  releasedClaims: string[];
}

type GitArcContinuationResult = GitCheckpointCreateResult;

export interface GitCheckpointCompareResult {
  phase?: "plan" | "active" | "resolved";
  changes: GitCheckpointFileChange[];
  checkpointCommit: string;
  checkpointRef: string;
  hasUncommittedChanges?: boolean;
  intentName: string | null;
  proposalId?: string;
  repoRoot: string;
  scopePaths: string[];
}

export interface GitCheckpointDiffResult extends GitCheckpointCompareResult, GitArcDiffPage {}

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
  parent: string | null;
}

function isArcMetadata(metadata: CheckpointMetadata | null): metadata is CheckpointMetadata {
  return Boolean(metadata && (metadata.kind === "arc" || metadata.kind === "implement") && metadata.scopePaths.length);
}

function requireArcMetadata(checkpoint: ReadCheckpointResult) {
  if (!isArcMetadata(checkpoint.metadata)) {
    throw new GitArcMissingClaimSetError();
  }
  return checkpoint.metadata;
}

function pathIsCoveredBy(candidate: string, scopePath: string) {
  return candidate === scopePath || candidate.startsWith(`${scopePath}/`);
}

async function resolveRepoRoot(cwd: string) {
  return (await WorkbenchGitRepository.open(cwd)).root;
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

async function checkpointRefName(repoRoot: string, harness: GitArcHarness, threadId: string, commit: string) {
  return await new GitCheckpointStore(new WorkbenchGitRepository(repoRoot)).checkpointRefName(harness, threadId, commit);
}

async function readCheckpoint(repoRoot: string, harness: GitArcHarness, threadId: string, rawCommit: string): Promise<ReadCheckpointResult> {
  return await new GitCheckpointStore(new WorkbenchGitRepository(repoRoot)).readCheckpoint(harness, threadId, rawCommit);
}

async function readRestorableCheckpoint(repoRoot: string, harness: GitArcHarness, threadId: string, rawCommit: string) {
  const repository = new WorkbenchGitRepository(repoRoot);
  const checkpoint = await readCheckpoint(repoRoot, harness, threadId, rawCommit);
  const currentHead = await repository.headOrNull();
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

export default class WorkbenchGitCheckpointController {
  private readonly plans = new GitArcPlanController();
  private readonly proposals = new GitArcProposalController();
  private readonly lifecycle = new GitArcLifecycleController();

  async createInspectionSnapshot(cwd: string): Promise<GitArcInspectionSnapshot> {
    return await GitObjectReadSession.run(async () => {
      const repository = await WorkbenchGitRepository.open(cwd);
      const [snapshot, entries] = await Promise.all([
        repository.writeWorktreeSnapshot(),
        new GitArcRegistry(repository).list(),
      ]);
      return { ...snapshot, entries, repository };
    });
  }

  async findPlanClaimCollisions({
    checkpointCommit: requestedCommit,
    cwd,
    harness: rawHarness,
    threadId,
  }: ControllerInput & { checkpointCommit?: string }): Promise<GitArcPlanClaimCollisionResult> {
    return await GitObjectReadSession.run(async () => {
      const repository = await WorkbenchGitRepository.open(cwd);
      const harness = normalizeHarness(rawHarness);
      const registry = new GitArcRegistry(repository);
      const current = await registry.find({ harness, threadId });
      const checkpointCommit = requestedCommit
        ?? (current?.phase === "plan" ? current.checkpointCommit : null);
      if (!checkpointCommit) throw new Error("This thread does not have an inactive Git arc plan.");
      const checkpoint = await readCheckpoint(repository.root, harness, threadId, checkpointCommit);
      if (!checkpoint.metadata || checkpoint.metadata.kind !== "plan" || !checkpoint.metadata.scopePaths.length) {
        throw new Error("The selected checkpoint is not an inactive Git arc plan.");
      }
      const scopePaths = (await partitionIgnoredGitArcPaths(repository, checkpoint.metadata.scopePaths)).paths;
      return {
        checkpointCommit: checkpoint.checkpointCommit,
        collisions: findGitArcCollisions(await registry.list(), { harness, threadId }, scopePaths),
        repoRoot: repository.root,
        scopePaths,
      };
    });
  }

  private async requireActiveArc(
    { cwd, harness: rawHarness, threadId }: ControllerInput,
    inspection?: GitArcInspectionSnapshot,
  ) {
    const repository = inspection?.repository ?? await WorkbenchGitRepository.open(cwd);
    const harness = normalizeHarness(rawHarness);
    const registry = new GitArcRegistry(repository);
    const active = inspection
      ? inspection.entries.find((entry) => (
        entry.harness === harness && entry.threadId === normalizeThreadId(threadId)
      )) ?? null
      : await registry.find({ harness, threadId });
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
      repository: activeArc.repository,
      harness: activeArc.harness,
      threadId: input.threadId,
    });
    return activeArc;
  }

  private async requireReleasableArc({ cwd, harness: rawHarness, threadId }: ControllerInput) {
    const repository = await WorkbenchGitRepository.open(cwd);
    const harness = normalizeHarness(rawHarness);
    const registry = new GitArcRegistry(repository);
    const active = await registry.find({ harness, threadId });
    const lifecycle = active?.phase === "plan"
      ? active.retainedArc
      : active?.phase === "resolved"
        ? null
        : active ? {
          checkpointCommit: active.checkpointCommit,
          claimedPaths: active.claimedPaths,
          intentDescription: active.intentDescription,
          intentName: active.intentName,
          phase: "active" as const,
          proposalIds: active.proposalIds ?? [],
        } : null;
    if (!active || !lifecycle || lifecycle.phase !== "active" || !lifecycle.claimedPaths.length) {
      throw new Error("This thread does not own any live Git arc claims.");
    }
    const checkpoint = await readCheckpoint(repository.root, harness, threadId, lifecycle.checkpointCommit);
    requireArcMetadata(checkpoint);
    return { active, checkpoint, harness, lifecycle, registry, repository };
  }

  private async assertClaimPathsClean(repository: WorkbenchGitRepository, paths: string[]) {
    const head = await repository.headOrNull();
    const dirtyPaths = await repository.listWorktreeChangedPaths(head, paths);
    if (dirtyPaths.length) throw new GitCheckpointDirtyPathsError(dirtyPaths, "Arc release");
  }

  async assertArcReleasable(input: ControllerInput): Promise<void> {
    await GitObjectReadSession.run(async () => {
      const { lifecycle, repository } = await this.requireReleasableArc(input);
      await this.assertClaimPathsClean(repository, lifecycle.claimedPaths);
    });
  }

  private async finishArcRelease({
    active,
    checkpoint,
    harness,
    lifecycle,
    registry,
    repository,
    threadId,
  }: Awaited<ReturnType<WorkbenchGitCheckpointController["requireReleasableArc"]>> & {
    threadId: string;
  }): Promise<GitArcReleaseResult> {
    const releasedEntry = active.phase === "plan"
      ? {
        ...active,
        retainedArc: active.retainedArc ? { ...active.retainedArc, claimedPaths: [], phase: "resolved" as const } : null,
      }
      : { ...active, claimedPaths: [], phase: "resolved" as const };
    const registryMutation = await registry.prepareSet(releasedEntry, active.checkpointCommit);
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
      outcomeUpdate,
      ...registryMutation.updates,
    ]);
    return {
      checkpointCommit: checkpoint.checkpointCommit,
      checkpointRef: checkpoint.checkpointRef,
      intentName: lifecycle.intentName ?? null,
      kind: "arc",
      releasedClaims: [...lifecycle.claimedPaths],
      phase: releasedEntry.phase ?? "resolved",
      repoRoot: repository.root,
      scopePaths: [],
    };
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
    parent: string | null;
    registry: GitArcRegistry;
    repository: WorkbenchGitRepository;
    scopePaths: string[];
    threadId: string;
    tree: string;
    withPublish?: (publish: () => Promise<void>) => Promise<void>;
  }): Promise<GitArcContinuationResult> {
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
      repository,
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
      proposalIds: [],
      retainedArc: undefined,
      phase: "active",
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
      ...registryMutation.updates,
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
    return await GitObjectReadSession.run(async () => {
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
    });
  }

  async listReloadScopeClaims({ cwd }: { cwd: string }) {
    return await GitObjectReadSession.run(async () => {
      const repository = await WorkbenchGitRepository.tryOpen(cwd);
      if (!repository) return [];
      return (await new GitArcRegistry(repository).list()).flatMap((entry) => {
        return entry.claimedPaths.length ? [{ harness: entry.harness, threadId: entry.threadId }] : [];
      });
    });
  }

  async findActiveClaim({ cwd, harness: rawHarness, threadId }: ControllerInput): Promise<GitArcActiveClaim | null> {
    return await GitObjectReadSession.run(async () => {
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
    });
  }

  async listLifecycleStates({ cwd }: { cwd: string }): Promise<GitArcLifecycleState[]> {
    return await GitObjectReadSession.run(() => this.proposals.listLifecycleStates({ cwd }));
  }

  async findLifecycleState(input: ControllerInput): Promise<GitArcLifecycleState | null> {
    return await GitObjectReadSession.run(() => this.proposals.findLifecycleState(input));
  }

  async hasLiveClaimsAtRepoRoot({ cwd, harness: rawHarness, threadId }: ControllerInput) {
    return await GitObjectReadSession.run(async () => {
      const harness = normalizeHarness(rawHarness);
      const entry = await new GitArcRegistry(new WorkbenchGitRepository(cwd)).find({ harness, threadId });
      return Boolean(entry && getGitArcLiveClaimPaths(entry).length);
    });
  }

  async listPlanStates({ cwd }: { cwd: string }): Promise<GitArcPlanState[]> {
    return await GitObjectReadSession.run(() => this.plans.listPlanStates({ cwd }));
  }

  async findPlanState(input: ControllerInput): Promise<GitArcPlanState | null> {
    return await GitObjectReadSession.run(() => this.plans.findPlanState(input));
  }

  async releaseActiveClaim({ cwd, harness: rawHarness, threadId }: ControllerInput): Promise<void> {
    await GitObjectReadSession.run(async () => {
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
      if (mutation) await repository.updateRefs(mutation.updates);
    });
  }

  async releaseArc({ cwd, disown, harness: rawHarness, threadId }: ControllerInput & { disown: boolean }): Promise<GitArcReleaseResult> {
    return await GitObjectReadSession.run(async () => {
      const releasable = await this.requireReleasableArc({ cwd, harness: rawHarness, threadId });
      if (!disown) await this.assertClaimPathsClean(releasable.repository, releasable.lifecycle.claimedPaths);
      return await this.finishArcRelease({
        ...releasable,
        threadId,
      });
    });
  }

  async pruneThreadHistory({ cwd, harness: rawHarness, threadId }: ControllerInput): Promise<GitArcRetentionResult> {
    return await GitObjectReadSession.run(() => new GitArcRetentionController().pruneThread({
      cwd,
      harness: normalizeHarness(rawHarness),
      threadId,
    }));
  }

  async createPlan({
    adoptPaths,
    cwd,
    harness: rawHarness,
    intentName,
    intentDescription = "",
    paths: rawPaths,
    threadId,
  }: ControllerInput & { adoptPaths?: string[]; intentDescription?: string; intentName: string; paths: string[] }): Promise<GitCheckpointCreateResult | GitArcNoopResult> {
    return await GitObjectReadSession.run(() => this.plans.createPlan({ adoptPaths, cwd, harness: rawHarness, intentDescription, intentName, paths: rawPaths, threadId }));
  }

  async addToPlan(input: ControllerInput & { paths: string[] }) {
    return await GitObjectReadSession.run(() => this.plans.addToPlan(input));
  }

  async adoptIntoPlan(input: ControllerInput & { paths: string[] }) {
    return await GitObjectReadSession.run(() => this.plans.adoptIntoPlan(input));
  }

  async removeFromPlan(input: ControllerInput & { paths: string[] }) {
    return await GitObjectReadSession.run(() => this.plans.removeFromPlan(input));
  }

  async createAndStartPlan(input: ControllerInput & { adoptPaths?: string[]; intentDescription?: string; intentName: string; paths: string[] }) {
    return await GitObjectReadSession.run(() => this.plans.createAndStartPlan(input));
  }

  async startArc({ checkpointCommit, cwd, harness: rawHarness, threadId }: ControllerInput & { checkpointCommit?: string }): Promise<GitArcStartResult | GitArcNoopResult> {
    return await GitObjectReadSession.run(() => this.plans.startArc({ checkpointCommit, cwd, harness: rawHarness, threadId }));
  }

  async continueArc(input: ControllerInput & { checkpointCommit?: string }) {
    return await GitObjectReadSession.run(() => this.lifecycle.continue(input));
  }

  async editPlanClaims(input: ControllerInput & GitArcClaimChanges & { intentName?: string; intentDescription?: string; start?: boolean }) {
    return await GitObjectReadSession.run(() => this.plans.editClaims(input));
  }

  async editArcClaims(input: ControllerInput & GitArcClaimChanges) {
    return await GitObjectReadSession.run(() => this.lifecycle.claims(input));
  }

  async readScope(input: ControllerInput) {
    return await GitObjectReadSession.run(() => this.lifecycle.scope(input));
  }

  async readStatus(input: ControllerInput, existingInspection?: GitArcInspectionSnapshot): Promise<GitArcStatus> {
    return await GitObjectReadSession.run(async () => {
      const inspection = existingInspection ?? await this.createInspectionSnapshot(input.cwd);
      const { repository, entries, head, tree } = inspection;
      const harness = normalizeHarness(input.harness);
      const current = entries.find(entry => entry.harness === harness && entry.threadId === normalizeThreadId(input.threadId));
      const claims = current ? getGitArcLiveClaimPaths(current) : [];
      const dirt = await repository.listAllChangedPaths(head, tree);
      const allClaims = entries.flatMap(getGitArcLiveClaimPaths);
      const lifecycle = current?.phase === "plan" ? current.retainedArc : current;
      const proposals = await this.proposals.readStatusProposals(input,
        lifecycle?.proposalIds ?? (current?.proposalId ? [current.proposalId] : []), repository, inspection);
      const status: GitArcStatus = {
        ...proposals,
        dirtyClaims: claims.filter(claim => dirt.some(file => gitArcPathsOverlap(claim, file))),
        cleanClaims: claims.filter(claim => !dirt.some(file => gitArcPathsOverlap(claim, file))),
        unclaimedDirt: dirt.filter(file => !allClaims.some(claim => gitArcPathsOverlap(claim, file))),
        recovery: [], unavailableRecovery: [],
      };
      if (!claims.length) {
        const lost = await new GitArcClaimLossStore(repository).read({ harness, threadId: input.threadId });
        if (lost) {
          const drift = await collectGitArcDrift({
            repository, baseline: lost.commit, baseHead: lost.head, head, tree, paths: lost.paths,
          });
          status.recovery.push({ ...drift, paths: lost.paths, commits: drift.commits.slice(0, 8), omittedCommits: Math.max(0, drift.commits.length - 8) });
        } else if (lifecycle?.phase === "resolved") {
          status.unavailableRecovery.push(repository.root);
        }
      }
      return status;
    });
  }

  async addToArc(input: ControllerInput & { paths: string[] }) {
    return await GitObjectReadSession.run(() => this.lifecycle.add(input));
  }

  async adoptIntoArc(input: ControllerInput & { paths: string[] }) {
    return await GitObjectReadSession.run(() => this.lifecycle.claims({ ...input, inherit: true, adoptPaths: input.paths }));
  }

  async removeFromArc(input: ControllerInput & { paths: string[] }) {
    return await GitObjectReadSession.run(() => this.lifecycle.claims({ ...input, inherit: true, removePaths: input.paths }));
  }

  async moveInArc({ cwd, harness: rawHarness, move, threadId }: ControllerInput & { move: GitArcMoveRequest }): Promise<GitArcMoveResult> {
    return await GitObjectReadSession.run<GitArcMoveResult>(async () => {
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

      await rejectIgnoredGitArcPaths(repository, additionalClaims);

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
    });
  }

  private async compareActiveArc(
    { cwd, harness: rawHarness, paths: rawPaths, threadId }: ControllerInput & { paths?: string[] },
    inspection: GitArcInspectionSnapshot,
  ): Promise<GitCheckpointCompareResult> {
    const { checkpoint, harness, metadata, repository } = await this.requireActiveArc(
      { cwd, harness: rawHarness, threadId },
      inspection,
    );
    const paths = rawPaths?.length ? repository.normalizePaths(rawPaths) : repository.normalizePaths(metadata.scopePaths);
    const baseline = await this.proposals.logicalBaseline({
      checkpointCommit: checkpoint.checkpointCommit,
      cwd: repository.root,
      fallbackHead: checkpoint.parent,
      harness,
      repository,
      threadId,
    });
    return {
      changes: await repository.buildFileChanges(baseline, inspection.tree, paths),
      checkpointCommit: checkpoint.checkpointCommit,
      checkpointRef: checkpoint.checkpointRef,
      hasUncommittedChanges: (await repository.listChangedPaths(inspection.head, inspection.tree, paths)).length > 0,
      intentName: metadata.intentName ?? null,
      repoRoot: repository.root,
      scopePaths: metadata.scopePaths,
    };
  }

  async compare(
    input: ControllerInput & { paths?: string[]; ref?: string },
    existingInspection?: GitArcInspectionSnapshot,
  ): Promise<GitCheckpointCompareResult> {
    return await GitObjectReadSession.run<GitCheckpointCompareResult>(async () => {
      const inspection = existingInspection ?? await this.createInspectionSnapshot(input.cwd);
      const repository = inspection.repository;
      if (!input.ref) {
        const current = inspection.entries.find((entry) => entry.harness === normalizeHarness(input.harness)
          && entry.threadId === normalizeThreadId(input.threadId));
        if (!current || !getGitArcLiveClaimPaths(current).length) {
          const lost = await new GitArcClaimLossStore(repository).read({ harness: normalizeHarness(input.harness), threadId: input.threadId });
          if (lost) {
            const paths = input.paths?.length ? repository.normalizePaths(input.paths) : lost.paths;
            return {
              checkpointCommit: lost.commit, checkpointRef: lost.ref, phase: "resolved",
              changes: await repository.buildFileChanges(lost.commit, inspection.tree, paths),
              scopePaths: paths, hasUncommittedChanges: (await repository.listChangedPaths(inspection.head, inspection.tree, paths)).length > 0,
              intentName: current?.intentName ?? null, repoRoot: repository.root,
            };
          }
          if (current?.phase === "resolved" || current?.retainedArc?.phase === "resolved") {
            throw new Error("The claim-loss baseline is unavailable. Inspect affected files or select an explicit arc ref.");
          }
        }
        if (current?.phase === "plan") input = { ...input, ref: current.checkpointCommit };
        if (current?.phase === "resolved") {
          if (input.paths?.length) {
            input = { ...input, ref: current.checkpointCommit };
          } else {
            const checkpoint = await readCheckpoint(repository.root, normalizeHarness(input.harness), input.threadId, current.checkpointCommit);
            return {
              checkpointCommit: checkpoint.checkpointCommit, checkpointRef: checkpoint.checkpointRef,
              phase: "resolved", changes: [], scopePaths: [], hasUncommittedChanges: false,
              intentName: current.intentName, repoRoot: repository.root,
            };
          }
        }
      }
      if (input.ref && !/^[a-f0-9]{7,64}$/iu.test(input.ref)) {
        const harness = normalizeHarness(input.harness);
        const proposal = await new GitCheckpointStore(repository).readProposal(harness, input.threadId, input.ref);
        const paths = input.paths?.length ? repository.normalizePaths(input.paths) : repository.normalizePaths(proposal.metadata.paths);
        return {
          changes: await repository.buildFileChanges(proposal.proposalCommit, inspection.tree, paths),
          checkpointCommit: proposal.proposalCommit,
          checkpointRef: proposal.proposalRef,
          intentName: null,
          proposalId: proposal.metadata.proposalId,
          repoRoot: repository.root,
          scopePaths: proposal.metadata.paths,
        };
      }
      if (input.ref) {
        const repoRoot = repository.root;
        const harness = normalizeHarness(input.harness);
        const checkpoint = await readCheckpoint(repoRoot, harness, input.threadId, input.ref);
        const metadata = checkpoint.metadata;
        if (metadata?.kind === "arc") {
          const active = inspection.entries.find((entry) => (
            entry.harness === harness && entry.threadId === normalizeThreadId(input.threadId)
          ));
          if (active?.phase === "active" && active.checkpointCommit === checkpoint.checkpointCommit) return await this.compareActiveArc(input, inspection);
        }
        if (!metadata || (metadata.kind !== "plan" && metadata.kind !== "arc" && metadata.kind !== "implement")) {
          throw new Error("Explicit inspection refs must identify this thread's plan, arc or proposal.");
        }
        const paths = input.paths?.length ? repository.normalizePaths(input.paths) : metadata.scopePaths;
        const changes = await repository.buildFileChanges(checkpoint.checkpointCommit, inspection.tree, paths);
        return {
          changes,
          phase: metadata.kind === "plan" ? "plan" : "active",
          checkpointCommit: checkpoint.checkpointCommit,
          checkpointRef: checkpoint.checkpointRef,
          intentName: metadata.intentName ?? null,
          repoRoot,
          scopePaths: metadata.scopePaths,
        };
      }
      return await this.compareActiveArc(input, inspection);
    });
  }

  async listUnclaimedWorkspaceDirt(
    { cwd, modifiedSince }: { cwd: string; modifiedSince: number },
    existingInspection?: GitArcInspectionSnapshot,
  ) {
    return await GitObjectReadSession.run(async () => {
      const inspection = existingInspection ?? await this.createInspectionSnapshot(cwd);
      const changedPaths = await inspection.repository.listAllChangedPaths(inspection.head, inspection.tree);
      const liveClaims = inspection.entries.flatMap((entry) => getGitArcLiveClaimPaths(entry));
      const unclaimedPaths = changedPaths.filter((candidate) => (
        !liveClaims.some((claimedPath) => gitArcPathsOverlap(candidate, claimedPath))
      ));
      return await inspection.repository.listPathsModifiedSince(unclaimedPaths, modifiedSince);
    });
  }

  async diff(input: ControllerInput & {
    page?: number;
    paths?: string[];
    ref?: string;
  }, existingInspection?: GitArcInspectionSnapshot): Promise<GitCheckpointDiffResult> {
    return await GitObjectReadSession.run(async () => {
      const result = await this.compare(input, existingInspection);
      return {
        ...result,
        ...createGitArcDiffPage(
          result.changes.map((change) => ({ change, content: change.diff })),
          {
            ...(input.page !== undefined ? { page: input.page } : {}),
            paginate: !input.paths?.length,
          },
        ),
      };
    });
  }

  async createProposal({
    amend,
    amendProposalId,
    cwd,
    description,
    freshDescription,
    freshTitle,
    harness: rawHarness,
    paths: rawPaths,
    replaceProposalId,
    threadId,
    title,
  }: ControllerInput & {
    amend?: boolean;
    amendProposalId?: string;
    description: string;
    freshDescription?: string;
    freshTitle?: string;
    paths?: string[];
    replaceProposalId?: string;
    title: string;
  }): Promise<GitCheckpointProposalReceipt> {
    return await GitObjectReadSession.run(() => this.proposals.createProposal({
      amend,
      amendProposalId,
      cwd,
      description,
      freshDescription,
      freshTitle,
      harness: rawHarness,
      paths: rawPaths,
      replaceProposalId,
      threadId,
      title,
    }));
  }

  async getProposal({
    cwd,
    harness: rawHarness,
    includeNewer,
    proposalId,
    threadId,
  }: ControllerInput & { includeNewer: boolean; proposalId: string }): Promise<GitCheckpointProposal> {
    return await GitObjectReadSession.run(() => this.proposals.getProposal({ cwd, harness: rawHarness, includeNewer, proposalId, threadId }));
  }

  async getProposalPaths({
    cwd,
    harness: rawHarness,
    proposalId,
    threadId,
  }: ControllerInput & { proposalId: string }): Promise<string[]> {
    return await GitObjectReadSession.run(() => this.proposals.getProposalPaths({ cwd, harness: rawHarness, proposalId, threadId }));
  }

  async rescindProposal(input: ControllerInput & { proposalId: string }) {
    return await GitObjectReadSession.run(() => this.proposals.rescindProposal(input));
  }

  async commitProposal({
    cwd,
    description,
    harness: rawHarness,
    includeNewer,
    mode,
    proposalId,
    threadId,
    title,
  }: ControllerInput & {
    description: string;
    includeNewer: boolean;
    mode?: "amend" | "commit";
    proposalId: string;
    title: string;
  }): Promise<GitCheckpointProposal> {
    return await GitObjectReadSession.run(() => this.proposals.commitProposal({ cwd, description, harness: rawHarness, includeNewer, mode, proposalId, threadId, title }));
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
    return await GitObjectReadSession.run(async () => {
      if (!rawPaths?.length && !confirmRestore) throw new Error("Checkpoint restore requires confirmation or selected paths.");
      const repoRoot = await resolveRepoRoot(cwd);
      const harness = normalizeHarness(rawHarness);
      const repository = new WorkbenchGitRepository(repoRoot);

      if (!rawPaths?.length) {
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
        const currentTree = await repository.writeWorktreeTree();
        const changedPaths = await repository.listAllChangedPaths(checkpoint.checkpointCommit, currentTree);
        const checkpointPaths = new Set(await repository.listTreePaths(checkpoint.checkpointCommit));
        const addedPaths = changedPaths.filter((filePath) => !checkpointPaths.has(filePath));
        await Promise.all(addedPaths.map(async (filePath) => {
          await fs.rm(repository.resolvePath(filePath), { force: true, recursive: true });
        }));
        await repository.run(["restore", "--source", checkpoint.checkpointCommit, "--worktree", "--", "."]);
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
      const paths = repository.normalizePaths(rawPaths);
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
      const headMovement = await repository.classifyHeadMovement(
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
      const currentTree = await repository.writeScopedWorktreeTree(paths, restoreSource);
      const changedPaths = await repository.listChangedPaths(restoreSource, currentTree, paths);
      const checkpointPaths = new Set(await repository.listTreePaths(restoreSource, paths));
      const addedPaths = changedPaths.filter((filePath) => !checkpointPaths.has(filePath));
      const sourcePaths = changedPaths.filter((filePath) => checkpointPaths.has(filePath));
      await Promise.all(addedPaths.map(async (filePath) => {
        await fs.rm(repository.resolvePath(filePath), { force: true, recursive: true });
      }));
      await repository.restorePaths(restoreSource, sourcePaths);
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
          ...registryMutation.updates,
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
    });
  }
}
