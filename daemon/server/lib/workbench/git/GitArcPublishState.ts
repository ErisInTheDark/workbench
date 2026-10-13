/*
 * Exports:
 * - default GitArcPublishState: own coalesced remote refresh, publication classification and the unpushed-amend requirement.
 * - GitArcCommitPublishState: whether a commit is pushed, unpushed or unknown.
 */
import WorkbenchGitRepository from "./WorkbenchGitRepository";
import { GitArcRejectionError } from "workbench-shared/workbench/git/git-arc-rejections";

export type GitArcCommitPublishState =
  | { kind: "pushed"; refs: string[] }
  | { kind: "unknown"; reason: string }
  | { kind: "unpushed" };

const refreshes = new Map<string, Promise<void>>();

export default class GitArcPublishState {
  constructor(private readonly repository: WorkbenchGitRepository) {}

  /** Reject every state except `unpushed`. */
  static requireUnpushed(state: GitArcCommitPublishState) {
    if (state.kind === "unpushed") return;
    if (state.kind === "pushed") throw new GitArcRejectionError({ reason: "publishedCommit", refs: state.refs }, `Commit is already present on remote refs: ${state.refs.join(", ")}`);
    throw new Error(state.reason);
  }

  private async refreshRemotes() {
    const existing = refreshes.get(this.repository.root);
    if (existing) return await existing;
    const refresh = this.repository.fetchRemotes().finally(() => {
      if (refreshes.get(this.repository.root) === refresh) refreshes.delete(this.repository.root);
    });
    refreshes.set(this.repository.root, refresh);
    return await refresh;
  }

  async classifyCommit(commit: string, { refresh = true }: { refresh?: boolean } = {}): Promise<GitArcCommitPublishState> {
    // Peer daemons write refs/remotes/wb-* without any configured remote, so containment is checked regardless.
    if (refresh && (await this.repository.remotes()).length) {
      try {
        await this.refreshRemotes();
      } catch (error) {
        return {
          kind: "unknown",
          reason: `Unable to refresh remote refs: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }
    const containingRefs = await this.repository.listRefsContaining(commit, "refs/remotes");
    return containingRefs.length ? { kind: "pushed", refs: containingRefs } : { kind: "unpushed" };
  }

  async requireAmendableCommit(commit: string, options: { refresh?: boolean } = {}) {
    GitArcPublishState.requireUnpushed(await this.classifyCommit(commit, options));
  }
}
