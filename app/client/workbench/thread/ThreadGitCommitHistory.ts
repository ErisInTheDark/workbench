/*
 * Exports:
 * - ThreadGitCommitDetail: one requested commit's loaded details, or why they are not there.
 * - threadGitCommitHistoryFor: the accepted-commit details shared by every view on one daemon client.
 * - default ThreadGitCommitHistory: load commit details on demand, share reads in flight, and keep loaded commits.
 */
import {
  workbenchThreadGitCommitKey,
  type WorkbenchThreadGitCommit,
  type WorkbenchThreadGitCommitRef,
} from "workbench-shared/workbench/thread/thread-state";
import type WorkbenchDaemonClient from "workbench-shared/workbench/daemon/WorkbenchDaemonClient";

type CommitKey = Pick<WorkbenchThreadGitCommitRef, "commitSha" | "rootId">;
type Read = (threadId: string, commits: CommitKey[]) => Promise<readonly WorkbenchThreadGitCommit[]>;

export type ThreadGitCommitDetail =
  | { status: "ready"; commit: WorkbenchThreadGitCommit }
  | { status: "loading" }
  | { status: "failed"; error: string };

const LOADING: ThreadGitCommitDetail = { status: "loading" };

/**
 * Accepted commits never change, so a loaded commit stays loaded; only commits a view asks for (an opened age
 * group) are read, and asking again while a read is in flight reads nothing new; subscribers hear when it lands.
 */
export default class ThreadGitCommitHistory {
  private readonly details = new Map<string, ThreadGitCommitDetail>();
  private readonly listeners = new Set<() => void>();
  private version = 0;

  constructor(private readonly read: Read) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  /** Changes whenever any detail changes, for `useSyncExternalStore`. */
  getVersion = () => this.version;

  get(threadId: string, commit: CommitKey): ThreadGitCommitDetail {
    return this.details.get(this.key(threadId, commit)) ?? LOADING;
  }

  /** Reads the commits not yet loaded or loading; failed ones are read again. */
  async load(threadId: string, commits: readonly CommitKey[]) {
    const missing = commits.filter(commit => {
      const detail = this.details.get(this.key(threadId, commit));
      return !detail || detail.status === "failed";
    });
    if (!missing.length) return;
    for (const commit of missing) this.details.set(this.key(threadId, commit), LOADING);
    this.changed();
    try {
      const keys = missing.map(({ commitSha, rootId }) => ({ commitSha, rootId }));
      const loaded = new Map((await this.read(threadId, keys)).map(commit => [this.key(threadId, commit), commit]));
      for (const commit of missing) {
        const key = this.key(threadId, commit);
        const found = loaded.get(key);
        this.details.set(key, found ? { status: "ready", commit: found } : { status: "failed", error: "This commit is no longer recorded." });
      }
    } catch (error) {
      const message = (error instanceof Error ? error.message : "Commit details could not be read.")
        .replace(/[\u0000-\u001f\u007f-\u009f]/gu, "?").slice(0, 300);
      for (const commit of missing) this.details.set(this.key(threadId, commit), { status: "failed", error: message });
    }
    this.changed();
  }

  private key(threadId: string, commit: CommitKey) {
    return `${threadId}\0${workbenchThreadGitCommitKey(commit)}`;
  }

  private changed() {
    this.version += 1;
    for (const listener of [...this.listeners]) listener();
  }
}

const histories = new WeakMap<WorkbenchDaemonClient, ThreadGitCommitHistory>();

export function threadGitCommitHistoryFor(daemon: WorkbenchDaemonClient) {
  let history = histories.get(daemon);
  if (!history) {
    history = new ThreadGitCommitHistory(async (threadId, commits) =>
      (await daemon.threads.history.gitCommits({ threadId, commits })).data);
    histories.set(daemon, history);
  }
  return history;
}
