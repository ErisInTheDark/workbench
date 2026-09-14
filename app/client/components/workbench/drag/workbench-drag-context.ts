/*
 * Exports:
 * - WorkbenchDragContext/useWorkbenchDragController: shared drag-controller access for reusable drag components. Keywords: React, context, controller.
 * - DropTargetBoundaryContext: nearest extended-range boundary ownership. Keywords: drop, closest, boundary.
 */
"use client";

import { createContext, useContext } from "react";

import type WorkbenchDragController from "../../../workbench/layout/WorkbenchDragController";

export const WorkbenchDragContext = createContext<WorkbenchDragController | null>(null);
export const DropTargetBoundaryContext = createContext<HTMLElement | null>(null);

export function useOptionalWorkbenchDragController() { return useContext(WorkbenchDragContext); }

export function useWorkbenchDragController() {
  const controller = useOptionalWorkbenchDragController();
  if (!controller) throw new Error("Workbench drag components require a WorkbenchDragProvider.");
  return controller;
}
