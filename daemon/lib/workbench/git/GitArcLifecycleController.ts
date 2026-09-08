/*
 * Keywords: git, arc, lifecycle, claims, continuation, atomic publication.
 * Exports:
 * - default GitArcLifecycleController: own current lifecycle reads and combined active scope transitions.
 */
import { applyGitClaimChanges, type GitArcClaimChanges, type GitArcMutationResult, type GitArcScopeState } from "workbench-shared/workbench/git/git-arc-state";
import type { CheckpointMetadata, GitArcHarness } from "workbench-shared/workbench/git/git-arc-storage";
import GitArcRegistry, { findGitArcCollisions, getGitArcLiveClaimPaths, GitArcCollisionError } from "./GitArcRegistry";
import GitArcProposalController from "./GitArcProposalController";
import { GitCheckpointDirtyPathsError, partitionIgnoredGitArcPaths } from "./GitArcPlanController";
import GitCheckpointStore from "./GitCheckpointStore";
import WorkbenchGitRepository from "./WorkbenchGitRepository";
import { GitArcRejectionError } from "workbench-shared/workbench/git/git-arc-rejections";

interface Identity {
  cwd: string;
  harness?: GitArcHarness;
  threadId: string;
}

function covers(scope: string, candidate: string) {
  return scope === candidate || candidate.startsWith(`${scope}/`);
}

export default class GitArcLifecycleController {
  private readonly proposals = new GitArcProposalController();

  async scope(input: Identity): Promise<GitArcScopeState | null> {
    const repository = await WorkbenchGitRepository.open(input.cwd);
    const harness = input.harness ?? "codex";
    const current = await new GitArcRegistry(repository).find({ harness, threadId: input.threadId });
    if (!current) return null;
    const checkpoint = await new GitCheckpointStore(repository).readCheckpoint(harness, input.threadId, current.checkpointCommit);
    return {
      phase: current.phase ?? "active",
      checkpointCommit: current.checkpointCommit,
      intentName: current.intentName,
      plannedPaths: current.phase === "plan" ? checkpoint.metadata?.scopePaths ?? [] : [],
      claimedPaths: getGitArcLiveClaimPaths(current),
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
    return await this.transition(input, input);
  }

  private async transition(
    input: Identity & { checkpointCommit?: string },
    changes?: GitArcClaimChanges,
  ): Promise<GitArcMutationResult> {
    const repository = await WorkbenchGitRepository.open(input.cwd);
    const harness = input.harness ?? "codex";
    const registry = new GitArcRegistry(repository);
    const store = new GitCheckpointStore(repository);
    const current = await registry.find({ harness, threadId: input.threadId });
    if (!current) throw new GitArcRejectionError({ reason: "missingActiveArc" }, "This thread does not own an active Git arc.");
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
      ...input, harness, checkpointCommit: checkpoint.checkpointCommit,
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
    const head = await repository.currentHead();
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
      const tree = await repository.writeScopedWorktreeTree(paths, head);
      const dirtyPaths = paths.length ? await repository.listChangedPaths(head, tree, paths) : [];
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
    const tree = retained.length
      ? await repository.writeTreeWithPathsFromSource(head, checkpoint.checkpointCommit, retained)
      : await repository.resolveTree(head);
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
      ...(registryMutation.update ? [registryMutation.update] : []),
    ]);
    return {
      ...result, checkpointCommit, checkpointRef: prepared?.checkpointRef ?? checkpoint.checkpointRef,
      phase, scopePaths, unchanged: false,
    };
  }
}
