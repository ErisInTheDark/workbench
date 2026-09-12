/*
 * Exports:
 * - default GitArcClaimLossStore: prepare and read exact thread-owned claim-loss snapshots.
 */
import { GitArcClaimLossSchema, type GitArcClaimLoss } from "workbench-shared/workbench/git/git-arc-status";
import { normalizeThreadId } from "workbench-shared/workbench/git/git-arc-storage";
import WorkbenchGitRepository, { type GitRefUpdate, type GitWorktreeSnapshot } from "./WorkbenchGitRepository";

interface Identity { harness: string; threadId: string }

export default class GitArcClaimLossStore {
  constructor(private readonly repository: WorkbenchGitRepository) {}

  private ref(identity: Identity) {
    if (!["codex", "copilot", "opencode"].includes(identity.harness)) throw new Error("Invalid claim-loss harness.");
    return `refs/worktree/agents/${identity.harness}/${normalizeThreadId(identity.threadId)}/claim-loss`;
  }

  async prepare(identity: Identity, paths: string[], snapshot?: GitWorktreeSnapshot): Promise<GitRefUpdate> {
    const boundary = snapshot ?? await this.repository.writeWorktreeSnapshot();
    const metadata: GitArcClaimLoss = GitArcClaimLossSchema.parse({ version: 1, paths, head: boundary.head });
    const commit = await this.repository.createCommitFromTree(boundary.tree, boundary.head, JSON.stringify(metadata));
    const ref = this.ref(identity);
    return { newValue: commit, oldValue: await this.repository.readRef(ref) ?? "0".repeat(40), ref };
  }

  async read(identity: Identity) {
    const ref = this.ref(identity);
    const commit = await this.repository.readRef(ref);
    if (!commit) return null;
    const batch = await this.repository.readCommits([commit]);
    const stored = batch.commits.get(commit);
    if (!stored) throw new Error("The claim-loss snapshot is unreadable.");
    const metadata = GitArcClaimLossSchema.parse(JSON.parse(stored.message));
    if ((stored.parents[0] ?? null) !== metadata.head || stored.parents.length > 1) throw new Error("Invalid claim-loss snapshot parent.");
    return { ...metadata, commit, ref, tree: stored.tree };
  }
}
