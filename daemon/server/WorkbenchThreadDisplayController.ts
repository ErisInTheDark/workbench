/*
 * Exports:
 * - setWorkbenchThreadEntryPriority: apply one valid priority transition.
 * - setWorkbenchThreadEntryDisplaySection: apply one valid display-section transition.
 * - default WorkbenchThreadDisplayController: own one project's durable display order.
 */

import type {
  WorkbenchThreadDisplayOrder,
  WorkbenchThreadDisplaySection,
} from "workbench-shared/workbench/thread/thread-display-order";
import { getWorkbenchThreadDisplaySection } from "workbench-shared/workbench/thread/thread-display-order";
import type { WorkbenchThreadPriority } from "workbench-shared/workbench/thread/thread-state";
import type { WorkbenchThreadStateEntry } from "./workbench-thread-state-record";

export function setWorkbenchThreadEntryPriority(
  entry: WorkbenchThreadStateEntry,
  priority: WorkbenchThreadPriority,
): WorkbenchThreadStateEntry | null {
  if (entry.entryKind !== "draft" && (entry.entryKind === "subagent" || entry.lifecycle.settled)) return null;
  if (entry.metadata.archived) return null;
  const metadata = priority === "pinned"
    ? { archived: false as const, pinned: true, snoozed: false }
    : priority === "main"
      ? { archived: false as const, pinned: false, snoozed: false }
      : { archived: false as const, pinned: entry.metadata.pinned, snoozed: true };
  return entry.entryKind === "draft"
    ? { ...entry, metadata }
    : { ...entry, metadata, snoozedUntil: null };
}

export function setWorkbenchThreadEntryDisplaySection(
  entry: WorkbenchThreadStateEntry,
  section: WorkbenchThreadDisplaySection,
) {
  if (section === "settled") return getWorkbenchThreadDisplaySection(entry) === "settled" ? entry : null;
  return setWorkbenchThreadEntryPriority(entry, section);
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
