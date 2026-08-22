/*
 * Exports:
 * - WorkbenchContextMenuAction/WorkbenchContextMenuControlGroup/WorkbenchContextMenuItem: contracts for context-menu rows, grouped controls, and separators. Keywords: context menu, action, checkbox, radio, separator.
 * - WorkbenchContextMenuDefinition/WorkbenchContextMenuRequest: contracts for document context menu content and placement. Keywords: context menu, definition, request.
 * - WorkbenchContextMenuController: controller exposed to context-menu capabilities. Keywords: context menu, controller, open, close.
 * - useWorkbenchContextMenu: read the canonical document context menu controller. Keywords: context menu, hook, controller.
 * - default WorkbenchContextMenuContext: canonical React context shared by the provider and consumers. Keywords: context menu, context, provider.
 */
"use client";

import { createContext, useContext, type ReactNode } from "react";

import type { WorkbenchThreadStatusControlTone } from "./workbench-thread-status-colors";

export interface WorkbenchContextMenuAction {
  disabled?: boolean;
  icon?: ReactNode;
  id: string;
  kind?: "action";
  label: string;
  onSelect: () => void;
  tone?: "default" | "danger";
}

export interface WorkbenchContextMenuControl {
  checked: boolean;
  disabled?: boolean;
  icon: ReactNode;
  id: string;
  label: string;
  onSelect: () => void;
  tone?: WorkbenchThreadStatusControlTone | "default" | "danger";
}

export interface WorkbenchContextMenuControlGroup {
  controls: WorkbenchContextMenuControl[];
  id: string;
  kind: "control-group";
  label: string;
  presentation: "connected" | "independent";
}

export interface WorkbenchContextMenuSeparator {
  id: string;
  kind: "separator";
}

export type WorkbenchContextMenuItem = WorkbenchContextMenuAction | WorkbenchContextMenuControlGroup | WorkbenchContextMenuSeparator;

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
