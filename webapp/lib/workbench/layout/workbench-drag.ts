/*
 * Exports:
 * - WorkbenchDragPayload: pointer-drag payloads for sidebar sections and main panel targets. Keywords: workbench, drag, payload, move.
 */

import type { WorkbenchSidebarSectionId } from "./workbench-layout-storage";
import type { WorkbenchHarness } from "../../types";
import type { WorkbenchPanelTarget } from "./workbench-layout";

export type WorkbenchDragPayload =
  | {
    readonly sectionId: WorkbenchSidebarSectionId;
    readonly type: "sidebar-section";
  }
  | {
    readonly sourcePanelId?: string;
    readonly target: WorkbenchPanelTarget;
    readonly type: "panel-target";
  }
  | {
    readonly harness: WorkbenchHarness;
    readonly type: "new-thread";
  };
