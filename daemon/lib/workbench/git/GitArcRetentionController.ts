/*
 * Exports:
 * - default GitArcRetentionController: remove one continuously settled thread's expired Git arc history without touching live work. Keywords: git, arc, retention, settled, refs.
 * - GitArcRetentionResult: report the exact namespace cleanup performed for one thread. Keywords: prune, refs, registry, count.
 */
import GitArcRegistry from "./GitArcRegistry";
import WorkbenchGitRepository from "./WorkbenchGitRepository";
import {
  checkpointNamespace,
  legacyCheckpointNamespace,
  type GitArcHarness,
} from "workbench-shared/workbench/git/git-arc-storage";

export interface GitArcRetentionResult {
  prunedRefCount: number;
  registryEntryRemoved: boolean;
}

function threadNamespace(namespace: string) {
  return namespace.replace(/\/checkpoints$/u, "");
}

export default class GitArcRetentionController {
  async pruneThread({
    cwd,
    harness,
    threadId,
  }: {
    cwd: string;
    harness: GitArcHarness;
    threadId: string;
  }): Promise<GitArcRetentionResult> {
    const repository = await WorkbenchGitRepository.tryOpen(cwd);
    if (!repository) return { prunedRefCount: 0, registryEntryRemoved: false };
    const registry = new GitArcRegistry(repository);
    const entry = await registry.find({ harness, threadId });
    if (entry && entry.phase !== "resolved") {
      throw new Error("Git arc history cannot expire while the thread owns an active arc or plan.");
    }
    const prefixes = [
      threadNamespace(checkpointNamespace(harness, threadId)),
      threadNamespace(legacyCheckpointNamespace(threadId)),
    ];
    const refs = (await repository.listRefsWithValues("refs/worktree/agents"))
      .filter(({ ref }) => prefixes.some((prefix) => ref.startsWith(`${prefix}/`)));
    const registryMutation = await registry.prepareRelease(
      { harness, threadId },
      entry ? { expectedCheckpointCommit: entry.checkpointCommit } : undefined,
    );
    await repository.updateRefs(
      registryMutation?.update ? [registryMutation.update] : [],
      refs.map(({ ref, value }) => ({ oldValue: value, ref })),
    );
    return {
      prunedRefCount: refs.length,
      registryEntryRemoved: Boolean(registryMutation?.update),
    };
  }
}
