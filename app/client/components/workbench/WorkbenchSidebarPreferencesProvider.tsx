/*
 * Exports:
 * - default WorkbenchSidebarPreferencesProvider: compose persisted preferences and memory-only Git/settled disclosure state.
 */
"use client";

import {
  useCallback,
  useMemo,
  useState,
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
} from "../../workbench/state/workbench-settings";
import {
  WorkbenchSidebarPreferencesContext,
  type WorkbenchSidebarDisplayState,
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
  const [displayState, setDisplayState] = useState<WorkbenchSidebarDisplayState>({
    gitOpen: true,
    settledThreadItemLimit: 50,
    settledThreadsOpen: false,
  });
  const preferences = useMemo(() => {
    const projectPreferences = projectId
      ? readWorkbenchProjectSidebarPreferences(clientState.daemonRegistrationId, projectId, clientState.records)
      : createDefaultWorkbenchProjectSidebarPreferences();
    return {
      ...projectPreferences,
      ...readWorkbenchGlobalSidebarPreferences(clientState.daemonRegistrationId, clientState.records),
      ...displayState,
    };
  }, [clientState.daemonRegistrationId, clientState.records, displayState, projectId]);

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
    value: boolean,
  ) => {
    if (!projectId || preferences[key] === value) return;
    void writeWorkbenchProjectSidebarPreference(controller, projectId, key, value).catch((error) => {
      console.error("Workbench project sidebar preference persistence failed.", error);
    });
  }, [controller, preferences, projectId]);
  const setDisclosureOpen = useCallback<WorkbenchSidebarPreferencesValue["setDisclosureOpen"]>(
    (key, open) => {
      if (key === "gitOpen") {
        setDisplayState(previous => ({ ...previous, gitOpen: open }));
      } else if (key === "settledThreadsOpen") {
        setDisplayState(previous => previous.settledThreadsOpen === open ? previous : {
          ...previous,
          settledThreadsOpen: open,
          settledThreadItemLimit: open ? 50 : previous.settledThreadItemLimit,
        });
      } else if (key === "projectsOpen") persistGlobalPreference(key, open);
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
      setDisplayState(previous => previous.settledThreadItemLimit === boundedLimit ? previous : {
        ...previous, settledThreadItemLimit: boundedLimit,
      });
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
