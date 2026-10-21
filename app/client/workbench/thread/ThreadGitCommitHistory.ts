/*
 * Exports:
 * - ThreadGitCommitDetail: one requested commit's loaded details, or why they are not there.
 * - ThreadGitCommitRefs: one thread's accepted-commit refs, or why they are not there yet.
 * - threadGitCommitHistoryFor: the accepted-commit refs and details shared by every view on one daemon client.
 * - default ThreadGitCommitHistory: load commit refs and details on demand, share reads in flight, and keep what loaded.
 */
import {
  workbenchThreadGitCommitKey,
  type WorkbenchThreadGitCommit,
  type WorkbenchThreadGitCommitRef,
} from "workbench-shared/workbench/thread/thread-state";
import type WorkbenchDaemonClient from "workbench-shared/workbench/daemon/WorkbenchDaemonClient";

type CommitKey = Pick<WorkbenchThreadGitCommitRef, "commitSha" | "rootId">;
interface Reads {
  details: (threadId: string, commits: CommitKey[]) => Promise<readonly WorkbenchThreadGitCommit[]>;
  refs: (threadId: string) => Promise<readonly WorkbenchThreadGitCommitRef[]>;
}

export type ThreadGitCommitDetail =
  | { status: "ready"; commit: WorkbenchThreadGitCommit }
  | { status: "loading" }
  | { status: "failed"; error: string };

export type ThreadGitCommitRefs =
  | { status: "ready"; refs: readonly WorkbenchThreadGitCommitRef[] }
  | { status: "loading" }
  | { status: "failed"; error: string };

/** The revision last asked for, the refs last loaded (possibly for an older revision) and that ask's failure. */
interface RefsEntry {
  failure: string | null;
  refs: readonly WorkbenchThreadGitCommitRef[] | null;
  requested: string;
}

const LOADING = { status: "loading" } as const;

/**
 * Accepted commits never change, so a loaded commit stays loaded; only commits a view asks for (an opened age
 * group) are read, and asking again while a read is in flight reads nothing new; subscribers hear when it lands.
 * A thread's ref list is read once per history revision; views keep the previous list while a newer one loads.
 */
export default class ThreadGitCommitHistory {
  private readonly details = new Map<string, ThreadGitCommitDetail>();
  private readonly refLists = new Map<string, RefsEntry>();
  private readonly listeners = new Set<() => void>();
  private version = 0;

  constructor(
    private readonly reads: Reads,
    /** One report per failed read; rows show a short notice, so the detail goes here. */
    private readonly reportFailure: (message: string) => void = message => console.error("Commit history unavailable:", message),
  ) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  /** Changes whenever any refs or detail change, for `useSyncExternalStore`. */
  getVersion = () => this.version;

  get(threadId: string, commit: CommitKey): ThreadGitCommitDetail {
    return this.details.get(this.key(threadId, commit)) ?? LOADING;
  }

  getRefs(threadId: string): ThreadGitCommitRefs {
    const entry = this.refLists.get(threadId);
    if (entry?.refs) return { status: "ready", refs: entry.refs };
    return entry?.failure ? { status: "failed", error: entry.failure } : LOADING;
  }

  /** Reads the thread's refs unless this revision was already asked for; a failed ask is read again. */
  async loadRefs(threadId: string, revision: string) {
    const current = this.refLists.get(threadId);
    if (current?.requested === revision && !current.failure) return;
    this.refLists.set(threadId, { failure: null, refs: current?.refs ?? null, requested: revision });
    this.changed();
    let next: Pick<RefsEntry, "failure" | "refs">;
    try {
      next = { failure: null, refs: await this.reads.refs(threadId) };
    } catch (error) {
      const message = this.failureMessage(error, "Commit history could not be read.");
      this.reportFailure(message);
      next = { failure: message, refs: this.refLists.get(threadId)?.refs ?? null };
    }
    // A newer revision asked meanwhile owns the entry now; its own read lands there.
    if (this.refLists.get(threadId)?.requested !== revision) return;
    this.refLists.set(threadId, { ...next, requested: revision });
    this.changed();
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
      const loaded = new Map((await this.reads.details(threadId, keys)).map(commit => [this.key(threadId, commit), commit]));
      for (const commit of missing) {
        const key = this.key(threadId, commit);
        const found = loaded.get(key);
        this.details.set(key, found ? { status: "ready", commit: found } : { status: "failed", error: "This commit is no longer recorded." });
      }
    } catch (error) {
      const message = this.failureMessage(error, "Commit details could not be read.");
      this.reportFailure(message);
      for (const commit of missing) this.details.set(this.key(threadId, commit), { status: "failed", error: message });
    }
    this.changed();
  }

  private failureMessage(error: unknown, fallback: string) {
    return (error instanceof Error ? error.message : fallback).replace(/[\u0000-\u001f\u007f-\u009f]/gu, "?").slice(0, 300);
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
    history = new ThreadGitCommitHistory({
      details: async (threadId, commits) => (await daemon.threads.history.gitCommits({ threadId, commits })).data,
      refs: async threadId => (await daemon.threads.history.gitCommitRefs({ threadId })).data,
    });
    histories.set(daemon, history);
  }
  return history;
}
