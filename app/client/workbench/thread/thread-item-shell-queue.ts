/*
 * Exports:
 * - ThreadItemShellQueue: one live wb shell's expensive-queue timing.
 * - deriveThreadItemShellQueue: index one thread's live shell queue by every reference naming each shell item.
 * - ThreadItemShellQueueContext/useThreadItemShellQueue: thread-scoped lookup for command rows.
 * - ThreadShellDurationSource/getShellQueueTiming: split a shell's duration into its queue wait and its run, live or recorded.
 */
import { createContext, useContext } from "react";
import type { WorkbenchShellQueueEntry } from "workbench-shared/workbench/thread/thread-state";

export type ThreadItemShellQueue = Pick<WorkbenchShellQueueEntry, "admittedAt" | "queuedAt">;

/** A recorded duration, or a live one ticking from `activeStartedAtMs`. */
export interface ThreadShellDurationSource {
  activeStartedAtMs: number | null;
  durationMs: number | null;
}

const EMPTY: ReadonlyMap<string, ThreadItemShellQueue> = new Map();

export function deriveThreadItemShellQueue(entries: readonly WorkbenchShellQueueEntry[] | undefined): ReadonlyMap<string, ThreadItemShellQueue> {
  if (!entries?.length) return EMPTY;
  return new Map(entries.flatMap(({ admittedAt, itemReferences, queuedAt }) => (
    itemReferences.map(reference => [reference, { admittedAt, queuedAt }] as const)
  )));
}

export const ThreadItemShellQueueContext = createContext<ReadonlyMap<string, ThreadItemShellQueue>>(EMPTY);

export function useThreadItemShellQueue(itemId: string): ThreadItemShellQueue | null {
  return useContext(ThreadItemShellQueueContext).get(itemId) ?? null;
}

/**
 * The queue wait shows only when the shell waited; the run then counts from admission, so it starts again from zero.
 * Without queue evidence the item's own timing is the run.
 */
export function getShellQueueTiming({ activeStartedAtMs, durationMs, live, queuedMs }: {
  activeStartedAtMs: number | null | undefined;
  durationMs: number | null | undefined;
  live: ThreadItemShellQueue | null;
  queuedMs: number | null | undefined;
}): { queued: ThreadShellDurationSource | null; run: ThreadShellDurationSource | null } {
  if (live) {
    if (live.admittedAt === null) return { queued: { activeStartedAtMs: live.queuedAt, durationMs: null }, run: null };
    return {
      queued: { activeStartedAtMs: null, durationMs: Math.max(0, live.admittedAt - live.queuedAt) },
      run: { activeStartedAtMs: live.admittedAt, durationMs: null },
    };
  }
  if (queuedMs !== null && queuedMs !== undefined && (activeStartedAtMs === null || activeStartedAtMs === undefined)) {
    return {
      queued: { activeStartedAtMs: null, durationMs: queuedMs },
      run: { activeStartedAtMs: null, durationMs: durationMs === null || durationMs === undefined ? null : Math.max(0, durationMs - queuedMs) },
    };
  }
  return { queued: null, run: { activeStartedAtMs: activeStartedAtMs ?? null, durationMs: durationMs ?? null } };
}
