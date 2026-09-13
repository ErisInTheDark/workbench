/*
 * Exports:
 * - default GitArcPlanController: own inactive planning and atomic activation.
 * - GitCheckpointDirtyPathsError/GitCheckpointIgnoredPathsError: rejected dirty or ignored paths.
 * - partitionIgnoredGitArcPaths/rejectIgnoredGitArcPaths: ignored ownership validation.
 * - createGitArcNoopResult/GitArcNoopResult: ignored requests that changed no refs.
 * - GitArcPlanResult/GitArcPlanState/GitArcStartResult: plan and activation results.
 */
import type { GitCheckpointFileChange } from "workbench-shared/workbench/git/checkpoint-contracts";
import { applyGitClaimChanges, type GitArcClaimChanges, type GitArcPlanningDrift } from "workbench-shared/workbench/git/git-arc-state";
import createGitArcStartDiagnosticError from "./git-arc-start-diagnostics";
import GitArcRegistry, {
  findGitArcCollisions,
  GitArcCollisionError,
  type GitArcRegistryEntry,
} from "./GitArcRegistry";
import GitCheckpointStore, { type StoredCheckpoint } from "./GitCheckpointStore";
import WorkbenchGitRepository from "./WorkbenchGitRepository";
import {
  passthroughGitArcThreadIdentityResolver,
  type GitArcThreadIdentityResolver,
} from "./git-arc-thread-identity";
import { GitArcRejectionError } from "workbench-shared/workbench/git/git-arc-rejections";
import { type CheckpointMetadata, type GitArcHarness } from "workbench-shared/workbench/git/git-arc-storage";

interface PlanInput {
  adoptPaths?: string[];
  cwd: string;
  harness?: GitArcHarness;
  intentDescription?: string;
  intentName: string;
  paths: string[];
  threadId: string;
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
  const normalized = String(harness ?? "codex").trim().toLowerCase();
  if (normalized === "codex" || normalized === "copilot" || normalized === "opencode") return normalized;
  throw new GitArcRejectionError({ reason: "invalidHarness" }, "A valid checkpoint harness is required.");
}

function pathIsCoveredBy(candidate: string, scopePath: string) {
  return candidate === scopePath || candidate.startsWith(`${scopePath}/`);
}

function collapseScopePaths(paths: string[]) {
  const uniquePaths = [...new Set(paths)].sort((left, right) => left.localeCompare(right));
  return uniquePaths.filter((candidate) => !uniquePaths.some((scopePath) => (
    candidate !== scopePath && pathIsCoveredBy(candidate, scopePath)
  )));
}

function overlappingBaselinePaths(previousPaths: string[], nextPaths: string[]) {
  return [...new Set(previousPaths.flatMap((previousPath) => nextPaths.flatMap((nextPath) => {
    if (pathIsCoveredBy(nextPath, previousPath)) return [nextPath];
    if (pathIsCoveredBy(previousPath, nextPath)) return [previousPath];
    return [];
  })))].sort((left, right) => left.localeCompare(right));
}

function liveClaims(entry: GitArcRegistryEntry) {
  if (entry.phase === "resolved") return [];
  if (entry.phase === "plan") return entry.retainedArc?.claimedPaths ?? entry.claimedPaths;
  return entry.claimedPaths;
}

function presentation(entry: GitArcRegistryEntry) {
  if (entry.phase === "plan") return entry.retainedArc ?? null;
  return {
    checkpointCommit: entry.checkpointCommit,
    claimedPaths: entry.claimedPaths,
    intentDescription: entry.intentDescription,
    intentName: entry.intentName,
    phase: entry.phase === "resolved" ? "resolved" as const : "active" as const,
    proposalIds: entry.proposalIds ?? [],
  };
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
    const baselinePlan = current?.phase === "plan"
      ? await this.store(repository).readCheckpoint(harness, input.threadId, current.checkpointCommit)
      : null;
    return await this.writePlan(repository, registry, harness, input.threadId, {
      adoptPaths: input.adoptPaths ?? [],
      intentDescription: input.intentDescription ?? "",
      intentName: input.intentName,
      paths: input.paths,
      retainedArc: current ? presentation(current) : null,
    }, current?.checkpointCommit, { baselinePlan });
  }

  async editClaims(input: PlanIdentityInput & GitArcClaimChanges & { intentName?: string; intentDescription?: string; start?: boolean }) {
    const repository = await WorkbenchGitRepository.open(input.cwd);
    const harness = normalizeHarness(input.harness);
    const registry = this.registry(repository);
    const current = await registry.find({ harness, threadId: input.threadId });
    if (input.inherit && !current) throw new GitArcRejectionError({ reason: "missingLifecycle" }, "This thread has no plan or arc to inherit.");
    const baselinePlan = current?.phase === "plan"
      ? await this.store(repository).readCheckpoint(harness, input.threadId, current.checkpointCommit)
      : null;
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
    const adoptPaths = [...new Set([
      ...inheritedAdoptions.filter((candidate) => !changes.removePaths.includes(candidate)),
      ...changes.adoptPaths,
    ])];
    const intentName = input.intentName?.trim() || (input.inherit ? current?.intentName : "");
    if (!intentName) throw new GitArcRejectionError({ reason: "missingPlanName" }, "An initial or replacement plan requires an intent.");
    const planInput = {
      adoptPaths,
      intentDescription: input.intentDescription ?? (input.inherit ? current?.intentDescription ?? "" : ""),
      intentName,
      paths,
      retainedArc: current ? presentation(current) : null,
    };
    const delta = {
      addedClaims: paths.filter((candidate) => !existing.includes(candidate)),
      removedClaims: existing.filter((candidate) => !paths.includes(candidate)),
    };
    if (input.start) {
      const prepared = await this.preparePlan(repository, registry, harness, input.threadId, planInput, current?.checkpointCommit, { baselinePlan, skippedIgnoredPaths });
      return { ...await this.activatePreparedPlan(repository, registry, harness, input, current, prepared), ...delta };
    }
    return { ...await this.writePlan(repository, registry, harness, input.threadId, planInput, current?.checkpointCommit, { baselinePlan, skippedIgnoredPaths }), ...delta };
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
    const plan = await this.preparePlan(repository, registry, harness, input.threadId, {
      adoptPaths: input.adoptPaths ?? [],
      intentDescription: input.intentDescription ?? "",
      intentName: input.intentName,
      paths: input.paths,
      retainedArc: current ? presentation(current) : null,
    }, current?.checkpointCommit);
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
    const retainedArc = await this.prepareRetainedArc(
      repository,
      harness,
      input.threadId,
      current ? presentation(current) : null,
      plan.paths,
    );
    if (!plan.paths.length) throw new GitArcRejectionError({ reason: "emptyPlan" }, "An empty Git arc plan cannot start. Add at least one path first.");

    const collisions = findGitArcCollisions(await registry.list(), { harness, threadId: input.threadId }, plan.paths);
    if (collisions.length) throw new GitArcCollisionError(collisions);
    const permittedDirty = [...plan.adoptPaths, ...(retainedArc?.claimedPaths ?? [])];
    const unexplained = plan.dirtyPaths.filter((candidate) => !permittedDirty.some((scopePath) => pathIsCoveredBy(candidate, scopePath)));
    if (unexplained.length) throw new GitCheckpointDirtyPathsError(unexplained, "Arc start");
    const activeMetadata: CheckpointMetadata = {
      amendedFrom: plan.prepared.checkpointCommit,
      ...(plan.metadata.intentDescription ? { intentDescription: plan.metadata.intentDescription } : {}),
      intentName: plan.metadata.intentName,
      kind: "arc",
      registryLifecycle: true,
      scopePaths: plan.paths,
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
    const registryMutation = await registry.prepareClaim({
      checkpointCommit: active.checkpointCommit,
      claimedPaths: plan.paths,
      harness,
      intentDescription: plan.metadata.intentDescription ?? "",
      intentName: plan.metadata.intentName ?? "Unnamed arc",
      phase: "active",
      proposalId: null,
      proposalIds: [],
      retainedArc: undefined,
      threadId: input.threadId,
    }, current ? { expectedCheckpointCommit: current.checkpointCommit } : undefined);
    await repository.updateRefs([
      plan.prepared.update,
      active.update,
      ...registryMutation.updates,
    ]);
    return {
      acquiredClaims: plan.paths,
      planningDrift: plan.planningDrift,
      changes: await repository.buildFileChanges(active.checkpointCommit, plan.tree, plan.paths),
      checkpointCommit: active.checkpointCommit,
      checkpointRef: active.checkpointRef,
      intentName: plan.metadata.intentName ?? null,
      kind: "arc",
      releasedClaims: current ? liveClaims(current) : [],
      repoRoot: repository.root,
      scopePaths: plan.paths,
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
        proposalIds: [],
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
    const paths = partitioned.paths;
    if (!paths.length && partitioned.skippedIgnoredPaths.length) {
      return createGitArcNoopResult(repository, partitioned.skippedIgnoredPaths);
    }
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
    const permittedDirty = [...adoptedPaths, ...retainedClaims];
    const unexplained = dirtyPaths.filter((candidate) => !permittedDirty.some((scopePath) => pathIsCoveredBy(candidate, scopePath)));
    if (unexplained.length) throw new GitCheckpointDirtyPathsError(unexplained, "Arc start");
    const cleanAdoptions = adoptedPaths.filter((candidate) => !dirtyPaths.some((dirtyPath) => pathIsCoveredBy(dirtyPath, candidate)));
    if (cleanAdoptions.length) {
      throw new GitArcRejectionError({ reason: "adoptionRequiresDirty", paths: cleanAdoptions }, `Adopted plan paths are clean against current HEAD: ${cleanAdoptions.join(", ")}. Use ordinary addPaths, not adoptPaths.`);
    }

    const activeMetadata: CheckpointMetadata = {
      amendedFrom: plan.checkpointCommit,
      ...(metadata.intentDescription ? { intentDescription: metadata.intentDescription } : {}),
      intentName: metadata.intentName,
      kind: "arc",
      registryLifecycle: true,
      scopePaths: paths,
      version: 3,
    };
    const baselineTree = headIdentity?.identity.tree ?? await repository.resolveTree(null);
    const prepared = await store.prepareCheckpoint(harness, input.threadId, baselineTree, head, activeMetadata);
    const releasedClaims = current ? liveClaims(current) : [];
    const registryMutation = await registry.prepareClaim({
      checkpointCommit: prepared.checkpointCommit,
      claimedPaths: paths,
      harness,
      intentDescription: metadata.intentDescription ?? "",
      intentName: metadata.intentName ?? "Unnamed arc",
      phase: "active",
      proposalId: null,
      proposalIds: [],
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
    input: { adoptPaths: string[]; intentDescription: string; intentName: string; paths: string[]; retainedArc: GitArcRegistryEntry["retainedArc"] | null },
    expectedCheckpointCommit?: string,
    options: { baselinePlan?: StoredCheckpoint | null; skippedIgnoredPaths?: string[] } = {},
  ): Promise<GitArcPlanResult | GitArcNoopResult> {
    const plan = await this.preparePlan(repository, registry, harness, threadId, input, expectedCheckpointCommit, options);
    if (!plan.paths.length && plan.skippedIgnoredPaths.length) {
      return createGitArcNoopResult(repository, plan.skippedIgnoredPaths);
    }
    const retainedArc = await this.prepareRetainedArc(repository, harness, threadId, input.retainedArc, plan.paths);
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
      threadId,
    }, expectedCheckpointCommit);
    await repository.updateRefs([plan.prepared.update, ...registryMutation.updates]);
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
      scopePaths: plan.paths,
      skippedIgnoredPaths: plan.skippedIgnoredPaths,
    };
  }

  private async preparePlan(
    repository: WorkbenchGitRepository,
    registry: GitArcRegistry,
    harness: GitArcHarness,
    threadId: string,
    input: { adoptPaths: string[]; intentDescription: string; intentName: string; paths: string[]; retainedArc: GitArcRegistryEntry["retainedArc"] | null },
    amendedFrom?: string,
    options: { baselinePlan?: StoredCheckpoint | null; skippedIgnoredPaths?: string[] } = {},
  ) {
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
    const scopePaths = collapseScopePaths([...paths, ...adoptPaths]);
    const head = await repository.headOrNull();
    const worktreeTree = await repository.writeWorktreeTree(head);
    const dirtyPaths = scopePaths.length ? await repository.listChangedPaths(head, worktreeTree, scopePaths) : [];
    const entries = await registry.list();
    const liveOwners = entries.flatMap((entry) => liveClaims(entry));
    const unexplained = dirtyPaths.filter((dirtyPath) => (
      !adoptPaths.some((candidate) => pathIsCoveredBy(dirtyPath, candidate))
      && !liveOwners.some((claim) => pathIsCoveredBy(dirtyPath, claim))
    ));
    if (unexplained.length) throw new GitCheckpointDirtyPathsError(unexplained);
    const adoptionCollisions = findGitArcCollisions(entries, { harness, threadId }, adoptPaths);
    if (adoptionCollisions.length) throw new GitArcCollisionError(adoptionCollisions);
    const cleanAdoptions = adoptPaths.filter((candidate) => !dirtyPaths.some((dirtyPath) => pathIsCoveredBy(dirtyPath, candidate)));
    if (cleanAdoptions.length) {
      throw new GitArcRejectionError({ reason: "adoptionRequiresDirty", paths: cleanAdoptions }, `Arc plan adopt paths are clean against current HEAD: ${cleanAdoptions.join(", ")}. Use ordinary addPaths, not adoptPaths.`);
    }
    const claimedAdoptions = adoptPaths.filter((candidate) => liveOwners.some((claim) => pathIsCoveredBy(candidate, claim) || pathIsCoveredBy(claim, candidate)));
    if (claimedAdoptions.length) throw new GitArcRejectionError({ reason: "adoptionRequiresUnclaimed", paths: claimedAdoptions }, `Arc plan adopt paths must be unclaimed: ${claimedAdoptions.join(", ")}`);

    const metadata: CheckpointMetadata = {
      adoptedPaths: adoptPaths,
      amendedFrom: amendedFrom ?? null,
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
      dirtyPaths,
      head,
      metadata,
      paths: scopePaths,
      prepared,
      planningDrift,
      skippedIgnoredPaths,
      tree,
    };
  }

  private async prepareRetainedArc(
    repository: WorkbenchGitRepository,
    harness: GitArcHarness,
    threadId: string,
    retainedArc: GitArcRegistryEntry["retainedArc"] | null,
    planPaths: string[],
  ): Promise<GitArcRegistryEntry["retainedArc"] | null> {
    if (!retainedArc || retainedArc.phase === "resolved" || !retainedArc.claimedPaths.length) return retainedArc;
    const store = this.store(repository);
    const checkpoint = await store.readCheckpoint(harness, threadId, retainedArc.checkpointCommit);
    const outcome = await store.readOutcome(harness, threadId, checkpoint.checkpointCommit);
    const baseline = outcome?.acceptedProposals?.at(-1)?.headSha ?? checkpoint.parent;
    const dirtyPaths = await repository.listWorktreeChangedPaths(baseline, retainedArc.claimedPaths);
    const uncovered = dirtyPaths.filter((dirtyPath) => !planPaths.some((planPath) => pathIsCoveredBy(dirtyPath, planPath)));
    if (uncovered.length) {
      throw new GitArcRejectionError({ reason: "uncoveredDirtyClaims", paths: uncovered }, `A replacement plan must include every dirty claimed file: ${uncovered.join(", ")}`);
    }
    return {
      ...retainedArc,
      claimedPaths: dirtyPaths,
      phase: dirtyPaths.length ? "active" : "resolved",
    };
  }
}
