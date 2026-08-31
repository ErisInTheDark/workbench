/*
 * Exports:
 * - default WorkbenchSidebarPreferencesProvider: own, persist, and provide the active project's sidebar display preferences. Keywords: sidebar, preferences, project, persistence, provider.
 */
"use client";

import {
  useCallback,
  useMemo,
  type ReactNode,
} from "react";

import {
  createDefaultWorkbenchProjectSidebarPreferences,
  readWorkbenchProjectSidebarPreferences,
  setWorkbenchProjectSidebarFolderOpen,
  writeWorkbenchProjectSidebarPreference,
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
    return projectId
      ? readWorkbenchProjectSidebarPreferences(clientState.daemonRegistrationId, projectId, clientState.records)
      : createDefaultWorkbenchProjectSidebarPreferences();
  }, [clientState.daemonRegistrationId, clientState.records, projectId]);

  const persistPreference = useCallback((
    key: Exclude<keyof WorkbenchProjectSidebarPreferences, "pinnedFolderIds" | "threadFolderIds">,
    value: boolean | number,
  ) => {
    if (!projectId || preferences[key] === value) return;
    void writeWorkbenchProjectSidebarPreference(controller, projectId, key, value).catch((error) => {
      console.error("Workbench sidebar preference persistence failed.", error);
    });
  }, [controller, preferences, projectId]);
  const setDisclosureOpen = useCallback<WorkbenchSidebarPreferencesValue["setDisclosureOpen"]>(
    (key, open) => persistPreference(key, open),
    [persistPreference],
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
      persistPreference("projectTimeGroupCount", boundedCount);
    },
    setReloadNecessaryOpen: (open) => persistPreference("reloadNecessaryOpen", open),
    setSettledThreadItemLimit: (limit) => {
      const boundedLimit = Math.max(50, Math.min(5_000, Math.floor(limit)));
      persistPreference("settledThreadItemLimit", boundedLimit);
    },
    setSidebarCollapsed: (collapsed) => persistPreference("sidebarCollapsed", collapsed),
    setStatusCountsExpanded: (scope, expanded) => {
      const key = scope === "pinned" ? "pinnedStatusCountsExpanded" : "projectStatusCountsExpanded";
      persistPreference(key, expanded);
    },
  }), [persistPreference, preferences, setDisclosureOpen, setFolderOpen]);

  return (
    <WorkbenchSidebarPreferencesContext.Provider value={value}>
      {children(value)}
    </WorkbenchSidebarPreferencesContext.Provider>
  );
}
