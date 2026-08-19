/*
 * Exports:
 * - default GitArcPublishState: own coalesced remote refresh and conservative amend-target publication checks. Keywords: git, arc, publish, remote, amend.
 * - GitArcCommitPublishState: classify whether a commit is safe to amend. Keywords: git, commit, pushed, unpushed.
 */
import WorkbenchGitRepository from "./WorkbenchGitRepository";

export type GitArcCommitPublishState =
  | { kind: "detached" }
  | { kind: "pushed"; refs: string[] }
  | { kind: "unknown"; reason: string }
  | { kind: "unpushed" };

const refreshes = new Map<string, Promise<void>>();

export default class GitArcPublishState {
  constructor(private readonly repository: WorkbenchGitRepository) {}

  private async refreshRemotes() {
    const existing = refreshes.get(this.repository.root);
    if (existing) return await existing;
    const refresh = this.repository.fetchRemotes().finally(() => {
      if (refreshes.get(this.repository.root) === refresh) refreshes.delete(this.repository.root);
    });
    refreshes.set(this.repository.root, refresh);
    return await refresh;
  }

  async classifyCurrentHead({ refresh = true }: { refresh?: boolean } = {}): Promise<GitArcCommitPublishState> {
    const headRef = await this.repository.symbolicHead();
    if (!headRef) return { kind: "detached" };
    const remotes = await this.repository.remotes();
    if (!remotes.length) return { kind: "unpushed" };
    if (refresh) {
      try {
        await this.refreshRemotes();
      } catch (error) {
        return {
          kind: "unknown",
          reason: `Unable to refresh remote refs: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }
    const head = await this.repository.currentHead();
    const containingRefs: string[] = [];
    for (const ref of await this.repository.listRefs("refs/remotes")) {
      if (await this.repository.refContainsCommit(ref, head)) containingRefs.push(ref);
    }
    return containingRefs.length ? { kind: "pushed", refs: containingRefs } : { kind: "unpushed" };
  }

  async requireAmendableCurrentHead(options: { refresh?: boolean } = {}) {
    const state = await this.classifyCurrentHead(options);
    if (state.kind === "unpushed") return;
    if (state.kind === "detached") throw new Error("Detached HEAD is unsafe for an amend proposal.");
    if (state.kind === "pushed") {
      throw new Error(`Current HEAD is already present on remote refs: ${state.refs.join(", ")}`);
    }
    throw new Error(state.reason);
  }
}
