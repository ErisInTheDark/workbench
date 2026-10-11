/*
 * Exports:
 * - useProjects: read the logical projects; members read their group tiers, daemon folder catalogues, logical and per-project thread summaries, and the route's project selection.
 * - useProject: read one logical project by id; members read the project owning a folder location and one project's summary.
 */
"use client";

import { useCallback, useContext, useRef, useSyncExternalStore } from "react";

import type {
  WorkbenchLogicalProject, WorkbenchLogicalProjectSummary, WorkbenchLogicalThreadRow, WorkbenchProjectOption,
} from "workbench-shared/types";
import { areDeeplyEqual } from "workbench-shared/workbench/deep-equality";
import type { ProjectLocationReference } from "workbench-shared/workbench/project/project-location";
import type { WorkbenchProjectThreadSummaries } from "workbench-shared/workbench/thread/thread-state";
import type { WorkbenchProjectThreadRowSidebars } from "workbench-shared/workbench/thread/thread-sidebar-row";
import type ProjectFactsStore from "../../workbench/project/ProjectFactsStore";
import type { ProjectGroupFacts } from "../../workbench/project/ProjectFactsStore";
import {
  resolveProjectSelection, type ProjectSelection, type ProjectSelectionFacts,
} from "../../workbench/project/project-selection";
import WorkbenchClientContext, { type WorkbenchClientController } from "./workbench-client-context";

const EMPTY_SUBSCRIBE = (_listener: () => void) => () => {};
const NO_PROJECTS: readonly WorkbenchLogicalProject[] = [];
const NO_GROUPS: ProjectGroupFacts = { phase: "pending", data: null };
const EMPTY_PROJECT_THREAD_SUMMARIES: WorkbenchProjectThreadSummaries = { projects: [] };

function useFacts<Value>(read: (store: ProjectFactsStore) => Value, fallback: Value, explicitClient?: WorkbenchClientController) {
  const providedClient = useContext(WorkbenchClientContext);
  const store = (explicitClient ?? providedClient)?.mounted?.projectFacts ?? null;
  const getSnapshot = () => store ? read(store) : fallback;
  return useSyncExternalStore(store?.subscribe ?? EMPTY_SUBSCRIBE, getSnapshot, getSnapshot);
}

export function useProjects(explicitClient?: WorkbenchClientController) {
  return useFacts(store => store.getProjects(), NO_PROJECTS, explicitClient);
}

useProjects.groups = function useProjectGroups(explicitClient?: WorkbenchClientController) {
  return useFacts(store => store.getGroups(), NO_GROUPS, explicitClient);
};

/** Daemon folder catalogues and unregistered folders; null until project facts first land. */
useProjects.folders = function useProjectFolders(explicitClient?: WorkbenchClientController) {
  return useFacts(store => store.getFolders(), null, explicitClient);
};

useProjects.threads = function useProjectThreads(explicitClient?: WorkbenchClientController) {
  const providedClient = useContext(WorkbenchClientContext);
  const store = (explicitClient ?? providedClient)?.mounted?.threadSidebar ?? null;
  const getSnapshot = store?.getProjectThreadSummaries ?? (() => EMPTY_PROJECT_THREAD_SUMMARIES);
  return useSyncExternalStore(store?.subscribe ?? EMPTY_SUBSCRIBE, getSnapshot, getSnapshot);
};

const NO_SUMMARIES: Readonly<Record<string, WorkbenchLogicalProjectSummary>> = {};

/** Every logical project's summary by project id. */
useProjects.summaries = function useProjectSummaries(explicitClient?: WorkbenchClientController) {
  return useFacts(store => store.getData()?.summaries ?? NO_SUMMARIES, NO_SUMMARIES, explicitClient);
};

const EMPTY_SIDEBARS: WorkbenchProjectThreadRowSidebars = { projects: [] };
const NO_ROWS: readonly WorkbenchLogicalThreadRow[] = [];

/**
 * The route's project selection. It reads every fact it derives from on each push but only changes identity when
 * the derived selection does, so hosts re-render on real selection changes rather than thread activity.
 */
useProjects.selection = function useProjectSelection(
  route: ProjectSelectionFacts["route"], physicalProjects: readonly WorkbenchProjectOption[],
  browseLocation: ProjectLocationReference | null, explicitClient?: WorkbenchClientController,
) {
  const providedClient = useContext(WorkbenchClientContext);
  const mounted = (explicitClient ?? providedClient)?.mounted ?? null;
  const facts = mounted?.projectFacts ?? null;
  const sidebar = mounted?.threadSidebar ?? null;
  const presentationMode = Boolean(mounted?.presentationClient);
  const selected = useRef<ProjectSelection | null>(null);
  const subscribe = useCallback((listener: () => void) => {
    const releases = [facts?.subscribe(listener), sidebar?.subscribe(listener), sidebar?.subscribeListing?.(listener)];
    return () => { for (const release of releases) release?.(); };
  }, [facts, sidebar]);
  const getSnapshot = useCallback(() => {
    const listing = sidebar?.getListing?.();
    const next = resolveProjectSelection({
      route, physicalProjects, presentationMode, browseLocation,
      logicalProjects: facts?.getProjects() ?? NO_PROJECTS,
      groups: facts?.getGroups() ?? NO_GROUPS,
      logicalSummaries: facts?.getData()?.summaries ?? NO_SUMMARIES,
      rows: listing?.rows ?? NO_ROWS,
      rowsLoading: listing?.status.loading ?? false,
      sidebars: sidebar?.getProjectThreadSidebars?.() ?? EMPTY_SIDEBARS,
      summaries: sidebar?.getProjectThreadSummaries?.() ?? EMPTY_PROJECT_THREAD_SUMMARIES,
    });
    if (selected.current && areDeeplyEqual(selected.current, next)) return selected.current;
    selected.current = next;
    return next;
  }, [browseLocation, facts, physicalProjects, presentationMode, route, sidebar]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
};

export function useProject(id: string | null | undefined) {
  return useFacts(store => id ? store.getProject(id) : null, null);
}

useProject.forLocation = function useProjectForLocation(location: ProjectLocationReference | null | undefined) {
  return useFacts(store => location ? store.getForLocation(location) : null, null);
};

useProject.summary = function useProjectSummary(id: string | null | undefined) {
  return useFacts(store => id ? store.getSummary(id) : null, null);
};
