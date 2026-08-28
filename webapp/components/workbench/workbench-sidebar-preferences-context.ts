/*
 * Exports:
 * - WorkbenchSidebarPreferencesContext/useWorkbenchSidebarPreferences: provide and consume the active project's sidebar display preferences. Keywords: sidebar, preferences, context, hook.
 * - WorkbenchSidebarDisclosurePreferenceKey/WorkbenchSidebarPreferencesValue: describe persisted disclosure keys and preference intent methods. Keywords: sidebar, disclosure, settings, types.
 */
import { createContext, useContext } from "react";

import type { WorkbenchProjectSidebarPreferences } from "../../lib/workbench/state/workbench-settings";

export type WorkbenchSidebarDisclosurePreferenceKey =
  | "browseSessionsOpen"
  | "explorerOpen"
  | "pinnedThreadsOpen"
  | "projectsOpen"
  | "settledThreadsOpen"
  | "threadsOpen";

export interface WorkbenchSidebarPreferencesValue {
  readonly preferences: WorkbenchProjectSidebarPreferences;
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
