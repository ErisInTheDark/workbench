/*
 * Exports:
 * - WORKBENCH_*_DROP_TARGET_ID: shared accepted-target identifiers for thread ordering, priority, row actions, and main panels. Keywords: workbench, drag, target.
 * - WorkbenchThreadDragAction/WorkbenchThreadDragPreview: icon-led action context for the cursor ghost. Keywords: workbench, drag, preview, action.
 * - WorkbenchThreadDragSection/WorkbenchThreadRowDragPayload/WorkbenchDragPayload: pointer-drag payloads for thread rows, thread folders, new threads, and main panel targets. Keywords: workbench, drag, payload, move.
 * - isWorkbenchThreadRowDragPayload/canMoveWorkbenchThreadRowToSection: identify row drags and preserve settled/project boundaries for exact placement. Keywords: workbench, drag, row, section, project.
 */

import type { WorkbenchHarness } from "workbench-shared/types";
import type { WorkbenchPanelTarget } from "workbench-shared/workbench/layout/workbench-layout";
import type { WorkbenchThreadDisplaySection } from "workbench-shared/workbench/thread/thread-display-order";

export const WORKBENCH_MAIN_PANEL_DROP_TARGET_ID = "workbench/main-panel";
export const WORKBENCH_THREAD_ORDER_DROP_TARGET_ID = "workbench/thread-order";
export const WORKBENCH_THREAD_PRIORITY_DROP_TARGET_ID = "workbench/thread-priority";
export const WORKBENCH_THREAD_ROW_ACTION_DROP_TARGET_ID = "workbench/thread-row-action";
export type WorkbenchThreadDragAction = "folder" | "main" | "pinned" | "snoozed";
export interface WorkbenchThreadDragPreview {
  action: WorkbenchThreadDragAction;
  label: string;
}
export type WorkbenchThreadDragSection = WorkbenchThreadDisplaySection | "main";

export type WorkbenchDragPayload =
  | {
    readonly sourcePanelId?: string;
    readonly target: WorkbenchPanelTarget;
    readonly type: "panel-target";
  }
  | {
    readonly harness: WorkbenchHarness;
    readonly type: "new-thread";
  }
  | {
    readonly ownerProjectId: string;
    readonly projectSourceKey: string;
    readonly section: WorkbenchThreadDragSection;
    readonly sourceKey: string;
    readonly target: WorkbenchPanelTarget;
    readonly type: "thread-row";
  }
  | {
    readonly section: WorkbenchThreadDisplaySection;
    readonly sourceKey: string;
    readonly type: "thread-folder";
  }
  | {
    readonly ownerProjectId: string;
    readonly projectSourceKey: string;
    readonly section: WorkbenchThreadDragSection;
    readonly sourceKey: string;
    readonly target: WorkbenchPanelTarget;
    readonly type: "home-thread-row";
  }
  | {
    readonly ownerProjectId: string;
    readonly section: WorkbenchThreadDisplaySection;
    readonly sourceKey: string;
    readonly type: "home-thread-folder";
  };

export type WorkbenchThreadRowDragPayload = Extract<WorkbenchDragPayload, { readonly type: "home-thread-row" | "thread-row" }>;

export function isWorkbenchThreadRowDragPayload(payload: WorkbenchDragPayload | null): payload is WorkbenchThreadRowDragPayload {
  return payload?.type === "thread-row" || payload?.type === "home-thread-row";
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
