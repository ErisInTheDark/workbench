/*
 * Exports:
 * - default GitArcStackController: own stack layer tips, chain reads, stacked baselines and seal/reopen operations.
 * - GitArcStackLayer: one readable stack tip with its sealed layer facts.
 * - GitArcStackStatusResolver: derived proposal status supplied by the proposal owner.
 * - GitArcStackedProposalState: waiting, replayable or broken stacked proposal classification.
 */
import { gitArcPathsOverlap } from "workbench-shared/workbench/git/git-arc-paths";
import { GitArcRejectionError } from "workbench-shared/workbench/git/git-arc-rejections";
import type { GitArcStackResult } from "workbench-shared/workbench/git/checkpoint-contracts";
import type { GitArcStackedProposal } from "workbench-shared/workbench/git/git-arc-receipts";
import {
  CHECKPOINT_METADATA_MARKER,
  type CheckpointMetadata,
  type GitArcHarness,
  type GitArcProposalStatus,
  normalizeThreadId,
  parseMarkedMetadata,
  type StackLayerMetadata,
} from "workbench-shared/workbench/git/git-arc-storage";
import GitArcRegistry, { type GitArcPreparedOperation, type GitArcRegistryEntry } from "./GitArcRegistry";
import GitCheckpointStore from "./GitCheckpointStore";
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

function lifecycleProposalIds(entry: GitArcRegistryEntry) {
  return (entry.phase === "plan" ? entry.retainedArc?.proposalIds : entry.proposalIds) ?? [];
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

  /** `base` with every sealed path in the chain below `tip` taken from that tip. */
  async sealedTree(base: string, tip: string) {
    const paths = [...new Set((await this.readChain(tip)).flatMap(({ scopePaths }) => scopePaths))];
    return await this.repository.writeTreeWithPathsFromSource(base, tip, paths);
  }

  /** HEAD may differ from a stack tip only on paths still owned by pending chain proposals. */
  async validateBaseline(tip: string, paths: string[], head: string | null) {
    const changed = await this.repository.listChangedPaths(tip, head, paths);
    if (!changed.length) return;
    const store = this.store();
    const pending = await this.storedPendingIds(await this.readChain(tip));
    const pendingPaths = (await Promise.all(pending.flatMap(({ layer, pending: ids }) => ids.map(async id => (
      (await store.readProposal(layer.layer.harness as GitArcHarness, layer.layer.threadId, id)).metadata.paths
    ))))).flat();
    const unexplained = changed.filter(candidate => !pendingPaths.some(owned => gitArcPathsOverlap(candidate, owned)));
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
      changes: (await this.repository.buildFileChanges(metadata.baseCommit, tree, metadata.paths))
        .map(({ additions, deletions, kind, path }) => ({ additions, deletions, kind: kind.type, path })),
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
