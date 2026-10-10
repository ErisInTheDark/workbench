/*
 * Exports:
 * - default WorkbenchThreadComposerDropTarget: highlight one writable sidebar thread and attach dropped feedback to its composer.
 */
"use client";

import {
  isWorkbenchFeedbackDragPayload,
  WORKBENCH_THREAD_COMPOSER_DROP_TARGET_ID,
  type WorkbenchDragPayload,
  type WorkbenchFeedbackDragPayload,
} from "../../workbench/layout/workbench-drag";
import DropTarget from "./drag/DropTarget";

export default function WorkbenchThreadComposerDropTarget({
  activePayload,
  onDrop,
  title,
}: {
  activePayload: WorkbenchDragPayload | null;
  onDrop: (payload: WorkbenchFeedbackDragPayload) => void;
  title: string;
}) {
  if (!isWorkbenchFeedbackDragPayload(activePayload)) return null;
  return (
    <DropTarget
      className="pointer-events-none absolute inset-0 z-30 rounded-[0.8rem]"
      dropTargetId={WORKBENCH_THREAD_COMPOSER_DROP_TARGET_ID}
      enabled={isWorkbenchFeedbackDragPayload}
      onDrop={(payload) => { if (isWorkbenchFeedbackDragPayload(payload)) onDrop(payload); }}
      preview={() => ({ action: "attach", label: `attach to ${title}` })}
      selectionPriority={200}
    >
      {({ selected }) => (
        <div
          aria-hidden="true"
          className={`
            absolute inset-0 rounded-[0.8rem] ring-2 ring-inset transition
            ${selected ? "bg-accent-soft/50 ring-accent opacity-100" : "ring-transparent opacity-0"}
          `}
          data-thread-feedback-drop-target="true"
        />
      )}
    </DropTarget>
  );
}
