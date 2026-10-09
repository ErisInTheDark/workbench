/*
 * Test support only.
 * Exports:
 * - createFakeStatsWorkspace: a workspace client double that records stats observations and lets tests publish section data.
 * - renderWithStats: render stats panels to markup against a store whose sections already hold the given data.
 */
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { WorkbenchStatsReadRequest, WorkbenchStatsResponse } from "workbench-shared/workbench/stats/workbench-stats-contract";
import type WorkbenchWorkspaceClient from "../../../workbench/app/WorkbenchWorkspaceClient";
import { WorkbenchStatsProvider } from "./use-stats";
import WorkbenchStatsStore, { type StatsInputs, type StatsSectionName } from "./WorkbenchStatsStore";

export const TEST_STATS_DAEMON_ID = "502902c0-9512-40be-bb06-c65d86ef2029";

export function createFakeStatsWorkspace() {
  const open = new Map<string, { request: WorkbenchStatsReadRequest; publish: (data: WorkbenchStatsResponse) => void }>();
  const workspace = {
    observe(query: { request: WorkbenchStatsReadRequest }) {
      const key = JSON.stringify(query.request);
      let value: object | null = null;
      const listeners = new Set<() => void>();
      open.set(key, {
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
    addressFeedback: () => {}, navigateThread: () => {}, projects: [],
    scope: { daemonId: TEST_STATS_DAEMON_ID, elsewhere: [], groups: [], labels: [], names: new Map(), projectIds: [] },
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
