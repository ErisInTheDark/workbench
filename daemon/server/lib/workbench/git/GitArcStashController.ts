/*
 * Exports:
 * - default GitArcStashController: keep ordinary stash storage while restoring or discarding adopted saved work; reject stash and unstash under pending stack layers.
 */
import fs from "node:fs/promises";
import { ProviderKeySchema } from "workbench-shared/workbench/provider/provider-key";
import { gitArcPathsOverlap } from "workbench-shared/workbench/git/git-arc-paths";
import type { GitArcHarness } from "workbench-shared/workbench/git/git-arc-storage";
import type { GitArcStashResult } from "./WorkbenchGitCheckpointController";
import GitArcRegistry, { findGitArcCollisions, getGitArcLiveClaimPaths, GitArcCollisionError, type GitArcPreparedOperation } from "./GitArcRegistry";
import GitCheckpointStore from "./GitCheckpointStore";
import GitArcClaimLossStore from "./GitArcClaimLossStore";
import GitArcStackController from "./GitArcStackController";
import { GitArcRejectionError } from "workbench-shared/workbench/git/git-arc-rejections";
import WorkbenchGitRepository, { type GitRefUpdate } from "./WorkbenchGitRepository";
import { passthroughGitArcThreadIdentityResolver, type GitArcThreadIdentityResolver } from "./git-arc-thread-identity";

interface Identity { cwd: string; harness?: GitArcHarness; threadId: string }

async function replaceWorktreePaths(repository: WorkbenchGitRepository, source: string, paths: string[]) {
  const [current, selected] = await Promise.all([repository.listWorktreePaths(paths), repository.listTreePaths(source, paths)]);
  const sourcePaths = new Set(selected);
  await Promise.all(current.filter(value => !sourcePaths.has(value)).map(async value => {
    await fs.rm(repository.resolvePath(value), { recursive: true, force: true });
  }));
  await repository.restorePaths(source, selected);
}

export default class GitArcStashController {
  constructor(private readonly resolveThreadIdentity: GitArcThreadIdentityResolver = passthroughGitArcThreadIdentityResolver) {}

  async prepare(input: Identity, action: "stash" | "unstash" | "discard"): Promise<GitArcPreparedOperation<GitArcStashResult>> {
    const repository = await WorkbenchGitRepository.open(input.cwd);
    const harness = ProviderKeySchema.parse(input.harness ?? "codex");
    const identity = { harness, threadId: input.threadId };
    const registry = new GitArcRegistry(repository, this.resolveThreadIdentity);
    const checkpoints = new GitCheckpointStore(repository, this.resolveThreadIdentity);
    const snapshots = new GitArcClaimLossStore(repository, this.resolveThreadIdentity);
    const current = await registry.find(identity);
    // Stash baselines are real HEAD; pending stack layers would leave sealed work unclaimed or block unstash.
    if (action !== "discard" && await new GitArcStackController(repository, this.resolveThreadIdentity).pendingTip(current)) {
      throw new GitArcRejectionError({ reason: "pendingStack" }, "Stash is unavailable while this thread's stack layers are pending.");
    }
    const saved = await snapshots.readOwnedStash(identity, current);
    const arc = current?.phase === "plan" ? current.retainedArc : current?.phase === "active" ? current : null;
    const live = current ? getGitArcLiveClaimPaths(current) : [];
    const head = await repository.headOrNull();
    const headTree = await repository.resolveTree(head);
    let updates: GitRefUpdate[] = [];
    let deletes: Array<{ oldValue?: string; ref: string }> = [];
    let paths: string[];
    let targetTree: string | null = null;
    let resetIndex = false;
    let result: GitArcStashResult;

    if (action === "stash") {
      if (saved) throw new Error("This thread already has a stash. Restore or discard it before saving another.");
      if (!current || !arc || !live.length) throw new Error("This thread does not own active or plan-retained Git arc claims.");
      const checkpoint = await checkpoints.readCheckpoint(harness, input.threadId, arc.checkpointCommit);
      if (!checkpoint.metadata || !["arc", "implement"].includes(checkpoint.metadata.kind)
        || live.some(value => !checkpoint.metadata!.scopePaths.includes(value))) {
        throw new Error("The live Git arc does not match its checkpoint claim set.");
      }
      paths = [...live];
      const snapshot = { head, tree: await repository.writeScopedWorktreeTree(paths, head) };
      const next = current.phase === "plan"
        ? { ...current, claimedPaths: paths, phase: "stashed" as const, proposalIds: arc.proposalIds ?? [] }
        : { ...current, claimedPaths: paths, phase: "stashed" as const };
      const mutation = await registry.prepareSet(next, current.checkpointCommit, { claimLossSnapshot: snapshot });
      updates = mutation.updates;
      targetTree = headTree;
      resetIndex = true;
      result = {
        checkpointCommit: current.checkpointCommit, checkpointRef: checkpoint.checkpointRef,
        intentName: current.intentName, kind: "arc", phase: "stashed",
        repoRoot: repository.root, scopePaths: [], stashedPaths: paths, conflictedPaths: [],
      };
    } else {
      if (!saved) throw new Error("This thread does not own a stashed Git arc.");
      paths = [...saved.paths];
      const original = await checkpoints.readCheckpoint(harness, input.threadId, saved.checkpointCommit);
      if (!original.metadata || !["arc", "implement"].includes(original.metadata.kind)) {
        throw new Error("The saved Git arc checkpoint is invalid.");
      }
      if (action === "discard") {
        deletes = saved.legacy
          ? (await snapshots.prepareDeleteFrozen(identity, saved.paths)).deletions
          : await snapshots.prepareDeleteAdopted(identity, saved.paths);
        if (current) {
          const next = saved.legacy && current.retainedArc && current.phase === "stashed"
            ? { ...current, phase: "plan" as const, claimedPaths: [], retainedArc: null, proposalId: null, proposalIds: [] }
            : saved.legacy
              ? { ...current, phase: "resolved" as const, claimedPaths: [] }
              : { ...current, savedStash: null };
          updates = (await registry.prepareSet(next, current.checkpointCommit)).updates;
        }
        result = {
          checkpointCommit: current?.checkpointCommit ?? saved.checkpointCommit, checkpointRef: original.checkpointRef,
          intentName: current?.intentName ?? saved.intentName, kind: "arc",
          phase: live.length ? "active" : "resolved", repoRoot: repository.root,
          scopePaths: live, stashedPaths: [], conflictedPaths: [],
        };
      } else {
        if (paths.some(value => live.some(claim => gitArcPathsOverlap(value, claim)))) {
          throw new Error("Stashed paths overlap the caller's current live claims.");
        }
        const dirty = await repository.listWorktreeChangedPaths(head, paths);
        if (dirty.length) throw new Error(`Stashed paths contain current worktree changes: ${dirty.join(", ")}`);
        const collisions = findGitArcCollisions(await registry.list(), identity, paths);
        if (collisions.length) throw new GitArcCollisionError(collisions);
        const combined = [...new Set([...live, ...paths])].sort();
        const pendingPlan = current?.phase === "plan" || current?.phase === "stashed" && current.retainedArc
          ? await checkpoints.readCheckpoint(harness, input.threadId, current.checkpointCommit) : null;
        if (pendingPlan && (!pendingPlan.metadata || pendingPlan.metadata.kind !== "plan"
          || combined.some(value => !pendingPlan.metadata!.scopePaths.some(scope => value === scope || value.startsWith(`${scope}/`))))) {
          throw new Error("The pending plan does not cover the restored claims. Revise its scope before restoring saved work.");
        }
        if (arc && live.length) {
          const base = await checkpoints.readCheckpoint(harness, input.threadId, arc.checkpointCommit);
          const movement = await new GitArcStackController(repository, this.resolveThreadIdentity).arcDrift(current, base, live, head);
          if (movement.incompatible || movement.changedPaths.length) {
            throw new Error("Current live claims no longer match their baseline. Re-plan before restoring saved work.");
          }
        }
        const merged = await repository.mergeWorktreeTrees(saved.head, head, saved.commit);
        if (merged.unsupportedConflictTypes.length) {
          throw new Error(`The stashed changes have conflicts that cannot be represented as editable markers: ${merged.unsupportedConflictTypes.join(", ")}`);
        }
        // Status reads restore evidence from the checkpoint itself: adopted stash refs are deleted below.
        const restoredFromStash = { head: saved.head, paths: await repository.listChangedPaths(saved.head, saved.commit, saved.paths) };
        const prepared = await checkpoints.prepareCheckpoint(harness, input.threadId, headTree, head, {
          amendedFrom: arc?.checkpointCommit ?? saved.checkpointCommit,
          intentName: arc?.intentName ?? saved.intentName,
          intentDescription: arc?.intentDescription ?? saved.intentDescription,
          kind: "arc", registryLifecycle: true, restoredFromStash, scopePaths: combined, version: 3,
        });
        const proposalIds = [...new Set([...(arc?.proposalIds ?? []), ...saved.proposalIds])];
        const retained = {
          checkpointCommit: prepared.checkpointCommit, claimedPaths: combined,
          intentName: arc?.intentName ?? saved.intentName,
          intentDescription: arc?.intentDescription ?? saved.intentDescription,
          phase: "active" as const, proposalIds,
        };
        const next = pendingPlan && current ? {
          ...current, phase: "plan" as const, claimedPaths: combined, retainedArc: retained,
          proposalId: null, proposalIds: [], savedStash: null,
        } : { ...identity, ...retained, proposalId: proposalIds.at(-1) ?? null, savedStash: null };
        const mutation = await registry.prepareOwners([{
          identity, expectedCheckpointCommit: current?.checkpointCommit ?? null, next,
        }]);
        // Saved paths never overlap live claims, so live proposals keep their committable snapshots.
        updates = [...mutation.updates, prepared.update];
        deletes = saved.legacy ? [] : await snapshots.prepareDeleteAdopted(identity, saved.paths);
        targetTree = merged.tree;
        result = {
          checkpointCommit: pendingPlan?.checkpointCommit ?? prepared.checkpointCommit,
          checkpointRef: pendingPlan?.checkpointRef ?? prepared.checkpointRef,
          intentName: current?.intentName ?? saved.intentName, kind: pendingPlan ? "plan" : "arc",
          phase: "active", repoRoot: repository.root,
          scopePaths: pendingPlan?.metadata?.scopePaths ?? combined,
          ...(pendingPlan ? { claimedPaths: combined, plannedPaths: pendingPlan.metadata?.scopePaths ?? [] } : {}),
          stashedPaths: [], conflictedPaths: merged.conflictedPaths,
        };
      }
    }
    const beforeTree = targetTree ? await repository.writeScopedWorktreeTree(paths, head) : null;
    const beforeIndex = resetIndex ? await repository.writeIndexTree() : null;
    const restoreFiles = async () => {
      if (beforeTree) await replaceWorktreePaths(repository, beforeTree, paths);
      if (beforeIndex) await repository.resetMixedPaths(beforeIndex, paths);
    };
    const rollback = async () => {
      const failures: Error[] = [];
      try { await restoreFiles(); } catch (error) { failures.push(error instanceof Error ? error : new Error(String(error))); }
      try { await GitArcRegistry.rollbackRefs(repository, updates, deletes); } catch (error) { failures.push(error instanceof Error ? error : new Error(String(error))); }
      if (failures.length) throw new AggregateError(failures, "Saved-work compensation failed.");
    };
    return {
      result, rollback,
      apply: async () => {
        if (action === "stash") {
          try {
            await replaceWorktreePaths(repository, targetTree!, paths);
            await repository.resetMixedPaths(headTree, paths);
            await repository.updateRefs(updates, deletes);
          } catch (error) {
            try { await restoreFiles(); } catch (rollbackError) {
              throw new AggregateError([error, rollbackError], "Arc stash failed and worktree compensation also failed.");
            }
            throw error;
          }
        } else {
          await repository.updateRefs(updates, deletes);
          if (targetTree) {
            try { await replaceWorktreePaths(repository, targetTree, paths); }
            catch (error) {
              try { await rollback(); } catch (rollbackError) {
                throw new AggregateError([error, rollbackError], "Arc restore failed and compensation also failed.");
              }
              throw error;
            }
          }
        }
        return result;
      },
    };
  }
}
