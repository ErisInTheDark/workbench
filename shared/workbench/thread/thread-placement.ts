/*
 * Exports:
 * - default ThreadPlacement: the app-owned pins and snoozes of every thread, overlaid onto daemon rows, entries and summaries.
 */
import type { PresentationSnapshot } from "../../state/workbench-presentation-state.ts";
import { ThreadSnooze } from "./thread-snooze.ts";
import type { WorkbenchThreadSidebarEntry } from "./thread-state.ts";
import type { WorkbenchThreadSidebarRow } from "./thread-sidebar-row.ts";

type Row = WorkbenchThreadSidebarRow | WorkbenchThreadSidebarEntry;

export default class ThreadPlacement {
  static readonly empty = new ThreadPlacement(new Map(), new Set());

  static from(presentation: Pick<PresentationSnapshot, "threadSnoozes" | "threadPins">) {
    return new ThreadPlacement(ThreadSnooze.byThread(presentation.threadSnoozes), new Set(presentation.threadPins ?? []));
  }

  private constructor(
    readonly snoozes: ReadonlyMap<string, ThreadSnooze>,
    readonly pins: ReadonlySet<string>,
  ) {}

  isPinned(threadId: string) { return this.pins.has(threadId); }

  /** The app's records decide placement even over a stale daemon flag; an unchanged row keeps its identity. */
  apply<Value extends Row>(row: Value): Value {
    if (row.entryKind !== "thread" || row.metadata.archived) return row;
    const pinned = this.pins.has(row.identity.threadId);
    const placed = row.metadata.pinned === pinned ? row : { ...row, metadata: { ...row.metadata, pinned } };
    return ThreadSnooze.apply(placed, this.snoozes.get(row.identity.threadId));
  }
}
