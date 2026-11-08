/*
 * Exports:
 * - default GitArcStackEditor: rewrite an owner's pending proposals and the stack layers above the lowest edit in one ref
 *   transaction, rebasing later proposals by three-way merging their own changes and dropping higher copies of proposals
 *   sealed twice; partial folds rerun the rebuild until every conflicting file stays at its source, fold-only edits must
 *   leave the stacked files unchanged, and dry runs stop before writing refs. Never reads or writes the worktree.
 * - GitArcStackEdit: drops, strips, folds or one revision that a single rewrite applies together.
 * - GitArcStackEditResult: per-proposal outcomes, rewritten layers, stack tip and paths returned to active claims.
 */
import GitArcPathSet from "workbench-shared/workbench/git/GitArcPathSet";
import { GitArcRejectionError } from "workbench-shared/workbench/git/git-arc-rejections";
import type { GitArcRestackOutcome } from "workbench-shared/workbench/git/git-arc-restack";
import {
  type GitArcHarness,
  normalizeThreadId,
  type ProposalMetadata,
  remapProposalMetadata,
} from "workbench-shared/workbench/git/git-arc-storage";
import GitArcClaimOwnershipController from "./GitArcClaimOwnershipController";
import GitArcHistoryRewriter from "./GitArcHistoryRewriter";
import GitArcRegistry, { getGitArcLiveClaimPaths, REGISTRY_REF, type GitArcRegistryEntry } from "./GitArcRegistry";
import GitArcStackController, { type GitArcStackLayer } from "./GitArcStackController";
import GitArcStackRebuild, {
  type GitArcStackFold,
  type GitArcStackGroup,
  type GitArcStackRevision,
  invalidRestack,
} from "./GitArcStackRebuild";
import GitCheckpointStore, { type StoredProposal } from "./GitCheckpointStore";
import type WorkbenchGitRepository from "./WorkbenchGitRepository";
import type { GitRefUpdate } from "./WorkbenchGitRepository";
import { passthroughGitArcThreadIdentityResolver, type GitArcThreadIdentityResolver } from "./git-arc-thread-identity";

export interface GitArcStackEdit {
  drop?: readonly string[];
  /** Report what the edit would do without writing any ref. */
  dryRun?: boolean;
  /** Each source's own changes merge into `into`, in any layer of the own stack. */
  fold?: ReadonlyArray<{ into: string; proposalId: string }>;
  /** Folds move what merges cleanly and keep conflicting files at their source instead of rejecting. */
  partial?: boolean;
  revise?: GitArcStackRevision;
  /** Path prefixes whose changes leave the proposal. */
  strip?: ReadonlyArray<{ paths: string[]; proposalId: string }>;
}

export interface GitArcStackEditResult {
  dryRun?: true;
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

function ownsLayer(layer: GitArcStackLayer, identity: Identity) {
  return layer.layer.harness === identity.harness && normalizeThreadId(layer.layer.threadId) === normalizeThreadId(identity.threadId);
}

function lifecycleProposalIds(entry: GitArcRegistryEntry) {
  return (entry.phase === "plan" ? entry.retainedArc?.proposalIds : entry.proposalIds) ?? [];
}

export default class GitArcStackEditor {
  constructor(
    private readonly repository: WorkbenchGitRepository,
    private readonly resolveThreadIdentity: GitArcThreadIdentityResolver = passthroughGitArcThreadIdentityResolver,
  ) {}

  async apply(identity: Identity, edit: GitArcStackEdit): Promise<GitArcStackEditResult> {
    const revise = edit.revise ?? null;
    const drop = new Set(edit.drop ?? []);
    const strip = new Map<string, string[]>();
    for (const { paths, proposalId } of edit.strip ?? []) strip.set(proposalId, [...strip.get(proposalId) ?? [], ...paths]);
    const foldTargets = new Map((edit.fold ?? []).map(({ into, proposalId }) => [proposalId, into]));
    if (revise && (drop.size || strip.size || foldTargets.size)) throw new Error("A revision cannot combine with restack edits.");
    if (!revise && !drop.size && !strip.size && !foldTargets.size) throw new GitArcRejectionError({ reason: "emptyRestack" });
    if (foldTargets.size !== (edit.fold?.length ?? 0)) invalidRestack("Each proposal can fold into only one target.");

    const registry = new GitArcRegistry(this.repository, this.resolveThreadIdentity);
    const store = new GitCheckpointStore(this.repository, this.resolveThreadIdentity);
    const entry = await registry.find(identity);
    if (!entry) throw new GitArcRejectionError({ reason: "proposalNotOwned" });
    const stack = new GitArcStackController(this.repository, this.resolveThreadIdentity);
    const chain = await stack.readChain(entry.stackTip);
    const oldTop = chain.at(-1)?.tipCommit ?? null;
    const sealedIds = new Set(chain.flatMap(({ layer }) => layer.proposalIds));
    const groups: GitArcStackGroup[] = await Promise.all(chain.map(async layer => ({
      layer,
      proposals: await Promise.all(layer.layer.proposalIds.map(async id => (
        await store.readProposal(layer.layer.harness as GitArcHarness, layer.layer.threadId, id)
      ))),
    })));
    const unsealedIds = new Set([...lifecycleProposalIds(entry), ...revise ? [revise.proposalId] : []]);
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
      if (index === undefined || !group || !proposal) invalidRestack(`Proposal ${proposalId} is not one of this thread's pending stack proposals.`);
      if (group.layer && !ownsLayer(group.layer, identity)) invalidRestack(`Proposal ${proposalId} is sealed in a layer this thread inherited.`);
      if (proposal.metadata.status !== "proposed") invalidRestack(`Proposal ${proposalId} is not pending.`);
      if (!revise && (proposal.metadata.mode !== "commit" || proposal.metadata.messageOnly)) {
        invalidRestack(`Proposal ${proposalId} is an amendment; restack edits only fresh-commit proposals.`);
      }
      return index;
    };
    const editedIds = [...drop, ...strip.keys(), ...foldTargets.keys(), ...foldTargets.values(), ...revise ? [revise.proposalId] : []];
    const startIndex = Math.min(...editedIds.map(locate), ...duplicateLayers);
    const folds = new Map<string, GitArcStackFold>();
    for (const [source, into] of foldTargets) {
      if (source === into || drop.has(into) || foldTargets.has(into) || drop.has(source)) {
        invalidRestack(`Proposal ${source} cannot fold into ${into}.`);
      }
      const sourceIndex = located.get(source)!;
      const targetIndex = located.get(into)!;
      const sourceProposal = byId.get(source)!;
      // A same-layer fold cannot conflict, and an unsealed source off the old top has no base holding moved hunks.
      const residualFits = targetIndex > sourceIndex || Boolean(groups[sourceIndex]!.layer) || sourceProposal.metadata.baseCommit === oldTop;
      folds.set(source, {
        into, partial: Boolean(edit.partial) && sourceIndex !== targetIndex && residualFits, proposalId: source, retracted: new Set(), sourceIndex, targetIndex,
      });
    }
    for (const [proposalId, prefixes] of strip) {
      if (drop.has(proposalId)) invalidRestack(`Proposal ${proposalId} cannot be both dropped and stripped.`);
      const proposal = byId.get(proposalId)!;
      const selected = new GitArcPathSet(prefixes);
      if (!proposal.metadata.paths.some(candidate => selected.covers(candidate))) {
        invalidRestack(`Strip paths ${prefixes.join(", ")} match none of proposal ${proposalId}'s files.`);
      }
    }

    const passInput = { byId, chain, drop, groups, isCopy, oldTop, revise, stackTip: entry.stackTip ?? null, startIndex, strip };
    const runPass = async () => {
      const rebuild = new GitArcStackRebuild(this.repository, store, { ...passInput, folds });
      return { pass: await rebuild.run(), rebuild };
    };
    let { pass, rebuild } = await runPass();
    // Every rerun keeps more files at their sources, so this ends.
    while (pass.retractions.size) {
      for (const [source, files] of pass.retractions) {
        const fold = folds.get(source)!;
        folds.set(source, { ...fold, retracted: new Set([...fold.retracted, ...files]) });
      }
      ({ pass, rebuild } = await runPass());
    }
    const emptiedIds = pass.emptied.map(({ metadata }) => metadata.proposalId);
    const [firstConflict] = pass.conflicts;
    if (firstConflict) {
      const [proposalId, paths] = firstConflict;
      const strips = [...pass.conflicts].filter(([id]) => !emptiedIds.includes(id)).flatMap(([id, files]) => files.map(file => `${id}=${file}`));
      throw new GitArcRejectionError({ reason: "restackConflict", paths, proposalId, title: byId.get(proposalId)!.metadata.title }, [
        `Restack conflicts in ${pass.conflicts.size} proposals.`,
        ...strips.length ? [`Stripping these files would clear them: ${strips.join(" ")}.`] : [],
        ...emptiedIds.length ? [`These would then have no changes, so they would need dropping: ${emptiedIds.join(" ")}.`] : [],
      ].join(" "));
    }
    const [firstEmptied] = pass.emptied;
    if (firstEmptied) {
      const { proposalId, title } = firstEmptied.metadata;
      throw new GitArcRejectionError({ reason: "proposalEmptied", paths: [], proposalId, title }, `These proposals would have no changes; drop them instead: ${emptiedIds.join(" ")}.`);
    }
    if (folds.size && !drop.size && !strip.size && !revise && !duplicateLayers.length) {
      const top = groups.length - 1;
      const stacked = async (tip: string | null, proposals: ReadonlyArray<{ paths: string[]; tree: string }>) => (
        await this.repository.writeTreeWithPathSources(tip, proposals.map(({ paths, tree }) => ({ paths, source: tree })))
      ).tree;
      const before = await stacked(oldTop, groups[top]!.proposals.filter(proposal => !isCopy(proposal, top)).map(({ metadata, tree }) => ({ paths: metadata.paths, tree })));
      const after = await stacked(pass.topLayerTip, pass.rebuilt.filter(({ proposal }) => located.get(proposal.metadata.proposalId) === top));
      const changed = await this.repository.listAllChangedPaths(before, after);
      if (changed.length) {
        throw new GitArcRejectionError({ reason: "restackChangedTip", paths: changed }, `These folds would change the stacked content of ${changed.join(", ")}.`);
      }
    }
    await stack.requireForeignPathsUnchanged(identity, pass.layerCommits);

    const rebuiltById = new Map(pass.rebuilt.map(result => [result.proposal.metadata.proposalId, result]));
    const fullyMoved = new Set([...folds.keys()].filter(id => !rebuiltById.has(id)));
    const touched = new Set([...drop, ...fullyMoved, ...pass.rebuilt.filter(({ base: nextBase, newId, proposal }) => (
      newId || nextBase !== proposal.metadata.baseCommit
    )).map(({ proposal }) => proposal.metadata.proposalId)]);
    const replace = new Map(pass.rebuilt.flatMap(({ newId, proposal }) => newId ? [[proposal.metadata.proposalId, newId] as const] : []));
    const targetIdOf = (fold: GitArcStackFold) => replace.get(fold.into) ?? fold.into;

    const outcomes: GitArcRestackOutcome[] = [];
    for (const { newId, proposal } of pass.rebuilt) {
      const id = proposal.metadata.proposalId;
      if (!touched.has(id) || folds.has(id)) continue;
      const { title } = rebuild.messageOf(proposal);
      outcomes.push(newId
        ? { proposalId: id, replacementId: newId, status: "replaced", stripped: pass.strippedById.get(id) ?? [], title }
        : { proposalId: id, status: "rebased", title });
    }
    for (const id of drop) outcomes.push({ proposalId: id, status: "rescinded", title: byId.get(id)!.metadata.title });
    for (const fold of folds.values()) {
      const id = fold.proposalId;
      const { title } = byId.get(id)!.metadata;
      const stripped = pass.strippedById.get(id) ?? [];
      const residual = rebuiltById.get(id);
      if (!residual) outcomes.push({ proposalId: id, replacementId: targetIdOf(fold), status: "superseded", stripped, title });
      else if (residual.newId) {
        outcomes.push({ kept: residual.paths, proposalId: id, replacementId: targetIdOf(fold), residualId: residual.newId, status: "split", stripped, title });
      } else outcomes.push({ kept: residual.paths, proposalId: id, status: "unmoved", title });
    }

    const storedIds = new Set([...entry.proposalIds ?? [], ...entry.retainedArc?.proposalIds ?? [], ...entry.savedStash?.proposalIds ?? []]);
    const mapIds = (ids: readonly string[]) => ids.flatMap(id => fullyMoved.has(id) ? [] : [replace.get(id) ?? id]);
    const proposalIds = mapIds(entry.proposalIds ?? []);
    for (const [from, to] of replace) if (!storedIds.has(from) && !proposalIds.includes(to)) proposalIds.push(to);
    const stackTip = pass.layerCommits.size || groups[startIndex]!.layer ? pass.topLayerTip : entry.stackTip ?? null;
    const guards = new GitArcPathSet(getGitArcLiveClaimPaths(entry));
    const releasedClaims = [...new Set(pass.released)].filter(candidate => guards.covers(candidate)).sort();
    if (edit.dryRun) return { dryRun: true, layers: pass.resultLayers, proposals: outcomes, releasedClaims, replacements: new Map(), stackTip };

    const ownProposals = await store.listProposals(identity.harness, identity.threadId);
    const rewrite = pass.layerCommits.size
      ? await new GitArcHistoryRewriter(this.repository).prepare(pass.layerCommits, {
        excludeRefs: [
          REGISTRY_REF,
          ...pass.replacedLayerRefs,
          ...ownProposals.filter(({ metadata }) => touched.has(metadata.proposalId)).map(({ proposalRef }) => proposalRef),
        ],
        freezeSettledProposals: true,
      })
      : { commits: new Map<string, string>(), deletes: [], updates: [], warnings: [] };
    if (rewrite.warnings.length) console.warn(`Git arc stack edit skipped refs: ${rewrite.warnings.slice(0, 5).join("; ")}`);
    const commits = rewrite.commits;

    const proposalUpdates: GitRefUpdate[] = [];
    const replacements = new Map<string, ProposalMetadata>();
    const settle = async (proposal: StoredProposal, metadata: ProposalMetadata) => {
      const { commit } = await store.createProposalCommit(proposal.tree, metadata, { previous: proposal });
      proposalUpdates.push({ newValue: commit, oldValue: proposal.proposalCommit, ref: proposal.proposalRef });
    };
    for (const result of pass.rebuilt) {
      const { proposal } = result;
      const id = proposal.metadata.proposalId;
      if (!touched.has(id)) continue;
      const remapped = remapProposalMetadata(proposal.metadata, commits);
      const { stackBase: _stackBase, ...withoutStackBase } = remapped;
      const rebased: ProposalMetadata = {
        ...withoutStackBase,
        ...(result.base !== proposal.metadata.baseCommit ? { baseCommit: result.base, liveBaseCommit: result.base } : {}),
        ...(result.base && pass.layerTips.has(result.base) ? { stackBase: result.base } : {}),
        livePaths: result.livePaths,
        paths: result.paths,
      };
      if (!result.newId) {
        const { commit } = await store.createProposalCommit(result.tree, rebased);
        proposalUpdates.push({ newValue: commit, oldValue: proposal.proposalCommit, ref: proposal.proposalRef });
        continue;
      }
      const revision = revise?.proposalId === id ? revise : null;
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
      await settle(proposal, { ...remapped, status: "superseded", supersededByProposalId: result.newId, supersededBySha: null, unavailableReason: null });
    }
    for (const id of drop) {
      const proposal = byId.get(id)!;
      await settle(proposal, { ...remapProposalMetadata(proposal.metadata, commits), status: "rescinded", unavailableReason: null });
    }
    for (const id of fullyMoved) {
      const proposal = byId.get(id)!;
      await settle(proposal, {
        ...remapProposalMetadata(proposal.metadata, commits), status: "superseded", supersededByProposalId: targetIdOf(folds.get(id)!), supersededBySha: null, unavailableReason: null,
      });
    }

    let nextEntry: GitArcRegistryEntry = {
      ...entry,
      checkpointCommit: commits.get(entry.checkpointCommit) ?? entry.checkpointCommit,
      proposalId: proposalIds.at(-1) ?? null,
      proposalIds,
      stackTip,
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
    if (releasedClaims.length) {
      const ownership = new GitArcClaimOwnershipController(this.repository, this.resolveThreadIdentity);
      nextEntry = ownership.withActiveClaims(nextEntry, [...new Set([...(await ownership.project(entry)).activeClaims, ...releasedClaims])]);
    }
    const { updatedAt: _updatedAt, ...claim } = nextEntry;
    const registryMutation = await registry.prepareClaim(claim, { commitRemaps: commits, expectedCheckpointCommit: entry.checkpointCommit });
    await this.repository.updateRefs(
      [...pass.layerUpdates, ...rewrite.updates, ...registryMutation.updates, ...proposalUpdates],
      [...pass.layerDeletes, ...rewrite.deletes],
    );
    return { layers: pass.resultLayers, proposals: outcomes, releasedClaims, replacements, stackTip };
  }
}
