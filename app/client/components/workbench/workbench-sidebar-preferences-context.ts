/*
 * Exports:
 * - WorkbenchSidebarPreferencesContext/useWorkbenchSidebarPreferences: provide and consume global and active-project sidebar preferences;
 *   `.global` reads and persists global preferences (such as sidebar collapse) straight from client state, without the provider.
 * - WorkbenchSidebarDisplayState: memory-only git/settled/snoozed disclosure and pagination.
 * - WorkbenchSidebarDisclosurePreferenceKey/WorkbenchSidebarPreferencesValue: describe disclosure keys and persistent or transient intents.
 */
import { createContext, useCallback, useContext, useMemo } from "react";

import {
  readWorkbenchGlobalSidebarPreferences,
  writeWorkbenchGlobalSidebarPreference,
  type WorkbenchGlobalSidebarPreferences,
  type WorkbenchSidebarPreferences,
} from "../../workbench/state/workbench-settings";
import { useWorkbenchClientStateController, useWorkbenchClientStateSnapshot } from "./workbench-client-state-context";

export type WorkbenchSidebarDisclosurePreferenceKey =
  | "gitOpen"
  | "browseSessionsOpen"
  | "explorerOpen"
  | "pinnedThreadsOpen"
  | "projectsOpen"
  | "settledThreadsOpen"
  | "snoozedThreadsOpen"
  | "threadsOpen";

export interface WorkbenchSidebarDisplayState {
  gitOpen: boolean;
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
  setProjectTimeGroupCount(count: number): void;
  setReloadNecessaryOpen(open: boolean): void;
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
  const clientState = useWorkbenchClientStateSnapshot();
  const preferences = useMemo(
    () => readWorkbenchGlobalSidebarPreferences(clientState.daemonRegistrationId, clientState.records),
    [clientState.daemonRegistrationId, clientState.records],
  );
  const set = useCallback(<Key extends keyof WorkbenchGlobalSidebarPreferences>(
    key: Key,
    value: WorkbenchGlobalSidebarPreferences[Key],
  ) => {
    if (preferences[key] === value) return;
    void writeWorkbenchGlobalSidebarPreference(controller, clientState.schemaVersion, key, value).catch((error) => {
      console.error("Workbench global sidebar preference persistence failed.", error);
    });
  }, [clientState.schemaVersion, controller, preferences]);
  return useMemo(() => ({ preferences, set }), [preferences, set]);
};
