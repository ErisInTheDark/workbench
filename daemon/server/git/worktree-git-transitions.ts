/*
 * Exports:
 * - createWorktreeGitTransitions: adapt resolved worktree paths into canonical transition keys, plus per-thread Git ownership leases.
 */
import { normalizePathKey } from "../lib/comparable-path";
import type WorkbenchThreadTransitionCoordinator from "../turn/WorkbenchThreadTransitionCoordinator";

export function createWorktreeGitTransitions(
  transitions: Pick<WorkbenchThreadTransitionCoordinator, "run" | "runMany">
    & Partial<Pick<WorkbenchThreadTransitionCoordinator, "read" | "readMany">>,
  platform: NodeJS.Platform = process.platform,
) {
  const key = (worktreePath: string) => {
    const normalized = normalizePathKey(worktreePath.trim(), platform);
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
    /**
     * Exclusive Git ownership of Workbench threads across every repository: settlement and claim transfers into or out of
     * a thread serialize here, never on unrelated worktree writes. Take it before any worktree lease.
     */
    ownership: async <TValue>(threadIds: readonly string[], operation: () => Promise<TValue>) => {
      const keys = [...new Set(threadIds.map(threadId => `git-arc-owner\0${threadId}`))].sort((left, right) => left.localeCompare(right));
      return await transitions.runMany(keys, operation);
    },
  };
}
