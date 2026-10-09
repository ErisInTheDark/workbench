/* No production exports. Protect section leasing: one observation per distinct request, filter relevance per section, retention while reloading, and release. */
import assert from "node:assert/strict";
import test from "node:test";

import { EMPTY_WORKBENCH_STATS_SECTIONS } from "workbench-shared/workbench/stats/workbench-stats-conformance";
import type WorkbenchWorkspaceClient from "../../../workbench/app/WorkbenchWorkspaceClient";
import { LogicalProjectIdSchema } from "workbench-shared/workbench/identity";
import { createFakeStatsWorkspace as fakeWorkspace, testStatsRoutes, testStatsScope } from "./stats-test-store";
import type { StatsProjectScope } from "./stats-project-scope";
import WorkbenchStatsStore from "./WorkbenchStatsStore";

function storeWith(workspace: WorkbenchWorkspaceClient, scope: StatsProjectScope = testStatsScope()) {
  const store = new WorkbenchStatsStore();
  store.setInputs({ addressFeedback: () => {}, ...testStatsRoutes, projects: [], scope, workspace });
  return store;
}

const settle = () => new Promise<void>((resolve) => queueMicrotask(resolve));

test("the whole-range overview and unnarrowed usage share one observation until a period is picked", () => {
  const { open, workspace } = fakeWorkspace();
  const store = storeWith(workspace);
  store.subscribeSection("overview", () => {});
  store.subscribeSection("usage", () => {});
  assert.equal(open.size, 1);
  store.getState().pickPeriod(1_000, false);
  assert.deepEqual([...open.values()].map(({ request }) => request.period), [null, { from: 1_000, to: 1_000 }]);
});

test("usage-only filters re-request usage but leave other sections' observations alone", () => {
  const { open, workspace } = fakeWorkspace();
  const store = storeWith(workspace);
  store.subscribeSection("tools", () => {});
  store.subscribeSection("usage", () => {});
  const tools = [...open.keys()].find((key) => key.includes("\"tools\""));
  store.getState().setProvider("claude");
  assert.ok(tools && open.has(tools), "the tools observation survives a provider filter");
  assert.equal([...open.values()].find(({ request }) => request.section === "usage")?.request.provider, "claude");
});

test("workspace sections read one selected project on every machine while usage reads the whole selection", () => {
  const { open, workspace } = fakeWorkspace();
  const game = { kind: "logical" as const, projectId: LogicalProjectIdSchema.parse("112f7e1e-81b6-4c30-bdc0-f83475981001") };
  const bak = { kind: "logical" as const, projectId: LogicalProjectIdSchema.parse("112f7e1e-81b6-4c30-bdc0-f83475981002") };
  const store = storeWith(workspace, testStatsScope({
    labels: ["Game", "bak"], references: [game, bak],
    groups: [
      { id: game.projectId, label: "Game", project: null, references: [game] },
      { id: bak.projectId, label: "bak", project: null, references: [bak] },
    ],
  }));
  store.subscribeSection("claims", () => {});
  store.subscribeSection("usage", () => {});
  const projects = (section: string) => [...open.values()].find(({ request }) => request.section === section)?.projects;
  assert.deepEqual(projects("claims"), [game]);
  assert.deepEqual(projects("usage"), [game, bak]);
  store.getState().setWorkspaceProject(bak.projectId);
  assert.deepEqual(projects("claims"), [bak]);
  // "All projects" reads every project on every machine.
  store.getState().setMode("all");
  assert.equal(projects("usage"), null);
});

test("focusing a merged project row reads that logical project across machines", () => {
  const { open, workspace } = fakeWorkspace();
  const logical = "112f7e1e-81b6-4c30-bdc0-f83475981001";
  const store = storeWith(workspace, testStatsScope({ names: new Map([[logical, "Game"]]) }));
  store.subscribeSection("usage", () => {});
  store.getState().focusProject({ daemonId: "elsewhere", logicalProjectId: logical, projectId: "game" });
  assert.deepEqual(store.getState().focusedProject?.label, "Game");
  assert.deepEqual([...open.values()][0]?.projects, [{ kind: "logical", projectId: logical }]);
});

test("a section keeps showing its last data while a new request loads, then releases once nobody shows it", async () => {
  const { open, workspace } = fakeWorkspace();
  const store = storeWith(workspace);
  const stop = store.subscribeSection("feedback", () => {});
  const data = { ...EMPTY_WORKBENCH_STATS_SECTIONS.feedback, generatedAt: 5 };
  [...open.values()][0]!.publish(data);
  assert.deepEqual(store.getSectionSnapshot("feedback"), { data, failure: null, loading: false, refining: false });
  store.getState().setRange("30d");
  assert.deepEqual(store.getSectionSnapshot("feedback"), { data, failure: null, loading: true, refining: false });
  stop();
  await settle();
  assert.equal(open.size, 0);
});
