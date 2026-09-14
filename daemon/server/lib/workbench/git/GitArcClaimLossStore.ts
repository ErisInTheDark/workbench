/*
 * Exports:
 * - default GitArcClaimLossStore: write canonical and read canonical-first compatible claim-loss snapshots.
 */
import { GitArcClaimLossSchema, type GitArcClaimLoss } from "workbench-shared/workbench/git/git-arc-status";
import { ProviderKeySchema } from "workbench-shared/workbench/provider/provider-key";
import { normalizeThreadId } from "workbench-shared/workbench/git/git-arc-storage";
import WorkbenchGitRepository, { type GitRefUpdate, type GitWorktreeSnapshot } from "./WorkbenchGitRepository";
import {
  gitArcThreadStorageIds,
  passthroughGitArcThreadIdentityResolver,
  type GitArcThreadIdentityResolver,
} from "./git-arc-thread-identity";

interface Identity { harness: string; threadId: string }

export default class GitArcClaimLossStore {
  constructor(
    private readonly repository: WorkbenchGitRepository,
    private readonly resolveThreadIdentity: GitArcThreadIdentityResolver = passthroughGitArcThreadIdentityResolver,
  ) {}

  private ref(identity: Identity) {
    if (!ProviderKeySchema.safeParse(identity.harness).success) throw new Error("Invalid claim-loss harness.");
    return `refs/worktree/agents/${identity.harness}/${normalizeThreadId(identity.threadId)}/claim-loss`;
  }

  private async identity(identity: Identity) {
    const resolved = await this.resolveThreadIdentity({
      harness: identity.harness,
      repositoryRoot: this.repository.root,
      threadId: identity.threadId,
    });
    if (!resolved) throw new Error("The Git arc owner identity is unavailable.");
    return resolved;
  }

  async prepare(identity: Identity, paths: string[], snapshot?: GitWorktreeSnapshot): Promise<GitRefUpdate> {
    const boundary = snapshot ?? await this.repository.writeWorktreeSnapshot();
    const metadata: GitArcClaimLoss = GitArcClaimLossSchema.parse({ version: 1, paths, head: boundary.head });
    const commit = await this.repository.createCommitFromTree(boundary.tree, boundary.head, JSON.stringify(metadata));
    const ref = this.ref({ ...identity, threadId: (await this.identity(identity)).threadId });
    return { newValue: commit, oldValue: await this.repository.readRef(ref) ?? "0".repeat(40), ref };
  }

  async read(identity: Identity) {
    const refs = gitArcThreadStorageIds(await this.identity(identity))
      .map(threadId => this.ref({ ...identity, threadId }));
    let selected: { commit: string; ref: string } | null = null;
    for (const ref of refs) {
      const commit = await this.repository.readRef(ref);
      if (commit) {
        selected = { commit, ref };
        break;
      }
    }
    if (!selected) return null;
    const { commit, ref } = selected;
    const batch = await this.repository.readCommits([commit]);
    const stored = batch.commits.get(commit);
    if (!stored) throw new Error("The claim-loss snapshot is unreadable.");
    const metadata = GitArcClaimLossSchema.parse(JSON.parse(stored.message));
    if ((stored.parents[0] ?? null) !== metadata.head || stored.parents.length > 1) throw new Error("Invalid claim-loss snapshot parent.");
    return { ...metadata, commit, ref, tree: stored.tree };
  }
}
