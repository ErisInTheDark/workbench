/*
 * Exports:
 * - default GitArcStackController: own stack layer tips, chain reads, baseline tips, proposal-layer rewrites, rebases onto HEAD, arc drift and seal/reopen operations.
 * - GitArcPreparedStackRevision: atomic ref and commit updates for one proposal revision or chain rebase.
 * - GitArcStackLayer: one readable stack tip with its sealed layer facts.
 * - GitArcStackStatusResolver: derived proposal status supplied by the proposal owner.
 * - GitArcStackedProposalState: waiting, replayable or broken stacked proposal classification.
 */
import GitArcPathSet from "workbench-shared/workbench/git/GitArcPathSet";
import { GitArcRejectionError } from "workbench-shared/workbench/git/git-arc-rejections";
import type { GitArcStackResult } from "workbench-shared/workbench/git/checkpoint-contracts";
import type { GitArcStackedProposal } from "workbench-shared/workbench/git/git-arc-receipts";
import {
  CHECKPOINT_METADATA_MARKER,
  checkpointMessage,
  type CheckpointMetadata,
  type GitArcHarness,
  type GitArcProposalStatus,
  normalizeThreadId,
  parseMarkedMetadata,
  type StackLayerMetadata,
} from "workbench-shared/workbench/git/git-arc-storage";
import GitArcHistoryRewriter from "./GitArcHistoryRewriter";
import GitArcRegistry, { REGISTRY_REF, type GitArcPreparedOperation, type GitArcRegistryEntry } from "./GitArcRegistry";
import GitCheckpointStore from "./GitCheckpointStore";
import type { StoredProposal } from "./GitCheckpointStore";
import WorkbenchGitRepository, { type GitRefUpdate } from "./WorkbenchGitRepository";
import { passthroughGitArcThreadIdentityResolver, type GitArcThreadIdentityResolver } from "./git-arc-thread-identity";

export interface GitArcStackLayer {
  layer: StackLayerMetadata;
  parent: string | null;
  scopePaths: string[];
  tipCommit: string;
}

export type GitArcStackStatusResolver = (owner: { harness: string; threadId: string }, proposalId: string) => Promise<GitArcProposalStatus>;

export type GitArcStackedProposalState =
  | { kind: "waiting"; layerTitle: string }
  | { kind: "replayable" }
  | { kind: "broken" };

interface StackIdentity {
  harness: GitArcHarness;
  threadId: string;
}

/** Tips are walked from untrusted refs; bound the walk so corrupt parent loops cannot hang a request. */
const MAX_STACK_DEPTH = 200;

export interface GitArcPreparedStackRevision {
  commits: Map<string, string>;
  deletes: Array<{ oldValue: string; ref: string }>;
  replacedRefs: string[];
  updates: GitRefUpdate[];
}

function lifecycleProposalIds(entry: GitArcRegistryEntry) {
  return (entry.phase === "plan" ? entry.retainedArc?.proposalIds : entry.proposalIds) ?? [];
}

function chainScope(chain: readonly GitArcStackLayer[]) {
  return [...new Set(chain.flatMap(({ scopePaths }) => scopePaths))];
}

function ownsLayer(layer: StackLayerMetadata, identity: { harness: string; threadId: string }) {
  return layer.harness === identity.harness && normalizeThreadId(layer.threadId) === normalizeThreadId(identity.threadId);
}

export default class GitArcStackController {
  constructor(
    private readonly repository: WorkbenchGitRepository,
    private readonly resolveThreadIdentity: GitArcThreadIdentityResolver = passthroughGitArcThreadIdentityResolver,
  ) {}

  private registry() {
    return new GitArcRegistry(this.repository, this.resolveThreadIdentity);
  }

  private store() {
    return new GitCheckpointStore(this.repository, this.resolveThreadIdentity);
  }

  /** Bottom-first stack tips reachable from `tip`. An unreadable tip ends the chain with a warning. */
  async readChain(tip: string | null | undefined): Promise<GitArcStackLayer[]> {
    const layers: GitArcStackLayer[] = [];
    let cursor = tip ?? null;
    while (cursor && layers.length < MAX_STACK_DEPTH) {
      const resolved = await this.repository.readCommitAt(cursor);
      if (!resolved) {
        console.warn(`Git arc stack tip ${cursor.slice(0, 12)} is unreadable; ignoring it and lower layers.`);
        break;
      }
      const metadata = parseMarkedMetadata<CheckpointMetadata>(resolved.identity.message, CHECKPOINT_METADATA_MARKER);
      if (metadata?.kind !== "stack" || !metadata.stackLayer) break;
      const parent = resolved.identity.parents[0] ?? null;
      layers.push({ layer: metadata.stackLayer, parent, scopePaths: metadata.scopePaths, tipCommit: resolved.commit });
      cursor = parent;
    }
    return layers.reverse();
  }

  ownLayers(chain: readonly GitArcStackLayer[], identity: { harness: string; threadId: string }) {
    return chain.filter(({ layer }) => ownsLayer(layer, identity));
  }

  /** The entry's own sealed layers, bottom first. */
  async readOwnLayers(entry: GitArcRegistryEntry | null | undefined) {
    return entry?.stackTip ? this.ownLayers(await this.readChain(entry.stackTip), entry) : [];
  }

  /** Stored statuses are enough to decide whether a chain still shapes the baseline. */
  private async storedPendingIds(chain: readonly GitArcStackLayer[]) {
    const summaries = await this.store().readProposalSummaryGroups(chain.map(({ layer }) => ({
      harness: layer.harness as GitArcHarness,
      proposalIds: layer.proposalIds,
      threadId: layer.threadId,
    })));
    return chain.map((layer, index) => ({
      layer,
      pending: (summaries[index] ?? []).filter(({ status }) => status === "proposed").map(({ proposalId }) => proposalId),
    }));
  }

  async chainHasPending(chain: readonly GitArcStackLayer[], excludedProposalId?: string) {
    return (await this.storedPendingIds(chain)).some(({ pending }) => pending.some(id => id !== excludedProposalId));
  }

  /** The tip that new work builds on, or null when no pending layer shapes the baseline. */
  async pendingTip(entry: Pick<GitArcRegistryEntry, "stackTip"> | null | undefined) {
    if (!entry?.stackTip) return null;
    const chain = await this.readChain(entry.stackTip);
    return chain.length && await this.chainHasPending(chain) ? chain.at(-1)!.tipCommit : null;
  }

  /** The own layer sealing a proposal, if any. */
  async sealingLayer(entry: GitArcRegistryEntry | null | undefined, proposalId: string) {
    return (await this.readOwnLayers(entry)).find(({ layer }) => layer.proposalIds.includes(proposalId))?.layer ?? null;
  }

  async sealedProposalIds(entry: GitArcRegistryEntry | null | undefined) {
    return new Set((await this.readOwnLayers(entry)).flatMap(({ layer }) => layer.proposalIds));
  }

  /** Rebuild the target layer and every layer above it, preserving each layer's own scoped proposal content. */
  async prepareProposalRevision(
    entry: GitArcRegistryEntry,
    targetProposalId: string,
    replacement: StoredProposal,
  ): Promise<GitArcPreparedStackRevision | null> {
    const chain = await this.readChain(entry.stackTip);
    const targetIndex = chain.findIndex(({ layer }) => layer.proposalIds.includes(targetProposalId));
    if (targetIndex < 0) return null;
    const store = this.store();
    return await this.rebuildLayers(chain.slice(targetIndex), chain[targetIndex]!.parent, async (current, base, stored) => {
      const proposalIds = current.layer.proposalIds.map(id => id === targetProposalId
        ? replacement.metadata.proposalId
        : id);
      const proposals = await Promise.all(proposalIds.map(async proposalId => (
        proposalId === replacement.metadata.proposalId
          ? replacement
          : await store.readProposal(current.layer.harness as GitArcHarness, current.layer.threadId, proposalId)
      )));
      let tree = await this.repository.resolveTree(base);
      for (const proposal of proposals) {
        tree = await this.repository.writeTreeWithPathsFromSource(tree, proposal.tree, proposal.metadata.paths);
      }
      const summaries = await Promise.all(proposals.map(async ({ metadata, tree: proposalTree }): Promise<GitArcStackedProposal> => ({
        changes: await this.repository.buildChangeTotals(metadata.baseCommit, proposalTree, metadata.paths),
        description: metadata.description,
        proposalId: metadata.proposalId,
        title: metadata.title,
      })));
      return {
        metadata: {
          ...stored,
          scopePaths: [...new Set(proposals.flatMap(({ metadata }) => metadata.paths))].sort(),
          stackLayer: { ...stored.stackLayer!, proposalIds, proposals: summaries },
        },
        tree,
      };
    });
  }

  /**
   * Rebuild a pending chain onto fast-forwarded HEAD so new work never builds on history HEAD has moved past. Null when
   * nothing moved, HEAD left the chain's history, or HEAD changed a sealed path to content no layer holds.
   */
  async prepareRebase(entry: Pick<GitArcRegistryEntry, "stackTip"> | null | undefined, head: string | null) {
    if (!head || !entry?.stackTip) return null;
    const chain = await this.readChain(entry.stackTip);
    if (!chain.length || !await this.chainHasPending(chain)) return null;
    const root = chain[0]!.parent;
    if (!root || root === head || !await this.repository.isAncestor(root, head)) return null;
    // Landed layers put their own sealed content on HEAD; anything else on a sealed path is a real conflict.
    let unexplained = await this.repository.listChangedPaths(root, head, chainScope(chain));
    for (const { tipCommit } of chain) {
      if (!unexplained.length) break;
      const differing = new Set(await this.repository.listChangedPaths(tipCommit, head, unexplained));
      unexplained = unexplained.filter(candidate => differing.has(candidate));
    }
    if (unexplained.length) return null;
    return await this.rebuildLayers(chain, head, async (current, base, stored) => ({
      metadata: stored,
      tree: await this.repository.writeTreeWithPathsFromSource(base, current.tipCommit, current.scopePaths),
    }));
  }

  /** Apply `prepareRebase`, remapping every dependent Workbench ref and registry stack tip. Returns whether tips moved. */
  async rebaseOntoHead(entry: Pick<GitArcRegistryEntry, "stackTip"> | null | undefined, head: string | null) {
    const revision = await this.prepareRebase(entry, head);
    if (!revision) return false;
    const rewrite = await new GitArcHistoryRewriter(this.repository).prepare(revision.commits, {
      excludeRefs: [REGISTRY_REF, ...revision.replacedRefs],
    });
    if (rewrite.warnings.length) console.warn(`Git arc stack rebase skipped refs: ${rewrite.warnings.slice(0, 5).join("; ")}`);
    const registryUpdate = await this.registry().prepareCommitRemap(rewrite.commits);
    await this.repository.updateRefs(
      [...revision.updates, ...rewrite.updates, ...registryUpdate ? [registryUpdate] : []],
      [...revision.deletes, ...rewrite.deletes],
    );
    return true;
  }

  /** Recreate `layers` bottom-up on `parent`, each from `rebuild`, replacing their tip refs. */
  private async rebuildLayers(
    layers: readonly GitArcStackLayer[],
    parent: string | null,
    rebuild: (layer: GitArcStackLayer, base: string | null, stored: CheckpointMetadata) => Promise<{ metadata: CheckpointMetadata; tree: string }>,
  ): Promise<GitArcPreparedStackRevision> {
    const store = this.store();
    const commits = new Map<string, string>();
    const updates: GitRefUpdate[] = [];
    const deletes: Array<{ oldValue: string; ref: string }> = [];
    const replacedRefs: string[] = [];
    for (const current of layers) {
      const stored = await store.readCheckpoint(
        current.layer.harness as GitArcHarness,
        current.layer.threadId,
        current.tipCommit,
      );
      if (!stored.metadata || stored.metadata.kind !== "stack" || !stored.metadata.stackLayer) {
        throw new Error("The sealed proposal layer is unavailable.");
      }
      const { metadata, tree } = await rebuild(current, parent, stored.metadata);
      const next = await this.repository.createCommitFromTree(
        tree,
        parent,
        checkpointMessage(metadata),
        await this.repository.readCommit(current.tipCommit),
      );
      const nextRef = stored.checkpointRef.replace(/-[a-f0-9]{7,64}$/iu, `-${next.slice(0, 8)}`);
      updates.push({ newValue: next, oldValue: "0".repeat(40), ref: nextRef });
      deletes.push({ oldValue: current.tipCommit, ref: stored.checkpointRef });
      replacedRefs.push(stored.checkpointRef, nextRef);
      commits.set(current.tipCommit, next);
      parent = next;
    }
    return { commits, deletes, replacedRefs, updates };
  }

  /** `base` with every sealed path in the chain below `tip` taken from that tip; with HEAD as `base`, the tip as if rebased. */
  async sealedTree(base: string | null, tip: string) {
    return await this.repository.writeTreeWithPathsFromSource(base, tip, chainScope(await this.readChain(tip)));
  }

  /**
   * Sealed paths where HEAD differs from a stack tip, other than those still owned by pending chain proposals. A tip's
   * unsealed paths are just HEAD content from sealing time, and claims keep other threads off claimed paths, so they never drift.
   */
  private async tipDrift(tip: string, paths: string[], head: string | null) {
    const chain = await this.readChain(tip);
    const scope = new GitArcPathSet(chainScope(chain));
    const sealed = paths.filter(candidate => scope.overlaps(candidate));
    const changed = sealed.length ? await this.repository.listChangedPaths(tip, head, sealed) : [];
    if (!changed.length) return [];
    const store = this.store();
    const pending = await this.storedPendingIds(chain);
    const pendingPaths = new GitArcPathSet((await Promise.all(pending.flatMap(({ layer, pending: ids }) => ids.map(async id => (
      (await store.readProposal(layer.layer.harness as GitArcHarness, layer.layer.threadId, id)).metadata.paths
    ))))).flat());
    return changed.filter(candidate => !pendingPaths.overlaps(candidate));
  }

  /**
   * The stack tip shaping an arc's baseline. Pending tips always do. A landed tip does only until the arc re-baselines
   * past its landing: the tip matches HEAD while the arc checkpoint still sits on older history, but once the checkpoint
   * parent holds every landing commit, later commits on the tip's paths are real history the tip knows nothing about.
   */
  async baselineTip(entry: Pick<GitArcRegistryEntry, "stackTip"> | null | undefined, checkpoint: { parent: string | null }) {
    if (!entry?.stackTip) return null;
    const chain = await this.readChain(entry.stackTip);
    if (!chain.length) return null;
    const summaries = (await this.store().readProposalSummaryGroups(chain.map(({ layer }) => ({
      harness: layer.harness as GitArcHarness, proposalIds: layer.proposalIds, threadId: layer.threadId,
    })))).flat();
    if (summaries.some(({ status }) => status === "proposed")) return { commit: entry.stackTip, pending: true };
    const landings = summaries.flatMap(({ committedSha }) => committedSha ? [committedSha] : []);
    if (!landings.length) return null;
    return checkpoint.parent && await this.repository.allAncestors(landings, checkpoint.parent)
      ? null
      : { commit: entry.stackTip, pending: false };
  }

  /** Claimed-path drift for an arc, measured from its baseline tip when one still applies; returns that tip too. */
  async arcDrift(
    entry: Pick<GitArcRegistryEntry, "stackTip"> | null | undefined,
    checkpoint: { checkpointCommit: string; parent: string | null },
    paths: string[],
    head: string | null,
  ) {
    const tip = await this.baselineTip(entry, checkpoint);
    if (tip) return { incompatible: false, changedPaths: await this.tipDrift(tip.commit, paths, head), tip };
    const movement = await this.repository.classifyHeadMovement(checkpoint.parent, paths, checkpoint.checkpointCommit, head);
    return { incompatible: movement.kind === "incompatible", changedPaths: movement.changedPaths, tip: null };
  }

  /** HEAD may differ from a stack tip only on paths still owned by pending chain proposals. */
  async validateBaseline(tip: string, paths: string[], head: string | null) {
    const unexplained = await this.tipDrift(tip, paths, head);
    if (unexplained.length) {
      throw new GitArcRejectionError(
        { reason: "baselineChanged", paths: unexplained },
        `Selected paths changed outside the pending stack layers: ${unexplained.join(", ")}`,
      );
    }
  }

  /** Lower layers must land first; afterwards the proposal replays only when its paths still match the tip. */
  async classifyStackedProposal(
    stackBase: string,
    livePaths: string[],
    head: string | null,
    resolveStatus: GitArcStackStatusResolver,
  ): Promise<GitArcStackedProposalState> {
    for (const { layer, pending } of await this.storedPendingIds(await this.readChain(stackBase))) {
      for (const proposalId of pending) {
        if (await resolveStatus(layer.layer, proposalId) === "proposed") return { kind: "waiting", layerTitle: layer.layer.title };
      }
    }
    return (await this.repository.listChangedPaths(stackBase, head, livePaths)).length
      ? { kind: "broken" }
      : { kind: "replayable" };
  }

  /** Own layers in chain order for lifecycle presentation. */
  async projectLayers(entry: GitArcRegistryEntry) {
    return (await this.readOwnLayers(entry)).map(({ layer }) => ({
      layerId: layer.layerId,
      proposalIds: [...layer.proposalIds],
      sealedAt: layer.sealedAt,
      title: layer.title,
    }));
  }

  /**
   * Seal every unsealed pending proposal into one tip checkpoint above the current baseline.
   * Returns null when this repository has nothing to seal so workspace callers can skip it.
   */
  async prepareStack(
    identity: StackIdentity,
    input: { layerId: string; sealedAt: string; title: string },
    resolveStatus: GitArcStackStatusResolver,
  ): Promise<GitArcPreparedOperation<GitArcStackResult> | null> {
    const registry = this.registry();
    const store = this.store();
    const entry = await registry.find(identity);
    if (!entry) return null;
    const chain = await this.readChain(entry.stackTip);
    const sealed = new Set(this.ownLayers(chain, entry).flatMap(({ layer }) => layer.proposalIds));
    const candidates = lifecycleProposalIds(entry).filter(id => !sealed.has(id));
    const pending = [];
    for (const proposalId of candidates) {
      if (await resolveStatus(identity, proposalId) !== "proposed") continue;
      pending.push(await store.readProposal(identity.harness, identity.threadId, proposalId));
    }
    if (!pending.length) return null;
    // Stash baselines are real HEAD; sealing beside saved work would strand it below the stack.
    if (entry.savedStash || entry.phase === "stashed") throw new GitArcRejectionError({ reason: "savedWorkBlocksStack" });
    const parentTip = chain.length && await this.chainHasPending(chain) ? chain.at(-1)!.tipCommit : null;
    const parent = parentTip ?? await this.repository.headOrNull();
    let tree = await this.repository.resolveTree(parent);
    for (const proposal of pending) {
      tree = await this.repository.writeTreeWithPathsFromSource(tree, proposal.proposalCommit, proposal.metadata.paths);
    }
    // Summaries live on the tip so stack cards never rehydrate each sealed proposal.
    const proposals = await Promise.all(pending.map(async ({ metadata, tree }): Promise<GitArcStackedProposal> => ({
      changes: await this.repository.buildChangeTotals(metadata.baseCommit, tree, metadata.paths),
      description: metadata.description,
      proposalId: metadata.proposalId,
      title: metadata.title,
    })));
    const stackLayer: StackLayerMetadata = {
      harness: identity.harness,
      layerId: input.layerId,
      proposalIds: proposals.map(({ proposalId }) => proposalId),
      proposals,
      sealedAt: input.sealedAt,
      threadId: entry.threadId,
      title: input.title.trim(),
    };
    const prepared = await store.prepareCheckpoint(identity.harness, identity.threadId, tree, parent, {
      amendedFrom: null,
      kind: "stack",
      scopePaths: [...new Set(pending.flatMap(({ metadata }) => metadata.paths))].sort(),
      stackLayer,
      version: 3,
    });
    const mutation = await registry.prepareSet({ ...entry, stackTip: prepared.checkpointCommit }, entry.checkpointCommit);
    const updates = [prepared.update, ...mutation.updates];
    return this.operation(updates, {
      ...this.resultBase(entry),
      layerId: stackLayer.layerId,
      layerProposals: proposals,
      layerTitle: stackLayer.title,
      proposalIds: stackLayer.proposalIds,
      stackTip: prepared.checkpointCommit,
    });
  }

  /**
   * Reopen the caller's top layer when nothing builds on it. Returns null when this repository's top
   * layer is not `layerId` so workspace callers can skip it.
   */
  async prepareUnstack(identity: StackIdentity, layerId?: string): Promise<GitArcPreparedOperation<GitArcStackResult> | null> {
    const registry = this.registry();
    const entry = await registry.find(identity);
    const chain = await this.readChain(entry?.stackTip);
    const top = chain.at(-1);
    if (!entry || !top || !ownsLayer(top.layer, entry)) {
      if (layerId) return null;
      throw new GitArcRejectionError({ reason: "noOwnStackLayer" });
    }
    if (layerId && top.layer.layerId !== layerId) return null;
    await this.requireLayerUnused(entry, top);
    const nextTip = chain.at(-2)?.tipCommit ?? null;
    const mutation = await registry.prepareSet({ ...entry, stackTip: nextTip }, entry.checkpointCommit);
    return this.operation(mutation.updates, {
      ...this.resultBase(entry),
      layerId: top.layer.layerId,
      ...(top.layer.proposals ? { layerProposals: top.layer.proposals } : {}),
      layerTitle: top.layer.title,
      proposalIds: [...top.layer.proposalIds],
      stackTip: nextTip,
    });
  }

  /** The caller's top layer when it is their own; workspace unstack picks one layer across repositories. */
  async topOwnLayer(identity: StackIdentity) {
    const entry = await this.registry().find(identity);
    const top = (await this.readChain(entry?.stackTip)).at(-1);
    return entry && top && ownsLayer(top.layer, entry) ? top.layer : null;
  }

  private async requireLayerUnused(entry: GitArcRegistryEntry, top: GitArcStackLayer) {
    const store = this.store();
    for (const proposalId of lifecycleProposalIds(entry)) {
      const proposal = await store.readProposal(entry.harness as GitArcHarness, entry.threadId, proposalId);
      if (proposal.metadata.status === "proposed" && proposal.metadata.stackBase === top.tipCommit) {
        throw new GitArcRejectionError({ reason: "stackLayerInUse" }, `Pending proposal ${proposalId} builds on the top stack layer.`);
      }
    }
    for (const other of await this.registry().list()) {
      if (!other.stackTip || ownsLayer(top.layer, other)) continue;
      if ((await this.readChain(other.stackTip)).some(({ tipCommit }) => tipCommit === top.tipCommit)) {
        throw new GitArcRejectionError({ reason: "stackLayerInUse" }, `Thread ${other.threadId} builds on the top stack layer.`);
      }
    }
  }

  private resultBase(entry: GitArcRegistryEntry) {
    const arc = entry.phase === "plan" ? entry.retainedArc : entry;
    const phase: GitArcStackResult["phase"] = entry.phase === "stashed" ? "stashed"
      : arc?.phase === "resolved" || !arc ? "resolved" : "active";
    return {
      checkpointCommit: arc?.checkpointCommit ?? entry.checkpointCommit,
      intentName: arc?.intentName ?? entry.intentName ?? null,
      phase,
      repoRoot: this.repository.root,
      scopePaths: phase === "active" ? [...(arc?.claimedPaths ?? [])] : [],
    };
  }

  private operation(updates: GitRefUpdate[], result: GitArcStackResult): GitArcPreparedOperation<GitArcStackResult> {
    return {
      result,
      apply: async () => {
        await this.repository.updateRefs(updates);
        return result;
      },
      rollback: async () => await GitArcRegistry.rollbackRefs(this.repository, updates),
    };
  }
}
