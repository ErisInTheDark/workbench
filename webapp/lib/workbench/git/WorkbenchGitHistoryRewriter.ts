/*
 * Exports:
 * - default WorkbenchGitHistoryRewriter: amend one unpushed commit in a linear local stack without touching worktree files. Keywords: git, amend, history, plumbing.
 * - WorkbenchGitHistoryRewriteResult: report target/tip replacements, committed paths, and bounded warnings. Keywords: git, commit, sha, result.
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

export interface WorkbenchGitHistoryMutationContext {
  amendedCommit: string;
  arcPlan: GitArcHistoryRewritePlan;
  branchCommits: ReadonlyMap<string, string>;
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

  async amend({
    excludeArcRefs,
    expectedHead,
    message,
    mutatePlan,
    paths,
    target,
    targetTree: suppliedTargetTree,
  }: {
    excludeArcRefs?: Iterable<string>;
    expectedHead?: string;
    message: string;
    mutatePlan?: (context: WorkbenchGitHistoryMutationContext) => Promise<WorkbenchGitHistoryAdditionalMutation>;
    paths: string[];
    target: string;
    targetTree?: string;
  }): Promise<WorkbenchGitHistoryRewriteResult> {
    const headRef = await this.repository.symbolicHead();
    if (!headRef) throw new Error("Detached HEAD is unsafe for an amend.");
    const head = await this.repository.currentHead();
    if (expectedHead && head !== this.repository.normalizeCommit(expectedHead)) {
      throw new Error("Repository HEAD changed after this amend proposal was created.");
    }
    const arcRewriter = new GitArcHistoryRewriter(this.repository);
    let resolvedTarget = await this.repository.resolveCommit(target);
    if (!await this.repository.isAncestor(resolvedTarget, head)) {
      resolvedTarget = await this.repository.resolveCommit(await arcRewriter.resolveAlias(resolvedTarget));
    }
    const range = await this.repository.firstParentRange(resolvedTarget, head);
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
    await new GitArcPublishState(this.repository).requireAmendableCommit(resolvedTarget);

    const liveTree = await this.repository.writeScopedWorktreeTree(paths, head);
    const livePaths = await this.repository.listChangedPaths(head, liveTree, paths);
    if (!livePaths.length) throw new Error("The selected files do not contain any current worktree changes to amend.");
    const targetTree = suppliedTargetTree ?? await this.repository.writeScopedWorktreeTree(paths, resolvedTarget);
    const committedPaths = await this.repository.listChangedPaths(resolvedTarget, targetTree, paths);
    if (!committedPaths.length) throw new Error("The selected files do not change the amend target.");

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
      const tree = await this.repository.mergeTree(oldParent, newParent, commit);
      const rewritten = await this.repository.createCommitFromTree(tree, newParent, metadata.message, metadata);
      branchCommits.set(commit, rewritten);
      newParent = rewritten;
    }

    const arcPlan = await arcRewriter.prepare(branchCommits, { excludeRefs: excludeArcRefs });
    const additional = mutatePlan ? await mutatePlan({
      amendedCommit,
      arcPlan,
      branchCommits,
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
    await this.repository.publishRefsAfterIndexNormalization({
      deletes: plannedDeletes,
      expectedStateGeneration: generation,
      indexCommit: newParent,
      paths: livePaths,
      updates: [...updatesByRef.values()],
    });
    return {
      amendedCommit,
      commit: newParent,
      committedPaths,
      rewrittenCommitCount: branchCommits.size,
      warnings: arcPlan.warnings,
    };
  }
}
