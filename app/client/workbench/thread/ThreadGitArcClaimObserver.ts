/*
 * Exports:
 * - ThreadGitArcClaimObservation: source-local loading, loaded (with refreshing), or failed state of a thread's claimed-file changes.
 * - ThreadGitArcClaimObserverPorts: claim comparison read, refresh trigger and change notification.
 * - default ThreadGitArcClaimObserver: own the demanded claim comparison for one thread: reads on claim changes and refreshes, with stale-read fencing.
 */
import {
  createGitArcOperationRejected,
  GitArcFailureException,
  type GitArcFailure,
} from "workbench-shared/workbench/git/git-arc-failures";
import type { WorkbenchHarness } from "workbench-shared/types";
import type { WorkbenchThreadSidebarEntry } from "workbench-shared/workbench/thread/thread-state";

type ThreadEntry = Exclude<WorkbenchThreadSidebarEntry, { entryKind: "draft" }>;
export type ThreadGitArcClaimObservation =
  | { failure: GitArcFailure; status: "failed" }
  | { changeCount: number; hasUncommittedChanges: boolean; refreshing?: true; status: "loaded" }
  | { status: "loading" };

export interface ThreadGitArcClaimObserverPorts {
  compare?: (input: { cwd: string; harness: WorkbenchHarness; threadId: string }) => Promise<{ changeCount: number; hasUncommittedChanges: boolean }>;
  subscribeRefresh?: (listener: () => void) => () => void;
  /** A read settled or a refresh was requested; the owner re-syncs and republishes. */
  changed: () => void;
  isLive: () => boolean;
}

export default class ThreadGitArcClaimObserver {
  private demands = 0;
  /** The compared claim's identity; a change, or a refresh clearing it, re-reads. */
  private key: string | null = null;
  private readSequence = 0;
  private stopRefresh: (() => void) | null = null;
  claimChanges: ThreadGitArcClaimObservation | null = null;

  constructor(private readonly ports: ThreadGitArcClaimObserverPorts) {}

  /** Demand the claim comparison; the caller re-syncs to start its read. */
  demand() {
    this.demands++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.demands--;
    };
  }

  /** Re-read on the next sync, keeping the current result visible meanwhile. */
  refresh() {
    this.key = null;
  }

  /** Only an active, stopped arc's claims are compared; a running turn still owns them. */
  sync(entry: ThreadEntry | null, cwd: string | null) {
    const arc = entry?.gitArc;
    const comparable = this.ports.compare && cwd && entry && arc && this.demands > 0
      && entry.lifecycle.kind !== "working" && arc.phase !== "stashed" && arc.claimedPaths.length > 0;
    if (!comparable) {
      this.clear();
      return;
    }
    if (!this.stopRefresh && this.ports.subscribeRefresh) {
      this.stopRefresh = this.ports.subscribeRefresh(() => {
        this.refresh();
        this.ports.changed();
      });
    }
    const key = [cwd, entry.identity.harness, entry.identity.threadId, arc.checkpointCommit, ...arc.claimedPaths].join("\0");
    if (key === this.key) return;
    this.key = key;
    const current = this.claimChanges;
    this.claimChanges = current?.status === "loaded" ? { ...current, refreshing: true } : { status: "loading" };
    this.read({ cwd, harness: entry.identity.harness, threadId: entry.identity.threadId });
  }

  clear() {
    this.key = null;
    this.readSequence++;
    this.claimChanges = null;
    this.stopRefresh?.();
    this.stopRefresh = null;
  }

  dispose() {
    this.clear();
    this.demands = 0;
  }

  private read(input: { cwd: string; harness: WorkbenchHarness; threadId: string }) {
    const token = ++this.readSequence;
    const isCurrent = () => this.ports.isLive() && token === this.readSequence;
    void this.ports.compare!(input).then(({ changeCount, hasUncommittedChanges }) => {
      if (!isCurrent()) return;
      this.claimChanges = { changeCount, hasUncommittedChanges, status: "loaded" };
      this.ports.changed();
    }).catch((error: unknown) => {
      if (!isCurrent()) return;
      this.claimChanges = {
        failure: error instanceof GitArcFailureException
          ? error.failure
          : createGitArcOperationRejected("compare", error instanceof Error ? error.message : "Unable to inspect the active Git arc claim."),
        status: "failed",
      };
      this.ports.changed();
    });
  }
}
