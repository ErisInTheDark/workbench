/*
 * Exports:
 * - default WorkbenchGitIntegration: bring an incoming commit into the current branch by fast-forward or rewriter-aware
 *   replay of local first-parent commits, predicted in memory and published atomically with every Workbench ref.
 * - WorkbenchGitIntegrationPlan: one prepared integration (current, fastForward, replay or blocked) with its counts.
 */
import GitArcHistoryRewriter, { type GitArcHistoryRewritePlan } from "./GitArcHistoryRewriter";
import GitArcPublishState from "./GitArcPublishState";
import WorkbenchGitRepository, { GIT_STATE_GENERATION_REF } from "./WorkbenchGitRepository";

interface PlanFacts {
  ahead: number;
  behind: number;
  /** Paths incoming changes relative to the merge base. */
  incomingPaths: string[];
}

export type WorkbenchGitIntegrationPlan = PlanFacts & (
  | { kind: "current" }
  | { kind: "blocked"; conflicts: string[]; reason: string | null }
  | {
    kind: "fastForward" | "replay";
    headRef: string;
    oldHead: string;
    newHead: string;
    generation: string | null;
    arcPlan: GitArcHistoryRewritePlan | null;
  }
);

function dirtyPaths(status: string) {
  const entries = status.split("\0");
  const paths: string[] = [];
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (!entry) continue;
    paths.push(entry.slice(3));
    // Porcelain -z writes destination first and source as a second NUL record.
    if (/[RC]/u.test(entry.slice(0, 2))) {
      const source = entries[++index];
      if (source) paths.push(source);
    }
  }
  return paths;
}

function overlaps(left: string, right: string) {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

export default class WorkbenchGitIntegration {
  constructor(private readonly repository: WorkbenchGitRepository) {}

  /** Reads and writes objects only: worktree, index, HEAD and refs stay untouched. */
  async prepare(incoming: string): Promise<WorkbenchGitIntegrationPlan> {
    const repository = this.repository;
    const target = await repository.resolveCommit(incoming);
    const headRef = await repository.symbolicHead();
    const oldHead = await repository.currentHead();
    const [ahead, behind] = (await repository.run(["rev-list", "--left-right", "--count", `${oldHead}...${target}`]))
      .trim().split(/\s+/u).map(Number);
    if (!Number.isInteger(ahead) || !Number.isInteger(behind)) throw new Error("Invalid integration commit counts.");
    const incomingPaths = (await repository.run(["diff", "--name-only", "-z", `${oldHead}...${target}`]))
      .split("\0").filter(Boolean);
    const facts: PlanFacts = { ahead: ahead!, behind: behind!, incomingPaths };
    if (!behind) return { ...facts, kind: "current" };
    const blocked = (conflicts: string[], reason: string | null = null): WorkbenchGitIntegrationPlan =>
      ({ ...facts, kind: "blocked", conflicts, reason });
    if (!headRef) return blocked([], "Detached HEAD cannot integrate incoming commits.");

    const dirty = dirtyPaths(await repository.run(["status", "--porcelain=v1", "-z", "--untracked-files=all"]));
    const dirtyOverlaps = dirty.filter(local => incomingPaths.some(remote => overlaps(local, remote)));
    if (dirtyOverlaps.length) return blocked([...new Set(dirtyOverlaps)]);

    const generation = await repository.readRef(GIT_STATE_GENERATION_REF);
    if (!ahead) return { ...facts, kind: "fastForward", headRef, oldHead, newHead: target, generation, arcPlan: null };

    const base = (await repository.run(["merge-base", oldHead, target])).trim();
    const local = await repository.listFirstParentRange(`${base}..${oldHead}`);
    const batch = await repository.readCommits(local);
    const commits = local.map(commit => {
      const metadata = batch.commits.get(commit);
      if (!metadata) throw new Error(batch.errors.get(commit) ?? `Unable to read commit metadata for ${commit}.`);
      return { commit, metadata };
    });
    if (commits.length !== ahead || commits.some(({ metadata }) => metadata.parents.length > 1)) {
      return blocked([], "Local commits include merges, so they cannot be replayed onto incoming commits.");
    }
    if (commits.some(({ metadata }) => metadata.signed)) {
      return blocked([], "Local commits are signed, so replaying them would drop their signatures.");
    }
    // Every later commit descends from the oldest, so an unpublished oldest commit proves the whole range unpublished.
    const published = await new GitArcPublishState(repository).classifyCommit(commits[0]!.commit, { refresh: false });
    if (published.kind === "pushed") {
      return blocked([], `Local commits are already published on ${published.refs.join(", ")}; replaying would rewrite them.`);
    }
    if (published.kind !== "unpushed") return blocked([], published.kind === "unknown" ? published.reason : null);

    const branchCommits = new Map<string, string>();
    let parent = target;
    for (const { commit, metadata } of commits) {
      const merged = await repository.mergeWorktreeTrees(metadata.parents[0]!, parent, commit);
      if (merged.conflictedPaths.length || merged.unsupportedConflictTypes.length) return blocked(merged.conflictedPaths);
      parent = await repository.createCommitFromTree(merged.tree, parent, metadata.message, metadata);
      branchCommits.set(commit, parent);
    }
    const arcPlan = await new GitArcHistoryRewriter(repository).prepare(branchCommits);
    return { ...facts, kind: "replay", headRef, oldHead, newHead: parent, generation, arcPlan };
  }

  /** Publish a prepared fast-forward or replay. Callers hold the worktree Git transition for prepare and apply. */
  async apply(plan: WorkbenchGitIntegrationPlan) {
    if (plan.kind !== "fastForward" && plan.kind !== "replay") throw new Error("Integration plan has nothing to apply.");
    const repository = this.repository;
    if (await repository.currentHead() !== plan.oldHead
      || await repository.readRef(GIT_STATE_GENERATION_REF) !== plan.generation) {
      throw new Error("Repository changed after the integration was prepared.");
    }
    await repository.checkoutTreeTransition(plan.oldHead, plan.newHead);
    try {
      await repository.updateRefs([
        { ref: plan.headRef, newValue: plan.newHead, oldValue: plan.oldHead },
        ...plan.arcPlan?.updates ?? [],
      ], plan.arcPlan?.deletes ?? [], { expectedStateGeneration: plan.generation });
    } catch (publicationError) {
      try {
        await repository.checkoutTreeTransition(plan.newHead, plan.oldHead);
      } catch (rollbackError) {
        throw new AggregateError([publicationError, rollbackError],
          "Integration ref publication failed and the worktree could not be restored.");
      }
      throw publicationError;
    }
    return { fromSha: plan.oldHead, toSha: plan.newHead, warnings: plan.arcPlan?.warnings ?? [] };
  }
}
