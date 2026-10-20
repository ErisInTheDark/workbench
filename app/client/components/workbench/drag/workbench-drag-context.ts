/*
 * Exports:
 * - WorkbenchDragContext: the app's drag controller, provided by WorkbenchDragProvider.
 * - DropTargetBoundaryContext: nearest extended-range boundary ownership.
 * - useWorkbenchDrag: the drag controller; `.optional` tolerates a missing provider and `.activePayload` reads the payload
 *   being dragged.
 */
"use client";

import { createContext, useCallback, useContext, useSyncExternalStore } from "react";

import type WorkbenchDragController from "../../../workbench/layout/WorkbenchDragController";

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
