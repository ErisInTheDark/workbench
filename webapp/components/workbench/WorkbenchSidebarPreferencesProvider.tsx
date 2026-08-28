/*
 * Exports:
 * - default WorkbenchSidebarPreferencesProvider: own, persist, and provide the active project's sidebar display preferences. Keywords: sidebar, preferences, project, persistence, provider.
 */
"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import {
  createDefaultWorkbenchProjectSidebarPreferences,
  readWorkbenchProjectSidebarPreferences,
  writeWorkbenchProjectSidebarPreferences,
  type WorkbenchProjectSidebarPreferences,
} from "../../lib/workbench/state/workbench-settings";
import {
  WorkbenchSidebarPreferencesContext,
  type WorkbenchSidebarPreferencesValue,
} from "./workbench-sidebar-preferences-context";

interface WorkbenchSidebarPreferencesState {
  readonly preferences: WorkbenchProjectSidebarPreferences;
  readonly projectId: string;
}

export default function WorkbenchSidebarPreferencesProvider({
  children,
  projectId,
}: {
  children: (value: WorkbenchSidebarPreferencesValue) => ReactNode;
  projectId: string;
}) {
  const defaultPreferences = useMemo(createDefaultWorkbenchProjectSidebarPreferences, [projectId]);
  const [state, setState] = useState<WorkbenchSidebarPreferencesState>(() => ({
    preferences: defaultPreferences,
    projectId,
  }));
  const preferences = state.projectId === projectId ? state.preferences : defaultPreferences;
  useEffect(() => {
    setState({
      preferences: projectId ? readWorkbenchProjectSidebarPreferences(projectId) : defaultPreferences,
      projectId,
    });
  }, [defaultPreferences, projectId]);

  const update = useCallback((
    transform: (current: WorkbenchProjectSidebarPreferences) => WorkbenchProjectSidebarPreferences,
  ) => {
    setState((currentState) => {
      const current = currentState.projectId === projectId ? currentState.preferences : defaultPreferences;
      const next = transform(current);
      if (projectId) writeWorkbenchProjectSidebarPreferences(projectId, next);
      return {
        preferences: next,
        projectId,
      };
    });
  }, [defaultPreferences, projectId]);
  const setDisclosureOpen = useCallback<WorkbenchSidebarPreferencesValue["setDisclosureOpen"]>(
    (key, open) => update((current) => current[key] === open ? current : { ...current, [key]: open }),
    [update],
  );
  const setFolderOpen = useCallback<WorkbenchSidebarPreferencesValue["setFolderOpen"]>((scope, folderId, open) => {
    const key = scope === "pinned" ? "pinnedFolderIds" : "threadFolderIds";
    update((current) => {
      const folderIds = current[key];
      const hasFolder = folderIds.includes(folderId);
      if (hasFolder === open) return current;
      return {
        ...current,
        [key]: open
          ? [...folderIds, folderId].slice(-500)
          : folderIds.filter((candidate) => candidate !== folderId),
      };
    });
  }, [update]);
  const value = useMemo<WorkbenchSidebarPreferencesValue>(() => ({
    preferences,
    setDisclosureOpen,
    setFolderOpen,
    setProjectTimeGroupCount: (count) => {
      const boundedCount = Math.max(1, Math.min(100, Math.floor(count)));
      update((current) => current.projectTimeGroupCount === boundedCount
        ? current
        : { ...current, projectTimeGroupCount: boundedCount });
    },
    setReloadNecessaryOpen: (open) => update((current) => current.reloadNecessaryOpen === open
      ? current
      : { ...current, reloadNecessaryOpen: open }),
    setSettledThreadItemLimit: (limit) => {
      const boundedLimit = Math.max(50, Math.min(5_000, Math.floor(limit)));
      update((current) => current.settledThreadItemLimit === boundedLimit
        ? current
        : { ...current, settledThreadItemLimit: boundedLimit });
    },
    setSidebarCollapsed: (collapsed) => update((current) => current.sidebarCollapsed === collapsed
      ? current
      : { ...current, sidebarCollapsed: collapsed }),
    setStatusCountsExpanded: (scope, expanded) => {
      const key = scope === "pinned" ? "pinnedStatusCountsExpanded" : "projectStatusCountsExpanded";
      update((current) => current[key] === expanded ? current : { ...current, [key]: expanded });
    },
  }), [preferences, setDisclosureOpen, setFolderOpen, update]);

  return (
    <WorkbenchSidebarPreferencesContext.Provider value={value}>
      {children(value)}
    </WorkbenchSidebarPreferencesContext.Provider>
  );
}
