/*
 * Exports:
 * - default GitArcPlanController: own inactive plan creation, revision, adoption, current-plan resolution, and atomic activation. Keywords: git, arc, plan, start, retained claims.
 * - GitCheckpointDirtyPathsError: identify unexplained dirty paths rejected by plan and claim operations. Keywords: git, plan, dirty paths, adoption.
 * - GitArcPlanResult/GitArcStartResult: typed immutable plan and visible claim-transition receipts. Keywords: git, plan, start, claims.
 */
import type { GitCheckpointFileChange } from "./checkpoint-contracts";
import createGitArcStartDiagnosticError from "./git-arc-start-diagnostics";
import GitArcRegistry, {
  findGitArcCollisions,
  GitArcCollisionError,
  type GitArcRegistryEntry,
} from "./GitArcRegistry";
import GitCheckpointStore from "./GitCheckpointStore";
import WorkbenchGitRepository from "./WorkbenchGitRepository";
import { type CheckpointMetadata, type GitArcHarness } from "./git-arc-storage";

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
  checkpointCommit: string;
  checkpointRef: string;
  intentName: string | null;
  kind: "plan";
  repoRoot: string;
  scopePaths: string[];
}

export interface GitArcStartResult {
  acquiredClaims: string[];
  changes: GitCheckpointFileChange[];
  checkpointCommit: string;
  checkpointRef: string;
  intentName: string | null;
  releasedClaims: string[];
  repoRoot: string;
  scopePaths: string[];
}

export class GitCheckpointDirtyPathsError extends Error {
  readonly dirtyPaths: string[];

  constructor(dirtyPaths: string[], operation = "Plan") {
    super(`${operation} paths must be clean against HEAD: ${dirtyPaths.join(", ")}`);
    this.name = "GitCheckpointDirtyPathsError";
    this.dirtyPaths = dirtyPaths;
  }
}

function normalizeHarness(harness: string | undefined): GitArcHarness {
  const normalized = String(harness ?? "codex").trim().toLowerCase();
  if (normalized === "codex" || normalized === "copilot" || normalized === "opencode") return normalized;
  throw new Error("A valid checkpoint harness is required.");
}

function pathIsCoveredBy(candidate: string, scopePath: string) {
  return candidate === scopePath || candidate.startsWith(`${scopePath}/`);
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
  if (!metadata || metadata.kind !== "plan") throw new Error("The selected checkpoint is not an inactive Git arc plan.");
  return metadata;
}

export default class GitArcPlanController {
  async createPlan(input: PlanInput): Promise<GitArcPlanResult> {
    const repository = await WorkbenchGitRepository.open(input.cwd);
    const harness = normalizeHarness(input.harness);
    const registry = new GitArcRegistry(repository);
    const current = await registry.find({ harness, threadId: input.threadId });
    return await this.writePlan(repository, registry, harness, input.threadId, {
      adoptPaths: input.adoptPaths ?? [],
      intentDescription: input.intentDescription ?? "",
      intentName: input.intentName,
      paths: input.paths,
      retainedArc: current ? presentation(current) : null,
    }, current?.checkpointCommit);
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

  async createAndStartPlan(input: PlanInput): Promise<GitArcStartResult> {
    const repository = await WorkbenchGitRepository.open(input.cwd);
    const harness = normalizeHarness(input.harness);
    const registry = new GitArcRegistry(repository);
    const current = await registry.find({ harness, threadId: input.threadId });
    const plan = await this.preparePlan(repository, registry, harness, input.threadId, {
      adoptPaths: input.adoptPaths ?? [],
      intentDescription: input.intentDescription ?? "",
      intentName: input.intentName,
      paths: input.paths,
      retainedArc: current ? presentation(current) : null,
    }, current?.checkpointCommit);
    const retainedArc = await this.prepareRetainedArc(
      repository,
      harness,
      input.threadId,
      current ? presentation(current) : null,
      plan.paths,
    );
    if (!plan.paths.length) throw new Error("An empty Git arc plan cannot start. Add at least one path first.");

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
    const store = new GitCheckpointStore(repository);
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
      ...(registryMutation.update ? [registryMutation.update] : []),
    ]);
    return {
      acquiredClaims: plan.paths,
      changes: await repository.buildFileChanges(active.checkpointCommit, plan.tree, plan.paths),
      checkpointCommit: active.checkpointCommit,
      checkpointRef: active.checkpointRef,
      intentName: plan.metadata.intentName ?? null,
      releasedClaims: current ? liveClaims(current) : [],
      repoRoot: repository.root,
      scopePaths: plan.paths,
    };
  }

  async startArc(input: PlanIdentityInput & { checkpointCommit?: string }): Promise<GitArcStartResult> {
    const repository = await WorkbenchGitRepository.open(input.cwd);
    const harness = normalizeHarness(input.harness);
    const registry = new GitArcRegistry(repository);
    const current = await registry.find({ harness, threadId: input.threadId });
    const checkpointCommit = input.checkpointCommit ?? (current?.phase === "plan" ? current.checkpointCommit : null);
    if (!checkpointCommit) throw new Error("This thread does not have a current inactive Git arc plan.");
    const store = new GitCheckpointStore(repository);
    const plan = await store.readCheckpoint(harness, input.threadId, checkpointCommit);
    if (plan.metadata && (plan.metadata.kind === "arc" || plan.metadata.kind === "implement")) {
      const metadata = plan.metadata;
      if (!metadata.scopePaths.length) throw new Error("An empty Git arc plan cannot start. Add at least one path first.");
      const paths = repository.normalizePaths(metadata.scopePaths);
      const currentTree = await repository.writeScopedWorktreeTree(paths);
      const changes = await repository.buildFileChanges(plan.checkpointCommit, currentTree, paths);
      if (metadata.version >= 3 && changes.length && current?.checkpointCommit !== plan.checkpointCommit) {
        throw await createGitArcStartDiagnosticError({
          adoptedPaths: [],
          currentHead: await repository.currentHead(),
          currentTree,
          harness,
          planBaseCommit: plan.parent,
          planCheckpointCommit: plan.checkpointCommit,
          planPaths: paths,
          registryEntries: await registry.list(),
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
        releasedClaims: [],
        repoRoot: repository.root,
        scopePaths: paths,
      };
    }
    const metadata = requirePlanMetadata(plan.metadata);
    if (!metadata.scopePaths.length) throw new Error("An empty Git arc plan cannot start. Add at least one path first.");
    const paths = repository.normalizePaths(metadata.scopePaths);
    const adoptedPaths = metadata.adoptedPaths?.length ? repository.normalizePaths(metadata.adoptedPaths) : [];
    const currentTree = await repository.writeScopedWorktreeTree(paths);
    const snapshotDrift = await repository.listChangedPaths(plan.checkpointCommit, currentTree, paths);
    const head = await repository.currentHead();
    const registryEntries = await registry.list();
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
    const collisions = findGitArcCollisions(registryEntries, { harness, threadId: input.threadId }, paths);
    if (collisions.length) throw new GitArcCollisionError(collisions);
    const dirtyPaths = await repository.listChangedPaths(head, currentTree, paths);
    const retainedClaims = current?.phase === "plan" ? current.retainedArc?.claimedPaths ?? [] : [];
    const permittedDirty = [...adoptedPaths, ...retainedClaims];
    const unexplained = dirtyPaths.filter((candidate) => !permittedDirty.some((scopePath) => pathIsCoveredBy(candidate, scopePath)));
    if (unexplained.length) throw new GitCheckpointDirtyPathsError(unexplained, "Arc start");
    const cleanAdoptions = adoptedPaths.filter((candidate) => !dirtyPaths.some((dirtyPath) => pathIsCoveredBy(dirtyPath, candidate)));
    if (cleanAdoptions.length) {
      throw new Error(`Adopted plan paths are clean against current HEAD: ${cleanAdoptions.join(", ")}. Clean or committed paths belong after -- as ordinary plan paths, not under --adopt.`);
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
    const baselineTree = await repository.resolveTree(head);
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
    await repository.updateRefs([prepared.update, ...(registryMutation.update ? [registryMutation.update] : [])]);
    const activeTree = await repository.writeScopedWorktreeTree(paths, head);
    return {
      acquiredClaims: paths,
      changes: await repository.buildFileChanges(prepared.checkpointCommit, activeTree, paths),
      checkpointCommit: prepared.checkpointCommit,
      checkpointRef: prepared.checkpointRef,
      intentName: metadata.intentName ?? null,
      releasedClaims,
      repoRoot: repository.root,
      scopePaths: paths,
    };
  }

  private async revisePlan(input: PlanIdentityInput & { paths: string[] }, operation: "add" | "adopt" | "remove") {
    const repository = await WorkbenchGitRepository.open(input.cwd);
    const harness = normalizeHarness(input.harness);
    const registry = new GitArcRegistry(repository);
    const current = await registry.find({ harness, threadId: input.threadId });
    if (!current) throw new Error("This thread does not have a current Git arc or inactive plan.");
    const paths = repository.normalizePaths(input.paths);
    if (current.phase === "active") {
      if (operation !== "add") {
        throw new Error("Only arc plan add can create an inactive plan from an active Git arc.");
      }
      return await this.writePlan(repository, registry, harness, input.threadId, {
        adoptPaths: [],
        intentDescription: current.intentDescription,
        intentName: current.intentName,
        paths: [...new Set([...current.claimedPaths, ...paths])].sort((left, right) => left.localeCompare(right)),
        retainedArc: presentation(current),
      }, current.checkpointCommit);
    }
    if (current.phase !== "plan") throw new Error("This thread does not have a current inactive Git arc plan.");
    const plan = await new GitCheckpointStore(repository).readCheckpoint(harness, input.threadId, current.checkpointCommit);
    const metadata = requirePlanMetadata(plan.metadata);
    const existing = metadata.scopePaths;
    const existingAdopted = metadata.adoptedPaths ?? [];
    if (operation === "adopt") {
      const collisions = findGitArcCollisions(await registry.list(), { harness, threadId: input.threadId }, paths);
      if (collisions.length) throw new GitArcCollisionError(collisions);
    }
    if (operation === "remove") {
      const unknown = paths.filter((candidate) => !existing.includes(candidate));
      if (unknown.length) throw new Error(`Arc plan remove paths must exactly match planned entries: ${unknown.join(", ")}`);
    }
    const nextPaths = operation === "remove"
      ? existing.filter((candidate) => !paths.includes(candidate))
      : [...new Set([...existing, ...paths])].sort((left, right) => left.localeCompare(right));
    const nextAdopted = operation === "remove"
      ? existingAdopted.filter((candidate) => !paths.includes(candidate))
      : operation === "adopt" ? [...new Set([...existingAdopted, ...paths])].sort((left, right) => left.localeCompare(right)) : existingAdopted;
    return await this.writePlan(repository, registry, harness, input.threadId, {
      adoptPaths: nextAdopted,
      intentDescription: metadata.intentDescription ?? "",
      intentName: metadata.intentName ?? current.intentName,
      paths: nextPaths,
      retainedArc: current.retainedArc ?? null,
    }, current.checkpointCommit);
  }

  private async writePlan(
    repository: WorkbenchGitRepository,
    registry: GitArcRegistry,
    harness: GitArcHarness,
    threadId: string,
    input: { adoptPaths: string[]; intentDescription: string; intentName: string; paths: string[]; retainedArc: GitArcRegistryEntry["retainedArc"] | null },
    expectedCheckpointCommit?: string,
  ): Promise<GitArcPlanResult> {
    const plan = await this.preparePlan(repository, registry, harness, threadId, input, expectedCheckpointCommit);
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
    await repository.updateRefs([plan.prepared.update, ...(registryMutation.update ? [registryMutation.update] : [])]);
    return {
      checkpointCommit: plan.prepared.checkpointCommit,
      checkpointRef: plan.prepared.checkpointRef,
      intentName: plan.metadata.intentName ?? null,
      kind: "plan",
      repoRoot: repository.root,
      scopePaths: plan.paths,
    };
  }

  private async preparePlan(
    repository: WorkbenchGitRepository,
    registry: GitArcRegistry,
    harness: GitArcHarness,
    threadId: string,
    input: { adoptPaths: string[]; intentDescription: string; intentName: string; paths: string[]; retainedArc: GitArcRegistryEntry["retainedArc"] | null },
    amendedFrom?: string,
  ) {
    const paths = input.paths.length ? repository.normalizePaths(input.paths) : [];
    const adoptPaths = input.adoptPaths.length ? repository.normalizePaths(input.adoptPaths) : [];
    const overlap = adoptPaths.flatMap((adoptedPath) => paths
      .filter((ordinaryPath) => pathIsCoveredBy(adoptedPath, ordinaryPath) || pathIsCoveredBy(ordinaryPath, adoptedPath))
      .map((ordinaryPath) => ({ adoptedPath, ordinaryPath })));
    if (overlap.length) {
      const details = overlap.map(({ adoptedPath, ordinaryPath }) => `${adoptedPath} (--adopt) overlaps ${ordinaryPath} (after --)`).join(", ");
      throw new Error(`Adopted paths already join the plan scope and must not overlap ordinary plan paths: ${details}. Keep dirty unclaimed paths under --adopt, and remove their duplicate ordinary scope after --.`);
    }
    const scopePaths = [...new Set([...paths, ...adoptPaths])].sort((left, right) => left.localeCompare(right));
    const head = await repository.currentHead();
    const tree = await repository.writeWorktreeTree();
    const dirtyPaths = scopePaths.length ? await repository.listChangedPaths(head, tree, scopePaths) : [];
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
      throw new Error(`Arc plan adopt paths are clean against current HEAD: ${cleanAdoptions.join(", ")}. Clean or committed paths belong after -- as ordinary plan paths, not under --adopt.`);
    }
    const claimedAdoptions = adoptPaths.filter((candidate) => liveOwners.some((claim) => pathIsCoveredBy(candidate, claim) || pathIsCoveredBy(claim, candidate)));
    if (claimedAdoptions.length) throw new Error(`Arc plan adopt paths must be unclaimed: ${claimedAdoptions.join(", ")}`);

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
    const store = new GitCheckpointStore(repository);
    const prepared = await store.prepareCheckpoint(harness, threadId, tree, head, metadata);
    return { adoptPaths, dirtyPaths, head, metadata, paths: scopePaths, prepared, tree };
  }

  private async prepareRetainedArc(
    repository: WorkbenchGitRepository,
    harness: GitArcHarness,
    threadId: string,
    retainedArc: GitArcRegistryEntry["retainedArc"] | null,
    planPaths: string[],
  ): Promise<GitArcRegistryEntry["retainedArc"] | null> {
    if (!retainedArc || retainedArc.phase === "resolved" || !retainedArc.claimedPaths.length) return retainedArc;
    const store = new GitCheckpointStore(repository);
    const checkpoint = await store.readCheckpoint(harness, threadId, retainedArc.checkpointCommit);
    const outcome = await store.readOutcome(harness, threadId, checkpoint.checkpointCommit);
    const baseline = outcome?.acceptedProposals?.at(-1)?.headSha ?? checkpoint.parent;
    const currentTree = await repository.writeScopedWorktreeTree(retainedArc.claimedPaths, baseline);
    const dirtyPaths = await repository.listChangedPaths(baseline, currentTree, retainedArc.claimedPaths);
    const uncovered = dirtyPaths.filter((dirtyPath) => !planPaths.some((planPath) => pathIsCoveredBy(dirtyPath, planPath)));
    if (uncovered.length) {
      throw new Error(`A replacement plan must include every dirty claimed file: ${uncovered.join(", ")}`);
    }
    return {
      ...retainedArc,
      claimedPaths: dirtyPaths,
      phase: dirtyPaths.length ? "active" : "resolved",
    };
  }
}
