/*
 * Exports:
 * - default GitArcLifecycleController: own current lifecycle reads and combined active scope transitions.
 */
import { applyGitClaimChanges, type GitArcClaimChanges, type GitArcMutationResult, type GitArcScopeState } from "workbench-shared/workbench/git/git-arc-state";
import { gitArcPathsOverlap } from "workbench-shared/workbench/git/git-arc-paths";
import type { CheckpointMetadata, GitArcHarness } from "workbench-shared/workbench/git/git-arc-storage";
import GitArcRegistry, { findGitArcCollisions, getGitArcLiveClaimPaths, GitArcCollisionError } from "./GitArcRegistry";
import GitArcProposalController from "./GitArcProposalController";
import { GitCheckpointDirtyPathsError, partitionIgnoredGitArcPaths } from "./GitArcPlanController";
import GitCheckpointStore from "./GitCheckpointStore";
import WorkbenchGitRepository from "./WorkbenchGitRepository";
import { GitArcRejectionError } from "workbench-shared/workbench/git/git-arc-rejections";
import {
  passthroughGitArcThreadIdentityResolver,
  type GitArcThreadIdentityResolver,
} from "./git-arc-thread-identity";

interface Identity {
  cwd: string;
  harness?: GitArcHarness;
  threadId: string;
}

type ClaimChangeRequest =
  | { kind: "add"; paths: string[] }
  | { kind: "claims"; changes: GitArcClaimChanges };

function covers(scope: string, candidate: string) {
  return scope === candidate || candidate.startsWith(`${scope}/`);
}

export default class GitArcLifecycleController {
  private readonly proposals: GitArcProposalController;

  constructor(private readonly resolveThreadIdentity: GitArcThreadIdentityResolver = passthroughGitArcThreadIdentityResolver) {
    this.proposals = new GitArcProposalController(undefined, resolveThreadIdentity);
  }

  async scope(input: Identity): Promise<GitArcScopeState | null> {
    const repository = await WorkbenchGitRepository.open(input.cwd);
    const harness = input.harness ?? "codex";
    const current = await new GitArcRegistry(repository, this.resolveThreadIdentity).find({ harness, threadId: input.threadId });
    if (!current) return null;
    const checkpoint = await new GitCheckpointStore(repository, this.resolveThreadIdentity).readCheckpoint(harness, input.threadId, current.checkpointCommit);
    return {
      phase: current.phase ?? "active",
      checkpointCommit: current.checkpointCommit,
      intentName: current.intentName,
      plannedPaths: current.phase === "plan" ? checkpoint.metadata?.scopePaths ?? [] : [],
      claimedPaths: getGitArcLiveClaimPaths(current),
      ...(current.phase === "stashed" ? { stashedPaths: current.claimedPaths } : {}),
      adoptedPaths: current.phase === "plan" ? checkpoint.metadata?.adoptedPaths ?? [] : [],
      proposals: (await this.proposals.findLifecycleState(input))?.proposals ?? [],
      repoRoot: repository.root,
    };
  }

  async continue(input: Identity & { checkpointCommit?: string }) {
    return await this.transition(input);
  }

  async claims(input: Identity & GitArcClaimChanges) {
    if (input.inherit !== true) throw new GitArcRejectionError({ reason: "inheritanceRequired" }, "Active claim edits require inherit: true.");
    return await this.transition(input, { kind: "claims", changes: input });
  }

  async add(input: Identity & { paths: string[] }) {
    if (!input.paths.length) throw new Error("Arc add requires at least one additional clean path.");
    return await this.transition(input, { kind: "add", paths: input.paths });
  }

  private async transition(
    input: Identity & { checkpointCommit?: string },
    request?: ClaimChangeRequest,
  ): Promise<GitArcMutationResult> {
    const repository = await WorkbenchGitRepository.open(input.cwd);
    const harness = input.harness ?? "codex";
    const registry = new GitArcRegistry(repository, this.resolveThreadIdentity);
    const store = new GitCheckpointStore(repository, this.resolveThreadIdentity);
    const current = await registry.find({ harness, threadId: input.threadId });
    if (!current) throw new GitArcRejectionError({ reason: "missingActiveArc" }, "This thread does not own an active Git arc.");
    if (current.phase === "stashed") throw new Error("This Git arc is stashed. Unstash it before continuing or editing claims.");
    if (request?.kind === "add") {
      const existing = getGitArcLiveClaimPaths(current);
      const overlapping = request.paths.filter((candidate) => existing.some((claim) => gitArcPathsOverlap(claim, candidate)));
      if (overlapping.length) throw new Error(`Arc paths are already covered by the claimed set: ${overlapping.join(", ")}`);
    }
    const changes: GitArcClaimChanges | undefined = request?.kind === "add"
      ? { inherit: true, addPaths: request.paths }
      : request?.changes;
    if (current.phase === "plan") throw new GitArcRejectionError({ reason: "inactiveArcRequiresStart" }, "Activate the inactive plan before editing active claims.");
    const checkpoint = await store.readCheckpoint(harness, input.threadId, current.checkpointCommit);
    const metadata = checkpoint.metadata;
    if (!metadata || (metadata.kind !== "arc" && metadata.kind !== "implement")) {
      throw new GitArcRejectionError({ reason: "notImplementationArc" }, "The registered lifecycle is not an implementation arc.");
    }
    if (input.checkpointCommit && input.checkpointCommit !== current.checkpointCommit) {
      const selected = await store.readCheckpoint(harness, input.threadId, input.checkpointCommit);
      let ancestor = checkpoint;
      while (ancestor.checkpointCommit !== selected.checkpointCommit && ancestor.metadata?.amendedFrom) {
        ancestor = await store.readCheckpoint(harness, input.threadId, ancestor.metadata.amendedFrom);
      }
      if (ancestor.checkpointCommit !== selected.checkpointCommit) {
        throw new GitArcRejectionError({ reason: "wrongLifecycleRef" }, "The selected ref does not lead to this thread's registered lifecycle.");
      }
    }
    const acceptedProposals = await this.proposals.readAcceptedOutcomes({
      ...input, harness, checkpointCommit: checkpoint.checkpointCommit, checkpoint, repository,
    });
    const existing = getGitArcLiveClaimPaths(current);
    if (current.phase !== "resolved" && (
      existing.length !== metadata.scopePaths.length
      || existing.some((candidate, index) => candidate !== metadata.scopePaths[index])
    )) throw new Error("The active Git arc registry does not match its checkpoint claim set.");
    const additions = await partitionIgnoredGitArcPaths(repository, changes?.addPaths ?? []);
    const adoptions = await partitionIgnoredGitArcPaths(repository, changes?.adoptPaths ?? []);
    const removePaths = changes?.removePaths?.length ? repository.normalizePaths(changes.removePaths) : [];
    const scopePaths = applyGitClaimChanges(existing, {
      inherit: true, addPaths: additions.paths, adoptPaths: adoptions.paths, removePaths,
    });
    const skippedIgnoredPaths = [...new Set([...additions.skippedIgnoredPaths, ...adoptions.skippedIgnoredPaths])];
    const entries = await registry.list();
    const collisions = findGitArcCollisions(entries, { harness, threadId: input.threadId }, scopePaths);
    if (collisions.length) throw new GitArcCollisionError(collisions);
    const ownedAdoptions = adoptions.paths.filter((candidate) => existing.some((scope) => covers(scope, candidate) || covers(candidate, scope)));
    if (ownedAdoptions.length) throw new GitArcRejectionError({ reason: "adoptionRequiresUnclaimed", paths: ownedAdoptions }, `Adoption requires unclaimed paths: ${ownedAdoptions.join(", ")}`);
    const result: GitArcMutationResult = {
      checkpointCommit: checkpoint.checkpointCommit,
      checkpointRef: checkpoint.checkpointRef,
      intentName: current.intentName,
      kind: "arc",
      phase: current.phase === "resolved" ? "resolved" : "active",
      scopePaths: existing,
      addedClaims: scopePaths.filter((candidate) => !existing.includes(candidate)),
      removedClaims: existing.filter((candidate) => !scopePaths.includes(candidate)),
      adoptedPaths: adoptions.paths,
      acceptedProposals,
      unchanged: true,
      repoRoot: repository.root,
      skippedIgnoredPaths,
    };
    if (changes && skippedIgnoredPaths.length && !additions.paths.length && !adoptions.paths.length && !removePaths.length) {
      return { ...result, kind: "noop", noOp: true };
    }
    if (current.phase === "resolved" && !scopePaths.length) return result;
    const headIdentity = await repository.readHead();
    const head = headIdentity?.commit ?? null;
    const retained = existing.filter((scope) => scopePaths.some((candidate) => covers(scope, candidate) || covers(candidate, scope)));
    const movement = await repository.classifyHeadMovement(checkpoint.parent, retained, checkpoint.checkpointCommit, head);
    if (current.phase !== "resolved" && movement.kind === "incompatible") {
      throw new GitArcRejectionError({ reason: "incompatibleHead" }, "Repository HEAD moved incompatibly after this arc began. Create a new plan before continuing.");
    }
    if (current.phase !== "resolved" && movement.changedPaths.length) {
      throw new GitArcRejectionError({ reason: "baselineChanged", paths: movement.changedPaths }, `Retained paths no longer match the arc baseline: ${movement.changedPaths.join(", ")}`);
    }
    if (!changes && metadata.priorProposalId && metadata.amendedFrom) {
      const transition = await store.readOutcome(harness, input.threadId, metadata.amendedFrom);
      if (transition?.status === "partial" && transition.successorCheckpoint === checkpoint.checkpointCommit
        && head === checkpoint.parent) return result;
    }
    if (changes) {
      const paths = [...new Set([...existing, ...scopePaths])];
      const dirtyPaths = paths.length ? await repository.listWorktreeChangedPaths(head, paths) : [];
      const exposed = dirtyPaths.filter((candidate) => existing.some((scope) => covers(scope, candidate))
        && !scopePaths.some((scope) => covers(scope, candidate)));
      if (exposed.length) throw new GitCheckpointDirtyPathsError(exposed, "Removed claims");
      const unexplained = dirtyPaths.filter((candidate) => !existing.some((scope) => covers(scope, candidate))
        && !adoptions.paths.some((scope) => covers(scope, candidate)));
      if (unexplained.length) throw new GitCheckpointDirtyPathsError(unexplained, "New claims");
      const cleanAdoptions = adoptions.paths.filter((scope) => !dirtyPaths.some((candidate) => covers(scope, candidate)));
      if (cleanAdoptions.length) throw new GitArcRejectionError({ reason: "adoptionRequiresDirty", paths: cleanAdoptions }, `Adoption requires dirty unclaimed paths: ${cleanAdoptions.join(", ")}`);
    }
    const proposalUpdates = scopePaths.length ? await this.proposals.prepareUnavailableUpdates({
      cwd: repository.root, harness, threadId: input.threadId,
      repository,
      proposalIds: current.proposalIds ?? (current.proposalId ? [current.proposalId] : []),
      reason: "Implementation continued after this proposal was created.",
    }) : [];
    if (!result.addedClaims.length && !result.removedClaims.length && !proposalUpdates.length
      && head === checkpoint.parent && current.phase !== "resolved") return result;
    const phase = scopePaths.length ? "active" as const : "resolved" as const;
    const nextMetadata: CheckpointMetadata = {
      amendedFrom: checkpoint.checkpointCommit,
      ...(current.intentDescription ? { intentDescription: current.intentDescription } : {}),
      intentName: current.intentName,
      kind: "arc",
      registryLifecycle: true,
      scopePaths,
      version: 3,
    };
    // The movement check proved every retained path already matches HEAD.
    const tree = headIdentity?.identity.tree ?? await repository.resolveTree(null);
    const prepared = scopePaths.length ? await store.prepareCheckpoint(harness, input.threadId, tree, head, nextMetadata) : null;
    const checkpointCommit = prepared?.checkpointCommit ?? checkpoint.checkpointCommit;
    const registryMutation = await registry.prepareClaim({
      ...current, checkpointCommit, claimedPaths: scopePaths, phase,
      proposalId: scopePaths.length ? null : current.proposalId,
      proposalIds: scopePaths.length ? [] : current.proposalIds,
      retainedArc: undefined,
    }, { expectedCheckpointCommit: current.checkpointCommit });
    const outcomeUpdate = await store.prepareOutcome(harness, input.threadId, {
      acceptedProposals,
      committedSha: acceptedProposals.at(-1)?.headSha ?? null,
      proposalId: current.proposalId ?? null,
      sourceCheckpoint: checkpoint.checkpointCommit,
      status: scopePaths.length ? "continued" : "released",
      successorCheckpoint: prepared?.checkpointCommit ?? null,
      version: 1,
    });
    await repository.updateRefs([
      ...proposalUpdates,
      ...(prepared ? [prepared.update] : []),
      outcomeUpdate,
      ...registryMutation.updates,
    ]);
    return {
      ...result, checkpointCommit, checkpointRef: prepared?.checkpointRef ?? checkpoint.checkpointRef,
      phase, scopePaths, unchanged: false,
    };
  }
}
