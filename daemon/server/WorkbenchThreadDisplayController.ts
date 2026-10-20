/*
 * Exports:
 * - setWorkbenchThreadEntryPriority: apply one valid pinned or main transition; snooze is app-owned.
 * - default WorkbenchThreadDisplayController: own one project's durable display order.
 */

import type { WorkbenchThreadDisplayOrder } from "workbench-shared/workbench/thread/thread-display-order";
import type { WorkbenchThreadStateEntry } from "./workbench-thread-state-record";

export function setWorkbenchThreadEntryPriority(
  entry: WorkbenchThreadStateEntry,
  priority: "pinned" | "main",
): WorkbenchThreadStateEntry | null {
  if (entry.entryKind !== "draft" && (entry.entryKind === "subagent" || entry.lifecycle.settled)) return null;
  if (entry.metadata.archived) return null;
  return { ...entry, metadata: { archived: false, pinned: priority === "pinned", snoozed: false } };
}

export default class WorkbenchThreadDisplayController {
  displayOrder: WorkbenchThreadDisplayOrder;

  constructor(displayOrder: WorkbenchThreadDisplayOrder = {}) {
    this.displayOrder = displayOrder;
  }

  clone() {
    return new WorkbenchThreadDisplayController(this.displayOrder);
  }
}
