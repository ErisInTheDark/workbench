/*
 * Exports:
 * - default GitArcRetentionController: expire one resolved thread's refs only after rechecking all actionable work.
 * - GitArcRetentionResult: exact thread-namespace cleanup result.
 */
import GitArcRegistry, { getGitArcLiveClaimPaths } from "./GitArcRegistry";
import GitCheckpointStore from "./GitCheckpointStore";
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

  async canPruneThread({ cwd, harness, threadId }: { cwd: string; harness: GitArcHarness; threadId: string }) {
    const repository = await WorkbenchGitRepository.tryOpen(cwd);
    if (!repository) return true;
    const registry = new GitArcRegistry(repository, this.resolveThreadIdentity);
    const entry = await registry.find({ harness, threadId });
    return !await this.hasActionableState(repository, harness, threadId, entry);
  }

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
    if (await this.hasActionableState(repository, harness, threadId, entry)) {
      throw new Error("Git arc history cannot expire while the thread owns actionable work.");
    }
    const prefixes = [...new Set(gitArcThreadStorageIds(identity).flatMap(storageId => [
      threadNamespace(checkpointNamespace(harness, storageId)),
      threadNamespace(legacyCheckpointNamespace(storageId)),
    ]))];
    // Only the thread's own namespaces; Git matches each prefix up to a slash, never a longer thread id.
    const refs = await repository.listRefsWithValues(...prefixes);
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

  private async hasActionableState(
    repository: WorkbenchGitRepository,
    harness: GitArcHarness,
    threadId: string,
    entry: Awaited<ReturnType<GitArcRegistry["find"]>>,
  ) {
    if (!entry) return false;
    if (entry.savedStash || entry.stackTip) return true;
    if (entry.phase !== "resolved"
      && !(entry.phase === "plan" && !getGitArcLiveClaimPaths(entry).length)) return true;
    const proposals = await new GitCheckpointStore(repository, this.resolveThreadIdentity)
      .readProposalSummaries(harness, threadId, entry.proposalIds ?? []);
    return proposals.some(({ status }) => status === "proposed" || status === "unavailable");
  }
}
