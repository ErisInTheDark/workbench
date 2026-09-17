/*
 * Exports:
 * - WorkbenchSidebarPreferencesContext/useWorkbenchSidebarPreferences: provide and consume global and active-project sidebar preferences.
 * - WorkbenchSidebarDisplayState: memory-only git/settled disclosure and pagination.
 * - WorkbenchSidebarDisclosurePreferenceKey/WorkbenchSidebarPreferencesValue: describe disclosure keys and persistent or transient intents.
 */
import { createContext, useContext } from "react";

import type { WorkbenchSidebarPreferences } from "../../workbench/state/workbench-settings";

export type WorkbenchSidebarDisclosurePreferenceKey =
  | "gitOpen"
  | "browseSessionsOpen"
  | "explorerOpen"
  | "pinnedThreadsOpen"
  | "projectsOpen"
  | "settledThreadsOpen"
  | "threadsOpen";

export interface WorkbenchSidebarDisplayState {
  gitOpen: boolean;
  settledThreadItemLimit: number;
  settledThreadsOpen: boolean;
}

export interface WorkbenchSidebarPreferencesValue {
  readonly preferences: WorkbenchSidebarPreferences & WorkbenchSidebarDisplayState;
  setDisclosureOpen(key: WorkbenchSidebarDisclosurePreferenceKey, open: boolean): void;
  setFolderOpen(scope: "pinned" | "threads", folderId: string, open: boolean): void;
  setProjectTimeGroupCount(count: number): void;
  setReloadNecessaryOpen(open: boolean): void;
  setSettledThreadItemLimit(limit: number): void;
  setSidebarCollapsed(collapsed: boolean): void;
  setStatusCountsExpanded(scope: "pinned" | "project", expanded: boolean): void;
}

export const WorkbenchSidebarPreferencesContext = createContext<WorkbenchSidebarPreferencesValue | null>(null);

export function useWorkbenchSidebarPreferences() {
  const value = useContext(WorkbenchSidebarPreferencesContext);
  if (!value) throw new Error("Workbench sidebar preferences require WorkbenchSidebarPreferencesProvider.");
  return value;
}
