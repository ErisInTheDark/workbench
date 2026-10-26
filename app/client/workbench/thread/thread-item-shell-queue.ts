/*
 * Exports:
 * - ThreadItemShellQueue: one live wb shell's expensive-queue timing.
 * - deriveThreadItemShellQueue: index one thread's live shell queue by every reference naming each shell item.
 * - ThreadItemShellQueueContext/useThreadItemShellQueue: thread-scoped lookup for command rows.
 * - ThreadYieldedShells/NO_YIELDED_SHELLS/getThreadYieldedShellsKey/deriveThreadYieldedShells/ThreadYieldedShellsContext/
 *   useThreadYieldedShells/useThreadItemShellYielded: which running shell rows already yielded, and their commands.
 * - ThreadShellOutputStoreContext/useThreadItemShellOutput: a running shell row's newest output from its thread store.
 * - ThreadShellDurationSource/getShellQueueTiming: split a shell's duration into its queue wait and its run, live or recorded.
 */
import { createContext, useCallback, useContext, useSyncExternalStore } from "react";
import type { WorkbenchBackgroundShell, WorkbenchShellQueueEntry } from "workbench-shared/workbench/thread/thread-state";
import type ThreadStore from "./ThreadStore";

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

/** Running shells whose call already answered, by every reference naming their item, to their command when known. */
export type ThreadYieldedShells = ReadonlyMap<string, string | null>;

export const NO_YIELDED_SHELLS: ThreadYieldedShells = new Map();

/** A key that changes only when the yielded shells do, not on every runtime publish that repeats them. */
export function getThreadYieldedShellsKey(shells: readonly WorkbenchBackgroundShell[] | undefined) {
  return JSON.stringify(shells?.map(({ command, reference }) => [reference, command]) ?? []);
}

export function deriveThreadYieldedShells(key: string): ThreadYieldedShells {
  const entries = JSON.parse(key) as [string, string | null][];
  return entries.length ? new Map(entries) : NO_YIELDED_SHELLS;
}

export const ThreadYieldedShellsContext = createContext<ThreadYieldedShells>(NO_YIELDED_SHELLS);

/** The thread's yielded shells, which name the commands of waits whose shell row is out of view. */
export function useThreadYieldedShells() {
  return useContext(ThreadYieldedShellsContext);
}

/** Whether the daemon backgrounded this running shell: its call already answered and the command runs on. */
export function useThreadItemShellYielded(itemId: string) {
  return useContext(ThreadYieldedShellsContext).has(itemId);
}

/** The store whose transcript the rows render; its shell output slice feeds running rows. */
export const ThreadShellOutputStoreContext = createContext<ThreadStore | null>(null);
const noSubscription = () => () => {};

/** A running shell's newest output, or null; only rows of shells that print re-render as it grows. */
export function useThreadItemShellOutput(itemId: string): string | null {
  const store = useContext(ThreadShellOutputStoreContext);
  const subscribe = useCallback((listener: () => void) => store?.subscribe("shellOutput", listener) ?? (() => {}), [store]);
  const read = useCallback(() => store?.getSlice("shellOutput").entries
    .find(entry => entry.itemReferences.includes(itemId))?.tail ?? null, [itemId, store]);
  return useSyncExternalStore(store ? subscribe : noSubscription, read, read);
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
