/*
 * Test support only.
 * Exports:
 * - TEST_STATS_DAEMON_ID/testStatsScope/testStatsRoutes: the attached test daemon, an empty selection on it, and plain thread routes.
 * - testFeedbackItem/testFeedbackReportSection/TEST_STATS_THREAD_LOCATION: one stored feedback report, the feedback section narrowed to it, and its thread's folder.
 * - createFakeStatsWorkspace: a workspace client double that resolves thread owners, records stats observations, and lets tests publish or fail section data.
 * - renderWithStats: render stats panels to markup against a store whose sections already hold the given data.
 */
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { WorkbenchStatsReadRequest, WorkbenchStatsResponse } from "workbench-shared/workbench/stats/workbench-stats-contract";
import type { WorkbenchFeedbackItem } from "workbench-shared/workbench/stats/workbench-stats-feedback-contract";
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

/** A stored report as the daemon returns it. */
export function testFeedbackItem(overrides: Partial<WorkbenchFeedbackItem> = {}): WorkbenchFeedbackItem {
  return {
    category: "bug", channel: "wb", createdAt: 1_000, harness: "codex", id: 53, importance: 0.8, model: "openai/gpt-5.6",
    projectId: "project-one", reasoningEffort: "high", report: "Stored report text.", scored: true, threadId: "thread-one",
    title: "Stored report title", ...overrides,
  };
}

/** The test daemon's folder that `thread-one` lives in. */
export const TEST_STATS_THREAD_LOCATION = { daemonId: TEST_STATS_DAEMON_ID, projectId: "project-one" };

/** The feedback section as a daemon answers a read narrowed to one report. */
export function testFeedbackReportSection(item: WorkbenchFeedbackItem | null): WorkbenchStatsResponse {
  return {
    feedback: item
      ? { counts: [{ category: item.category, count: 1 }], items: [item], total: 1, workbenchProjectId: null }
      : { counts: [], items: [], total: 0, workbenchProjectId: null },
    generatedAt: 1, section: "feedback",
  };
}

/** Stats observations stay open for tests to publish or fail; thread owners resolve from `owners`, unknown ones as unavailable. */
export function createFakeStatsWorkspace(owners: ReadonlyMap<string, typeof TEST_STATS_THREAD_LOCATION> = new Map()) {
  type Query = { projects: WorkspaceProjectReference[] | null; request: Omit<WorkbenchStatsReadRequest, "projectIds"> };
  type OwnerQuery = { kind: "threadOwner"; threadId: string };
  const open = new Map<string, Query & { fail: (failure: string) => void; publish: (data: WorkbenchStatsResponse) => void }>();
  const ownerReads = new Set<string>();
  const handle = (getValue: () => object | null, getFailure: () => string | null, listeners: Set<() => void>, release: () => void) => ({
    getSnapshot: () => ({ phase: getValue() ? "current" : getFailure() ? "failed" : "pending", failure: getFailure(), value: getValue() }),
    signal: new AbortController().signal,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    release,
  });
  const workspace = {
    observe(query: Query | OwnerQuery) {
      if ("kind" in query && query.kind === "threadOwner") {
        const location = owners.get(query.threadId);
        ownerReads.add(query.threadId);
        const value = { kind: "threadOwner", data: location
          ? { phase: "current", identity: { harness: "codex", threadId: query.threadId }, location, logicalProjectId: null }
          : { phase: "unavailable", failure: "Unknown thread." } };
        return handle(() => value, () => null, new Set(), () => { ownerReads.delete(query.threadId); });
      }
      const stats = query as Query;
      const key = JSON.stringify([stats.projects, stats.request]);
      let value: object | null = null;
      let failure: string | null = null;
      const listeners = new Set<() => void>();
      open.set(key, {
        projects: stats.projects,
        request: stats.request,
        fail: (message) => {
          failure = message;
          listeners.forEach((listener) => listener());
        },
        publish: (data) => {
          value = { kind: "stats", phase: "current", failure: null, refinement: "current", data };
          listeners.forEach((listener) => listener());
        },
      });
      return handle(() => value, () => failure, listeners, () => { open.delete(key); });
    },
  } as unknown as WorkbenchWorkspaceClient;
  return { open, ownerReads, workspace };
}

/** Server rendering never subscribes, so the sections are leased and published before rendering. */
export function renderWithStats(
  element: ReactElement,
  sections: Partial<Record<StatsSectionName, WorkbenchStatsResponse>>,
  inputs: Partial<StatsInputs> = {},
) {
  const { open, workspace } = createFakeStatsWorkspace();
  const store = new WorkbenchStatsStore(workspace);
  store.setInputs({
    addressFeedback: () => {}, ...testStatsRoutes, projects: [], scope: testStatsScope(),
    ...inputs,
  });
  for (const [name, data] of Object.entries(sections) as Array<[StatsSectionName, WorkbenchStatsResponse]>) {
    store.subscribeSection(name, () => {});
    const section = name === "overview" ? "usage" : name;
    for (const entry of open.values()) if (entry.request.section === section) entry.publish(data);
  }
  return renderToStaticMarkup(createElement(WorkbenchStatsProvider, { value: store }, element));
}
