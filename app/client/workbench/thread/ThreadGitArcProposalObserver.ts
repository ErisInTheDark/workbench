/*
 * Exports:
 * - ThreadGitArcProposalObservation: source-local loading, loaded, refreshing, or failed proposal validity.
 * - ThreadGitArcProposalVariant: the optional newer-work and unclaimed-dirt inclusions one read covers.
 * - getThreadGitArcProposalObservationKey: the observation key for a proposal read variant; the plain read keys by proposal id.
 * - ThreadGitArcProposalObserverPorts: proposal reads, refresh trigger and change notification.
 * - default ThreadGitArcProposalObserver: own demanded proposal cards and read variants for one thread: reads, lifecycle-driven refreshes and stale-read fencing.
 */
import type { GitCheckpointProposal } from "workbench-shared/workbench/git/checkpoint-contracts";
import { GitArcFailureException, type GitArcFailure } from "workbench-shared/workbench/git/git-arc-failures";
import type { WorkbenchHarness } from "workbench-shared/types";
import type { WorkbenchThreadSidebarEntry } from "workbench-shared/workbench/thread/thread-state";

type ThreadEntry = Exclude<WorkbenchThreadSidebarEntry, { entryKind: "draft" }>;
export type ThreadGitArcProposalObservation =
  | { error: string; failure?: GitArcFailure; status: "failed" }
  | { proposal: GitCheckpointProposal; refreshing?: true; status: "loaded" }
  | { status: "loading" };

export interface ThreadGitArcProposalVariant {
  includeNewer?: boolean;
  includeUnclaimed?: boolean;
}

export function getThreadGitArcProposalObservationKey(proposalId: string, { includeNewer = false, includeUnclaimed = false }: ThreadGitArcProposalVariant = {}) {
  return includeNewer || includeUnclaimed
    ? [proposalId, includeNewer ? "newer" : "", includeUnclaimed ? "unclaimed" : ""].join("\0")
    : proposalId;
}

export interface ThreadGitArcProposalObserverPorts {
  read?: (input: {
    cwd: string; harness: WorkbenchHarness; includeNewer: boolean; includeUnclaimed: boolean; proposalId: string; rootId?: string; threadId: string;
  }) => Promise<GitCheckpointProposal>;
  subscribeRefresh?: (listener: () => void) => () => void;
  /** A read settled or a refresh was requested; the owner re-syncs and republishes. */
  changed: () => void;
  isLive: () => boolean;
}

interface Demand {
  count: number;
  includeNewer: boolean;
  includeUnclaimed: boolean;
  proposalId: string;
}

export default class ThreadGitArcProposalObserver {
  /** The observed thread's identity; a change (or invalidation) refreshes every demanded card. */
  private observationKey: string | null = null;
  private refreshKey: string | null = null;
  /** Last observed lifecycle facts, so a change re-reads only what it affects. */
  private lifecycle: { checkpoint: string; rows: Map<string, string> } | null = null;
  /** The newest read per observation key; older reads resolve into nothing. */
  private readonly reads = new Map<string, number>();
  private readSequence = 0;
  /** Demands by observation key. */
  private readonly demands = new Map<string, Demand>();
  private stopRefresh: (() => void) | null = null;
  /** Observations by key: plain reads by proposal id, variants by `getThreadGitArcProposalObservationKey`. */
  proposals: Record<string, ThreadGitArcProposalObservation> = {};

  constructor(private readonly ports: ThreadGitArcProposalObserverPorts) {}

  get hasDemand() { return this.demands.size > 0; }

  /** Demand one proposal card, or one read variant of it; the caller re-syncs to start its read. */
  demand(proposalId: string, variant: ThreadGitArcProposalVariant = {}) {
    const key = getThreadGitArcProposalObservationKey(proposalId, variant);
    const current = this.demands.get(key);
    this.demands.set(key, current ? { ...current, count: current.count + 1 } : {
      count: 1, includeNewer: Boolean(variant.includeNewer), includeUnclaimed: Boolean(variant.includeUnclaimed), proposalId,
    });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const demand = this.demands.get(key);
      if (!demand || demand.count <= 1) this.demands.delete(key);
      else this.demands.set(key, { ...demand, count: demand.count - 1 });
    };
  }

  sync(entry: ThreadEntry | null, cwd: string | null) {
    const proposals = entry?.gitArc?.proposals ?? [];
    if (!this.ports.read || !cwd || !entry) {
      this.clear();
      return;
    }
    if ((proposals.length || this.demands.size) && !this.stopRefresh && this.ports.subscribeRefresh) {
      this.stopRefresh = this.ports.subscribeRefresh(() => {
        this.invalidate(this.observationKey);
        this.ports.changed();
      });
    }
    const key = [cwd, entry.identity.harness, entry.identity.threadId].join("\0");
    const lifecycle = {
      checkpoint: entry.gitArc?.checkpointCommit ?? "",
      rows: new Map(proposals.map(({ proposalId, rootId, status }) => [proposalId, `${rootId ?? ""}\0${status}`])),
    };
    // The lifecycle lists only actionable proposals; demanded cards still need unavailable, rescinded, or superseded state.
    const proposalRoots = new Map(proposals.map(({ proposalId, rootId }) => [proposalId, rootId]));
    const previousLifecycle = this.lifecycle;
    this.lifecycle = lifecycle;
    const read = (observationKey: string) => this.read(entry, cwd, observationKey, proposalRoots);
    if (key !== this.observationKey) {
      // A new thread loads from scratch; a refresh of the same thread keeps what its cards already show.
      const retainLoaded = key === this.refreshKey;
      this.refreshKey = null;
      this.observationKey = key;
      this.refresh([...this.demands.keys()], retainLoaded, read);
      return;
    }
    const changed = previousLifecycle !== null && (previousLifecycle.checkpoint !== lifecycle.checkpoint
      || previousLifecycle.rows.size !== lifecycle.rows.size
      || [...lifecycle.rows].some(([proposalId, row]) => previousLifecycle.rows.get(proposalId) !== row));
    if (changed) {
      // While an acceptance runs, only rows it changed are re-read; HEAD-dependent text elsewhere refreshes once it ends.
      const affected = entry.gitArc?.acceptance
        ? [...this.demands].filter(([, { proposalId }]) => previousLifecycle.rows.get(proposalId) !== lifecycle.rows.get(proposalId))
          .map(([observationKey]) => observationKey)
        : [...this.demands.keys()];
      this.refresh(affected, true, read);
    }
    for (const [observationKey] of this.demands) {
      if (this.proposals[observationKey]) continue;
      this.proposals = { ...this.proposals, [observationKey]: { status: "loading" } };
      read(observationKey);
    }
  }

  invalidate(refreshKey: string | null = null) {
    this.reads.clear();
    this.observationKey = null;
    this.lifecycle = null;
    this.refreshKey = refreshKey;
  }

  clear() {
    this.invalidate();
    this.proposals = {};
    this.stopRefresh?.();
    this.stopRefresh = null;
  }

  dispose() {
    this.clear();
    this.demands.clear();
  }

  /** Re-reads the given demanded observations, dropping ones no longer demanded; loaded ones keep showing while refreshing. */
  private refresh(observationKeys: readonly string[], retainLoaded: boolean, read: (observationKey: string) => void) {
    const previous = this.proposals;
    this.proposals = Object.fromEntries(Object.entries(previous).filter(([observationKey]) => this.demands.has(observationKey)));
    for (const observationKey of observationKeys) {
      const current = previous[observationKey];
      this.proposals[observationKey] = retainLoaded && current?.status === "loaded"
        ? { ...current, refreshing: true }
        : { status: "loading" };
      read(observationKey);
    }
  }

  private read(entry: ThreadEntry, cwd: string, observationKey: string, proposalRoots: ReadonlyMap<string, string | undefined>) {
    const demand = this.demands.get(observationKey);
    if (!demand) return;
    const { includeNewer, includeUnclaimed, proposalId } = demand;
    const rootId = proposalRoots.get(proposalId);
    const token = ++this.readSequence;
    this.reads.set(observationKey, token);
    void this.ports.read!({
      cwd,
      harness: entry.identity.harness,
      includeNewer,
      includeUnclaimed,
      proposalId,
      ...(rootId ? { rootId } : {}),
      threadId: entry.identity.threadId,
    }).then((proposal) => {
      if (!this.isCurrent(token, observationKey)) return;
      this.proposals = { ...this.proposals, [observationKey]: { proposal, status: "loaded" } };
      this.ports.changed();
    }).catch((error) => {
      if (!this.isCurrent(token, observationKey)) return;
      const message = (error instanceof Error ? error.message : "Unable to observe Git arc proposal.")
        .replace(/[\u0000-\u001f\u007f-\u009f]/gu, "?")
        .slice(0, 500);
      this.proposals = {
        ...this.proposals,
        [observationKey]: {
          error: message,
          ...(error instanceof GitArcFailureException ? { failure: error.failure } : {}),
          status: "failed",
        },
      };
      this.ports.changed();
    });
  }

  private isCurrent(token: number, observationKey: string) {
    return this.ports.isLive() && this.reads.get(observationKey) === token && Object.hasOwn(this.proposals, observationKey);
  }
}
