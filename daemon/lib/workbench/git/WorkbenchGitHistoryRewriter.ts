/*
 * Exports:
 * - default WorkbenchGitHistoryRewriter: amend one unpushed commit in a linear local stack without touching worktree files.
 * - WorkbenchGitHistoryRewriteResult: target/tip replacements, committed paths and bounded warnings.
 * - WorkbenchGitCommitAmendability: whether one exact commit can use the history rewriter.
 * - WorkbenchGitPreparedHead: future history used only for read-only presentation.
 * - WorkbenchGitHistoryMutationContext: prepared history and arc changes before atomic publication.
 * - WorkbenchGitHistoryAdditionalMutation: extra ref mutations included in history publication.
 */
import GitArcHistoryRewriter from "./GitArcHistoryRewriter";
import GitArcPublishState from "./GitArcPublishState";
import WorkbenchGitRepository, { GIT_STATE_GENERATION_REF, type GitRefUpdate } from "./WorkbenchGitRepository";
import type { GitArcHistoryRewritePlan } from "./GitArcHistoryRewriter";

export interface WorkbenchGitHistoryRewriteResult {
  amendedCommit: string;
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

  private async readAmendRange(target: string, preparedHead?: WorkbenchGitPreparedHead) {
    const headRef = preparedHead ? preparedHead.ref : await this.repository.symbolicHead();
    if (!headRef) throw new Error("Detached HEAD is unsafe for an amend.");
    const head = preparedHead ? preparedHead.commit : await this.repository.currentHead();
    const arcRewriter = new GitArcHistoryRewriter(this.repository);
    let resolvedTarget = target === head ? head : await this.repository.resolveCommit(target);
    if (resolvedTarget !== head && !await this.repository.isAncestor(resolvedTarget, head)) {
      resolvedTarget = await this.repository.resolveCommit(await arcRewriter.resolveAlias(resolvedTarget));
      if (resolvedTarget !== head && !await this.repository.isAncestor(resolvedTarget, head)) {
        throw new Error("The amend target is not on the current branch history.");
      }
    }
    const range = resolvedTarget === head ? [head] : await this.repository.firstParentRange(resolvedTarget, head);
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
    return { arcRewriter, commits, head, headRef, resolvedTarget };
  }

  async classifyAmendability(target: string, options: {
    preparedHead?: WorkbenchGitPreparedHead;
    refresh?: boolean;
  } = {}): Promise<WorkbenchGitCommitAmendability> {
    try {
      const { resolvedTarget } = await this.readAmendRange(target, options.preparedHead);
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

  async amend({
    excludeArcRefs,
    expectedHead,
    message,
    mutatePlan,
    messageOnly = false,
    paths,
    target,
    targetTree: suppliedTargetTree,
  }: {
    excludeArcRefs?: Iterable<string>;
    expectedHead?: string;
    message: string;
    messageOnly?: boolean;
    mutatePlan?: (context: WorkbenchGitHistoryMutationContext) => Promise<WorkbenchGitHistoryAdditionalMutation>;
    paths: string[];
    target: string;
    targetTree?: string;
  }): Promise<WorkbenchGitHistoryRewriteResult> {
    const { arcRewriter, commits, head, headRef, resolvedTarget } = await this.readAmendRange(target);
    if (expectedHead && head !== this.repository.normalizeCommit(expectedHead)) {
      throw new Error("Repository HEAD changed after this amend proposal was created.");
    }
    await new GitArcPublishState(this.repository).requireAmendableCommit(resolvedTarget);

    const livePaths = messageOnly
      ? []
      : await this.repository.listWorktreeChangedPaths(head, paths);
    if (!messageOnly && !livePaths.length) throw new Error("The selected files do not contain any current worktree changes to amend.");
    const targetTree = suppliedTargetTree
      ?? (messageOnly ? commits[0]!.metadata.tree : await this.repository.writeScopedWorktreeTree(paths, resolvedTarget));
    const committedPaths = messageOnly ? [] : await this.repository.listChangedPaths(resolvedTarget, targetTree, paths);
    if (!messageOnly && !committedPaths.length) throw new Error("The selected files do not change the amend target.");

    const generation = await this.repository.readRef(GIT_STATE_GENERATION_REF);
    const branchCommits = new Map<string, string>();
    const targetMetadata = commits[0]!.metadata;
    const now = `${Math.floor(Date.now() / 1000)} +0000`;
    const amendedCommit = await this.repository.createCommitFromTree(
      targetTree,
      targetMetadata.parents,
      `${message.trim()}\n`,
      { ...targetMetadata, committerDate: now },
    );
    branchCommits.set(resolvedTarget, amendedCommit);
    let newParent = amendedCommit;
    for (const { commit, metadata } of commits.slice(1)) {
      const oldParent = metadata.parents[0]!;
      const tree = targetTree === targetMetadata.tree
        ? metadata.tree
        : await this.repository.mergeTree(oldParent, newParent, commit);
      const rewritten = await this.repository.createCommitFromTree(tree, newParent, metadata.message, metadata);
      branchCommits.set(commit, rewritten);
      newParent = rewritten;
    }

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
    if (messageOnly) {
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
      commit: newParent,
      committedPaths,
      rewrittenCommitCount: branchCommits.size,
      warnings: arcPlan.warnings,
    };
  }
}
