/*
 * Exports:
 * - createWorktreeGitTransitions: adapt resolved worktree paths into canonical transition keys. Keywords: git, worktree, transition.
 */
import type WorkbenchThreadTransitionCoordinator from "./WorkbenchThreadTransitionCoordinator";

export function createWorktreeGitTransitions(
  transitions: Pick<WorkbenchThreadTransitionCoordinator, "run" | "runMany">
    & Partial<Pick<WorkbenchThreadTransitionCoordinator, "read" | "readMany">>,
) {
  const key = (worktreePath: string) => {
    const normalized = worktreePath.trim().replace(/\\/gu, "/").replace(/\/+$/u, "").toLowerCase();
    if (!normalized) throw new Error("A worktree path is required for Git transition coordination.");
    return `git-worktree\0${normalized}`;
  };
  const read = transitions.read?.bind(transitions) ?? transitions.run.bind(transitions);
  const readMany = transitions.readMany?.bind(transitions) ?? transitions.runMany.bind(transitions);
  return {
    read: async <TValue>(worktreePath: string, operation: () => Promise<TValue>) => await read(key(worktreePath), operation),
    readMany: async <TValue>(worktreePaths: readonly string[], operation: () => Promise<TValue>) => {
      const keys = [...new Set(worktreePaths.map(key))].sort((left, right) => left.localeCompare(right));
      return await readMany(keys, operation);
    },
    run: async <TValue>(worktreePath: string, operation: () => Promise<TValue>) => await transitions.run(key(worktreePath), operation),
    runMany: async <TValue>(worktreePaths: readonly string[], operation: () => Promise<TValue>) => {
      const keys = [...new Set(worktreePaths.map(key))].sort((left, right) => left.localeCompare(right));
      return await transitions.runMany(keys, operation);
    },
  };
}
