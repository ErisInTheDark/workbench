/*
 * Exports:
 * - WorkbenchSidebarPreferencesContext/useWorkbenchSidebarPreferences: provide and consume global and active-project sidebar preferences;
 *   `.global` reads and persists global preferences (such as sidebar collapse) straight from client state, without the provider.
 * - WorkbenchSidebarDisplayState: memory-only panel choice, settled/snoozed disclosure and pagination.
 * - WorkbenchSidebarDisclosurePreferenceKey/WorkbenchSidebarPreferencesValue: describe disclosure keys and persistent or transient intents.
 */
import { createContext, useCallback, useContext, useMemo } from "react";

import {
  readWorkbenchGlobalSidebarPreferences,
  writeWorkbenchGlobalSidebarPreference,
  type WorkbenchGlobalSidebarPreferences,
  type WorkbenchSidebarPreferences,
} from "../../workbench/state/workbench-settings";
import type { WorkbenchSidebarPanel } from "./sidebar/sidebar-panel";
import { useWorkbenchClientState, useWorkbenchClientStateController } from "./workbench-client-state-context";

export type WorkbenchSidebarDisclosurePreferenceKey =
  | "browseSessionsOpen"
  | "explorerOpen"
  | "pinnedThreadsOpen"
  | "projectsOpen"
  | "settledThreadsOpen"
  | "snoozedThreadsOpen"
  | "threadsOpen";

export interface WorkbenchSidebarDisplayState {
  /** The panel between the fixed header and status footer. */
  panel: WorkbenchSidebarPanel;
  settledThreadItemLimit: number;
  settledThreadsOpen: boolean;
  snoozedThreadsOpen: boolean;
}

export interface WorkbenchSidebarPreferencesValue {
  readonly preferences: WorkbenchSidebarPreferences & WorkbenchSidebarDisplayState;
  /** Home folder keys of open folders, whichever project is viewed. */
  readonly openFolderKeys: ReadonlySet<string>;
  setDisclosureOpen(key: WorkbenchSidebarDisclosurePreferenceKey, open: boolean): void;
  /** `projectId` is the folder's own logical project. */
  setFolderOpen(projectId: string, folderId: string, open: boolean): void;
  setPanel(panel: WorkbenchSidebarPanel): void;
  setProjectTimeGroupCount(count: number): void;
  setSettledThreadItemLimit(limit: number): void;
  setStatusCountsExpanded(scope: "pinned" | "project", expanded: boolean): void;
}

export const WorkbenchSidebarPreferencesContext = createContext<WorkbenchSidebarPreferencesValue | null>(null);

export function useWorkbenchSidebarPreferences() {
  const value = useContext(WorkbenchSidebarPreferencesContext);
  if (!value) throw new Error("Workbench sidebar preferences require WorkbenchSidebarPreferencesProvider.");
  return value;
}

useWorkbenchSidebarPreferences.global = function useWorkbenchGlobalSidebarPreferences() {
  const controller = useWorkbenchClientStateController();
  const preferences = useWorkbenchClientState(state =>
    readWorkbenchGlobalSidebarPreferences(state.daemonRegistrationId, state.records));
  const schemaVersion = useWorkbenchClientState(state => state.schemaVersion);
  const set = useCallback(<Key extends keyof WorkbenchGlobalSidebarPreferences>(
    key: Key,
    value: WorkbenchGlobalSidebarPreferences[Key],
  ) => {
    if (preferences[key] === value) return;
    void writeWorkbenchGlobalSidebarPreference(controller, schemaVersion, key, value).catch((error) => {
      console.error("Workbench global sidebar preference persistence failed.", error);
    });
  }, [schemaVersion, controller, preferences]);
  return useMemo(() => ({ preferences, set }), [preferences, set]);
};
