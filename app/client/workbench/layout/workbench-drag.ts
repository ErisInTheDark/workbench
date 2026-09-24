/*
 * Exports:
 * - WORKBENCH_*_DROP_TARGET_ID: shared accepted-target identifiers for thread ordering, priority, row actions, and main panels.
 * - WorkbenchThreadDragAction/WorkbenchThreadDragPreview: icon-led action context for the cursor ghost.
 * - WorkbenchThreadDragSection/WorkbenchThreadRowDragPayload/WorkbenchDragPayload: pointer-drag payloads for thread rows, thread folders, new threads, and main panel targets.
 * - isWorkbenchThreadRowDragPayload/canMoveWorkbenchThreadRowToSection: identify row drags and preserve settled/project boundaries for exact placement.
 */

import type { WorkbenchHarness } from "workbench-shared/types";
import type { WorkbenchPanelTarget } from "workbench-shared/workbench/layout/workbench-layout";
import type { WorkbenchThreadDisplaySection } from "workbench-shared/workbench/thread/thread-display-order";
import type { ThreadDisplayKey } from "workbench-shared/workbench/identity";
import type { WorkbenchThreadTarget } from "workbench-shared/workbench/thread/thread-state";

type SidebarThreadTarget = Extract<WorkbenchPanelTarget, { kind: "thread" }> & { target: WorkbenchThreadTarget };

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
    readonly projectSourceKey: ThreadDisplayKey;
    readonly section: WorkbenchThreadDragSection;
    readonly sourceKey: string;
    readonly target: SidebarThreadTarget;
    readonly type: "thread-row";
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
    readonly target: SidebarThreadTarget;
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
