/*
 * Test support only.
 * Exports:
 * - TEST_STATS_DAEMON_ID/testStatsScope/testStatsRoutes: the attached test daemon, an empty selection on it, and plain thread routes.
 * - createFakeStatsWorkspace: a workspace client double that records stats observations and lets tests publish section data.
 * - renderWithStats: render stats panels to markup against a store whose sections already hold the given data.
 */
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { WorkbenchStatsReadRequest, WorkbenchStatsResponse } from "workbench-shared/workbench/stats/workbench-stats-contract";
import { createThreadRoute } from "workbench-shared/workbench/navigation/workbench-route";
import type WorkbenchWorkspaceClient from "../../../workbench/app/WorkbenchWorkspaceClient";
import type { WorkspaceProjectReference } from "workbench-shared/workbench/workspace/workspace-observation";
import type { StatsProjectScope } from "./stats-project-scope";
import { WorkbenchStatsProvider } from "./use-stats";
import WorkbenchStatsStore, { type StatsInputs, type StatsSectionName } from "./WorkbenchStatsStore";

export const TEST_STATS_DAEMON_ID = "502902c0-9512-40be-bb06-c65d86ef2029";

/** An empty sidebar selection on the test daemon. */
export function testStatsScope(overrides: Partial<StatsProjectScope> = {}): StatsProjectScope {
  return { attachedDaemonId: TEST_STATS_DAEMON_ID, groups: [], labels: [], logical: new Map(), names: new Map(), references: [], ...overrides };
}

export const testStatsRoutes = {
  openRoute: () => {},
  threadRoute: (thread: { projectId: string; threadId: string }) => createThreadRoute(thread.projectId, thread.threadId),
};

export function createFakeStatsWorkspace() {
  type Query = { projects: WorkspaceProjectReference[] | null; request: Omit<WorkbenchStatsReadRequest, "projectIds"> };
  const open = new Map<string, Query & { publish: (data: WorkbenchStatsResponse) => void }>();
  const workspace = {
    observe(query: Query) {
      const key = JSON.stringify([query.projects, query.request]);
      let value: object | null = null;
      const listeners = new Set<() => void>();
      open.set(key, {
        projects: query.projects,
        request: query.request,
        publish: (data) => {
          value = { kind: "stats", phase: "current", failure: null, refinement: "current", data };
          listeners.forEach((listener) => listener());
        },
      });
      return {
        getSnapshot: () => ({ phase: value ? "current" : "pending", failure: null, value }),
        signal: new AbortController().signal,
        subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
        release: () => { open.delete(key); },
      };
    },
  } as unknown as WorkbenchWorkspaceClient;
  return { open, workspace };
}

/** Server rendering never subscribes, so the sections are leased and published before rendering. */
export function renderWithStats(
  element: ReactElement,
  sections: Partial<Record<StatsSectionName, WorkbenchStatsResponse>>,
  inputs: Partial<Omit<StatsInputs, "workspace">> = {},
) {
  const { open, workspace } = createFakeStatsWorkspace();
  const store = new WorkbenchStatsStore();
  store.setInputs({
    addressFeedback: () => {}, ...testStatsRoutes, projects: [], scope: testStatsScope(),
    ...inputs,
    workspace,
  });
  for (const [name, data] of Object.entries(sections) as Array<[StatsSectionName, WorkbenchStatsResponse]>) {
    store.subscribeSection(name, () => {});
    const section = name === "overview" ? "usage" : name;
    for (const entry of open.values()) if (entry.request.section === section) entry.publish(data);
  }
  return renderToStaticMarkup(createElement(WorkbenchStatsProvider, { value: store }, element));
}
