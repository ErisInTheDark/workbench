/*
 * Exports:
 * - default WorkbenchGitIntegration: prepare fast-forward, merge or protected replay in memory and publish atomically
 *   with affected Workbench refs; report whether local commits may be replayed.
 * - WorkbenchGitIntegrationPlan: one prepared integration (current, fastForward, replay, merge or blocked) with its counts.
 * - listDirtyPaths: every dirty or untracked worktree path, rename sources included.
 */
import GitArcHistoryRewriter, { type GitArcHistoryRewritePlan } from "./GitArcHistoryRewriter";
import GitArcPublishState from "./GitArcPublishState";
import WorkbenchGitRepository, { GIT_STATE_GENERATION_REF, type GitCommitIdentity } from "./WorkbenchGitRepository";

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
    /** `merge` adds one merge commit over HEAD, so no existing commit is rewritten. */
    kind: "fastForward" | "replay" | "merge";
    headRef: string;
    oldHead: string;
    newHead: string;
    generation: string | null;
    arcPlan: GitArcHistoryRewritePlan | null;
  }
);

/** Every dirty or untracked path, rename sources included, in one porcelain read. */
export async function listDirtyPaths(repository: WorkbenchGitRepository) {
  return dirtyPaths(await repository.run(["status", "--porcelain=v1", "-z", "--untracked-files=all"]));
}

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
  async prepare(incoming: string, mode: "replay" | "merge" | "fastForward" = "replay"): Promise<WorkbenchGitIntegrationPlan> {
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

    const dirty = await listDirtyPaths(repository);
    const dirtyOverlaps = dirty.filter(local => incomingPaths.some(remote => overlaps(local, remote)));
    if (dirtyOverlaps.length) return blocked([...new Set(dirtyOverlaps)], "Uncommitted changes overlap incoming files.");

    const generation = await repository.readRef(GIT_STATE_GENERATION_REF);
    if (!ahead) return { ...facts, kind: "fastForward", headRef, oldHead, newHead: target, generation, arcPlan: null };
    if (mode === "fastForward") return blocked([], "The receiving branch has diverged; refresh and try again.");
    if (mode === "merge") {
      const base = (await repository.run(["merge-base", oldHead, target])).trim();
      const merged = await repository.mergeWorktreeTrees(base, oldHead, target);
      if (merged.conflictedPaths.length || merged.unsupportedConflictTypes.length) {
        return blocked(merged.conflictedPaths, "Committed changes conflict and need resolution.");
      }
      const newHead = await repository.createCommitFromTree(merged.tree, [oldHead, target],
        `merge incoming work into ${headRef.slice("refs/heads/".length)}`);
      return { ...facts, kind: "merge", headRef, oldHead, newHead, generation, arcPlan: null };
    }

    const replayable = await this.replayable(oldHead, target);
    if (replayable.kind === "blocked") return blocked([], replayable.reason);
    const commits = replayable.commits;

    const branchCommits = new Map<string, string>();
    let parent = target;
    for (const { commit, metadata } of commits) {
      const merged = await repository.mergeWorktreeTrees(metadata.parents[0]!, parent, commit);
      if (merged.conflictedPaths.length || merged.unsupportedConflictTypes.length) {
        return blocked(merged.conflictedPaths, "Replaying local commits conflicts and needs resolution.");
      }
      parent = await repository.createCommitFromTree(merged.tree, parent, metadata.message, metadata);
      branchCommits.set(commit, parent);
    }
    const arcPlan = await new GitArcHistoryRewriter(repository).prepare(branchCommits);
    return { ...facts, kind: "replay", headRef, oldHead, newHead: parent, generation, arcPlan };
  }

  /**
   * Local first-parent commits since the merge base with `target`, oldest first, when replaying them is safe: no merges,
   * no signatures and none held by any `refs/remotes` ref (a configured remote or a peer daemon).
   */
  async replayable(oldHead: string, target: string): Promise<
    { kind: "replayable"; base: string; commits: Array<{ commit: string; metadata: GitCommitIdentity }> }
    | { kind: "blocked"; reason: string | null }
  > {
    const repository = this.repository;
    const base = (await repository.run(["merge-base", oldHead, target])).trim();
    const local = await repository.listFirstParentRange(`${base}..${oldHead}`);
    const ahead = Number((await repository.run(["rev-list", "--count", `${base}..${oldHead}`])).trim());
    const batch = await repository.readCommits(local);
    const commits = local.map(commit => {
      const metadata = batch.commits.get(commit);
      if (!metadata) throw new Error(batch.errors.get(commit) ?? `Unable to read commit metadata for ${commit}.`);
      return { commit, metadata };
    });
    if (commits.length !== ahead || commits.some(({ metadata }) => metadata.parents.length > 1)) {
      return { kind: "blocked", reason: "Local commits include merges, so they cannot be replayed onto incoming commits." };
    }
    if (commits.some(({ metadata }) => metadata.signed)) {
      return { kind: "blocked", reason: "Local commits are signed, so replaying them would drop their signatures." };
    }
    if (!commits.length) return { kind: "replayable", base, commits };
    // Every later commit descends from the oldest, so an unpublished oldest commit proves the whole range unpublished.
    const published = await new GitArcPublishState(repository).classifyCommit(commits[0]!.commit, { refresh: false });
    if (published.kind === "pushed") {
      return { kind: "blocked", reason: `Local commits are already published on ${published.refs.join(", ")}; replaying would rewrite them.` };
    }
    if (published.kind !== "unpushed") return { kind: "blocked", reason: published.kind === "unknown" ? published.reason : null };
    return { kind: "replayable", base, commits };
  }

  /** Publish a prepared fast-forward, replay or merge. Callers hold the worktree Git transition for prepare and apply. */
  async apply(plan: WorkbenchGitIntegrationPlan) {
    if (plan.kind !== "fastForward" && plan.kind !== "replay" && plan.kind !== "merge") {
      throw new Error("Integration plan has nothing to apply.");
    }
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
