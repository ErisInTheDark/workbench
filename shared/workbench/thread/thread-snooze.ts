/*
 * Exports:
 * - ThreadSnoozeBasisSchema/ThreadSnoozeBasis: the thread facts a snooze saw when it began; departing from them wakes it.
 * - ThreadSnoozeSchema/ThreadSnooze: one app-owned thread snooze and its dependent targets, which may live on any daemon.
 * - ThreadSnooze: pure snooze rules: capture a basis, decide wakes, target readiness, toggle targets, index and overlay rows.
 */
import { z } from "zod";
import { WorkbenchThreadIdSchema } from "../identity.ts";
import {
  getWorkbenchLifecycleTurnId, isWorkbenchThreadStatusProviderOwned, WorkbenchThreadWaitTargetSchema,
  type WorkbenchThreadSidebarEntry, type WorkbenchThreadWaitTarget,
} from "./thread-state.ts";
import type { WorkbenchThreadSidebarRow } from "./thread-sidebar-row.ts";

export const ThreadSnoozeBasisSchema = z.object({
  lifecycleKind: z.enum(["working", "needsAttention", "completed", "stopped"]),
  turnId: z.string().min(1).nullable(),
  /** Set for questionnaire snooze: only that questionnaire leaving wakes the thread. */
  questionnaireKey: z.string().min(1).nullable(),
}).strict();
export type ThreadSnoozeBasis = z.infer<typeof ThreadSnoozeBasisSchema>;

export const ThreadSnoozeSchema = z.object({
  threadId: WorkbenchThreadIdSchema,
  basis: ThreadSnoozeBasisSchema,
  targets: z.array(WorkbenchThreadWaitTargetSchema),
}).strict();
export type ThreadSnooze = z.infer<typeof ThreadSnoozeSchema>;

type Row = WorkbenchThreadSidebarRow | WorkbenchThreadSidebarEntry;
type ThreadRow = Extract<Row, { entryKind: "thread" }>;

function capture(row: ThreadRow, questionnaireKey: string | null = null): ThreadSnoozeBasis {
  return questionnaireKey
    ? { lifecycleKind: "needsAttention", turnId: null, questionnaireKey }
    : { lifecycleKind: row.lifecycle.kind, turnId: getWorkbenchLifecycleTurnId(row.lifecycle), questionnaireKey: null };
}

/**
 * Derived from current facts rather than events, so a wake missed while the app was closed still fires on reconnect.
 * Leaving the basis lifecycle covers turn ends, new turns, stop and user status changes.
 */
function isWakeDue(snooze: ThreadSnooze, row: Row) {
  if (row.entryKind !== "thread" || row.metadata.archived || row.lifecycle.settled) return true;
  const { basis } = snooze;
  if (basis.questionnaireKey !== null) return row.pendingQuestionnaire?.requestKey !== basis.questionnaireKey;
  if (row.lifecycle.kind !== basis.lifecycleKind) return true;
  const turnId = getWorkbenchLifecycleTurnId(row.lifecycle);
  if (turnId !== null && turnId !== basis.turnId) return true;
  return !snooze.targets.length && row.lifecycle.kind !== "working" && Boolean(row.gitArc?.claimedPaths.length);
}

function isTargetReady(row: Row) {
  return row.entryKind === "thread" && row.lifecycle.kind === "completed" && !row.gitArc?.claimedPaths.length;
}

/** Dependent snooze may keep claims, but not a turn or questionnaire the provider still owns. */
function canWait(row: Row) {
  return row.entryKind === "thread" && !row.metadata.archived && !row.lifecycle.settled
    && !isWorkbenchThreadStatusProviderOwned(row.lifecycle);
}

/** Toggling a held target removes it; a ready target adds nothing. Null means the thread is no longer snoozed. */
function toggleTarget(
  snooze: ThreadSnooze | null, source: ThreadRow, target: WorkbenchThreadWaitTarget, targetReady: boolean,
): ThreadSnooze | null {
  const held = snooze?.targets.some(wait => wait.identity.threadId === target.identity.threadId) ?? false;
  if (held) {
    const targets = snooze!.targets.filter(wait => wait.identity.threadId !== target.identity.threadId);
    return targets.length ? { ...snooze!, targets } : null;
  }
  if (targetReady) return snooze;
  return {
    threadId: WorkbenchThreadIdSchema.parse(source.identity.threadId),
    basis: snooze?.basis ?? capture(source),
    targets: [...snooze?.targets ?? [], target],
  };
}

/** The app owns snooze, so its record decides placement even over a stale daemon flag. */
function apply<Value extends Row>(row: Value, snooze: ThreadSnooze | undefined): Value {
  if (row.entryKind !== "thread" || row.metadata.archived) return row;
  if (!snooze) {
    return row.metadata.snoozed || row.waitingOnThreads?.length
      ? { ...row, metadata: { ...row.metadata, snoozed: false }, waitingOnThreads: [] } : row;
  }
  return {
    ...row,
    metadata: { ...row.metadata, snoozed: true },
    waitingOnThreads: snooze.targets,
    ...(snooze.targets.length ? { waitingFor: row.waitingFor ?? "other" } : {}),
  };
}

function byThread(snoozes: readonly ThreadSnooze[] | undefined): ReadonlyMap<string, ThreadSnooze> {
  return new Map((snoozes ?? []).map(snooze => [snooze.threadId, snooze]));
}

export const ThreadSnooze = { capture, isWakeDue, isTargetReady, canWait, toggleTarget, apply, byThread };
