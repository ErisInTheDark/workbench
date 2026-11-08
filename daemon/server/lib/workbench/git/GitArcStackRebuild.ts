/*
 * Exports:
 * - default GitArcStackRebuild: one pass rebuilding an owner's stack upward from a start group with drops, strips, folds
 *   or a revision applied; writes only unreferenced objects, and reports unresolved conflicts plus the files partial
 *   folds must keep at their source before another pass.
 * - GitArcStackGroup: one sealed layer's proposals, or the unsealed pending ones.
 * - GitArcStackRevision: replacement content and message for one pending proposal.
 * - GitArcStackFold: one fold's source and target positions and the files that stay at its source.
 * - GitArcStackRebuilt: one proposal as a pass rebuilt it.
 * - GitArcStackPass: everything one pass produced.
 * - invalidRestack: reject a restack edit that cannot apply to the stack.
 */
import { randomUUID } from "node:crypto";
import GitArcPathSet from "workbench-shared/workbench/git/GitArcPathSet";
import { GitArcRejectionError } from "workbench-shared/workbench/git/git-arc-rejections";
import type { GitArcStackedProposal } from "workbench-shared/workbench/git/git-arc-receipts";
import { checkpointMessage, type CheckpointMetadata, type GitArcHarness } from "workbench-shared/workbench/git/git-arc-storage";
import type { GitArcStackLayer } from "./GitArcStackController";
import type GitCheckpointStore from "./GitCheckpointStore";
import type { StoredProposal } from "./GitCheckpointStore";
import type WorkbenchGitRepository from "./WorkbenchGitRepository";
import type { GitRefUpdate } from "./WorkbenchGitRepository";

export interface GitArcStackGroup {
  layer: GitArcStackLayer | null;
  proposals: StoredProposal[];
}

/** Its tree builds on the target's base and it is published under a new id. */
export interface GitArcStackRevision {
  description: string;
  livePaths: string[];
  paths: string[];
  proposalId: string;
  sourceCheckpoint: string;
  title: string;
  tree: string;
}

export interface GitArcStackFold {
  into: string;
  /** Moves what it can and keeps the rest at the source as a residual, instead of rejecting on conflict. */
  partial: boolean;
  proposalId: string;
  /** Files that stay at the source. */
  retracted: ReadonlySet<string>;
  sourceIndex: number;
  targetIndex: number;
}

export interface GitArcStackRebuilt {
  base: string | null;
  livePaths: string[];
  newId: string | null;
  paths: string[];
  proposal: StoredProposal;
  tree: string;
}

export interface GitArcStackPass {
  /** Files each unresolved conflict is on, by proposal id. */
  conflicts: Map<string, string[]>;
  /** Proposals left with no changes, in stack order. */
  emptied: StoredProposal[];
  layerCommits: Map<string, string>;
  layerDeletes: Array<{ oldValue: string; ref: string }>;
  /** Commits that remain stack tips; a proposal built on one records it as its stack base. */
  layerTips: Set<string>;
  layerUpdates: GitRefUpdate[];
  /** Fold sources whose content reached their target. */
  moved: Set<string>;
  rebuilt: GitArcStackRebuilt[];
  released: string[];
  replacedLayerRefs: string[];
  resultLayers: Array<{ proposalIds: string[]; title: string }>;
  /** Files each partial fold must keep at its source on the next pass, by source id. */
  retractions: Map<string, Set<string>>;
  /** Files each strip took out of its proposal, by proposal id. */
  strippedById: Map<string, string[]>;
  topLayerTip: string | null;
}

export interface GitArcStackPassInput {
  byId: ReadonlyMap<string, StoredProposal>;
  chain: readonly GitArcStackLayer[];
  drop: ReadonlySet<string>;
  /** Keyed by source id. */
  folds: ReadonlyMap<string, GitArcStackFold>;
  groups: readonly GitArcStackGroup[];
  isCopy: (proposal: StoredProposal, index: number) => boolean;
  oldTop: string | null;
  revise: GitArcStackRevision | null;
  stackTip: string | null;
  startIndex: number;
  strip: ReadonlyMap<string, string[]>;
}

interface GroupResult extends GitArcStackRebuilt {
  /** Files folds moved into this proposal. */
  foldedIn: string[];
}

export function invalidRestack(message: string): never {
  throw new GitArcRejectionError({ reason: "invalidRestackTarget" }, message);
}

const lowIndex = (fold: GitArcStackFold) => Math.min(fold.sourceIndex, fold.targetIndex);
const highIndex = (fold: GitArcStackFold) => Math.max(fold.sourceIndex, fold.targetIndex);

export default class GitArcStackRebuild {
  private readonly pass: GitArcStackPass = {
    conflicts: new Map(), emptied: [], layerCommits: new Map(), layerDeletes: [], layerTips: new Set(), layerUpdates: [],
    moved: new Set(), rebuilt: [], released: [], replacedLayerRefs: [], resultLayers: [], retractions: new Map(),
    strippedById: new Map(), topLayerTip: null,
  };
  /** Files each fold moves this pass, by source id. */
  private readonly moving = new Map<string, ReadonlySet<string>>();

  constructor(
    private readonly repository: WorkbenchGitRepository,
    private readonly store: GitCheckpointStore,
    private readonly input: GitArcStackPassInput,
  ) {
    for (const fold of input.folds.values()) {
      const prefixes = input.strip.get(fold.proposalId);
      const stripped = prefixes ? new GitArcPathSet(prefixes) : null;
      this.moving.set(fold.proposalId, new Set(input.byId.get(fold.proposalId)!.metadata.paths.filter(candidate => (
        !stripped?.covers(candidate) && !fold.retracted.has(candidate)
      ))));
    }
  }

  async run(): Promise<GitArcStackPass> {
    const { chain, groups, oldTop, startIndex } = this.input;
    const startLayer = groups[startIndex]!.layer;
    let base = startLayer ? startLayer.parent : oldTop;
    let baseChanged = false;
    this.pass.topLayerTip = startLayer ? chain[startIndex - 1]?.tipCommit ?? null : this.input.stackTip;
    for (const { tipCommit } of chain.slice(0, startIndex)) this.pass.layerTips.add(tipCommit);
    for (let index = startIndex; index < groups.length; index++) {
      const group = groups[index]!;
      const results: GroupResult[] = [];
      for (const proposal of group.proposals) {
        // Unsealed proposals rebase only when they built on the old top.
        const rebases = baseChanged && (Boolean(group.layer) || proposal.metadata.baseCommit === oldTop);
        const result = await this.rebuildProposal(proposal, index, base, rebases);
        if (result) results.push(result);
      }
      this.claimFoldOverlaps(results, index);
      this.pass.rebuilt.push(...results.map(({ foldedIn: _foldedIn, ...result }) => result));
      if (!group.layer) continue;
      const stored = await this.store.readCheckpoint(group.layer.layer.harness as GitArcHarness, group.layer.layer.threadId, group.layer.tipCommit);
      if (!stored.metadata?.stackLayer) throw new Error("The sealed proposal layer is unavailable.");
      this.pass.layerDeletes.push({ oldValue: group.layer.tipCommit, ref: stored.checkpointRef });
      this.pass.replacedLayerRefs.push(stored.checkpointRef);
      baseChanged = true;
      if (!results.length) {
        if (base) this.pass.layerCommits.set(group.layer.tipCommit, base);
        continue;
      }
      let tree = await this.repository.resolveTree(base);
      for (const result of results) tree = await this.repository.writeTreeWithPathsFromSource(tree, result.tree, result.paths);
      const proposals = await Promise.all(results.map(async (result): Promise<GitArcStackedProposal> => ({
        changes: await this.repository.buildChangeTotals(base, result.tree, result.paths),
        ...this.messageOf(result.proposal),
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
      this.pass.layerUpdates.push({ newValue: next, oldValue: null, ref: nextRef });
      this.pass.replacedLayerRefs.push(nextRef);
      this.pass.layerCommits.set(group.layer.tipCommit, next);
      this.pass.layerTips.add(next);
      this.pass.resultLayers.push({ proposalIds, title: stored.metadata.stackLayer.title });
      base = next;
      this.pass.topLayerTip = next;
    }
    return this.pass;
  }

  messageOf({ metadata }: StoredProposal) {
    const { revise } = this.input;
    return revise?.proposalId === metadata.proposalId
      ? { description: revise.description, title: revise.title }
      : { description: metadata.description, title: metadata.title };
  }

  private async rebuildProposal(proposal: StoredProposal, index: number, base: string | null, rebases: boolean): Promise<GroupResult | null> {
    const { byId, drop, folds, isCopy, revise, strip } = this.input;
    const id = proposal.metadata.proposalId;
    if (isCopy(proposal, index)) return null;
    if (drop.has(id)) {
      this.pass.released.push(...proposal.metadata.paths);
      return null;
    }
    const fold = folds.get(id);
    if (fold && !fold.partial) return null;
    const revision = revise?.proposalId === id ? revise : null;
    const intoFolds = [...folds.values()].filter(({ into }) => into === id);
    if (!fold && !revision && !strip.has(id) && !intoFolds.length && !rebases) {
      return { base: proposal.metadata.baseCommit, foldedIn: [], livePaths: proposal.metadata.livePaths, newId: null, paths: proposal.metadata.paths, proposal, tree: proposal.tree };
    }
    if (!revision && (proposal.metadata.mode !== "commit" || proposal.metadata.messageOnly)) {
      invalidRestack(`Proposal ${id} is an amendment that cannot be rebased; land or rescind it first.`);
    }
    let own = await this.stripOwn(proposal, revision?.tree ?? proposal.tree, revision?.paths ?? proposal.metadata.paths);
    const moving = fold ? this.moving.get(id)! : null;
    if (fold && moving?.size && fold.targetIndex > index) {
      // An upward fold's moving files leave here; what stays is the residual.
      own = {
        paths: own.paths.filter(candidate => !moving.has(candidate)),
        tree: (await this.repository.writeTreeWithPathSources(own.tree, [{ paths: [...moving], source: proposal.metadata.baseCommit }])).tree,
      };
      this.pass.moved.add(id);
    }
    let tree = rebases ? await this.merge(proposal.metadata.baseCommit, base, own.tree, { index, proposalId: id }) : own.tree;
    let candidates = own.paths;
    let contentEdited = Boolean(revision || strip.has(id));
    const foldedIn: string[] = [];
    for (const into of intoFolds) {
      const source = byId.get(into.proposalId)!;
      const sourceOwn = await this.stripOwn(source, source.tree, source.metadata.paths);
      const sourceMoving = this.moving.get(into.proposalId)!;
      if (!sourceMoving.size) continue;
      const kept = sourceOwn.paths.filter(candidate => !sourceMoving.has(candidate));
      const theirs = kept.length
        ? (await this.repository.writeTreeWithPathSources(sourceOwn.tree, [{ paths: kept, source: source.metadata.baseCommit }])).tree
        : sourceOwn.tree;
      const downward = into.targetIndex < into.sourceIndex;
      const before = tree;
      // Only downward folds keep clean hunks of a conflicting file: an upward fold's residual sits below its target, so
      // it cannot hold "the source minus some hunks".
      tree = await this.merge(source.metadata.baseCommit, tree, theirs, {
        direct: into, favorCurrent: into.partial && downward, index, proposalId: into.proposalId,
      });
      if (tree !== before) {
        contentEdited = true;
        if (downward) this.pass.moved.add(into.proposalId);
      }
      candidates = [...new Set([...candidates, ...sourceMoving])];
      foldedIn.push(...sourceMoving);
    }
    const nextBase = rebases ? base : proposal.metadata.baseCommit;
    if (revision) {
      return { base: nextBase, foldedIn, livePaths: revision.livePaths, newId: randomUUID(), paths: revision.paths, proposal, tree };
    }
    const paths = await this.repository.listChangedPaths(nextBase, tree, candidates);
    if (fold) {
      // A residual with nothing left means the whole source moved.
      return paths.length
        ? { base: nextBase, foldedIn, livePaths: paths, newId: this.pass.moved.has(id) ? randomUUID() : null, paths, proposal, tree }
        : null;
    }
    if (!paths.length) {
      this.pass.emptied.push(proposal);
      return null;
    }
    return { base: nextBase, foldedIn, livePaths: paths, newId: contentEdited ? randomUUID() : null, paths, proposal, tree };
  }

  private async stripOwn(proposal: StoredProposal, tree: string, paths: string[]) {
    const prefixes = this.input.strip.get(proposal.metadata.proposalId);
    if (!prefixes) return { paths, tree };
    const selected = new GitArcPathSet(prefixes);
    const stripped = paths.filter(candidate => selected.covers(candidate));
    this.pass.strippedById.set(proposal.metadata.proposalId, stripped);
    this.pass.released.push(...stripped);
    return {
      paths: paths.filter(candidate => !selected.covers(candidate)),
      tree: (await this.repository.writeTreeWithPathSources(tree, [{ paths: prefixes, source: proposal.metadata.baseCommit }])).tree,
    };
  }

  /**
   * Partial folds whose move put these files in conflict keep them at their source next pass; the rest are returned.
   * `direct` is the fold being merged into its target; otherwise every partial fold spanning `index` that moves a file
   * answers for it. Conflicts never resolve to either side, since that would hide one proposal's lines in another's diff.
   */
  private retract(index: number, paths: readonly string[], direct?: GitArcStackFold) {
    const unresolved: string[] = [];
    for (const candidate of paths) {
      const owners = (direct ? [direct] : [...this.input.folds.values()].filter(fold => lowIndex(fold) < index && index <= highIndex(fold)))
        .filter(fold => fold.partial && this.moving.get(fold.proposalId)!.has(candidate));
      if (!owners.length) unresolved.push(candidate);
      for (const { proposalId } of owners) {
        this.pass.retractions.set(proposalId, new Set([...this.pass.retractions.get(proposalId) ?? [], candidate]));
      }
    }
    return unresolved;
  }

  private conflict(proposalId: string, paths: string[]) {
    return this.input.revise
      ? new GitArcRejectionError({ reason: "proposalRevisionConflict" }, `The revision conflicts with proposal ${proposalId} layered above it: ${paths.join(", ")}`)
      : new GitArcRejectionError(
        { reason: "restackConflict", paths, proposalId, title: this.input.byId.get(proposalId)!.metadata.title },
        `Proposal ${proposalId} conflicts after the restack: ${paths.join(", ")}`,
      );
  }

  private async merge(base: string | null, ours: string | null, theirs: string, { direct, favorCurrent = false, index, proposalId }: {
    direct?: GitArcStackFold;
    favorCurrent?: boolean;
    index: number;
    proposalId: string;
  }) {
    const result = await this.repository.mergeWorktreeTrees(base, ours, theirs, { favorCurrent });
    const conflicted = result.conflictedPaths;
    if (!conflicted.length && !result.unsupportedConflictTypes.length) return result.tree;
    if (this.input.revise) throw this.conflict(proposalId, conflicted);
    const unresolved = this.retract(index, conflicted, direct);
    if (result.unsupportedConflictTypes.length && (unresolved.length || !conflicted.length)) {
      throw this.conflict(proposalId, unresolved.length ? unresolved : conflicted);
    }
    if (unresolved.length) this.pass.conflicts.set(proposalId, [...this.pass.conflicts.get(proposalId) ?? [], ...unresolved]);
    // Keeping the lower file is what stripping or retracting it does, so the report holds for the next pass.
    return (await this.repository.writeTreeWithPathSources(result.tree, [{ paths: conflicted, source: ours }])).tree;
  }

  /** Layers compose their proposals file by file, so a file folded into one proposal must not belong to a sibling. */
  private claimFoldOverlaps(results: readonly GroupResult[], index: number) {
    for (const result of results) {
      if (!result.foldedIn.length) continue;
      const siblingPaths = new Set(results.filter(other => other !== result).flatMap(({ paths }) => paths));
      const overlap = result.foldedIn.filter(candidate => siblingPaths.has(candidate));
      if (!overlap.length) continue;
      const folds = [...this.input.folds.values()].filter(({ into }) => into === result.proposal.metadata.proposalId);
      for (const fold of folds) {
        const unresolved = this.retract(index, overlap.filter(candidate => this.moving.get(fold.proposalId)!.has(candidate)), fold);
        if (unresolved.length) this.pass.conflicts.set(fold.proposalId, [...this.pass.conflicts.get(fold.proposalId) ?? [], ...unresolved]);
      }
    }
  }
}
