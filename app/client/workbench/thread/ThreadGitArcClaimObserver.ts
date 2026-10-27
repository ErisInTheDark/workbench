/*
 * Exports:
 * - ThreadGitArcClaimObservation: source-local loading, loaded (with refreshing), or failed state of a thread's claimed-file changes.
 * - ThreadGitArcClaimObserverPorts: cancellable claim comparison read, refresh trigger and change notification.
 * - default ThreadGitArcClaimObserver: own the demanded claim comparison for one thread: reads on claim changes and refreshes,
 *   aborting reads nobody needs any more and holding off while a claim mutation runs.
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
  compare?: (
    input: { cwd: string; harness: WorkbenchHarness; threadId: string },
    signal: AbortSignal,
  ) => Promise<{ changeCount: number; hasUncommittedChanges: boolean }>;
  subscribeRefresh?: (listener: () => void) => () => void;
  /** A read settled or a refresh was requested; the owner re-syncs and republishes. */
  changed: () => void;
  isLive: () => boolean;
}

export default class ThreadGitArcClaimObserver {
  private demands = 0;
  private holds = 0;
  /** The compared claim's identity; a change, or a refresh clearing it, re-reads. */
  private key: string | null = null;
  /** The in-flight read; aborting it cancels the comparison upstream. */
  private reading: AbortController | null = null;
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

  /** Suspend comparison while a claim mutation runs, so it never queues behind a read; the caller re-syncs after either edge. */
  hold() {
    this.holds++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.holds--;
    };
  }

  /** Re-read on the next sync, keeping the current result visible meanwhile. */
  refresh() {
    this.key = null;
  }

  /** Only an active, stopped arc's claims are compared; a running turn still owns them. */
  sync(entry: ThreadEntry | null, cwd: string | null) {
    const arc = entry?.gitArc;
    const comparable = this.ports.compare && cwd && entry && arc && this.demands > 0 && !this.holds
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
    this.abortRead();
    this.claimChanges = null;
    this.stopRefresh?.();
    this.stopRefresh = null;
  }

  dispose() {
    this.clear();
    this.demands = 0;
    this.holds = 0;
  }

  private abortRead() {
    this.reading?.abort(new Error("The claim comparison is no longer needed."));
    this.reading = null;
  }

  private read(input: { cwd: string; harness: WorkbenchHarness; threadId: string }) {
    this.abortRead();
    const reading = new AbortController();
    this.reading = reading;
    const isCurrent = () => this.ports.isLive() && this.reading === reading;
    void this.ports.compare!(input, reading.signal).then(({ changeCount, hasUncommittedChanges }) => {
      if (!isCurrent()) return;
      this.reading = null;
      this.claimChanges = { changeCount, hasUncommittedChanges, status: "loaded" };
      this.ports.changed();
    }).catch((error: unknown) => {
      if (!isCurrent()) return;
      this.reading = null;
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
