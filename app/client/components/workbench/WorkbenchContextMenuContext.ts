/*
 * Exports:
 * - WorkbenchContextMenuAction: context-menu command row.
 * - WorkbenchContextMenuControl: grouped icon control.
 * - WorkbenchContextMenuControlGroup: grouped commands, checkboxes, or radio controls.
 * - WorkbenchContextMenuSeparator: menu section divider.
 * - WorkbenchContextMenuChecklistTree/WorkbenchContextMenuChecklistItem: scrollable grouped checkbox tree.
 * - WorkbenchContextMenuItem: supported menu rows.
 * - WorkbenchContextMenuDefinition/WorkbenchContextMenuRequest: document context-menu content and placement contracts.
 * - WorkbenchContextMenuController: controller exposed to context-menu capabilities.
 * - useWorkbenchContextMenu: read the canonical document context-menu controller.
 * - default WorkbenchContextMenuContext: canonical React context shared by the provider and consumers.
 */
"use client";

import { createContext, useContext, type ReactNode } from "react";

import type { ContextMenuPlacementScope } from "./context-menu-placement";
import type { WorkbenchThreadStatusControlTone } from "./workbench-thread-status-colors";

export interface WorkbenchContextMenuAction {
  disabled?: boolean;
  /** Selecting needs a press held this long, for actions that cannot be undone. */
  holdToConfirmMs?: number;
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
  closeOnSelect?: boolean;
  controls: WorkbenchContextMenuControl[];
  id: string;
  kind: "control-group";
  label: string;
  presentation: "connected" | "independent" | "actions";
}

export interface WorkbenchContextMenuSeparator {
  id: string;
  kind: "separator";
}

/** One checkbox leaf; `note` is muted trailing text, `title` hover text (defaults to `label`). */
export interface WorkbenchContextMenuChecklistItem {
  checked: boolean;
  disabled?: boolean;
  id: string;
  label: string;
  note?: string;
  title?: string;
}

/** Scrollable two-level checklist; group rows show and toggle their enabled items. The menu stays open. */
export interface WorkbenchContextMenuChecklistTree {
  groups: Array<{ id: string; items: WorkbenchContextMenuChecklistItem[]; label: string }>;
  id: string;
  kind: "checklist-tree";
  label: string;
  onToggle: (itemIds: string[], checked: boolean) => void;
}

export type WorkbenchContextMenuItem = WorkbenchContextMenuAction | WorkbenchContextMenuControlGroup
  | WorkbenchContextMenuSeparator | WorkbenchContextMenuChecklistTree;

export interface WorkbenchContextMenuDefinition {
  id: string;
  items: WorkbenchContextMenuItem[];
  label: string;
  placementScope?: ContextMenuPlacementScope;
}

export interface WorkbenchContextMenuRequest {
  menu: WorkbenchContextMenuDefinition;
  x: number;
  y: number;
}

export interface WorkbenchContextMenuController {
  closeContextMenu: () => void;
  openContextMenu: (request: WorkbenchContextMenuRequest) => void;
  refreshContextMenu: (menu: WorkbenchContextMenuDefinition) => void;
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
