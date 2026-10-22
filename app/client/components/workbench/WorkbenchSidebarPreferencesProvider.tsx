/*
 * Exports:
 * - default WorkbenchSidebarPreferencesProvider: compose global and project-scoped persisted preferences, folder-owned
 *   folder disclosure, and memory-only panel choice and settled/snoozed disclosure state.
 */
"use client";

import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  readWorkbenchProjectSidebarPreferences,
  readWorkbenchSidebarOpenFolders,
  setWorkbenchSidebarFolderOpen,
  writeWorkbenchGlobalSidebarPreference,
  writeWorkbenchProjectSidebarPreference,
  type WorkbenchProjectSidebarPreferences,
} from "../../workbench/state/workbench-settings";
import {
  useWorkbenchSidebarPreferences,
  WorkbenchSidebarPreferencesContext,
  type WorkbenchSidebarDisclosurePreferenceKey,
  type WorkbenchSidebarDisplayState,
  type WorkbenchSidebarPreferencesValue,
} from "./workbench-sidebar-preferences-context";
import {
  useWorkbenchClientState,
  useWorkbenchClientStateController,
} from "./workbench-client-state-context";

export default function WorkbenchSidebarPreferencesProvider({
  children,
  projectId,
}: {
  children: ReactNode;
  projectId: string;
}) {
  const controller = useWorkbenchClientStateController();
  const projectPreferences = useWorkbenchClientState(state =>
    readWorkbenchProjectSidebarPreferences(state.daemonRegistrationId, projectId, state.records));
  const openFolders = useWorkbenchClientState(state =>
    readWorkbenchSidebarOpenFolders(state.daemonRegistrationId, state.records));
  const schemaVersion = useWorkbenchClientState(state => state.schemaVersion);
  const globalPreferences = useWorkbenchSidebarPreferences.global();
  const [displayState, setDisplayState] = useState<WorkbenchSidebarDisplayState>({
    panel: "threads",
    settledThreadItemLimit: 50,
    settledThreadsOpen: false,
    snoozedThreadsOpen: false,
  });
  const [pendingDisclosure, setPendingDisclosure] = useState<Partial<Record<WorkbenchSidebarDisclosurePreferenceKey, boolean>>>({});
  const disclosureGeneration = useRef(new Map<WorkbenchSidebarDisclosurePreferenceKey, number>());
  const persistedPreferences = useMemo(() => ({
    ...projectPreferences,
    ...globalPreferences.preferences,
  }), [globalPreferences.preferences, projectPreferences]);
  const preferences = useMemo(() => ({
    ...persistedPreferences, ...displayState, ...pendingDisclosure,
  }), [displayState, pendingDisclosure, persistedPreferences]);

  const persistProjectPreference = useCallback((
    key: keyof WorkbenchProjectSidebarPreferences,
    value: boolean,
  ) => {
    if (!projectId || persistedPreferences[key] === value) return;
    void writeWorkbenchProjectSidebarPreference(controller, projectId, key, value).catch((error) => {
      console.error("Workbench project sidebar preference persistence failed.", error);
    });
  }, [controller, persistedPreferences, projectId]);
  const setDisclosureOpen = useCallback<WorkbenchSidebarPreferencesValue["setDisclosureOpen"]>(
    (key, open) => {
      if (key === "settledThreadsOpen") {
        setDisplayState(previous => previous.settledThreadsOpen === open ? previous : {
          ...previous,
          settledThreadsOpen: open,
          settledThreadItemLimit: open ? 50 : previous.settledThreadItemLimit,
        });
      } else if (key === "snoozedThreadsOpen") {
        setDisplayState(previous => previous.snoozedThreadsOpen === open ? previous : {
          ...previous,
          snoozedThreadsOpen: open,
        });
      } else {
        if (preferences[key] === open || key !== "projectsOpen" && !projectId) return;
        const generation = (disclosureGeneration.current.get(key) ?? 0) + 1;
        disclosureGeneration.current.set(key, generation);
        setPendingDisclosure(previous => ({ ...previous, [key]: open }));
        const clear = () => {
          if (disclosureGeneration.current.get(key) !== generation) return;
          setPendingDisclosure(previous => {
            const next = { ...previous };
            delete next[key];
            return next;
          });
        };
        const write = key === "projectsOpen"
          ? writeWorkbenchGlobalSidebarPreference(controller, schemaVersion, key, open)
          : writeWorkbenchProjectSidebarPreference(controller, projectId, key, open);
        void write.then(clear, error => {
          clear();
          console.error("Workbench sidebar disclosure persistence failed.", error);
        });
      }
    },
    [schemaVersion, controller, preferences, projectId],
  );
  const openFolderKeys = useMemo(() => new Set(openFolders.map(folder => folder.key)), [openFolders]);
  const setFolderOpen = useCallback<WorkbenchSidebarPreferencesValue["setFolderOpen"]>((folderProjectId, folderId, open) => {
    if (openFolders.some(folder => folder.projectId === folderProjectId && folder.folderId === folderId) === open) return;
    const operation = async () => {
      const oldest = openFolders[0];
      if (open && openFolders.length >= 500 && oldest) {
        await setWorkbenchSidebarFolderOpen(controller, oldest.projectId, oldest.folderId, false);
      }
      await setWorkbenchSidebarFolderOpen(controller, folderProjectId, folderId, open);
    };
    void operation().catch((error) => {
      console.error("Workbench sidebar folder persistence failed.", error);
    });
  }, [controller, openFolders]);
  const value = useMemo<WorkbenchSidebarPreferencesValue>(() => ({
    openFolderKeys,
    preferences,
    setDisclosureOpen,
    setFolderOpen,
    setProjectTimeGroupCount: (count) => {
      const boundedCount = Math.max(1, Math.min(100, Math.floor(count)));
      globalPreferences.set("projectTimeGroupCount", boundedCount);
    },
    setPanel: (panel) => setDisplayState(previous => previous.panel === panel ? previous : { ...previous, panel }),
    setSettledThreadItemLimit: (limit) => {
      const boundedLimit = Math.max(50, Math.min(5_000, Math.floor(limit)));
      setDisplayState(previous => previous.settledThreadItemLimit === boundedLimit ? previous : {
        ...previous, settledThreadItemLimit: boundedLimit,
      });
    },
    setStatusCountsExpanded: (scope, expanded) => {
      if (scope === "pinned") persistProjectPreference("pinnedStatusCountsExpanded", expanded);
      else globalPreferences.set("projectStatusCountsExpanded", expanded);
    },
  }), [
    globalPreferences,
    openFolderKeys,
    persistProjectPreference,
    preferences,
    setDisclosureOpen,
    setFolderOpen,
  ]);

  return (
    <WorkbenchSidebarPreferencesContext.Provider value={value}>
      {children}
    </WorkbenchSidebarPreferencesContext.Provider>
  );
}
