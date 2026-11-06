/*
 * Exports:
 * - GitArcAdoptionInput/GitArcAdoptionResult: complete or selected source transfer input and the recipient's receipt.
 * - GitArcSelectedTransferInput: selected live claims released to a child, optionally editing its inactive plan.
 * - GitArcPlanTransferEdit/GitArcPlanTransferInput: edits a parent applies to a child's inactive plan, and the input resolving what that plan selects.
 * - gitArcAdoptionHandlesStash/assertGitArcAdoptionStashChoice: classify and validate the source-stash move, leave or discard choice.
 * - default GitArcOwnershipTransferController: resolve plan-selected transfers and prepare atomic claim/stash ownership transfers, optionally discarding the source stash; children inherit stack baselines (fast-forwarding from the releaser's lower layers), sealed proposals survive and selected transfers reject unsealed ones.
 */
import { ProviderKeySchema } from "workbench-shared/workbench/provider/provider-key";
import type { GitArcHarness } from "workbench-shared/workbench/git/git-arc-storage";
import type { GitArcInvalidatedProposal } from "workbench-shared/workbench/git/git-arc-receipts";
import GitArcPathSet from "workbench-shared/workbench/git/GitArcPathSet";
import { applyGitClaimChanges, assertSelectedLiveClaims } from "workbench-shared/workbench/git/git-arc-state";
import type { GitArcReleaseResult } from "./WorkbenchGitCheckpointController";
import { expandGitArcClaimPaths } from "./git-arc-claim-expansion";
import GitArcClaimOwnershipController from "./GitArcClaimOwnershipController";
import GitArcRegistry, { type GitArcRegistryEntry } from "./GitArcRegistry";
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
  /** Required when the source has saved stash unless it is discarded: true moves it; false leaves it. */
  transferStash?: boolean;
  /** Delete the source's saved stash in the same ref transition instead of moving or leaving it. */
  discardStash?: boolean;
}

export interface GitArcPlanTransferEdit {
  addPaths: string[];
  removePaths: string[];
}

export interface GitArcSelectedTransferInput extends GitArcAdoptionInput {
  selectedPaths: string[];
  /** Applied to the recipient's inactive plan in the same ref transaction. */
  planEdit?: GitArcPlanTransferEdit;
}

export type GitArcPlanTransferInput = Pick<GitArcAdoptionInput, "cwd" | "harness" | "source" | "threadId"> & GitArcPlanTransferEdit;

export interface GitArcAdoptionResult {
  checkpointCommit: string;
  checkpointRef: string;
  intentName: string;
  kind: "arc" | "plan";
  phase: "active" | "plan" | "stashed" | "resolved";
  repoRoot: string;
  scopePaths: string[];
  claimedPaths: string[];
  additionalClaims: string[];
  stashedPaths: string[];
  /** Source proposals that lost their owner's claims; reported so they never vanish silently. */
  invalidatedProposals: GitArcInvalidatedProposal[];
}

type GitArcAdoptionStashChoice = Pick<GitArcAdoptionInput, "discardStash" | "transferStash">;

/** Whether the adoption moves or deletes the source's saved stash rather than leaving it. */
export function gitArcAdoptionHandlesStash(input: GitArcAdoptionStashChoice) {
  return input.transferStash === true || input.discardStash === true;
}

/** A source with saved stash needs an explicit move, leave or discard; a source without one accepts none of them. */
export function assertGitArcAdoptionStashChoice(input: GitArcAdoptionStashChoice, sourceHasStash: boolean) {
  if (input.discardStash && input.transferStash !== undefined) throw new Error("Choose either discardStash or transferStash.");
  if (sourceHasStash && input.transferStash === undefined && !input.discardStash) {
    throw new Error("The source has saved stash. Set transferStash explicitly to true or false, or discardStash to delete it.");
  }
  if (!sourceHasStash && gitArcAdoptionHandlesStash(input)) {
    throw new Error(`${input.discardStash ? "discardStash" : "transferStash"} is set, but the source has no saved stash.`);
  }
}

function liveArc(entry: GitArcRegistryEntry | null) {
  return entry?.phase === "plan" ? entry.retainedArc
    : entry?.phase === "active" ? entry : null;
}

async function readRecipientPlan(store: GitCheckpointStore, harness: GitArcHarness, threadId: string, entry: GitArcRegistryEntry | null) {
  if (entry?.phase !== "plan" && !(entry?.phase === "stashed" && entry.retainedArc)) return null;
  const plan = await store.readCheckpoint(harness, threadId, entry.checkpointCommit);
  if (!plan.metadata || plan.metadata.kind !== "plan") throw new Error("The recipient's inactive plan checkpoint is invalid.");
  return { ...plan, metadata: plan.metadata };
}

/** The plan scope after a parent's edits. Removing a file inside a planned folder expands only that folder entry. */
async function editPlanScope(repository: WorkbenchGitRepository, scopePaths: readonly string[], edit: GitArcPlanTransferEdit) {
  const addPaths = edit.addPaths.length ? repository.normalizePaths(edit.addPaths) : [];
  const removePaths = edit.removePaths.length ? repository.normalizePaths(edit.removePaths) : [];
  const scope = new GitArcPathSet(scopePaths);
  const carved = new Set(removePaths.flatMap(removal => scope.holding(removal)));
  const inherited = [...scopePaths.filter(entry => !carved.has(entry)), ...await expandGitArcClaimPaths(repository, [...carved])];
  return {
    addPaths, removals: new GitArcPathSet(removePaths),
    scopePaths: applyGitClaimChanges(inherited, { inherit: true, addPaths, removePaths }),
  };
}

export default class GitArcOwnershipTransferController {
  constructor(private readonly resolveThreadIdentity: GitArcThreadIdentityResolver = passthroughGitArcThreadIdentityResolver) {}

  async prepareAdoption(input: GitArcAdoptionInput): Promise<GitArcPreparedOperation<GitArcAdoptionResult>> {
    return (await this.prepareTransfer(input, input.selectedPaths ?? null)).operation;
  }

  async prepareReleaseToChild(input: GitArcSelectedTransferInput): Promise<GitArcPreparedOperation<GitArcReleaseResult>> {
    const { operation, sourceResult } = await this.prepareTransfer(input, input.selectedPaths, input.planEdit);
    return {
      result: sourceResult,
      apply: async () => { await operation.apply(); return sourceResult; },
      rollback: operation.rollback,
    };
  }

  /** What a plan-selected transfer would move in this repository, or null when the recipient has no inactive plan here. */
  async resolvePlanTransfer(input: GitArcPlanTransferInput) {
    const repository = await WorkbenchGitRepository.open(input.cwd);
    const { caller, source } = await this.resolveOwners(repository, input);
    const registry = new GitArcRegistry(repository, this.resolveThreadIdentity);
    const [target, origin] = await Promise.all([registry.find(caller), registry.find(source)]);
    const editsPlan = input.addPaths.length > 0 || input.removePaths.length > 0;
    const plan = await readRecipientPlan(new GitCheckpointStore(repository, this.resolveThreadIdentity), caller.harness, caller.threadId, target);
    if (!plan) {
      if (editsPlan) throw new GitArcRejectionError({ reason: "missingInactivePlan" }, "Plan edits name a repository where the subagent has no inactive plan.");
      return null;
    }
    const edited = await editPlanScope(repository, plan.metadata.scopePaths, input);
    const sourceLive = origin ? (await new GitArcClaimOwnershipController(repository, this.resolveThreadIdentity).project(origin)).guardClaims : [];
    const live = new GitArcPathSet(sourceLive);
    const unowned = edited.addPaths.filter(value => !live.overlaps(value));
    if (unowned.length) throw new Error(`Added plan paths must overlap claims the releasing thread owns: ${unowned.join(", ")}`);
    const scope = new GitArcPathSet(edited.scopePaths);
    return { editsPlan, selectedPaths: sourceLive.filter(value => scope.covers(value)) };
  }

  private async resolveOwners(repository: WorkbenchGitRepository, input: Pick<GitArcAdoptionInput, "harness" | "source" | "threadId">) {
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
    return { caller, source };
  }

  private async prepareTransfer(input: GitArcAdoptionInput, selectedPaths: string[] | null, planEdit?: GitArcPlanTransferEdit) {
    const repository = await WorkbenchGitRepository.open(input.cwd);
    const { caller, source } = await this.resolveOwners(repository, input);
    const { harness } = caller;
    const sourceHarness = source.harness;
    const registry = new GitArcRegistry(repository, this.resolveThreadIdentity);
    const store = new GitCheckpointStore(repository, this.resolveThreadIdentity);
    const stashes = new GitArcClaimLossStore(repository, this.resolveThreadIdentity);
    const proposals = new GitArcProposalController(undefined, this.resolveThreadIdentity);
    const [target, origin] = await Promise.all([registry.find(caller), registry.find(source)]);
    const ownership = new GitArcClaimOwnershipController(repository, this.resolveThreadIdentity);
    const [targetOwnership, sourceOwnership] = await Promise.all([
      target ? ownership.project(target) : null,
      origin ? ownership.project(origin) : null,
    ]);
    const [callerStash, sourceStash] = await Promise.all([
      stashes.readOwnedStash(caller, target), stashes.readOwnedStash(source, origin),
    ]);
    assertGitArcAdoptionStashChoice(input, Boolean(sourceStash));
    const moveStash = Boolean(sourceStash && input.transferStash);
    const discardStash = Boolean(sourceStash && input.discardStash);
    const stashLeaves = moveStash || discardStash;
    const stack = new GitArcStackController(repository, this.resolveThreadIdentity);
    const [sourceChain, targetChain] = await Promise.all([stack.readChain(origin?.stackTip), stack.readChain(target?.stackTip)]);
    const targetOwn = stack.ownLayers(targetChain, caller);
    if (moveStash && targetOwn.length && await stack.chainHasPending(targetOwn)) {
      throw new GitArcRejectionError({ reason: "pendingStack" }, "Saved stash cannot move to a thread with its own pending stack layers.");
    }
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
    const targetOwned = targetOwnership?.guardClaims ?? [];
    const targetOwnedSet = new Set(targetOwned);
    const fastForward = Boolean(sourceTip && targetPendingTip && !targetAtSourceTip && skippedIndex >= 0
      && !sourceChain.slice(skippedIndex + 1).some(({ scopePaths }) => scopePaths.some(scope => targetOwnedSet.has(scope))));
    if (sourceTip && targetPendingTip && !targetAtSourceTip && !fastForward) {
      throw new GitArcRejectionError({ reason: "stackBaseMismatch" }, "The receiving thread builds on a different stack baseline.");
    }
    const recipientStackTip = sourceTip && (!targetPendingTip || fastForward) ? sourceTip : undefined;
    const sourceSealed = new Set(sourceOwn.flatMap(({ layer }) => layer.proposalIds));
    const sourceLive = sourceOwnership?.guardClaims ?? [];
    const requested = selectedPaths?.length ? repository.normalizePaths(selectedPaths) : [];
    assertSelectedLiveClaims(requested, sourceLive);
    const incoming = selectedPaths ? requested : sourceLive;
    const incomingSet = new Set(incoming);
    const remaining = sourceLive.filter(value => !incomingSet.has(value));
    const remainingActive = (sourceOwnership?.activeClaims ?? []).filter(value => !incomingSet.has(value));
    const existing = targetOwned;
    const targetActive = [...new Set([...(targetOwnership?.activeClaims ?? []), ...incoming])].sort();
    if (!incoming.length && !moveStash && !discardStash && !planEdit) throw new Error("The source thread owns no selected live claims or saved stash.");
    // A discard-only adoption changes nothing the caller owns, so the caller's registry entry stays untouched.
    const callerChanges = incoming.length > 0 || moveStash || Boolean(planEdit);
    if (moveStash && callerStash) throw new Error("The calling thread already has a stash. Adoption cannot replace it.");
    const head = await repository.headOrNull();
    const sourceArc = liveArc(origin);
    const callerArc = liveArc(target);
    for (const [identity, entry, arc, paths] of [[source, origin, sourceArc, sourceLive], [caller, target, callerArc, callerChanges ? existing : []]] as const) {
      if (!paths.length) continue;
      if (!arc) throw new Error("Live claims have no implementation baseline.");
      const checkpoint = await store.readCheckpoint(identity.harness, identity.threadId, arc.checkpointCommit);
      const scope = new Set(checkpoint.metadata?.scopePaths);
      if (!checkpoint.metadata || !["arc", "implement"].includes(checkpoint.metadata.kind)
        || paths.some(value => !scope.has(value))) {
        throw new Error("The claim transfer set does not match its implementation checkpoint.");
      }
      const movement = await stack.arcDrift(entry, checkpoint, paths, head);
      if (movement.incompatible || movement.changedPaths.length) {
        throw new Error("Claim transfer baselines changed. Re-plan the affected claims before transferring ownership.");
      }
    }
    // Only the source loses files. Its unsealed proposals are about to be built on, which needs a stack layer; a selected
    // transfer leaves that choice to its owner. A whole-source move may have no live owner left to choose, so it invalidates them.
    // Sealed proposals and every caller proposal are frozen snapshots that stay committable.
    const sourcePending = (sourceArc?.proposalIds ?? origin?.proposalIds ?? []).filter(id => !sourceSealed.has(id));
    if (selectedPaths) {
      const covering = await proposals.proposalsCoveringPaths(repository, source.harness, source.threadId, sourcePending, incoming);
      if (covering.length) {
        throw new GitArcRejectionError(
          { reason: "pathsInPendingProposal", paths: [...new Set(covering.flatMap(({ paths }) => paths))] },
          `Selected claims are in the releasing thread's unsealed pending proposals ${covering.map(({ proposalId }) => proposalId).join(", ")}. Stack them to keep them and let the recipient build on the layer, or rescind them, before transferring.`,
        );
      }
    }
    const claimedPaths = [...new Set([...existing, ...incoming])].sort();
    const plan = await readRecipientPlan(store, harness, caller.threadId, target);
    if (planEdit && !plan) throw new GitArcRejectionError({ reason: "missingInactivePlan" }, "Plan edits need the recipient's inactive plan.");
    const editedPlan = plan && planEdit ? await editPlanScope(repository, plan.metadata.scopePaths, planEdit) : null;
    const planScope = new GitArcPathSet(editedPlan?.scopePaths ?? plan?.metadata.scopePaths);
    if (plan && claimedPaths.some(value => !planScope.covers(value))) {
      throw new Error("The recipient's pending plan does not cover the incoming claims. Revise it before transfer.");
    }
    const updates: GitRefUpdate[] = [];
    const deletes: Array<{ oldValue?: string; ref: string }> = [];
    // Seeding from the old plan tree keeps existing paths' baselines, so edits never swallow the recipient's drift.
    const nextPlan = plan && editedPlan ? await store.prepareCheckpoint(harness, caller.threadId,
      await (editedPlan.addPaths.length
        ? repository.writeScopedWorktreeTree(editedPlan.addPaths, plan.checkpointCommit)
        : repository.resolveTree(plan.checkpointCommit)),
      plan.parent, {
        ...plan.metadata,
        adoptedPaths: (plan.metadata.adoptedPaths ?? []).filter(value => !editedPlan.removals.covers(value)),
        amendedFrom: plan.checkpointCommit,
        scopePaths: editedPlan.scopePaths,
      }) : null;
    if (nextPlan) updates.push(nextPlan.update);
    if (discardStash && sourceStash) {
      deletes.push(...sourceStash.legacy
        ? (await stashes.prepareDeleteFrozen(source, sourceStash.paths)).deletions
        : await stashes.prepareDeleteAdopted(source, sourceStash.paths));
    }
    let stashCheckpoint: Awaited<ReturnType<GitCheckpointStore["prepareCheckpoint"]>> | null = null;
    if (moveStash && sourceStash) {
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
    } else if (callerStash?.legacy && callerChanges) {
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
    // Discard-only adoption by a thread without Git arc state reports the source's last checkpoint.
    const checkpointCommit = prepared?.checkpointCommit ?? target?.checkpointCommit ?? stashCheckpoint?.checkpointCommit ?? origin!.checkpointCommit;
    const retained = {
      checkpointCommit: prepared?.checkpointCommit ?? callerArc?.checkpointCommit ?? checkpointCommit,
      activeClaimedPaths: targetActive,
      claimedPaths, intentName, intentDescription, phase: claimedPaths.length ? "active" as const : "resolved" as const,
      proposalIds: callerArc?.proposalIds ?? target?.proposalIds ?? [],
    };
    const savedStash = sourceStash && stashCheckpoint ? {
      checkpointCommit: stashCheckpoint.checkpointCommit, paths: sourceStash.paths,
      intentName: sourceStash.intentName, intentDescription: sourceStash.intentDescription,
      proposalIds: [],
    } : callerStash ? {
      checkpointCommit: callerStash.checkpointCommit, paths: callerStash.paths,
      intentName: callerStash.intentName, intentDescription: callerStash.intentDescription,
      proposalIds: callerStash.proposalIds,
    } : null;
    const nextTarget = plan && target ? {
      ...target, ...nextPlan ? { checkpointCommit: nextPlan.checkpointCommit } : {},
      phase: "plan" as const, claimedPaths, retainedArc: claimedPaths.length ? retained : null,
      savedStash, stackTip: recipientStackTip,
    } : {
      ...caller, ...retained, proposalId: retained.proposalIds.at(-1) ?? null, retainedArc: null, savedStash,
      stackTip: recipientStackTip,
    };
    const nextSource = origin ? origin.phase === "plan" || origin.phase === "stashed" && origin.retainedArc
      ? {
        ...origin, phase: "plan" as const, claimedPaths: remaining,
        retainedArc: sourcePrepared && origin.retainedArc
          ? {
            ...origin.retainedArc,
            activeClaimedPaths: remainingActive,
            checkpointCommit: sourcePrepared.checkpointCommit,
            claimedPaths: remaining,
          } : null,
        proposalId: remaining.length ? origin.proposalId : null,
        proposalIds: remaining.length ? origin.proposalIds : [],
        savedStash: stashLeaves ? null : origin.savedStash,
      }
      : {
        ...origin, checkpointCommit: sourcePrepared?.checkpointCommit ?? origin.checkpointCommit,
        activeClaimedPaths: remainingActive,
        phase: remaining.length ? "active" as const : "resolved" as const,
        claimedPaths: remaining, savedStash: stashLeaves ? null : origin.savedStash,
      } : null;
    const mutation = await registry.prepareOwners([
      ...callerChanges ? [{ identity: caller, expectedCheckpointCommit: target?.checkpointCommit ?? null, next: nextTarget }] : [],
      { identity: source, expectedCheckpointCommit: origin?.checkpointCommit ?? null, next: nextSource },
    ]);
    updates.push(...mutation.updates);
    const leavingStashProposals = (stashLeaves ? sourceStash?.proposalIds ?? [] : []).filter(id => !sourceSealed.has(id));
    const { updates: invalidationUpdates, invalidatedProposals } = await proposals.prepareUnavailableUpdates({
      cwd: repository.root, ...source, repository,
      proposalIds: selectedPaths ? leavingStashProposals : [...new Set([...sourcePending, ...leavingStashProposals])],
      reason: selectedPaths ? "Its saved stash left this thread." : "Claim ownership was transferred to a coordinating thread.",
    });
    updates.push(...invalidationUpdates);
    const checkpoint = prepared ?? stashCheckpoint ?? (target
      ? await store.readCheckpoint(harness, caller.threadId, checkpointCommit)
      : await store.readCheckpoint(sourceHarness, source.threadId, checkpointCommit));
    const result: GitArcAdoptionResult = {
      checkpointCommit: nextPlan?.checkpointCommit ?? plan?.checkpointCommit ?? checkpointCommit,
      checkpointRef: nextPlan?.checkpointRef ?? plan?.checkpointRef ?? checkpoint.checkpointRef,
      intentName, kind: plan ? "plan" : "arc",
      phase: claimedPaths.length ? plan ? "plan" : "active" : savedStash ? "stashed" : plan ? "plan" : "resolved",
      repoRoot: repository.root, scopePaths: editedPlan?.scopePaths ?? plan?.metadata.scopePaths ?? claimedPaths,
      claimedPaths, additionalClaims: incoming,
      stashedPaths: moveStash ? sourceStash?.paths ?? [] : callerStash?.paths ?? [],
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
      phase: origin?.phase === "plan" ? "plan" : remaining.length ? "active" : sourceStash && !stashLeaves ? "stashed" : "resolved",
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
