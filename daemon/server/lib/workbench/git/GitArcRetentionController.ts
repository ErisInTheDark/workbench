/*
 * Exports:
 * - default GitArcRetentionController: expire one settled thread's canonical and compatible refs without touching live work.
 * - GitArcRetentionResult: exact thread-namespace cleanup result.
 */
import GitArcRegistry from "./GitArcRegistry";
import WorkbenchGitRepository from "./WorkbenchGitRepository";
import {
  checkpointNamespace,
  legacyCheckpointNamespace,
  type GitArcHarness,
} from "workbench-shared/workbench/git/git-arc-storage";
import {
  gitArcThreadStorageIds,
  passthroughGitArcThreadIdentityResolver,
  type GitArcThreadIdentityResolver,
} from "./git-arc-thread-identity";

export interface GitArcRetentionResult {
  prunedRefCount: number;
  registryEntryRemoved: boolean;
}

function threadNamespace(namespace: string) {
  return namespace.replace(/\/checkpoints$/u, "");
}

export default class GitArcRetentionController {
  constructor(
    private readonly resolveThreadIdentity: GitArcThreadIdentityResolver = passthroughGitArcThreadIdentityResolver,
  ) {}

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
    const identity = await this.resolveThreadIdentity({ harness, repositoryRoot: repository.root, threadId });
    if (!identity) throw new Error("The Git arc owner identity is unavailable.");
    const registry = new GitArcRegistry(repository, this.resolveThreadIdentity);
    const entry = await registry.find({ harness, threadId });
    if (entry && entry.phase !== "resolved") {
      throw new Error("Git arc history cannot expire while the thread owns an active arc or plan.");
    }
    const prefixes = [...new Set(gitArcThreadStorageIds(identity).flatMap(storageId => [
      threadNamespace(checkpointNamespace(harness, storageId)),
      threadNamespace(legacyCheckpointNamespace(storageId)),
    ]))];
    const refs = (await repository.listRefsWithValues("refs/worktree/agents"))
      .filter(({ ref }) => prefixes.some((prefix) => ref.startsWith(`${prefix}/`)));
    const registryMutation = await registry.prepareRelease(
      { harness, threadId },
      entry ? { expectedCheckpointCommit: entry.checkpointCommit } : undefined,
    );
    await repository.updateRefs(
      registryMutation?.updates ?? [],
      refs.map(({ ref, value }) => ({ oldValue: value, ref })),
    );
    return {
      prunedRefCount: refs.length,
      registryEntryRemoved: Boolean(registryMutation?.updates.length),
    };
  }
}
