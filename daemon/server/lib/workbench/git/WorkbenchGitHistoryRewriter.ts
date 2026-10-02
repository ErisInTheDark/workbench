/*
 * Exports:
 * - default WorkbenchGitHistoryRewriter: amend unpushed commits in a linear local stack without touching worktree files.
 * - WorkbenchGitHistoryRewriteResult: target/tip replacements, selected commit replacements, committed paths and bounded warnings.
 * - WorkbenchGitIdentityOverride: canonical author/committer fields overlaid onto selected commits.
 * - WorkbenchGitCommitAmendability: whether one exact commit can use the history rewriter.
 * - WorkbenchGitPreparedHead: future history used only for read-only presentation.
 * - WorkbenchGitHistoryMutationContext: prepared history and arc changes before atomic publication.
 * - WorkbenchGitHistoryAdditionalMutation: extra ref mutations included in history publication.
 */
import GitArcHistoryRewriter from "./GitArcHistoryRewriter";
import GitArcPublishState from "./GitArcPublishState";
import { replaceCoAuthorTrailers } from "./git-commit-trailers";
import WorkbenchGitRepository, { GIT_STATE_GENERATION_REF, type GitCommitIdentity, type GitRefUpdate } from "./WorkbenchGitRepository";
import type { GitArcHistoryRewritePlan } from "./GitArcHistoryRewriter";

export type WorkbenchGitIdentityOverride = Partial<Pick<
  GitCommitIdentity,
  "authorDate" | "authorEmail" | "authorName" | "committerDate" | "committerEmail" | "committerName"
>>;

export interface WorkbenchGitHistoryRewriteResult {
  amendedCommit: string;
  /** Selected commits in history order, oldest first. */
  amendedCommits: Array<{ commit: string; original: string }>;
  commit: string;
  committedPaths: string[];
  rewrittenCommitCount: number;
  warnings: string[];
}

export type WorkbenchGitCommitAmendability =
  | { resolvedTarget: string; status: "available" }
  | { reason: string; status: "unavailable" };

export interface WorkbenchGitPreparedHead {
  commit: string;
  ref: string | null;
}

export interface WorkbenchGitHistoryMutationContext {
  amendedCommit: string;
  arcPlan: GitArcHistoryRewritePlan;
  branchCommits: ReadonlyMap<string, string>;
  headRef: string;
  newHead: string;
  oldHead: string;
  targetTree: string;
}

export interface WorkbenchGitHistoryAdditionalMutation {
  deletes?: Array<{ oldValue: string; ref: string }>;
  replaceRefs: string[];
  updates: GitRefUpdate[];
}

export default class WorkbenchGitHistoryRewriter {
  constructor(private readonly repository: WorkbenchGitRepository) {}

  /** Resolves targets in input order; the range starts at the oldest target and ends at HEAD. */
  private async readAmendRange(targets: readonly string[], preparedHead?: WorkbenchGitPreparedHead) {
    const headRef = preparedHead ? preparedHead.ref : await this.repository.symbolicHead();
    if (!headRef) throw new Error("Detached HEAD is unsafe for an amend.");
    const head = preparedHead ? preparedHead.commit : await this.repository.currentHead();
    const arcRewriter = new GitArcHistoryRewriter(this.repository);
    const resolvedTargets: string[] = [];
    let range = [head];
    for (const target of targets) {
      let resolvedTarget = target === head ? head : await this.repository.resolveCommit(target);
      if (resolvedTarget !== head && !await this.repository.isAncestor(resolvedTarget, head)) {
        resolvedTarget = await this.repository.resolveCommit(await arcRewriter.resolveAlias(resolvedTarget));
        if (resolvedTarget !== head && !await this.repository.isAncestor(resolvedTarget, head)) {
          throw new Error(`The amend target ${target} is not on the current branch history.`);
        }
      }
      resolvedTargets.push(resolvedTarget);
      const targetRange = resolvedTarget === head ? [head] : await this.repository.firstParentRange(resolvedTarget, head);
      if (targetRange.length > range.length) range = targetRange;
    }
    const commitBatch = await this.repository.readCommits(range);
    const commits = range.map((commit) => {
      const metadata = commitBatch.commits.get(commit);
      if (!metadata) throw new Error(commitBatch.errors.get(commit) ?? `Unable to read commit metadata for ${commit}.`);
      return { commit, metadata };
    });
    if (commits.some(({ metadata }) => metadata.parents.length > 1)) {
      throw new Error("Amend ranges containing merge commits are not supported.");
    }
    if (commits.some(({ metadata }) => metadata.signed)) {
      throw new Error("Amend ranges containing signed commits are not supported.");
    }
    return { arcRewriter, commits, head, headRef, resolvedTargets };
  }

  async classifyAmendability(target: string, options: {
    preparedHead?: WorkbenchGitPreparedHead;
    refresh?: boolean;
  } = {}): Promise<WorkbenchGitCommitAmendability> {
    try {
      const [resolvedTarget] = (await this.readAmendRange([target], options.preparedHead)).resolvedTargets as [string];
      const publishState = await new GitArcPublishState(this.repository).classifyCommit(resolvedTarget, {
        refresh: options.preparedHead ? false : options.refresh,
      });
      if (publishState.kind === "unpushed") return { resolvedTarget, status: "available" };
      if (publishState.kind === "pushed") {
        return { reason: `Commit is already present on remote refs: ${publishState.refs.join(", ")}`, status: "unavailable" };
      }
      if (publishState.kind === "detached") return { reason: "Detached HEAD is unsafe for an amend.", status: "unavailable" };
      return { reason: publishState.reason, status: "unavailable" };
    } catch (error) {
      return { reason: error instanceof Error ? error.message : String(error), status: "unavailable" };
    }
  }

  /**
   * Rewrites `target` (message, paths and overlays) plus `identityTargets` (overlays only), replaying
   * every later first-parent commit with its original metadata, then publishes all refs atomically.
   * `coAuthors` replaces Co-authored-by trailers on selected commits; `null` strips them.
   */
  async amend({
    coAuthors,
    excludeArcRefs,
    expectedHead,
    identity,
    identityTargets = [],
    message,
    mutatePlan,
    metadataOnly = false,
    paths,
    target,
    targetTree: suppliedTargetTree,
  }: {
    coAuthors?: string[] | null;
    excludeArcRefs?: Iterable<string>;
    expectedHead?: string;
    identity?: WorkbenchGitIdentityOverride;
    identityTargets?: readonly string[];
    /** Replacement message for `target`; omitted keeps its original message exactly. */
    message?: string;
    /** Keep the target tree and publish refs without index normalization. */
    metadataOnly?: boolean;
    mutatePlan?: (context: WorkbenchGitHistoryMutationContext) => Promise<WorkbenchGitHistoryAdditionalMutation>;
    paths: string[];
    target: string;
    targetTree?: string;
  }): Promise<WorkbenchGitHistoryRewriteResult> {
    const { arcRewriter, commits, head, headRef, resolvedTargets } = await this.readAmendRange([target, ...identityTargets]);
    const resolvedTarget = resolvedTargets[0]!;
    if (expectedHead && head !== this.repository.normalizeCommit(expectedHead)) {
      throw new Error("Repository HEAD changed after this amend proposal was created.");
    }
    // Every later commit descends from the oldest, so an unpushed oldest commit proves the whole range unpushed.
    await new GitArcPublishState(this.repository).requireAmendableCommit(commits[0]!.commit);

    const targetIndex = commits.findIndex(({ commit }) => commit === resolvedTarget);
    const targetMetadata = commits[targetIndex]!.metadata;
    const livePaths = metadataOnly
      ? []
      : await this.repository.listWorktreeChangedPaths(head, paths);
    if (!metadataOnly && !livePaths.length) throw new Error("The selected files do not contain any current worktree changes to amend.");
    const targetTree = suppliedTargetTree
      ?? (metadataOnly ? targetMetadata.tree : await this.repository.writeScopedWorktreeTree(paths, resolvedTarget));
    const committedPaths = metadataOnly ? [] : await this.repository.listChangedPaths(resolvedTarget, targetTree, paths);
    if (!metadataOnly && !committedPaths.length) throw new Error("The selected files do not change the amend target.");

    const generation = await this.repository.readRef(GIT_STATE_GENERATION_REF);
    const branchCommits = new Map<string, string>();
    const selected = new Set(resolvedTargets);
    const treeChanged = targetTree !== targetMetadata.tree;
    const now = `${Math.floor(Date.now() / 1000)} +0000`;
    let newParent: string | null = null;
    for (const [index, { commit, metadata }] of commits.entries()) {
      const tree = index === targetIndex
        ? targetTree
        : index > targetIndex && treeChanged
          ? await this.repository.mergeTree(metadata.parents[0]!, newParent!, commit)
          : metadata.tree;
      let commitMessage = index === targetIndex && message !== undefined ? `${message.trim()}\n` : metadata.message;
      if (selected.has(commit) && coAuthors !== undefined) commitMessage = replaceCoAuthorTrailers(commitMessage, coAuthors ?? []);
      const commitIdentity = selected.has(commit) ? { ...metadata, committerDate: now, ...identity } : metadata;
      const rewritten = await this.repository.createCommitFromTree(
        tree,
        newParent ?? metadata.parents,
        commitMessage,
        commitIdentity,
      );
      branchCommits.set(commit, rewritten);
      newParent = rewritten;
    }
    if (!newParent) throw new Error("The amend range is empty.");
    const amendedCommit = branchCommits.get(resolvedTarget)!;
    const amendedCommits = commits
      .filter(({ commit }) => selected.has(commit))
      .map(({ commit }) => ({ commit: branchCommits.get(commit)!, original: commit }));

    const arcPlan = await arcRewriter.prepare(branchCommits, { excludeRefs: excludeArcRefs });
    const additional = mutatePlan ? await mutatePlan({
      amendedCommit,
      arcPlan,
      branchCommits,
      headRef,
      newHead: newParent,
      oldHead: head,
      targetTree,
    }) : null;
    const replacedRefs = new Set(additional?.replaceRefs ?? []);
    const plannedUpdates = [
      { newValue: newParent, oldValue: head, ref: headRef },
      ...arcPlan.updates.filter(({ ref }) => !replacedRefs.has(ref)),
      ...(additional?.updates ?? []),
    ];
    const updatesByRef = new Map<string, (typeof plannedUpdates)[number]>();
    for (const update of plannedUpdates) {
      const existing = updatesByRef.get(update.ref);
      if (existing && (existing.newValue !== update.newValue || existing.oldValue !== update.oldValue)) {
        throw new Error(`Commit rewrite prepared contradictory updates for ${update.ref}.`);
      }
      updatesByRef.set(update.ref, update);
    }
    const plannedDeletes = [
      ...arcPlan.deletes.filter(({ ref }) => !replacedRefs.has(ref)),
      ...(additional?.deletes ?? []),
    ];
    const updateRefs = new Set(updatesByRef.keys());
    const duplicateDelete = plannedDeletes.find(({ ref }) => updateRefs.has(ref));
    if (duplicateDelete) throw new Error(`Commit rewrite prepared both deletion and update for ${duplicateDelete.ref}.`);
    if (metadataOnly) {
      await this.repository.updateRefs([...updatesByRef.values()], plannedDeletes, { expectedStateGeneration: generation });
    } else {
      await this.repository.publishRefsAfterIndexNormalization({
        deletes: plannedDeletes,
        expectedStateGeneration: generation,
        indexCommit: newParent,
        paths: livePaths,
        updates: [...updatesByRef.values()],
      });
    }
    return {
      amendedCommit,
      amendedCommits,
      commit: newParent,
      committedPaths,
      rewrittenCommitCount: branchCommits.size,
      warnings: arcPlan.warnings,
    };
  }
}
