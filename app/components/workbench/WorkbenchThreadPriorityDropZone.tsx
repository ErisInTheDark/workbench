/*
 * Exports:
 * - default WorkbenchThreadPriorityDropZone: expose one sidebar priority group as a temporary drag target with an empty-group affordance. Keywords: thread, drag, priority, group.
 */
"use client";

import {
  isWorkbenchThreadRowDragPayload,
  WORKBENCH_THREAD_PRIORITY_DROP_TARGET_ID,
  type WorkbenchDragPayload,
  type WorkbenchThreadRowDragPayload,
} from "../../workbench/layout/workbench-drag";
import type { WorkbenchThreadPriority } from "workbench-shared/workbench/thread/thread-state";
import DropTarget from "./drag/DropTarget";

function isCompatible(payload: WorkbenchDragPayload, priority: WorkbenchThreadPriority): payload is WorkbenchThreadRowDragPayload {
  return isWorkbenchThreadRowDragPayload(payload)
    && payload.section !== "settled"
    && payload.section !== priority;
}

export default function WorkbenchThreadPriorityDropZone({
  activePayload,
  onDrop,
  priority,
}: {
  activePayload: WorkbenchDragPayload | null;
  onDrop: (payload: WorkbenchThreadRowDragPayload) => void;
  priority: WorkbenchThreadPriority;
}) {
  const active = Boolean(activePayload && isCompatible(activePayload, priority));
  if (!active) return null;
  const label = `move to ${priority}`;
  return (
    <DropTarget
      className="relative h-1 rounded-full"
      dropTargetId={WORKBENCH_THREAD_PRIORITY_DROP_TARGET_ID}
      enabled={(payload) => isCompatible(payload, priority)}
      onDrop={(payload) => { if (isCompatible(payload, priority)) onDrop(payload); }}
      preview={() => ({ action: priority, label })}
      range={{ x: 16, y: 6 }}
      selectionPriority={10}
    >
      {({ selected }) => (
        <div
          aria-hidden="true"
          className={`pointer-events-none absolute inset-0 rounded-full transition-colors ${selected ? "bg-accent" : "bg-transparent"}`}
          data-thread-priority-drop-target={priority}
        />
      )}
    </DropTarget>
  );
}
