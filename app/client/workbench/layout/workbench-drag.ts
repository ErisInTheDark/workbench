/*
 * Exports:
 * - WORKBENCH_*_DROP_TARGET_ID: shared accepted-target identifiers for thread ordering, priority, row actions, and composer attachment.
 * - WorkbenchThreadDragAction/WorkbenchThreadDragPreview: icon-led action context for the cursor ghost.
 * - WorkbenchThreadDragSection/WorkbenchThreadRowDragPayload/WorkbenchFeedbackDragPayload/WorkbenchDragPayload: pointer-drag payloads for threads, folders, and feedback.
 * - isWorkbenchThreadRowDragPayload/isWorkbenchFeedbackDragPayload/canMoveWorkbenchThreadRowToSection: classify drags and preserve placement boundaries.
 */

import type { WorkbenchThreadDisplaySection } from "workbench-shared/workbench/thread/thread-display-order";
import type { ThreadDisplayKey } from "workbench-shared/workbench/identity";
import type { WorkbenchThreadTarget } from "workbench-shared/workbench/thread/thread-state";
import type { WorkbenchThreadAddressedFeedback } from "workbench-shared/workbench/thread/thread-addressed-feedback";

export const WORKBENCH_THREAD_ORDER_DROP_TARGET_ID = "workbench/thread-order";
export const WORKBENCH_THREAD_PRIORITY_DROP_TARGET_ID = "workbench/thread-priority";
export const WORKBENCH_THREAD_ROW_ACTION_DROP_TARGET_ID = "workbench/thread-row-action";
export const WORKBENCH_THREAD_COMPOSER_DROP_TARGET_ID = "workbench/thread-composer";
export type WorkbenchThreadDragAction = "attach" | "folder" | "main" | "pinned" | "snoozed" | "wait";
export interface WorkbenchThreadDragPreview {
  action: WorkbenchThreadDragAction;
  label: string;
}
export type WorkbenchThreadDragSection = WorkbenchThreadDisplaySection | "main";

export type WorkbenchDragPayload =
  | {
    readonly ownerProjectId: string;
    readonly projectSourceKey: ThreadDisplayKey;
    readonly section: WorkbenchThreadDragSection;
    readonly sourceKey: string;
    readonly target: WorkbenchThreadTarget;
    readonly type: "thread-row";
    readonly waitingOnThreadIds?: readonly string[];
  }
  | {
    readonly section: WorkbenchThreadDisplaySection;
    readonly sourceKey: ThreadDisplayKey;
    readonly type: "thread-folder";
  }
  | {
    readonly ownerProjectId: string;
    readonly projectSourceKey: ThreadDisplayKey;
    readonly section: WorkbenchThreadDragSection;
    readonly sourceKey: string;
    readonly target: WorkbenchThreadTarget;
    readonly type: "home-thread-row";
    readonly waitingOnThreadIds?: readonly string[];
  }
  | {
    readonly ownerProjectId: string;
    readonly section: WorkbenchThreadDisplaySection;
    readonly sourceKey: string;
    readonly type: "home-thread-folder";
  }
  | {
    readonly reference: WorkbenchThreadAddressedFeedback;
    readonly type: "feedback";
  };

export type WorkbenchThreadRowDragPayload = Extract<WorkbenchDragPayload, { readonly type: "home-thread-row" | "thread-row" }>;
export type WorkbenchFeedbackDragPayload = Extract<WorkbenchDragPayload, { readonly type: "feedback" }>;

export function isWorkbenchThreadRowDragPayload(payload: WorkbenchDragPayload | null): payload is WorkbenchThreadRowDragPayload {
  return payload?.type === "thread-row" || payload?.type === "home-thread-row";
}

export function isWorkbenchFeedbackDragPayload(payload: WorkbenchDragPayload | null): payload is WorkbenchFeedbackDragPayload {
  return payload?.type === "feedback";
}

export function canMoveWorkbenchThreadRowToSection(
  payload: WorkbenchDragPayload | null,
  section: WorkbenchThreadDisplaySection,
  ownerProjectId?: string,
): payload is WorkbenchThreadRowDragPayload {
  if (!isWorkbenchThreadRowDragPayload(payload)) return false;
  if (ownerProjectId && payload.ownerProjectId !== ownerProjectId) return false;
  return section === "settled"
    ? payload.section === "settled"
    : payload.section !== "settled";
}
