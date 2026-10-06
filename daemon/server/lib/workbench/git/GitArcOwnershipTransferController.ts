/*
 * Exports:
 * - GitArcAdoptionInput/GitArcAdoptionResult: complete or selected source transfer input and the recipient's receipt.
 * - GitArcSelectedTransferInput: selected live claims released to a child.
 * - default GitArcOwnershipTransferController: prepare atomic claim/stash ownership transfers; children inherit stack baselines (fast-forwarding from the releaser's lower layers) and sealed proposals survive.
 */
import { ProviderKeySchema } from "workbench-shared/workbench/provider/provider-key";
import type { GitArcHarness } from "workbench-shared/workbench/git/git-arc-storage";
import type { GitArcInvalidatedProposal } from "workbench-shared/workbench/git/git-arc-receipts";
import type { GitArcReleaseResult } from "./WorkbenchGitCheckpointController";
import GitArcRegistry, { getGitArcLiveClaimPaths, type GitArcRegistryEntry } from "./GitArcRegistry";
import GitCheckpointStore from "./GitCheckpointStore";
import GitArcProposalController from "./GitArcProposalController";
import GitArcClaimLossStore from "./GitArcClaimLossStore";
import GitArcStackController from "./GitArcStackController";
import { GitArcRejectionError } from "workbench-shared/workbench/git/git-arc-rejections";
import type { GitArcPreparedOperation } from "./GitArcRegistry";
import WorkbenchGitRepository, { type GitRefUpdate } from "./WorkbenchGitRepository";
import { passthroughGitArcThreadIdentityResolver, type GitArcThreadIdentityResolver } from "./git-arc-thread-identity";

export interface GitArcAdoptionInput {
  cwd: string;
  harness?: GitArcHarness;
  threadId: string;
  source: { harness: GitArcHarness; threadId: string };
  /** Move only these live source claims; the source keeps its stash and remaining claims. */
  selectedPaths?: string[];
}

export interface GitArcSelectedTransferInput extends GitArcAdoptionInput {
  selectedPaths: string[];
}

export interface GitArcAdoptionResult {
  checkpointCommit: string;
  checkpointRef: string;
  intentName: string;
  kind: "arc" | "plan";
  phase: "active" | "plan" | "stashed";
  repoRoot: string;
  scopePaths: string[];
  claimedPaths: string[];
  additionalClaims: string[];
  stashedPaths: string[];
  /** Source proposals that lost their owner's claims; reported so they never vanish silently. */
  invalidatedProposals: GitArcInvalidatedProposal[];
}

function liveArc(entry: GitArcRegistryEntry | null) {
  return entry?.phase === "plan" ? entry.retainedArc
    : entry?.phase === "active" ? entry : null;
}

export default class GitArcOwnershipTransferController {
  constructor(private readonly resolveThreadIdentity: GitArcThreadIdentityResolver = passthroughGitArcThreadIdentityResolver) {}

  async prepareAdoption(input: GitArcAdoptionInput): Promise<GitArcPreparedOperation<GitArcAdoptionResult>> {
    return (await this.prepareTransfer(input, input.selectedPaths ?? null, "Selected claims moved to another thread.")).operation;
  }

  async prepareReleaseToChild(input: GitArcSelectedTransferInput): Promise<GitArcPreparedOperation<GitArcReleaseResult>> {
    const { operation, sourceResult } = await this.prepareTransfer(input, input.selectedPaths, "Selected claims were released to a subagent.");
    return {
      result: sourceResult,
      apply: async () => { await operation.apply(); return sourceResult; },
      rollback: operation.rollback,
    };
  }

  private async prepareTransfer(input: GitArcAdoptionInput, selectedPaths: string[] | null, selectedReason: string) {
    const repository = await WorkbenchGitRepository.open(input.cwd);
    const harness = ProviderKeySchema.parse(input.harness ?? "codex");
    const sourceHarness = ProviderKeySchema.parse(input.source.harness);
    const [callerIdentity, sourceIdentity] = await Promise.all([
      this.resolveThreadIdentity({ harness, threadId: input.threadId, repositoryRoot: repository.root }),
      this.resolveThreadIdentity({ harness: sourceHarness, threadId: input.source.threadId, repositoryRoot: repository.root }),
    ]);
    if (!callerIdentity || !sourceIdentity) throw new Error("Both claim transfer owners must have an admitted Git identity.");
    const caller = { harness, threadId: callerIdentity.threadId };
    const source = { harness: sourceHarness, threadId: sourceIdentity.threadId };
    if (caller.threadId === source.threadId) throw new Error("A thread cannot transfer Git ownership to itself.");
    const registry = new GitArcRegistry(repository, this.resolveThreadIdentity);
    const store = new GitCheckpointStore(repository, this.resolveThreadIdentity);
    const stashes = new GitArcClaimLossStore(repository, this.resolveThreadIdentity);
    const proposals = new GitArcProposalController(undefined, this.resolveThreadIdentity);
    const [target, origin] = await Promise.all([registry.find(caller), registry.find(source)]);
    const [callerStash, sourceStash] = await Promise.all([
      stashes.readOwnedStash(caller, target), stashes.readOwnedStash(source, origin),
    ]);
    const stack = new GitArcStackController(repository, this.resolveThreadIdentity);
    const [sourceChain, targetChain] = await Promise.all([stack.readChain(origin?.stackTip), stack.readChain(target?.stackTip)]);
    const sourceOwn = stack.ownLayers(sourceChain, source);
    if (!selectedPaths && sourceOwn.length && await stack.chainHasPending(sourceOwn)) {
      throw new GitArcRejectionError({ reason: "stackedSource" }, "The source thread owns pending stack layers. They must be committed before adoption.");
    }
    // Children build on the releasing thread's sealed layers so their proposals never re-propose sealed work.
    const sourceTip = selectedPaths && sourceChain.length && await stack.chainHasPending(sourceChain) ? sourceChain.at(-1)!.tipCommit : null;
    const targetPendingTip = targetChain.length && await stack.chainHasPending(targetChain) ? targetChain.at(-1)!.tipCommit : null;
    const targetAtSourceTip = targetChain.some(({ tipCommit }) => tipCommit === sourceTip);
    // A child whose top is one of the releasing thread's lower layers has nothing of its own above it, so it
    // fast-forwards to the releaser's top, unless the skipped layers changed files the child already owns.
    const skippedIndex = targetPendingTip ? sourceChain.findIndex(({ tipCommit }) => tipCommit === targetPendingTip) : -1;
    const targetOwned = target ? getGitArcLiveClaimPaths(target) : [];
    const fastForward = Boolean(sourceTip && targetPendingTip && !targetAtSourceTip && skippedIndex >= 0
      && !sourceChain.slice(skippedIndex + 1).some(({ scopePaths }) => scopePaths.some(scope => targetOwned.includes(scope))));
    if (sourceTip && targetPendingTip && !targetAtSourceTip && !fastForward) {
      throw new GitArcRejectionError({ reason: "stackBaseMismatch" }, "The receiving thread builds on a different stack baseline.");
    }
    const recipientStackTip = sourceTip && (!targetPendingTip || fastForward) ? sourceTip : undefined;
    const sourceSealed = new Set(sourceOwn.flatMap(({ layer }) => layer.proposalIds));
    const sourceLive = origin ? getGitArcLiveClaimPaths(origin) : [];
    const requested = selectedPaths?.length ? repository.normalizePaths(selectedPaths) : [];
    if (selectedPaths && (!requested.length || new Set(requested).size !== selectedPaths.length
      || requested.some(value => !sourceLive.includes(value)))) {
      throw new Error("Every selected path must be a distinct live claim owned by the releasing thread.");
    }
    const incoming = selectedPaths ? requested : sourceLive;
    const remaining = sourceLive.filter(value => !incoming.includes(value));
    const existing = targetOwned;
    if (!incoming.length && (!sourceStash || selectedPaths)) throw new Error("The source thread owns no transferable live claims or saved stash.");
    if (!selectedPaths && sourceStash && callerStash) throw new Error("The calling thread already has a stash. Adoption cannot replace it.");
    const head = await repository.headOrNull();
    const sourceArc = liveArc(origin);
    const callerArc = liveArc(target);
    for (const [identity, entry, arc, paths] of [[source, origin, sourceArc, sourceLive], [caller, target, callerArc, existing]] as const) {
      if (!paths.length) continue;
      if (!arc) throw new Error("Live claims have no implementation baseline.");
      const checkpoint = await store.readCheckpoint(identity.harness, identity.threadId, arc.checkpointCommit);
      if (!checkpoint.metadata || !["arc", "implement"].includes(checkpoint.metadata.kind)
        || paths.some(value => !checkpoint.metadata!.scopePaths.includes(value))) {
        throw new Error("The claim transfer set does not match its implementation checkpoint.");
      }
      const movement = await stack.arcDrift(entry, checkpoint, paths, head);
      if (movement.incompatible || movement.changedPaths.length) {
        throw new Error("Claim transfer baselines changed. Re-plan the affected claims before transferring ownership.");
      }
    }
    const claimedPaths = [...new Set([...existing, ...incoming])].sort();
    const plan = target?.phase === "plan" || target?.phase === "stashed" && target.retainedArc
      ? await store.readCheckpoint(harness, caller.threadId, target.checkpointCommit) : null;
    if (plan && (!plan.metadata || plan.metadata.kind !== "plan"
      || claimedPaths.some(value => !plan.metadata!.scopePaths.some(scope => value === scope || value.startsWith(`${scope}/`))))) {
      throw new Error("The recipient's pending plan does not cover the incoming claims. Revise it before transfer.");
    }
    const updates: GitRefUpdate[] = [];
    const deletes: Array<{ oldValue?: string; ref: string }> = [];
    let stashCheckpoint: Awaited<ReturnType<GitCheckpointStore["prepareCheckpoint"]>> | null = null;
    if (!selectedPaths && sourceStash) {
      const baseline = await store.readCheckpoint(source.harness, source.threadId, sourceStash.checkpointCommit);
      if (!baseline.metadata || !["arc", "implement"].includes(baseline.metadata.kind)) {
        throw new Error("The source stash has no valid implementation checkpoint.");
      }
      stashCheckpoint = await store.prepareCheckpoint(harness, caller.threadId,
        await repository.resolveTree(baseline.checkpointCommit), baseline.parent, {
          amendedFrom: null, scopePaths: sourceStash.paths,
          intentName: sourceStash.intentName, intentDescription: sourceStash.intentDescription,
          kind: "arc", registryLifecycle: true, version: 3,
        });
      const moved = sourceStash.legacy
        ? await stashes.prepareRehomeFrozen(source, caller, sourceStash.paths)
        : await stashes.prepareRehomeAdopted(source, caller, sourceStash.paths);
      updates.push(stashCheckpoint.update, ...moved.updates);
      deletes.push(...moved.deletions);
    } else if (callerStash?.legacy) {
      const moved = await stashes.prepareRehomeFrozen(caller, caller, callerStash.paths);
      updates.push(...moved.updates);
      deletes.push(...moved.deletions);
    }
    const intentName = callerArc?.intentName ?? target?.intentName ?? sourceArc?.intentName ?? sourceStash!.intentName;
    const intentDescription = callerArc?.intentDescription ?? target?.intentDescription ?? sourceArc?.intentDescription ?? sourceStash!.intentDescription;
    const prepared = incoming.length ? await store.prepareCheckpoint(harness, caller.threadId,
      await repository.resolveTree(head), head, {
        amendedFrom: existing.length ? callerArc!.checkpointCommit : callerStash?.checkpointCommit ?? null,
        intentName, intentDescription, kind: "arc", registryLifecycle: true, scopePaths: claimedPaths, version: 3,
      }) : null;
    if (prepared) updates.push(prepared.update);
    const sourcePrepared = remaining.length ? await store.prepareCheckpoint(sourceHarness, source.threadId,
      await repository.resolveTree(head), head, {
        amendedFrom: sourceArc!.checkpointCommit,
        intentName: sourceArc!.intentName, intentDescription: sourceArc!.intentDescription,
        kind: "arc", registryLifecycle: true, scopePaths: remaining, version: 3,
      }) : null;
    if (sourcePrepared) updates.push(sourcePrepared.update);
    const checkpointCommit = prepared?.checkpointCommit ?? target?.checkpointCommit ?? stashCheckpoint!.checkpointCommit;
    const retained = {
      checkpointCommit: prepared?.checkpointCommit ?? callerArc?.checkpointCommit ?? checkpointCommit,
      claimedPaths, intentName, intentDescription, phase: claimedPaths.length ? "active" as const : "resolved" as const,
      proposalIds: callerArc?.proposalIds ?? target?.proposalIds ?? [],
    };
    const savedStash = !selectedPaths && sourceStash ? {
      checkpointCommit: stashCheckpoint!.checkpointCommit, paths: sourceStash.paths,
      intentName: sourceStash.intentName, intentDescription: sourceStash.intentDescription,
      proposalIds: [],
    } : callerStash ? {
      checkpointCommit: callerStash.checkpointCommit, paths: callerStash.paths,
      intentName: callerStash.intentName, intentDescription: callerStash.intentDescription,
      proposalIds: callerStash.proposalIds,
    } : null;
    const nextTarget = plan && target ? {
      ...target, phase: "plan" as const, claimedPaths, retainedArc: claimedPaths.length ? retained : null,
      savedStash, stackTip: recipientStackTip,
    } : {
      ...caller, ...retained, proposalId: retained.proposalIds.at(-1) ?? null, retainedArc: null, savedStash,
      stackTip: recipientStackTip,
    };
    const nextSource = origin ? origin.phase === "plan" || origin.phase === "stashed" && origin.retainedArc
      ? {
        ...origin, phase: "plan" as const, claimedPaths: remaining,
        retainedArc: sourcePrepared && origin.retainedArc
          ? { ...origin.retainedArc, checkpointCommit: sourcePrepared.checkpointCommit, claimedPaths: remaining } : null,
        proposalId: remaining.length ? origin.proposalId : null,
        proposalIds: remaining.length ? origin.proposalIds : [],
        savedStash: selectedPaths ? origin.savedStash : null,
      }
      : {
        ...origin, checkpointCommit: sourcePrepared?.checkpointCommit ?? origin.checkpointCommit,
        phase: remaining.length ? "active" as const : "resolved" as const,
        claimedPaths: remaining, savedStash: selectedPaths ? origin.savedStash : null,
      } : null;
    const mutation = await registry.prepareOwners([
      { identity: caller, expectedCheckpointCommit: target?.checkpointCommit ?? null, next: nextTarget },
      { identity: source, expectedCheckpointCommit: origin?.checkpointCommit ?? null, next: nextSource },
    ]);
    updates.push(...mutation.updates);
    // Only the source loses files. Its pending proposals covering moved files can no longer be committed by their owner;
    // sealed proposals and every caller proposal are frozen snapshots that stay committable.
    const sourceOpen = [...new Set([...(sourceArc?.proposalIds ?? origin?.proposalIds ?? []), ...(!selectedPaths ? sourceStash?.proposalIds ?? [] : [])])]
      .filter(id => !sourceSealed.has(id));
    const { updates: invalidationUpdates, invalidatedProposals } = await proposals.prepareUnavailableUpdates({
      cwd: repository.root, ...source, repository,
      proposalIds: selectedPaths
        ? await proposals.proposalsCoveringPaths(repository, source.harness, source.threadId, sourceOpen, incoming)
        : sourceOpen,
      reason: selectedPaths ? selectedReason : "Claim ownership was transferred to a coordinating thread.",
    });
    updates.push(...invalidationUpdates);
    const checkpoint = prepared ?? stashCheckpoint ?? await store.readCheckpoint(harness, caller.threadId, checkpointCommit);
    const result: GitArcAdoptionResult = {
      checkpointCommit: plan?.checkpointCommit ?? checkpointCommit,
      checkpointRef: plan?.checkpointRef ?? checkpoint.checkpointRef,
      intentName, kind: plan ? "plan" : "arc",
      phase: claimedPaths.length ? plan ? "plan" : "active" : "stashed",
      repoRoot: repository.root, scopePaths: plan?.metadata?.scopePaths ?? claimedPaths,
      claimedPaths, additionalClaims: incoming, stashedPaths: sourceStash?.paths ?? callerStash?.paths ?? [],
      invalidatedProposals,
    };
    const sourcePlan = origin?.phase === "plan"
      ? await store.readCheckpoint(sourceHarness, source.threadId, origin.checkpointCommit) : null;
    const sourceCheckpoint = sourcePlan ?? sourcePrepared ?? (origin
        ? await store.readCheckpoint(sourceHarness, source.threadId, origin.checkpointCommit) : null);
    const sourceResult: GitArcReleaseResult = {
      checkpointCommit: origin?.phase === "plan" ? origin.checkpointCommit : sourceCheckpoint?.checkpointCommit ?? checkpointCommit,
      checkpointRef: sourceCheckpoint?.checkpointRef ?? checkpoint.checkpointRef,
      intentName: origin?.intentName ?? null, kind: "arc",
      phase: origin?.phase === "plan" ? "plan" : remaining.length ? "active" : "resolved",
      repoRoot: repository.root, scopePaths: remaining, claimedPaths: remaining, releasedClaims: incoming,
      ...(sourcePlan ? { plannedPaths: sourcePlan.metadata?.scopePaths ?? [] } : {}),
      invalidatedProposals,
    };
    return {
      operation: {
        result,
        apply: async () => { await repository.updateRefs(updates, deletes); return result; },
        rollback: async () => await GitArcRegistry.rollbackRefs(repository, updates, deletes),
      },
      sourceResult,
    };
  }
}
