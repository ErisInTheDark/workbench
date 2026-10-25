/*
 * Exports:
 * - default GitArcPlanController: own inactive planning and atomic activation, turning planned folders into their current file claims and retaining dirty claims replacement scope omits.
 * - GitCheckpointDirtyPathsError/GitCheckpointIgnoredPathsError: rejected dirty or ignored paths.
 * - partitionIgnoredGitArcPaths/rejectIgnoredGitArcPaths: ignored ownership validation.
 * - createGitArcNoopResult/GitArcNoopResult: ignored requests that changed no refs.
 * - GitArcPlanResult/GitArcPlanState/GitArcStartResult: plan and activation results.
 */
import type { GitCheckpointFileChange } from "workbench-shared/workbench/git/checkpoint-contracts";
import { ProviderKeySchema } from "workbench-shared/workbench/provider/provider-key";
import { applyGitClaimChanges, type GitArcClaimChanges, type GitArcPlanningDrift } from "workbench-shared/workbench/git/git-arc-state";
import GitArcPathSet from "workbench-shared/workbench/git/GitArcPathSet";
import createGitArcStartDiagnosticError from "./git-arc-start-diagnostics";
import { expandGitArcClaimPaths } from "./git-arc-claim-expansion";
import GitArcRegistry, {
  findGitArcCollisions,
  GitArcCollisionError,
  type GitArcRegistryEntry,
} from "./GitArcRegistry";
import GitArcClaimLossStore from "./GitArcClaimLossStore";
import GitArcClaimOwnershipController from "./GitArcClaimOwnershipController";
import GitArcStackController from "./GitArcStackController";
import GitCheckpointStore, { type StoredCheckpoint } from "./GitCheckpointStore";
import WorkbenchGitRepository from "./WorkbenchGitRepository";
import {
  passthroughGitArcThreadIdentityResolver,
  type GitArcThreadIdentityResolver,
} from "./git-arc-thread-identity";
import { GitArcRejectionError } from "workbench-shared/workbench/git/git-arc-rejections";
import {
  type CheckpointMetadata,
  type GitArcHarness,
  type GitArcSavedStash,
} from "workbench-shared/workbench/git/git-arc-storage";

interface PlanInput {
  adoptPaths?: string[];
  cwd: string;
  harness?: GitArcHarness;
  intentDescription?: string;
  intentName: string;
  paths: string[];
  threadId: string;
}

interface PlanRequest {
  adoptPaths: string[];
  intentDescription: string;
  intentName: string;
  paths: string[];
}

interface PlanOptions {
  baselinePlan?: StoredCheckpoint | null;
  skippedIgnoredPaths?: string[];
}

interface PlanIdentityInput {
  cwd: string;
  harness?: GitArcHarness;
  threadId: string;
}

export interface GitArcPlanResult {
  claimedPaths: string[];
  plannedPaths: string[];
  adoptedPaths: string[];
  checkpointCommit: string;
  checkpointRef: string;
  intentName: string | null;
  kind: "plan";
  planningDrift?: GitArcPlanningDrift;
  repoRoot: string;
  /** Dirty or proposed claims kept in scope although the request omitted them. */
  retainedPaths: string[];
  scopePaths: string[];
  skippedIgnoredPaths: string[];
}

export interface GitArcPlanState {
  checkpointCommit: string;
  harness: string;
  intentDescription: string;
  intentName: string;
  scopePaths: string[];
  threadId: string;
  updatedAt: string;
}

export interface GitArcStartResult {
  planningDrift?: GitArcPlanningDrift;
  acquiredClaims: string[];
  changes: GitCheckpointFileChange[];
  checkpointCommit: string;
  checkpointRef: string;
  intentName: string | null;
  kind: "arc";
  releasedClaims: string[];
  repoRoot: string;
  /** Dirty or proposed claims kept in scope although the request omitted them; absent when starting a published plan. */
  retainedPaths?: string[];
  scopePaths: string[];
  skippedIgnoredPaths: string[];
}

export interface GitArcNoopResult {
  acquiredClaims: string[];
  changes: GitCheckpointFileChange[];
  checkpointCommit: string;
  checkpointRef: string;
  intentName: null;
  kind: "noop";
  noOp: true;
  planningDrift?: GitArcPlanningDrift;
  releasedClaims: string[];
  repoRoot: string;
  scopePaths: string[];
  skippedIgnoredPaths: string[];
}

export class GitCheckpointDirtyPathsError extends Error {
  readonly dirtyPaths: string[];

  constructor(dirtyPaths: string[], operation = "Plan") {
    super(`${operation} paths must be clean against HEAD: ${dirtyPaths.join(", ")}`);
    this.name = "GitCheckpointDirtyPathsError";
    this.dirtyPaths = dirtyPaths;
  }
}

export class GitCheckpointIgnoredPathsError extends Error {
  readonly ignoredPaths: string[];

  constructor(ignoredPaths: string[]) {
    super(`Git arc paths must not be ignored: ${ignoredPaths.join(", ")}`);
    this.name = "GitCheckpointIgnoredPathsError";
    this.ignoredPaths = ignoredPaths;
  }
}

export async function partitionIgnoredGitArcPaths(repository: WorkbenchGitRepository, paths: string[]) {
  const normalizedPaths = paths.length ? repository.normalizePaths(paths) : [];
  const skippedIgnoredPaths = await repository.listIgnoredPaths(normalizedPaths);
  const skipped = new Set(skippedIgnoredPaths);
  return {
    paths: normalizedPaths.filter((candidate) => !skipped.has(candidate)),
    skippedIgnoredPaths,
  };
}

export async function rejectIgnoredGitArcPaths(repository: WorkbenchGitRepository, paths: string[]) {
  const { skippedIgnoredPaths } = await partitionIgnoredGitArcPaths(repository, paths);
  if (skippedIgnoredPaths.length) throw new GitCheckpointIgnoredPathsError(skippedIgnoredPaths);
}

export function createGitArcNoopResult(
  repository: WorkbenchGitRepository,
  skippedIgnoredPaths: string[],
): GitArcNoopResult {
  return {
    acquiredClaims: [],
    changes: [],
    checkpointCommit: "",
    checkpointRef: "",
    intentName: null,
    kind: "noop",
    noOp: true,
    releasedClaims: [],
    repoRoot: repository.root,
    scopePaths: [],
    skippedIgnoredPaths,
  };
}

function normalizeHarness(harness: string | undefined): GitArcHarness {
  const parsed = ProviderKeySchema.safeParse(harness ?? "codex");
  if (parsed.success) return parsed.data;
  throw new GitArcRejectionError({ reason: "invalidHarness" }, "A valid checkpoint harness is required.");
}

function collapseScopePaths(paths: string[]) {
  const uniquePaths = [...new Set(paths)].sort((left, right) => left.localeCompare(right));
  const scopes = new GitArcPathSet(uniquePaths);
  return uniquePaths.filter((candidate) => !scopes.within(candidate));
}

/** Each overlapping previous/next pair contributes its narrower path. */
function overlappingBaselinePaths(previousPaths: string[], nextPaths: string[]) {
  const previous = new GitArcPathSet(previousPaths);
  const next = new GitArcPathSet(nextPaths);
  return [...new Set([
    ...nextPaths.filter((nextPath) => previous.covers(nextPath)),
    ...previousPaths.filter((previousPath) => next.covers(previousPath)),
  ])].sort((left, right) => left.localeCompare(right));
}

function liveClaims(entry: GitArcRegistryEntry) {
  if (entry.phase === "resolved" || entry.phase === "stashed") return [];
  if (entry.phase === "plan") return entry.retainedArc?.claimedPaths ?? entry.claimedPaths;
  return entry.claimedPaths;
}

function presentation(entry: GitArcRegistryEntry) {
  if (entry.phase === "stashed") return null;
  if (entry.phase === "plan") return entry.retainedArc ?? null;
  return {
    ...(entry.activeClaimedPaths !== undefined ? { activeClaimedPaths: entry.activeClaimedPaths } : {}),
    checkpointCommit: entry.checkpointCommit,
    claimedPaths: entry.claimedPaths,
    intentDescription: entry.intentDescription,
    intentName: entry.intentName,
    phase: entry.phase === "resolved" ? "resolved" as const : "active" as const,
    proposalIds: entry.proposalIds ?? [],
  };
}

/** Successor work keeps a pending stack whole, otherwise only live (pending or unavailable) proposals; resolved ids drop. */
async function activationProposalIds(
  store: GitCheckpointStore,
  harness: GitArcHarness,
  threadId: string,
  current: GitArcRegistryEntry | null,
  retainedArc = current ? presentation(current) : null,
) {
  const ids = retainedArc?.proposalIds ?? [];
  if (current?.stackTip || !ids.length) return ids;
  const live = new Set((await store.readProposalSummaries(harness, threadId, ids))
    .filter(({ status }) => status === "proposed" || status === "unavailable")
    .map(({ proposalId }) => proposalId));
  return ids.filter(id => live.has(id));
}

function requirePlanMetadata(metadata: CheckpointMetadata | null) {
  if (!metadata || metadata.kind !== "plan") throw new GitArcRejectionError({ reason: "wrongPlanKind" }, "The selected checkpoint is not an inactive Git arc plan.");
  return metadata;
}

export default class GitArcPlanController {
  constructor(private readonly resolveThreadIdentity: GitArcThreadIdentityResolver = passthroughGitArcThreadIdentityResolver) {}

  private registry(repository: WorkbenchGitRepository) {
    return new GitArcRegistry(repository, this.resolveThreadIdentity);
  }

  private store(repository: WorkbenchGitRepository) {
    return new GitCheckpointStore(repository, this.resolveThreadIdentity);
  }
  async listPlanStates({ cwd }: { cwd: string }): Promise<GitArcPlanState[]> {
    const repository = await WorkbenchGitRepository.tryOpen(cwd);
    if (!repository) return [];
    const entries = (await this.registry(repository).list()).filter((entry) => entry.phase === "plan");
    const store = this.store(repository);
    return await Promise.all(entries.map(async (entry) => {
      const checkpoint = await store.readCheckpoint(normalizeHarness(entry.harness), entry.threadId, entry.checkpointCommit);
      const metadata = requirePlanMetadata(checkpoint.metadata);
      return {
        checkpointCommit: entry.checkpointCommit,
        harness: entry.harness,
        intentDescription: metadata.intentDescription ?? "",
        intentName: metadata.intentName ?? entry.intentName,
        scopePaths: metadata.scopePaths.length ? repository.normalizePaths(metadata.scopePaths) : [],
        threadId: entry.threadId,
        updatedAt: entry.updatedAt,
      };
    }));
  }

  async findPlanState(input: PlanIdentityInput): Promise<GitArcPlanState | null> {
    const states = await this.listPlanStates({ cwd: input.cwd });
    const harness = normalizeHarness(input.harness);
    return states.find((state) => state.harness === harness && state.threadId === input.threadId) ?? null;
  }

  async createPlan(input: PlanInput): Promise<GitArcPlanResult | GitArcNoopResult> {
    const repository = await WorkbenchGitRepository.open(input.cwd);
    const harness = normalizeHarness(input.harness);
    const registry = this.registry(repository);
    const current = await registry.find({ harness, threadId: input.threadId });
    const baselinePlan = await this.readPendingPlan(repository, harness, input.threadId, current);
    return await this.writePlan(repository, registry, harness, input.threadId, current, {
      adoptPaths: input.adoptPaths ?? [],
      intentDescription: input.intentDescription ?? "",
      intentName: input.intentName,
      paths: input.paths,
    }, { baselinePlan });
  }

  async editClaims(input: PlanIdentityInput & GitArcClaimChanges & { intentName?: string; intentDescription?: string; start?: boolean }) {
    const repository = await WorkbenchGitRepository.open(input.cwd);
    const harness = normalizeHarness(input.harness);
    const registry = this.registry(repository);
    const current = await registry.find({ harness, threadId: input.threadId });
    if (input.inherit && !current) throw new GitArcRejectionError({ reason: "missingLifecycle" }, "This thread has no plan or arc to inherit.");
    const baselinePlan = await this.readPendingPlan(repository, harness, input.threadId, current);
    const existing = baselinePlan?.metadata?.scopePaths ?? (current ? liveClaims(current) : []);
    const normalise = (paths: string[] | undefined) => paths?.length ? repository.normalizePaths(paths) : [];
    const additions = await partitionIgnoredGitArcPaths(repository, input.addPaths ?? []);
    const adoptions = await partitionIgnoredGitArcPaths(repository, input.adoptPaths ?? []);
    const skippedIgnoredPaths = [...new Set([...additions.skippedIgnoredPaths, ...adoptions.skippedIgnoredPaths])];
    const changes = {
      inherit: input.inherit,
      addPaths: additions.paths,
      removePaths: normalise(input.removePaths),
      adoptPaths: adoptions.paths,
    };
    if (skippedIgnoredPaths.length && !changes.addPaths.length && !changes.adoptPaths.length && !changes.removePaths.length && !input.intentName) {
      return createGitArcNoopResult(repository, skippedIgnoredPaths);
    }
    const inheritedAdoptions = input.inherit ? baselinePlan?.metadata?.adoptedPaths ?? [] : [];
    const paths = applyGitClaimChanges([...new Set([...existing, ...inheritedAdoptions])], changes);
    const removals = new GitArcPathSet(changes.removePaths);
    const adoptPaths = [...new Set([
      ...inheritedAdoptions.filter((candidate) => !removals.covers(candidate)),
      ...changes.adoptPaths,
    ])];
    const intentName = input.intentName?.trim() || (input.inherit ? current?.intentName : "");
    if (!intentName) throw new GitArcRejectionError({ reason: "missingPlanName" }, "An initial or replacement plan requires an intent.");
    const planInput = {
      adoptPaths,
      intentDescription: input.intentDescription ?? (input.inherit ? current?.intentDescription ?? "" : ""),
      intentName,
      paths,
    };
    const result = input.start
      ? await this.activatePreparedPlan(repository, registry, harness, input, current,
        await this.preparePlan(repository, registry, harness, input.threadId, current, planInput, { baselinePlan, skippedIgnoredPaths }))
      : await this.writePlan(repository, registry, harness, input.threadId, current, planInput, { baselinePlan, skippedIgnoredPaths });
    const existingPaths = new Set(existing);
    const nextPaths = new Set([...paths, ...(result.kind === "noop" ? [] : result.retainedPaths ?? [])]);
    return {
      ...result,
      addedClaims: paths.filter((candidate) => !existingPaths.has(candidate)),
      removedClaims: existing.filter((candidate) => !nextPaths.has(candidate)),
    };
  }

  async addToPlan(input: PlanIdentityInput & { paths: string[] }) {
    return await this.revisePlan(input, "add");
  }

  async adoptIntoPlan(input: PlanIdentityInput & { paths: string[] }) {
    return await this.revisePlan(input, "adopt");
  }

  async removeFromPlan(input: PlanIdentityInput & { paths: string[] }) {
    return await this.revisePlan(input, "remove");
  }

  async createAndStartPlan(input: PlanInput): Promise<GitArcStartResult | GitArcNoopResult> {
    const repository = await WorkbenchGitRepository.open(input.cwd);
    const harness = normalizeHarness(input.harness);
    const registry = this.registry(repository);
    const current = await registry.find({ harness, threadId: input.threadId });
    const baselinePlan = await this.readPendingPlan(repository, harness, input.threadId, current);
    const plan = await this.preparePlan(repository, registry, harness, input.threadId, current, {
      adoptPaths: input.adoptPaths ?? [],
      intentDescription: input.intentDescription ?? "",
      intentName: input.intentName,
      paths: input.paths,
    }, { baselinePlan });
    return await this.activatePreparedPlan(repository, registry, harness, input, current, plan);
  }

  private async activatePreparedPlan(
    repository: WorkbenchGitRepository,
    registry: GitArcRegistry,
    harness: GitArcHarness,
    input: PlanIdentityInput,
    current: GitArcRegistryEntry | null,
    plan: Awaited<ReturnType<GitArcPlanController["preparePlan"]>>,
  ): Promise<GitArcStartResult | GitArcNoopResult> {
    if (!plan.paths.length && plan.skippedIgnoredPaths.length) {
      return createGitArcNoopResult(repository, plan.skippedIgnoredPaths);
    }
    if (!plan.paths.length) throw new GitArcRejectionError({ reason: "emptyPlan" }, "An empty Git arc plan cannot start. Add at least one path first.");
    const claimPaths = await expandGitArcClaimPaths(repository, plan.paths);
    const { retainedArc } = plan;
    const guardPaths = [...new Set([...claimPaths, ...plan.baselineClaims])]
      .sort((left, right) => left.localeCompare(right));

    const collisions = findGitArcCollisions(await registry.list(), { harness, threadId: input.threadId }, guardPaths);
    if (collisions.length) throw new GitArcCollisionError(collisions);
    const permittedDirty = new GitArcPathSet([...plan.adoptPaths, ...(retainedArc?.claimedPaths ?? [])]);
    const unexplained = plan.dirtyPaths.filter((candidate) => !permittedDirty.covers(candidate));
    if (unexplained.length) throw new GitCheckpointDirtyPathsError(unexplained, "Arc start");
    const activeMetadata: CheckpointMetadata = {
      amendedFrom: plan.prepared.checkpointCommit,
      ...(plan.metadata.intentDescription ? { intentDescription: plan.metadata.intentDescription } : {}),
      intentName: plan.metadata.intentName,
      kind: "arc",
      registryLifecycle: true,
      scopePaths: guardPaths,
      version: 3,
    };
    const store = this.store(repository);
    const active = await store.prepareCheckpoint(
      harness,
      input.threadId,
      await repository.resolveTree(plan.head),
      plan.head,
      activeMetadata,
    );
    const successor = await this.prepareStashedSuccessor(repository, harness, input.threadId, current);
    const registryMutation = await registry.prepareClaim({
      checkpointCommit: active.checkpointCommit,
      activeClaimedPaths: claimPaths,
      claimedPaths: guardPaths,
      harness,
      intentDescription: plan.metadata.intentDescription ?? "",
      intentName: plan.metadata.intentName ?? "Unnamed arc",
      phase: "active",
      proposalId: null,
      proposalIds: await activationProposalIds(store, harness, input.threadId, current, retainedArc),
      retainedArc: undefined,
      ...(successor ? { savedStash: successor.savedStash } : {}),
      threadId: input.threadId,
    }, current ? { expectedCheckpointCommit: current.checkpointCommit } : undefined);
    await repository.updateRefs([
      plan.prepared.update,
      active.update,
      ...(successor?.updates ?? []),
      ...registryMutation.updates,
    ], successor?.deletions ?? []);
    return {
      acquiredClaims: claimPaths,
      planningDrift: plan.planningDrift,
      changes: await repository.buildFileChanges(active.checkpointCommit, plan.tree, claimPaths),
      checkpointCommit: active.checkpointCommit,
      checkpointRef: active.checkpointRef,
      intentName: plan.metadata.intentName ?? null,
      kind: "arc",
      releasedClaims: current ? liveClaims(current) : [],
      repoRoot: repository.root,
      retainedPaths: plan.retainedPaths,
      scopePaths: claimPaths,
      skippedIgnoredPaths: plan.skippedIgnoredPaths,
    };
  }

  async startArc(input: PlanIdentityInput & { checkpointCommit?: string }): Promise<GitArcStartResult | GitArcNoopResult> {
    const repository = await WorkbenchGitRepository.open(input.cwd);
    const harness = normalizeHarness(input.harness);
    const registry = this.registry(repository);
    const current = await registry.find({ harness, threadId: input.threadId });
    const checkpointCommit = input.checkpointCommit ?? (current?.phase === "plan" ? current.checkpointCommit : null);
    if (!checkpointCommit) throw new GitArcRejectionError({ reason: "missingInactivePlan" }, "This thread does not have a current inactive Git arc plan.");
    const store = this.store(repository);
    const plan = await store.readCheckpoint(harness, input.threadId, checkpointCommit);
    if (plan.metadata && (plan.metadata.kind === "arc" || plan.metadata.kind === "implement")) {
      const metadata = plan.metadata;
      if (!metadata.scopePaths.length) throw new GitArcRejectionError({ reason: "emptyPlan" }, "An empty Git arc plan cannot start. Add at least one path first.");
      const partitioned = await partitionIgnoredGitArcPaths(repository, metadata.scopePaths);
      const paths = partitioned.paths;
      if (!paths.length && partitioned.skippedIgnoredPaths.length) {
        return createGitArcNoopResult(repository, partitioned.skippedIgnoredPaths);
      }
      const registryEntries = await registry.list();
      const collisions = findGitArcCollisions(registryEntries, { harness, threadId: input.threadId }, paths);
      if (collisions.length) throw new GitArcCollisionError(collisions);
      const currentTree = await repository.writeScopedWorktreeTree(paths);
      const changes = await repository.buildFileChanges(plan.checkpointCommit, currentTree, paths);
      if (metadata.version >= 3 && changes.length && current?.checkpointCommit !== plan.checkpointCommit) {
        throw await createGitArcStartDiagnosticError({
          adoptedPaths: [],
          currentHead: await repository.headOrNull(),
          currentTree,
          harness,
          planBaseCommit: plan.parent,
          planCheckpointCommit: plan.checkpointCommit,
          planPaths: paths,
          registryEntries,
          repository,
          snapshotDrift: changes.map(({ path }) => path),
          threadId: input.threadId,
        });
      }
      const claimed = await registry.claim({
        checkpointCommit: plan.checkpointCommit,
        claimedPaths: paths,
        harness,
        intentDescription: metadata.intentDescription ?? "",
        intentName: metadata.intentName ?? "Unnamed arc",
        phase: "active",
        proposalId: null,
        proposalIds: await activationProposalIds(store, harness, input.threadId, current),
        retainedArc: undefined,
        threadId: input.threadId,
      });
      return {
        acquiredClaims: claimed.claimedPaths,
        changes,
        checkpointCommit: plan.checkpointCommit,
        checkpointRef: plan.checkpointRef,
        intentName: metadata.intentName ?? null,
        kind: "arc",
        releasedClaims: [],
        repoRoot: repository.root,
        scopePaths: paths,
        skippedIgnoredPaths: partitioned.skippedIgnoredPaths,
      };
    }
    const metadata = requirePlanMetadata(plan.metadata);
    if (!metadata.scopePaths.length) throw new GitArcRejectionError({ reason: "emptyPlan" }, "An empty Git arc plan cannot start. Add at least one path first.");
    const partitioned = await partitionIgnoredGitArcPaths(repository, metadata.scopePaths);
    if (!partitioned.paths.length && partitioned.skippedIgnoredPaths.length) {
      return createGitArcNoopResult(repository, partitioned.skippedIgnoredPaths);
    }
    const paths = await expandGitArcClaimPaths(repository, partitioned.paths);
    const adoptedPaths = metadata.adoptedPaths?.length
      ? (await partitionIgnoredGitArcPaths(repository, metadata.adoptedPaths)).paths
      : [];
    const registryEntries = await registry.list();
    const collisions = findGitArcCollisions(registryEntries, { harness, threadId: input.threadId }, paths);
    if (collisions.length) throw new GitArcCollisionError(collisions);
    const headIdentity = await repository.readHead();
    const head = headIdentity?.commit ?? null;
    const currentTree = await repository.writeScopedWorktreeTree(paths, head);
    const snapshotDrift = await repository.listChangedPaths(plan.checkpointCommit, currentTree, paths);
    if (snapshotDrift.length) {
      throw await createGitArcStartDiagnosticError({
        adoptedPaths,
        currentHead: head,
        currentTree,
        harness,
        planBaseCommit: plan.parent,
        planCheckpointCommit: plan.checkpointCommit,
        planPaths: paths,
        registryEntries,
        repository,
        snapshotDrift,
        threadId: input.threadId,
      });
    }
    const dirtyPaths = await repository.listChangedPaths(head, currentTree, paths);
    const retainedClaims = current?.phase === "plan" ? current.retainedArc?.claimedPaths ?? [] : [];
    const permittedDirty = new GitArcPathSet([...adoptedPaths, ...retainedClaims]);
    const unexplained = dirtyPaths.filter((candidate) => !permittedDirty.covers(candidate));
    if (unexplained.length) throw new GitCheckpointDirtyPathsError(unexplained, "Arc start");
    const dirty = new GitArcPathSet(dirtyPaths);
    const cleanAdoptions = adoptedPaths.filter((candidate) => !dirty.has(candidate) && !dirty.contains(candidate));
    if (cleanAdoptions.length) {
      throw new GitArcRejectionError({ reason: "adoptionRequiresDirty", paths: cleanAdoptions }, `Adopted plan paths are clean against current HEAD: ${cleanAdoptions.join(", ")}. Use ordinary addPaths, not adoptPaths.`);
    }

    const ownership = current
      ? await new GitArcClaimOwnershipController(repository, this.resolveThreadIdentity).project(current)
      : null;
    const guardPaths = [...new Set([...paths, ...(ownership?.baselineClaims ?? [])])].sort();
    const activeMetadata: CheckpointMetadata = {
      amendedFrom: plan.checkpointCommit,
      ...(metadata.intentDescription ? { intentDescription: metadata.intentDescription } : {}),
      intentName: metadata.intentName,
      kind: "arc",
      registryLifecycle: true,
      scopePaths: guardPaths,
      version: 3,
    };
    const baselineTree = headIdentity?.identity.tree ?? await repository.resolveTree(null);
    const prepared = await store.prepareCheckpoint(harness, input.threadId, baselineTree, head, activeMetadata);
    const releasedClaims = current ? liveClaims(current) : [];
    const registryMutation = await registry.prepareClaim({
      checkpointCommit: prepared.checkpointCommit,
      activeClaimedPaths: paths,
      claimedPaths: guardPaths,
      harness,
      intentDescription: metadata.intentDescription ?? "",
      intentName: metadata.intentName ?? "Unnamed arc",
      phase: "active",
      proposalId: null,
      proposalIds: await activationProposalIds(store, harness, input.threadId, current),
      retainedArc: undefined,
      threadId: input.threadId,
    }, current ? { expectedCheckpointCommit: current.checkpointCommit } : undefined);
    await repository.updateRefs([prepared.update, ...registryMutation.updates]);
    return {
      acquiredClaims: paths,
      changes: await repository.buildFileChanges(prepared.checkpointCommit, currentTree, paths),
      checkpointCommit: prepared.checkpointCommit,
      checkpointRef: prepared.checkpointRef,
      intentName: metadata.intentName ?? null,
      kind: "arc",
      releasedClaims,
      repoRoot: repository.root,
      scopePaths: paths,
      skippedIgnoredPaths: partitioned.skippedIgnoredPaths,
    };
  }

  private async revisePlan(input: PlanIdentityInput & { paths: string[] }, operation: "add" | "adopt" | "remove") {
    const repository = await WorkbenchGitRepository.open(input.cwd);
    const harness = normalizeHarness(input.harness);
    const registry = this.registry(repository);
    const current = await registry.find({ harness, threadId: input.threadId });
    if (!current) throw new GitArcRejectionError({ reason: "missingLifecycle" }, "This thread does not have a current Git arc or inactive plan.");
    if (current.phase === "stashed") throw new Error("This Git arc is stashed. Unstash it before revising its plan.");
    if (current.phase === "active" && operation !== "add") {
      throw new GitArcRejectionError({ reason: "activePlanMutationRequiresRevision" }, "Activate or revise the plan through combined claims before this legacy operation.");
    }
    return await this.editClaims({
      ...input,
      inherit: true,
      ...(operation === "add" ? { addPaths: input.paths } : operation === "adopt" ? { adoptPaths: input.paths } : { removePaths: input.paths }),
    });
  }

  private async writePlan(
    repository: WorkbenchGitRepository,
    registry: GitArcRegistry,
    harness: GitArcHarness,
    threadId: string,
    current: GitArcRegistryEntry | null,
    input: PlanRequest,
    options: PlanOptions = {},
  ): Promise<GitArcPlanResult | GitArcNoopResult> {
    const plan = await this.preparePlan(repository, registry, harness, threadId, current, input, options);
    if (!plan.paths.length && plan.skippedIgnoredPaths.length) {
      return createGitArcNoopResult(repository, plan.skippedIgnoredPaths);
    }
    const { retainedArc } = plan;
    const successor = await this.prepareStashedSuccessor(repository, harness, threadId, current);
    const registryMutation = await registry.prepareSet({
      checkpointCommit: plan.prepared.checkpointCommit,
      claimedPaths: [],
      harness,
      intentDescription: plan.metadata.intentDescription ?? "",
      intentName: plan.metadata.intentName ?? "Unnamed plan",
      phase: "plan",
      proposalId: null,
      proposalIds: [],
      retainedArc: retainedArc ?? undefined,
      ...(successor ? { savedStash: successor.savedStash } : {}),
      threadId,
    }, current?.checkpointCommit);
    await repository.updateRefs([
      plan.prepared.update,
      ...(successor?.updates ?? []),
      ...registryMutation.updates,
    ], successor?.deletions ?? []);
    return {
      checkpointCommit: plan.prepared.checkpointCommit,
      checkpointRef: plan.prepared.checkpointRef,
      intentName: plan.metadata.intentName ?? null,
      kind: "plan",
      claimedPaths: retainedArc?.claimedPaths ?? [],
      plannedPaths: plan.paths,
      adoptedPaths: plan.metadata.adoptedPaths ?? [],
      planningDrift: plan.planningDrift,
      repoRoot: repository.root,
      retainedPaths: plan.retainedPaths,
      scopePaths: plan.paths,
      skippedIgnoredPaths: plan.skippedIgnoredPaths,
    };
  }

  private async readPendingPlan(
    repository: WorkbenchGitRepository,
    harness: GitArcHarness,
    threadId: string,
    current: GitArcRegistryEntry | null,
  ) {
    return current?.phase === "plan" || current?.phase === "stashed" && current.retainedArc
      ? await this.store(repository).readCheckpoint(harness, threadId, current.checkpointCommit)
      : null;
  }

  private async prepareStashedSuccessor(
    repository: WorkbenchGitRepository,
    harness: GitArcHarness,
    threadId: string,
    current: GitArcRegistryEntry | null,
  ): Promise<{
    deletions: Array<{ oldValue: string; ref: string }>;
    savedStash: GitArcSavedStash;
    updates: Array<{ newValue: string; oldValue: string | null; ref: string }>;
  } | null> {
    if (current?.phase !== "stashed") return null;
    const stashes = new GitArcClaimLossStore(repository, this.resolveThreadIdentity);
    const saved = await stashes.readOwnedStash({ harness, threadId }, current);
    if (!saved?.legacy) throw new Error("The ordinary Git arc stash is unavailable.");
    const moved = await stashes.prepareRehomeFrozen({ harness, threadId }, { harness, threadId }, saved.paths);
    return {
      deletions: moved.deletions,
      savedStash: {
        checkpointCommit: saved.checkpointCommit,
        intentDescription: saved.intentDescription,
        intentName: saved.intentName,
        paths: saved.paths,
        proposalIds: saved.proposalIds,
      },
      updates: moved.updates,
    };
  }

  private async preparePlan(
    repository: WorkbenchGitRepository,
    registry: GitArcRegistry,
    harness: GitArcHarness,
    threadId: string,
    current: GitArcRegistryEntry | null,
    input: PlanRequest,
    options: PlanOptions = {},
  ) {
    const ownership = current
      ? await new GitArcClaimOwnershipController(repository, this.resolveThreadIdentity).project(current)
      : null;
    const currentPresentation = current ? presentation(current) : null;
    const baselineClaims = ownership?.baselineClaims ?? [];
    const retained = await this.prepareRetainedArc(
      repository,
      harness,
      threadId,
      currentPresentation
        ? { ...currentPresentation, activeClaimedPaths: ownership?.activeClaims ?? currentPresentation.activeClaimedPaths }
        : null,
      baselineClaims,
      current?.stackTip,
    );
    const requested = await partitionIgnoredGitArcPaths(repository, input.paths);
    const adopted = await partitionIgnoredGitArcPaths(repository, input.adoptPaths);
    const requestedPaths = requested.paths;
    const adoptPaths = adopted.paths;
    const skippedIgnoredPaths = [...new Set([
      ...(options.skippedIgnoredPaths ?? []),
      ...requested.skippedIgnoredPaths,
      ...adopted.skippedIgnoredPaths,
    ])].sort((left, right) => left.localeCompare(right));
    const exactAdoptedPaths = new Set(adoptPaths);
    const paths = requestedPaths.filter((candidate) => !exactAdoptedPaths.has(candidate));
    const requestedScope = new GitArcPathSet([...paths, ...adoptPaths]);
    const retainedPaths = retained.dirtyPaths.filter((candidate) => !requestedScope.covers(candidate));
    const scopePaths = collapseScopePaths([...paths, ...adoptPaths, ...retainedPaths]);
    const head = await repository.headOrNull();
    const worktreeTree = await repository.writeWorktreeTree(head);
    const dirtyPaths = scopePaths.length ? await repository.listChangedPaths(head, worktreeTree, scopePaths) : [];
    const entries = await registry.list();
    const liveOwners = new GitArcPathSet(entries.flatMap((entry) => liveClaims(entry)));
    const adoptedScope = new GitArcPathSet(adoptPaths);
    const unexplained = dirtyPaths.filter((dirtyPath) => !adoptedScope.covers(dirtyPath) && !liveOwners.covers(dirtyPath));
    if (unexplained.length) throw new GitCheckpointDirtyPathsError(unexplained);
    const adoptionCollisions = findGitArcCollisions(entries, { harness, threadId }, adoptPaths);
    if (adoptionCollisions.length) throw new GitArcCollisionError(adoptionCollisions);
    const dirty = new GitArcPathSet(dirtyPaths);
    const cleanAdoptions = adoptPaths.filter((candidate) => !dirty.has(candidate) && !dirty.contains(candidate));
    if (cleanAdoptions.length) {
      throw new GitArcRejectionError({ reason: "adoptionRequiresDirty", paths: cleanAdoptions }, `Arc plan adopt paths are clean against current HEAD: ${cleanAdoptions.join(", ")}. Use ordinary addPaths, not adoptPaths.`);
    }
    const claimedAdoptions = adoptPaths.filter((candidate) => liveOwners.overlaps(candidate));
    if (claimedAdoptions.length) throw new GitArcRejectionError({ reason: "adoptionRequiresUnclaimed", paths: claimedAdoptions }, `Arc plan adopt paths must be unclaimed: ${claimedAdoptions.join(", ")}`);

    const metadata: CheckpointMetadata = {
      adoptedPaths: adoptPaths,
      amendedFrom: current?.checkpointCommit ?? null,
      ...(input.intentDescription.trim() ? { intentDescription: input.intentDescription.trim() } : {}),
      intentName: input.intentName.trim(),
      kind: "plan",
      registryLifecycle: true,
      scopePaths,
      version: 3,
    };
    const store = this.store(repository);
    const baselineMetadata = options.baselinePlan ? requirePlanMetadata(options.baselinePlan.metadata) : null;
    const preservedPaths = baselineMetadata
      ? overlappingBaselinePaths(baselineMetadata.scopePaths, scopePaths)
      : [];
    const planningDrift = options.baselinePlan ? {
      previousRef: options.baselinePlan.checkpointCommit,
      paths: preservedPaths.length
        ? await repository.listChangedPaths(options.baselinePlan.checkpointCommit, worktreeTree, preservedPaths)
        : [],
    } : undefined;
    const tree = worktreeTree;
    const prepared = await store.prepareCheckpoint(
      harness,
      threadId,
      tree,
      head,
      metadata,
    );
    return {
      adoptPaths,
      baselineClaims,
      dirtyPaths,
      head,
      metadata,
      paths: scopePaths,
      prepared,
      planningDrift,
      retainedArc: retained.retainedArc,
      retainedPaths,
      skippedIgnoredPaths,
      tree,
    };
  }

  private async prepareRetainedArc(
    repository: WorkbenchGitRepository,
    harness: GitArcHarness,
    threadId: string,
    retainedArc: GitArcRegistryEntry["retainedArc"] | null,
    baselineClaims: string[],
    stackTip?: string | null,
  ): Promise<{ dirtyPaths: string[]; retainedArc: GitArcRegistryEntry["retainedArc"] | null }> {
    if (!retainedArc || retainedArc.phase === "resolved" || !retainedArc.claimedPaths.length) return { dirtyPaths: [], retainedArc };
    const store = this.store(repository);
    const checkpoint = await store.readCheckpoint(harness, threadId, retainedArc.checkpointCommit);
    const outcome = await store.readOutcome(harness, threadId, checkpoint.checkpointCommit);
    const activeClaims = retainedArc.activeClaimedPaths ?? retainedArc.claimedPaths;
    let dirtyPaths: string[] = [];
    if (activeClaims.length) {
      const baseline = outcome?.acceptedProposals?.at(-1)?.headSha ?? checkpoint.parent;
      const stack = new GitArcStackController(repository, this.resolveThreadIdentity);
      const tip = await stack.baselineTip({ stackTip }, checkpoint);
      dirtyPaths = await repository.listWorktreeChangedPaths(
        tip ? await stack.sealedTree(baseline, tip.commit) : baseline,
        activeClaims,
      );
    }
    return {
      dirtyPaths,
      retainedArc: {
        ...retainedArc,
        activeClaimedPaths: dirtyPaths,
        claimedPaths: [...new Set([...dirtyPaths, ...baselineClaims])].sort((left, right) => left.localeCompare(right)),
        phase: dirtyPaths.length || baselineClaims.length ? "active" : "resolved",
      },
    };
  }
}
