/* No production exports. Protect section leasing: one observation per distinct request, filter relevance per section, retention while reloading, and release. */
import assert from "node:assert/strict";
import test from "node:test";

import { EMPTY_WORKBENCH_STATS_SECTIONS } from "workbench-shared/workbench/stats/workbench-stats-conformance";
import type WorkbenchWorkspaceClient from "../../../workbench/app/WorkbenchWorkspaceClient";
import { createFakeStatsWorkspace as fakeWorkspace, TEST_STATS_DAEMON_ID as daemonId } from "./stats-test-store";
import WorkbenchStatsStore from "./WorkbenchStatsStore";

function storeWith(workspace: WorkbenchWorkspaceClient) {
  const store = new WorkbenchStatsStore();
  store.setInputs({
    addressFeedback: () => {}, navigateThread: () => {}, projects: [], workspace,
    scope: { daemonId, elsewhere: [], groups: [], labels: [], names: new Map(), projectIds: [] },
  });
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

test("workspace sections read one selected project with all its local folders while usage reads the whole selection", () => {
  const { open, workspace } = fakeWorkspace();
  const store = new WorkbenchStatsStore();
  store.setInputs({
    addressFeedback: () => {}, navigateThread: () => {}, projects: [], workspace,
    scope: {
      daemonId, elsewhere: [], labels: ["Game", "bak"], names: new Map(), projectIds: ["game", "game-next", "bak"],
      groups: [
        { id: "logical-game", label: "Game", project: null, projectIds: ["game", "game-next"] },
        { id: "logical-bak", label: "bak", project: null, projectIds: ["bak"] },
      ],
    },
  });
  store.subscribeSection("claims", () => {});
  store.subscribeSection("usage", () => {});
  const projects = (section: string) => [...open.values()].find(({ request }) => request.section === section)?.request.projectIds;
  assert.deepEqual(projects("claims"), ["game", "game-next"]);
  assert.deepEqual(projects("usage"), ["game", "game-next", "bak"]);
  store.getState().setWorkspaceProject("logical-bak");
  assert.deepEqual(projects("claims"), ["bak"]);
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
