/*
 * Exports:
 * - default GitArcStackEditor: rewrite an owner's pending proposals and the stack layers above the lowest edit in one ref
 *   transaction, rebasing later proposals by three-way merging their own changes and dropping higher copies of proposals
 *   sealed twice; never reads or writes the worktree.
 * - GitArcStackEdit: drops, strips, folds or one revision that a single rewrite applies together.
 * - GitArcStackEditResult: per-proposal outcomes, rewritten layers, stack tip and paths returned to active claims.
 */
import { randomUUID } from "node:crypto";
import GitArcPathSet from "workbench-shared/workbench/git/GitArcPathSet";
import { GitArcRejectionError } from "workbench-shared/workbench/git/git-arc-rejections";
import type { GitArcStackedProposal } from "workbench-shared/workbench/git/git-arc-receipts";
import type { GitArcRestackOutcome } from "workbench-shared/workbench/git/git-arc-restack";
import {
  checkpointMessage,
  type CheckpointMetadata,
  type GitArcHarness,
  normalizeThreadId,
  type ProposalMetadata,
  remapProposalMetadata,
} from "workbench-shared/workbench/git/git-arc-storage";
import GitArcClaimOwnershipController from "./GitArcClaimOwnershipController";
import GitArcHistoryRewriter from "./GitArcHistoryRewriter";
import GitArcRegistry, { getGitArcLiveClaimPaths, REGISTRY_REF, type GitArcRegistryEntry } from "./GitArcRegistry";
import GitArcStackController, { type GitArcStackLayer } from "./GitArcStackController";
import GitCheckpointStore, { type StoredProposal } from "./GitCheckpointStore";
import type WorkbenchGitRepository from "./WorkbenchGitRepository";
import type { GitRefUpdate } from "./WorkbenchGitRepository";
import { passthroughGitArcThreadIdentityResolver, type GitArcThreadIdentityResolver } from "./git-arc-thread-identity";

export interface GitArcStackEdit {
  drop?: readonly string[];
  /** Each source's own changes merge into `into`, which sits in the same or a lower layer. */
  fold?: ReadonlyArray<{ into: string; proposalId: string }>;
  /** Replacement content and message for one pending proposal under a new id; its tree builds on the target's base. */
  revise?: {
    description: string;
    livePaths: string[];
    paths: string[];
    proposalId: string;
    sourceCheckpoint: string;
    title: string;
    tree: string;
  };
  /** Path prefixes whose changes leave the proposal. */
  strip?: ReadonlyArray<{ paths: string[]; proposalId: string }>;
}

export interface GitArcStackEditResult {
  layers: Array<{ proposalIds: string[]; title: string }>;
  proposals: GitArcRestackOutcome[];
  releasedClaims: string[];
  /** Metadata of every proposal published under a new id, keyed by that id. */
  replacements: Map<string, ProposalMetadata>;
  stackTip: string | null;
}

interface Identity {
  harness: GitArcHarness;
  threadId: string;
}

interface Group {
  layer: GitArcStackLayer | null;
  proposals: StoredProposal[];
}

interface Rebuilt {
  base: string | null;
  contentEdited: boolean;
  livePaths: string[];
  newId: string | null;
  paths: string[];
  proposal: StoredProposal;
  tree: string;
}

function ownsLayer(layer: GitArcStackLayer, identity: Identity) {
  return layer.layer.harness === identity.harness && normalizeThreadId(layer.layer.threadId) === normalizeThreadId(identity.threadId);
}

function lifecycleProposalIds(entry: GitArcRegistryEntry) {
  return (entry.phase === "plan" ? entry.retainedArc?.proposalIds : entry.proposalIds) ?? [];
}

function invalid(message: string): never {
  throw new GitArcRejectionError({ reason: "invalidRestackTarget" }, message);
}

export default class GitArcStackEditor {
  constructor(
    private readonly repository: WorkbenchGitRepository,
    private readonly resolveThreadIdentity: GitArcThreadIdentityResolver = passthroughGitArcThreadIdentityResolver,
  ) {}

  async apply(identity: Identity, edit: GitArcStackEdit): Promise<GitArcStackEditResult> {
    const revising = Boolean(edit.revise);
    const drop = new Set(edit.drop ?? []);
    const strip = new Map<string, string[]>();
    for (const { paths, proposalId } of edit.strip ?? []) strip.set(proposalId, [...strip.get(proposalId) ?? [], ...paths]);
    const foldSources = new Map((edit.fold ?? []).map(({ into, proposalId }) => [proposalId, into]));
    if (revising && (drop.size || strip.size || foldSources.size)) throw new Error("A revision cannot combine with restack edits.");
    if (!revising && !drop.size && !strip.size && !foldSources.size) throw new GitArcRejectionError({ reason: "emptyRestack" });
    if (foldSources.size !== (edit.fold?.length ?? 0)) invalid("Each proposal can fold into only one target.");

    const registry = new GitArcRegistry(this.repository, this.resolveThreadIdentity);
    const store = new GitCheckpointStore(this.repository, this.resolveThreadIdentity);
    const entry = await registry.find(identity);
    if (!entry) throw new GitArcRejectionError({ reason: "proposalNotOwned" });
    const stack = new GitArcStackController(this.repository, this.resolveThreadIdentity);
    const chain = await stack.readChain(entry.stackTip);
    const oldTop = chain.at(-1)?.tipCommit ?? null;
    const sealedIds = new Set(chain.flatMap(({ layer }) => layer.proposalIds));
    const groups: Group[] = await Promise.all(chain.map(async layer => ({
      layer,
      proposals: await Promise.all(layer.layer.proposalIds.map(async id => (
        await store.readProposal(layer.layer.harness as GitArcHarness, layer.layer.threadId, id)
      ))),
    })));
    const unsealedIds = new Set([...lifecycleProposalIds(entry), ...edit.revise ? [edit.revise.proposalId] : []]);
    const unsealed = await Promise.all([...unsealedIds].filter(id => !sealedIds.has(id))
      .map(async id => await store.readProposal(identity.harness, identity.threadId, id)));
    groups.push({ layer: null, proposals: unsealed.filter(({ metadata }) => metadata.status === "proposed" && !metadata.messageOnly) });

    // Chain reads once stopped 200 layers deep, so deep stacks resealed their lowest proposals at the top, overwriting
    // later work with those proposals' old trees. The lowest copy is the real one; higher copies drop when rebuilt.
    const located = new Map<string, number>();
    const byId = new Map<string, StoredProposal>();
    const duplicateLayers: number[] = [];
    groups.forEach(({ proposals }, index) => proposals.forEach((proposal) => {
      const id = proposal.metadata.proposalId;
      if (located.has(id)) {
        duplicateLayers.push(index);
        return;
      }
      located.set(id, index);
      byId.set(id, proposal);
    }));
    const isCopy = (proposal: StoredProposal, index: number) => located.get(proposal.metadata.proposalId) !== index;
    const locate = (proposalId: string) => {
      const index = located.get(proposalId);
      const group = index === undefined ? undefined : groups[index];
      const proposal = byId.get(proposalId);
      if (index === undefined || !group || !proposal) invalid(`Proposal ${proposalId} is not one of this thread's pending stack proposals.`);
      if (group.layer && !ownsLayer(group.layer, identity)) invalid(`Proposal ${proposalId} is sealed in a layer this thread inherited.`);
      if (proposal.metadata.status !== "proposed") invalid(`Proposal ${proposalId} is not pending.`);
      if (!revising && (proposal.metadata.mode !== "commit" || proposal.metadata.messageOnly)) {
        invalid(`Proposal ${proposalId} is an amendment; restack edits only fresh-commit proposals.`);
      }
      return index;
    };
    const editedIds = [...drop, ...strip.keys(), ...foldSources.keys(), ...foldSources.values(), ...edit.revise ? [edit.revise.proposalId] : []];
    const startIndex = Math.min(...editedIds.map(locate), ...duplicateLayers);
    for (const [source, into] of foldSources) {
      if (source === into || drop.has(into) || foldSources.has(into) || drop.has(source)) {
        invalid(`Proposal ${source} cannot fold into ${into}.`);
      }
      if (located.get(into)! > located.get(source)!) {
        throw new GitArcRejectionError({ reason: "invalidFoldTarget" }, `Proposal ${source} must fold into a proposal in its own or a lower layer, not ${into}.`);
      }
    }
    for (const [proposalId, prefixes] of strip) {
      if (drop.has(proposalId)) invalid(`Proposal ${proposalId} cannot be both dropped and stripped.`);
      const proposal = byId.get(proposalId)!;
      const selected = new GitArcPathSet(prefixes);
      if (!proposal.metadata.paths.some(candidate => selected.covers(candidate))) {
        invalid(`Strip paths ${prefixes.join(", ")} match none of proposal ${proposalId}'s files.`);
      }
    }

    const conflict = (proposalId: string, paths: string[]) => revising
      ? new GitArcRejectionError({ reason: "proposalRevisionConflict" }, `The revision conflicts with proposal ${proposalId} layered above it: ${paths.join(", ")}`)
      : new GitArcRejectionError({ reason: "restackConflict", paths, proposalId, title: byId.get(proposalId)!.metadata.title }, `Proposal ${proposalId} conflicts after the restack: ${paths.join(", ")}`);
    /** Files each restack conflict is on, by proposal id; the whole stack is scanned so one rejection names them all. */
    const conflicts = new Map<string, string[]>();
    /** Restack proposals left with no changes, in stack order. */
    const emptied: StoredProposal[] = [];
    const merge = async (base: string | null, ours: string | null, theirs: string, proposalId: string) => {
      const result = await this.repository.mergeWorktreeTrees(base, ours, theirs);
      if (!result.conflictedPaths.length && !result.unsupportedConflictTypes.length) return result.tree;
      if (revising || result.unsupportedConflictTypes.length) throw conflict(proposalId, result.conflictedPaths);
      conflicts.set(proposalId, [...conflicts.get(proposalId) ?? [], ...result.conflictedPaths]);
      // Keeping the lower file is what stripping it from this proposal does, so the report holds for the retry.
      return (await this.repository.writeTreeWithPathSources(result.tree, [{ paths: result.conflictedPaths, source: ours }])).tree;
    };
    /** Files each strip took out of its proposal, by proposal id. */
    const strippedById = new Map<string, string[]>();
    const stripOwn = async (proposal: StoredProposal, tree: string, paths: string[]) => {
      const prefixes = strip.get(proposal.metadata.proposalId);
      if (!prefixes) return { paths, stripped: [] as string[], tree };
      const selected = new GitArcPathSet(prefixes);
      const stripped = paths.filter(candidate => selected.covers(candidate));
      strippedById.set(proposal.metadata.proposalId, stripped);
      return {
        paths: paths.filter(candidate => !selected.covers(candidate)),
        stripped,
        tree: (await this.repository.writeTreeWithPathSources(tree, [{ paths: prefixes, source: proposal.metadata.baseCommit }])).tree,
      };
    };

    const messageOf = ({ metadata }: StoredProposal) => edit.revise?.proposalId === metadata.proposalId
      ? { description: edit.revise.description, title: edit.revise.title }
      : { description: metadata.description, title: metadata.title };
    const released: string[] = [];
    const rebuilt: Rebuilt[] = [];
    const layerUpdates: GitRefUpdate[] = [];
    const layerDeletes: Array<{ oldValue: string; ref: string }> = [];
    const replacedLayerRefs: string[] = [];
    const layerCommits = new Map<string, string>();
    const resultLayers: GitArcStackEditResult["layers"] = [];
    const startLayer = groups[startIndex]!.layer;
    let base = startLayer ? startLayer.parent : oldTop;
    let topLayerTip = startLayer ? chain[startIndex - 1]?.tipCommit ?? null : entry.stackTip ?? null;
    let baseChanged = false;
    /** Commits that remain stack tips; a proposal built on one records it as its stack base. */
    const layerTips = new Set(chain.slice(0, startIndex).map(({ tipCommit }) => tipCommit));
    for (const [offset, group] of groups.slice(startIndex).entries()) {
      const results: Rebuilt[] = [];
      for (const proposal of group.proposals) {
        const id = proposal.metadata.proposalId;
        if (isCopy(proposal, startIndex + offset)) continue;
        if (drop.has(id)) {
          released.push(...proposal.metadata.paths);
          continue;
        }
        if (foldSources.has(id)) continue;
        const revision = edit.revise?.proposalId === id ? edit.revise : null;
        const folds = [...foldSources].filter(([, into]) => into === id).map(([source]) => source);
        const contentEdited = Boolean(revision || strip.has(id) || folds.length);
        const rebases = baseChanged && (group.layer || proposal.metadata.baseCommit === oldTop);
        if (!contentEdited && !rebases) {
          results.push({ base: proposal.metadata.baseCommit, contentEdited, livePaths: proposal.metadata.livePaths, newId: null, paths: proposal.metadata.paths, proposal, tree: proposal.tree });
          continue;
        }
        if (!revision && (proposal.metadata.mode !== "commit" || proposal.metadata.messageOnly)) {
          invalid(`Proposal ${id} is an amendment that cannot be rebased; land or rescind it first.`);
        }
        const own = await stripOwn(proposal, revision?.tree ?? proposal.tree, revision?.paths ?? proposal.metadata.paths);
        released.push(...own.stripped);
        let tree = rebases ? await merge(proposal.metadata.baseCommit, base, own.tree, id) : own.tree;
        let candidates = own.paths;
        for (const sourceId of folds) {
          const source = byId.get(sourceId)!;
          const sourceOwn = await stripOwn(source, source.tree, source.metadata.paths);
          released.push(...sourceOwn.stripped);
          tree = await merge(source.metadata.baseCommit, tree, sourceOwn.tree, sourceId);
          candidates = [...new Set([...candidates, ...sourceOwn.paths])];
        }
        const nextBase = rebases ? base : proposal.metadata.baseCommit;
        if (revision) {
          results.push({ base: nextBase, contentEdited, livePaths: revision.livePaths, newId: randomUUID(), paths: revision.paths, proposal, tree });
          continue;
        }
        const paths = await this.repository.listChangedPaths(nextBase, tree, candidates);
        if (!paths.length) {
          emptied.push(proposal);
          continue;
        }
        results.push({ base: nextBase, contentEdited, livePaths: paths, newId: contentEdited ? randomUUID() : null, paths, proposal, tree });
      }
      rebuilt.push(...results);
      if (!group.layer) continue;
      const stored = await store.readCheckpoint(group.layer.layer.harness as GitArcHarness, group.layer.layer.threadId, group.layer.tipCommit);
      if (!stored.metadata?.stackLayer) throw new Error("The sealed proposal layer is unavailable.");
      layerDeletes.push({ oldValue: group.layer.tipCommit, ref: stored.checkpointRef });
      replacedLayerRefs.push(stored.checkpointRef);
      if (!results.length) {
        if (base) layerCommits.set(group.layer.tipCommit, base);
        baseChanged = true;
        continue;
      }
      let tree = await this.repository.resolveTree(base);
      for (const result of results) tree = await this.repository.writeTreeWithPathsFromSource(tree, result.tree, result.paths);
      const proposals = await Promise.all(results.map(async (result): Promise<GitArcStackedProposal> => ({
        changes: await this.repository.buildChangeTotals(base, result.tree, result.paths),
        ...messageOf(result.proposal),
        proposalId: result.newId ?? result.proposal.metadata.proposalId,
      })));
      const proposalIds = proposals.map(({ proposalId }) => proposalId);
      const metadata: CheckpointMetadata = {
        ...stored.metadata,
        scopePaths: [...new Set(results.flatMap(({ paths }) => paths))].sort(),
        stackLayer: { ...stored.metadata.stackLayer, proposalIds, proposals },
      };
      const next = await this.repository.createCommitFromTree(tree, base, checkpointMessage(metadata), await this.repository.readCommit(group.layer.tipCommit));
      const nextRef = stored.checkpointRef.replace(/-[a-f0-9]{7,64}$/iu, `-${next.slice(0, 8)}`);
      layerUpdates.push({ newValue: next, oldValue: null, ref: nextRef });
      replacedLayerRefs.push(nextRef);
      layerCommits.set(group.layer.tipCommit, next);
      layerTips.add(next);
      resultLayers.push({ proposalIds, title: stored.metadata.stackLayer.title });
      base = next;
      topLayerTip = next;
      baseChanged = true;
    }
    const emptiedIds = emptied.map(({ metadata }) => metadata.proposalId);
    const [firstConflict] = conflicts;
    if (firstConflict) {
      const [proposalId, paths] = firstConflict;
      const strips = [...conflicts].filter(([id]) => !emptiedIds.includes(id)).flatMap(([id, files]) => files.map(file => `${id}=${file}`));
      throw new GitArcRejectionError({ reason: "restackConflict", paths, proposalId, title: byId.get(proposalId)!.metadata.title }, [
        `Restack conflicts in ${conflicts.size} proposals.`,
        ...strips.length ? [`Stripping these files would clear them: ${strips.join(" ")}.`] : [],
        ...emptiedIds.length ? [`These would then have no changes, so they would need dropping: ${emptiedIds.join(" ")}.`] : [],
      ].join(" "));
    }
    const [firstEmptied] = emptied;
    if (firstEmptied) {
      const { proposalId, title } = firstEmptied.metadata;
      throw new GitArcRejectionError({ reason: "proposalEmptied", paths: [], proposalId, title }, `These proposals would have no changes; drop them instead: ${emptiedIds.join(" ")}.`);
    }
    await stack.requireForeignPathsUnchanged(identity, layerCommits);

    const touched = new Set([...drop, ...foldSources.keys(), ...rebuilt.filter(({ base: nextBase, newId, proposal }) => (
      newId || nextBase !== proposal.metadata.baseCommit
    )).map(({ proposal }) => proposal.metadata.proposalId)]);
    const ownProposals = await store.listProposals(identity.harness, identity.threadId);
    const rewrite = layerCommits.size
      ? await new GitArcHistoryRewriter(this.repository).prepare(layerCommits, {
        excludeRefs: [
          REGISTRY_REF,
          ...replacedLayerRefs,
          ...ownProposals.filter(({ metadata }) => touched.has(metadata.proposalId)).map(({ proposalRef }) => proposalRef),
        ],
        freezeSettledProposals: true,
      })
      : { commits: new Map<string, string>(), deletes: [], updates: [], warnings: [] };
    if (rewrite.warnings.length) console.warn(`Git arc stack edit skipped refs: ${rewrite.warnings.slice(0, 5).join("; ")}`);
    const commits = rewrite.commits;

    const proposalUpdates: GitRefUpdate[] = [];
    const outcomes: GitArcStackEditResult["proposals"] = [];
    const replacements = new Map<string, ProposalMetadata>();
    const replace = new Map<string, string>();
    const settle = async (proposal: StoredProposal, metadata: ProposalMetadata) => {
      const { commit } = await store.createProposalCommit(proposal.tree, metadata, { previous: proposal });
      proposalUpdates.push({ newValue: commit, oldValue: proposal.proposalCommit, ref: proposal.proposalRef });
    };
    for (const result of rebuilt) {
      const { proposal } = result;
      const id = proposal.metadata.proposalId;
      if (!touched.has(id)) continue;
      const remapped = remapProposalMetadata(proposal.metadata, commits);
      const { stackBase: _stackBase, ...withoutStackBase } = remapped;
      const rebased: ProposalMetadata = {
        ...withoutStackBase,
        ...(result.base !== proposal.metadata.baseCommit ? { baseCommit: result.base, liveBaseCommit: result.base } : {}),
        ...(result.base && layerTips.has(result.base) ? { stackBase: result.base } : {}),
        livePaths: result.livePaths,
        paths: result.paths,
      };
      if (!result.newId) {
        const { commit } = await store.createProposalCommit(result.tree, rebased);
        proposalUpdates.push({ newValue: commit, oldValue: proposal.proposalCommit, ref: proposal.proposalRef });
        outcomes.push({ proposalId: id, status: "rebased", title: proposal.metadata.title });
        continue;
      }
      const revision = edit.revise?.proposalId === id ? edit.revise : null;
      const metadata: ProposalMetadata = {
        ...rebased,
        committedSha: null,
        proposalId: result.newId,
        status: "proposed",
        supersededByProposalId: null,
        supersededBySha: null,
        unavailableReason: null,
        ...(revision ? { description: revision.description, sourceCheckpoint: revision.sourceCheckpoint, title: revision.title } : {}),
      };
      const created = await store.createProposalCommit(result.tree, metadata);
      proposalUpdates.push({ newValue: created.commit, oldValue: null, ref: await store.proposalRefName(identity.harness, identity.threadId, result.newId) });
      replacements.set(result.newId, created.metadata);
      replace.set(id, result.newId);
      await settle(proposal, { ...remapped, status: "superseded", supersededByProposalId: result.newId, supersededBySha: null, unavailableReason: null });
      outcomes.push({
        proposalId: id, replacementId: result.newId, status: "replaced", stripped: strippedById.get(id) ?? [], title: messageOf(proposal).title,
      });
    }
    for (const proposal of byId.values()) {
      const id = proposal.metadata.proposalId;
      const remapped = remapProposalMetadata(proposal.metadata, commits);
      if (drop.has(id)) {
        await settle(proposal, { ...remapped, status: "rescinded", unavailableReason: null });
        outcomes.push({ proposalId: id, status: "rescinded", title: proposal.metadata.title });
      }
      const into = foldSources.get(id);
      if (into) {
        const replacementId = replace.get(into)!;
        await settle(proposal, { ...remapped, status: "superseded", supersededByProposalId: replacementId, supersededBySha: null, unavailableReason: null });
        outcomes.push({ proposalId: id, replacementId, status: "superseded", stripped: strippedById.get(id) ?? [], title: proposal.metadata.title });
      }
    }

    const removed = new Set(foldSources.keys());
    const storedIds = new Set([...entry.proposalIds ?? [], ...entry.retainedArc?.proposalIds ?? [], ...entry.savedStash?.proposalIds ?? []]);
    const mapIds = (ids: readonly string[]) => ids.flatMap(id => removed.has(id) ? [] : [replace.get(id) ?? id]);
    const proposalIds = mapIds(entry.proposalIds ?? []);
    for (const [from, to] of replace) if (!storedIds.has(from) && !proposalIds.includes(to)) proposalIds.push(to);
    let nextEntry: GitArcRegistryEntry = {
      ...entry,
      checkpointCommit: commits.get(entry.checkpointCommit) ?? entry.checkpointCommit,
      proposalId: proposalIds.at(-1) ?? null,
      proposalIds,
      stackTip: startLayer || layerCommits.size ? topLayerTip : entry.stackTip ?? null,
      ...(entry.retainedArc ? {
        retainedArc: {
          ...entry.retainedArc,
          checkpointCommit: commits.get(entry.retainedArc.checkpointCommit) ?? entry.retainedArc.checkpointCommit,
          proposalIds: mapIds(entry.retainedArc.proposalIds),
        },
      } : {}),
      ...(entry.savedStash ? {
        savedStash: {
          ...entry.savedStash,
          checkpointCommit: commits.get(entry.savedStash.checkpointCommit) ?? entry.savedStash.checkpointCommit,
          proposalIds: mapIds(entry.savedStash.proposalIds),
        },
      } : {}),
    };
    const guards = new GitArcPathSet(getGitArcLiveClaimPaths(nextEntry));
    const releasedClaims = [...new Set(released)].filter(candidate => guards.covers(candidate)).sort();
    if (releasedClaims.length) {
      const ownership = new GitArcClaimOwnershipController(this.repository, this.resolveThreadIdentity);
      nextEntry = ownership.withActiveClaims(nextEntry, [...new Set([...(await ownership.project(entry)).activeClaims, ...releasedClaims])]);
    }
    const { updatedAt: _updatedAt, ...claim } = nextEntry;
    const registryMutation = await registry.prepareClaim(claim, { commitRemaps: commits, expectedCheckpointCommit: entry.checkpointCommit });
    await this.repository.updateRefs(
      [...layerUpdates, ...rewrite.updates, ...registryMutation.updates, ...proposalUpdates],
      [...layerDeletes, ...rewrite.deletes],
    );
    return {
      layers: resultLayers,
      proposals: outcomes,
      releasedClaims,
      replacements,
      stackTip: nextEntry.stackTip ?? null,
    };
  }
}
