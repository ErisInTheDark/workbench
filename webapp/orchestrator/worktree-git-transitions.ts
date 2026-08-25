/*
 * Exports:
 * - createWorktreeGitTransitions: adapt resolved worktree paths into canonical transition keys. Keywords: git, worktree, transition.
 */
import type WorkbenchThreadTransitionCoordinator from "./WorkbenchThreadTransitionCoordinator";

export function createWorktreeGitTransitions(transitions: Pick<WorkbenchThreadTransitionCoordinator, "run">) {
  const key = (worktreePath: string) => {
    const normalized = worktreePath.trim().replace(/\\/gu, "/").replace(/\/+$/u, "").toLowerCase();
    if (!normalized) throw new Error("A worktree path is required for Git transition coordination.");
    return `git-worktree\0${normalized}`;
  };
  return {
    run: async <TValue>(worktreePath: string, operation: () => Promise<TValue>) => await transitions.run(key(worktreePath), operation),
    runMany: async <TValue>(worktreePaths: readonly string[], operation: () => Promise<TValue>) => {
      const keys = [...new Set(worktreePaths.map(key))].sort((left, right) => left.localeCompare(right));
      const coordinator = transitions as Pick<WorkbenchThreadTransitionCoordinator, "run" | "runMany">;
      if (coordinator.runMany) return await coordinator.runMany(keys, operation);
      const acquire = async (index: number): Promise<TValue> => index >= keys.length
        ? await operation()
        : await transitions.run(keys[index]!, async () => await acquire(index + 1));
      return await acquire(0);
    },
  };
}
