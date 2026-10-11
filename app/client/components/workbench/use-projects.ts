/*
 * Exports:
 * - useProjects: read the logical projects; members read their group tiers, daemon folder catalogues, and the per-project thread summaries.
 * - useProject: read one logical project by id; members read the project owning a folder location and one project's summary.
 */
"use client";

import { useContext, useSyncExternalStore } from "react";

import type { WorkbenchLogicalProject } from "workbench-shared/types";
import type { ProjectLocationReference } from "workbench-shared/workbench/project/project-location";
import type { WorkbenchProjectThreadSummaries } from "workbench-shared/workbench/thread/thread-state";
import type ProjectFactsStore from "../../workbench/project/ProjectFactsStore";
import type { ProjectGroupFacts } from "../../workbench/project/ProjectFactsStore";
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

export function useProject(id: string | null | undefined) {
  return useFacts(store => id ? store.getProject(id) : null, null);
}

useProject.forLocation = function useProjectForLocation(location: ProjectLocationReference | null | undefined) {
  return useFacts(store => location ? store.getForLocation(location) : null, null);
};

useProject.summary = function useProjectSummary(id: string | null | undefined) {
  return useFacts(store => id ? store.getSummary(id) : null, null);
};
