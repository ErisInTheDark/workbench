/*
 * Exports:
 * - WorkbenchDragContext: the app's drag controller, provided by WorkbenchDragProvider.
 * - DropTargetBoundaryContext: nearest extended-range boundary ownership.
 * - useWorkbenchDrag: the drag controller; `.optional` tolerates a missing provider, `.activePayload` reads the payload being
 *   dragged, and `.mainPanel` begins a main-panel drag (disabled on mobile viewports).
 */
"use client";

import { createContext, useCallback, useContext, useSyncExternalStore, type PointerEvent } from "react";

import type WorkbenchDragController from "../../../workbench/layout/WorkbenchDragController";
import useMediaQuery from "../../../workbench/dom/layout/use-media-query";
import {
  mainPanelDragLabel, WORKBENCH_MAIN_PANEL_DROP_TARGET_ID, type WorkbenchMainPanelDragPayload,
} from "../../../workbench/layout/workbench-drag";
import { MOBILE_MEDIA_QUERY } from "../../../workbench/state/mobile-pane-url-state";

export const WorkbenchDragContext = createContext<WorkbenchDragController | null>(null);
export const DropTargetBoundaryContext = createContext<HTMLElement | null>(null);

const NO_SUBSCRIPTION = (_listener: () => void) => () => {};
const NO_PAYLOAD = () => null;

export function useWorkbenchDrag() {
  const controller = useContext(WorkbenchDragContext);
  if (!controller) throw new Error("Workbench drag components require a WorkbenchDragProvider.");
  return controller;
}

useWorkbenchDrag.optional = function useOptionalWorkbenchDrag() {
  return useContext(WorkbenchDragContext);
};

useWorkbenchDrag.activePayload = function useWorkbenchDragActivePayload() {
  const controller = useContext(WorkbenchDragContext);
  const read = useCallback(() => {
    const activity = controller?.getActivitySnapshot();
    return activity?.active ? activity.payload : null;
  }, [controller]);
  return useSyncExternalStore(controller?.subscribe ?? NO_SUBSCRIPTION, controller ? read : NO_PAYLOAD, controller ? read : NO_PAYLOAD);
};

useWorkbenchDrag.mainPanel = function useWorkbenchMainPanelDrag() {
  const controller = useContext(WorkbenchDragContext);
  const isMobile = useMediaQuery(MOBILE_MEDIA_QUERY);
  return useCallback((event: PointerEvent<HTMLElement>, payload: WorkbenchMainPanelDragPayload) => {
    if (isMobile || event.button !== 0) return;
    controller?.begin(event, {
      dropTargetIds: [WORKBENCH_MAIN_PANEL_DROP_TARGET_ID],
      label: mainPanelDragLabel(payload),
      payload,
    });
  }, [controller, isMobile]);
};
