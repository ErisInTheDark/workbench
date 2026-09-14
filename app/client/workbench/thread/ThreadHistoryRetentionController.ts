/*
 * Exports:
 * - THREAD_HISTORY_RETENTION_AGE_MS: minimum mounted-view age before a historical turn can unload.
 * - ThreadHistoryRetentionCandidates: eligible turn IDs and the next required age review.
 * - getThreadTurnLastUpdateMs: derive one turn's latest canonical update timestamp.
 * - getThreadHistoryRetentionCandidates: select old loaded turns while protecting current context.
 * - ThreadHistoryRetentionSurface: report one mounted surface's exact-end state.
 * - default ThreadHistoryRetentionController: own per-thread surface retention and its review schedule.
 */

import type { ThreadPayload, WorkbenchThreadTurnHistoryEntry } from "workbench-shared/types";

export const THREAD_HISTORY_RETENTION_AGE_MS = 60 * 60 * 1_000;

export interface ThreadHistoryRetentionCandidates {
  nextReviewAtMs: number | null;
  turnIds: string[];
}

export interface ThreadHistoryRetentionSurface {
  release: () => void;
  setAtEnd: (atEnd: boolean) => void;
}

function finiteTimestamp(value: number | null | undefined, scale = 1) {
  return typeof value === "number" && Number.isFinite(value) ? value * scale : null;
}

export function getThreadTurnLastUpdateMs(
  turn: ThreadPayload["turns"][number],
  history: WorkbenchThreadTurnHistoryEntry | undefined,
) {
  const timestamps = [
    finiteTimestamp(turn.startedAt, 1_000),
    finiteTimestamp(turn.completedAt, 1_000),
    finiteTimestamp(history?.startedAt, 1_000),
    finiteTimestamp(history?.completedAt, 1_000),
    ...(history?.itemTimeline ?? []).flatMap((entry) => [
      finiteTimestamp(entry.startedAt),
      finiteTimestamp(entry.firstSeenAt),
      finiteTimestamp(entry.completedAt),
      finiteTimestamp(entry.lastSeenAt),
    ]),
  ].filter((value): value is number => value !== null);
  return timestamps.length ? Math.max(...timestamps) : null;
}

export function getThreadHistoryRetentionCandidates(
  thread: ThreadPayload,
  nowMs: number,
): ThreadHistoryRetentionCandidates {
  if (thread.harness !== "codex" || thread.isDraft || thread.turns.length <= 2) {
    return { nextReviewAtMs: null, turnIds: [] };
  }

  const historyByTurnId = new Map(thread.turnHistory.map((entry) => [entry.turnId, entry]));
  const candidates = thread.turns.slice(0, -2);
  const turnIds: string[] = [];
  let nextReviewAtMs: number | null = null;
  for (const turn of candidates) {
    const lastUpdateMs = getThreadTurnLastUpdateMs(turn, historyByTurnId.get(turn.id));
    if (lastUpdateMs === null) continue;
    const eligibleAtMs = lastUpdateMs + THREAD_HISTORY_RETENTION_AGE_MS + 1;
    if (eligibleAtMs <= nowMs) {
      turnIds.push(turn.id);
    } else {
      nextReviewAtMs = nextReviewAtMs === null ? eligibleAtMs : Math.min(nextReviewAtMs, eligibleAtMs);
    }
  }
  return { nextReviewAtMs, turnIds };
}

export default class ThreadHistoryRetentionController {
  readonly #now: () => number;
  readonly #releaseTurns: (turnIds: readonly string[]) => ThreadPayload | null;
  readonly #schedule: (callback: () => void, delayMs: number) => () => void;
  readonly #surfaces = new Map<object, boolean>();
  #cancelReview: (() => void) | null = null;
  #thread: ThreadPayload | null = null;
  #disposed = false;
  #evaluating = false;

  constructor(options: {
    now?: () => number;
    releaseTurns: (turnIds: readonly string[]) => ThreadPayload | null;
    schedule?: (callback: () => void, delayMs: number) => () => void;
  }) {
    this.#now = options.now ?? Date.now;
    this.#releaseTurns = options.releaseTurns;
    this.#schedule = options.schedule ?? ((callback, delayMs) => {
      const timer = setTimeout(callback, delayMs);
      return () => clearTimeout(timer);
    });
  }

  acquireSurface(): ThreadHistoryRetentionSurface {
    if (this.#disposed) {
      return { release: () => {}, setAtEnd: () => {} };
    }
    const token = {};
    this.#surfaces.set(token, false);
    this.#sync();
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.#surfaces.delete(token);
        this.#sync();
      },
      setAtEnd: (atEnd) => {
        if (released || this.#surfaces.get(token) === atEnd) return;
        this.#surfaces.set(token, atEnd);
        this.#sync();
      },
    };
  }

  select(thread: ThreadPayload | null) {
    if (this.#disposed) return;
    this.#thread = thread;
    this.#sync();
  }

  releaseInactive() {
    if (this.#disposed || !this.#thread || this.#thread.harness !== "codex"
      || this.#thread.isDraft || this.#thread.turns.length <= 1) return this.#thread;
    this.#cancelScheduledReview();
    this.#thread = this.#releaseTurns(this.#thread.turns.slice(0, -1).map(({ id }) => id));
    return this.#thread;
  }

  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#cancelScheduledReview();
    this.#surfaces.clear();
    this.#thread = null;
  }

  #cancelScheduledReview() {
    this.#cancelReview?.();
    this.#cancelReview = null;
  }

  #sync() {
    this.#cancelScheduledReview();
    if (this.#disposed || this.#evaluating || !this.#thread || !this.#surfaces.size
      || [...this.#surfaces.values()].some((atEnd) => !atEnd)) return;

    this.#evaluating = true;
    try {
      const candidates = getThreadHistoryRetentionCandidates(this.#thread, this.#now());
      if (candidates.turnIds.length) {
        this.#thread = this.#releaseTurns(candidates.turnIds);
      }
      if (!this.#thread) return;
      const next = getThreadHistoryRetentionCandidates(this.#thread, this.#now());
      if (next.turnIds.length) return;
      if (next.nextReviewAtMs !== null) {
        const delayMs = Math.max(0, Math.min(0x7fffffff, next.nextReviewAtMs - this.#now()));
        this.#cancelReview = this.#schedule(() => {
          this.#cancelReview = null;
          this.#sync();
        }, delayMs);
      }
    } finally {
      this.#evaluating = false;
    }
  }
}
