/*
 * Exports:
 * - default WorkbenchSidebarPreferencesProvider: compose global shell and active-project sidebar preferences behind focused intents. Keywords: sidebar, preferences, global, project, home, persistence, provider.
 */
"use client";

import {
  useCallback,
  useMemo,
  type ReactNode,
} from "react";

import {
  createDefaultWorkbenchProjectSidebarPreferences,
  readWorkbenchGlobalSidebarPreferences,
  readWorkbenchProjectSidebarPreferences,
  setWorkbenchProjectSidebarFolderOpen,
  writeWorkbenchGlobalSidebarPreference,
  writeWorkbenchProjectSidebarPreference,
  type WorkbenchGlobalSidebarPreferences,
  type WorkbenchProjectSidebarPreferences,
} from "../../lib/workbench/state/workbench-settings";
import {
  WorkbenchSidebarPreferencesContext,
  type WorkbenchSidebarPreferencesValue,
} from "./workbench-sidebar-preferences-context";
import {
  useWorkbenchClientStateController,
  useWorkbenchClientStateSnapshot,
} from "./workbench-client-state-context";

export default function WorkbenchSidebarPreferencesProvider({
  children,
  projectId,
}: {
  children: (value: WorkbenchSidebarPreferencesValue) => ReactNode;
  projectId: string;
}) {
  const controller = useWorkbenchClientStateController();
  const clientState = useWorkbenchClientStateSnapshot();
  const preferences = useMemo(() => {
    const projectPreferences = projectId
      ? readWorkbenchProjectSidebarPreferences(clientState.daemonRegistrationId, projectId, clientState.records)
      : createDefaultWorkbenchProjectSidebarPreferences();
    return {
      ...projectPreferences,
      ...readWorkbenchGlobalSidebarPreferences(clientState.daemonRegistrationId, clientState.records),
    };
  }, [clientState.daemonRegistrationId, clientState.records, projectId]);

  const persistGlobalPreference = useCallback((
    key: keyof WorkbenchGlobalSidebarPreferences,
    value: boolean | number,
  ) => {
    if (preferences[key] === value) return;
    void writeWorkbenchGlobalSidebarPreference(controller, clientState.schemaVersion, key, value).catch((error) => {
      console.error("Workbench global sidebar preference persistence failed.", error);
    });
  }, [clientState.schemaVersion, controller, preferences]);
  const persistProjectPreference = useCallback((
    key: Exclude<keyof WorkbenchProjectSidebarPreferences, "pinnedFolderIds" | "threadFolderIds">,
    value: boolean | number,
  ) => {
    if (!projectId || preferences[key] === value) return;
    void writeWorkbenchProjectSidebarPreference(controller, projectId, key, value).catch((error) => {
      console.error("Workbench project sidebar preference persistence failed.", error);
    });
  }, [controller, preferences, projectId]);
  const setDisclosureOpen = useCallback<WorkbenchSidebarPreferencesValue["setDisclosureOpen"]>(
    (key, open) => {
      if (key === "projectsOpen") persistGlobalPreference(key, open);
      else persistProjectPreference(key, open);
    },
    [persistGlobalPreference, persistProjectPreference],
  );
  const setFolderOpen = useCallback<WorkbenchSidebarPreferencesValue["setFolderOpen"]>((scope, folderId, open) => {
    const key = scope === "pinned" ? "pinnedFolderIds" : "threadFolderIds";
    if (!projectId || preferences[key].includes(folderId) === open) return;
    const storedScope = scope === "pinned" ? "pinned" : "thread";
    const operation = async () => {
      if (open && preferences[key].length >= 500) {
        const oldestFolderId = preferences[key][0];
        if (oldestFolderId) {
          await setWorkbenchProjectSidebarFolderOpen(
            controller,
            projectId,
            storedScope,
            oldestFolderId,
            false,
          );
        }
      }
      await setWorkbenchProjectSidebarFolderOpen(
        controller,
        projectId,
        storedScope,
        folderId,
        open,
      );
    };
    void operation().catch((error) => {
      console.error("Workbench sidebar folder persistence failed.", error);
    });
  }, [controller, preferences, projectId]);
  const value = useMemo<WorkbenchSidebarPreferencesValue>(() => ({
    preferences,
    setDisclosureOpen,
    setFolderOpen,
    setProjectTimeGroupCount: (count) => {
      const boundedCount = Math.max(1, Math.min(100, Math.floor(count)));
      persistGlobalPreference("projectTimeGroupCount", boundedCount);
    },
    setReloadNecessaryOpen: (open) => persistGlobalPreference("reloadNecessaryOpen", open),
    setSettledThreadItemLimit: (limit) => {
      const boundedLimit = Math.max(50, Math.min(5_000, Math.floor(limit)));
      persistProjectPreference("settledThreadItemLimit", boundedLimit);
    },
    setSidebarCollapsed: (collapsed) => persistGlobalPreference("sidebarCollapsed", collapsed),
    setStatusCountsExpanded: (scope, expanded) => {
      if (scope === "pinned") persistProjectPreference("pinnedStatusCountsExpanded", expanded);
      else persistGlobalPreference("projectStatusCountsExpanded", expanded);
    },
  }), [
    persistGlobalPreference,
    persistProjectPreference,
    preferences,
    setDisclosureOpen,
    setFolderOpen,
  ]);

  return (
    <WorkbenchSidebarPreferencesContext.Provider value={value}>
      {children(value)}
    </WorkbenchSidebarPreferencesContext.Provider>
  );
}
