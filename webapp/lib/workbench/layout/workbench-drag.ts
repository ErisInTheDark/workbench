/*
 * Exports:
 * - WORKBENCH_*_DROP_TARGET_ID: shared accepted-target identifiers for thread ordering and main panels. Keywords: workbench, drag, target.
 * - WorkbenchDragPayload: pointer-drag payloads for thread rows, thread folders, new threads, and main panel targets. Keywords: workbench, drag, payload, move.
 */

import type { WorkbenchHarness } from "../../types";
import type { WorkbenchPanelTarget } from "./workbench-layout";
import type { WorkbenchThreadDisplaySection } from "../thread/thread-display-order";

export const WORKBENCH_MAIN_PANEL_DROP_TARGET_ID = "workbench/main-panel";
export const WORKBENCH_THREAD_ORDER_DROP_TARGET_ID = "workbench/thread-order";

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
    readonly section: WorkbenchThreadDisplaySection;
    readonly sourceKey: string;
    readonly target: WorkbenchPanelTarget;
    readonly type: "thread-row";
  }
  | {
    readonly section: WorkbenchThreadDisplaySection;
    readonly sourceKey: string;
    readonly type: "thread-folder";
  };
