/*
 * Exports:
 * - WorkbenchContextMenuItem/WorkbenchContextMenuDefinition/WorkbenchContextMenuRequest: contracts for document context menu actions and placement. Keywords: context menu, item, definition, request.
 * - WorkbenchContextMenuController: controller exposed to context-menu capabilities. Keywords: context menu, controller, open, close.
 * - useWorkbenchContextMenu: read the canonical document context menu controller. Keywords: context menu, hook, controller.
 * - default WorkbenchContextMenuContext: canonical React context shared by the provider and consumers. Keywords: context menu, context, provider.
 */
"use client";

import { createContext, useContext, type ReactNode } from "react";

export interface WorkbenchContextMenuItem {
  disabled?: boolean;
  icon?: ReactNode;
  id: string;
  label: string;
  onSelect: () => void;
  tone?: "default" | "danger";
}

export interface WorkbenchContextMenuDefinition {
  id: string;
  items: WorkbenchContextMenuItem[];
  label: string;
}

export interface WorkbenchContextMenuRequest {
  menu: WorkbenchContextMenuDefinition;
  x: number;
  y: number;
}

export interface WorkbenchContextMenuController {
  closeContextMenu: () => void;
  openContextMenu: (request: WorkbenchContextMenuRequest) => void;
}

const WorkbenchContextMenuContext = createContext<WorkbenchContextMenuController | null>(null);

export function useWorkbenchContextMenu() {
  const controller = useContext(WorkbenchContextMenuContext);
  if (!controller) {
    throw new Error("useWorkbenchContextMenu must be used inside WorkbenchContextMenuProvider.");
  }

  return controller;
}

export default WorkbenchContextMenuContext;
