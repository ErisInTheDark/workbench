/*
 * No production exports. Tests protect fair usage/claim import, item failure isolation, coalesced starts, and disposal. Keywords: stats, import, lifecycle, test.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { WorkbenchStatsImportProgress } from "workbench-shared/workbench/stats/workbench-stats-contract";
import WorkbenchStatsImportController from "./WorkbenchStatsImportController.ts";

function progress(
  state: WorkbenchStatsImportProgress["state"],
  usage = { completed: 0, failed: 0, processed: 0, total: 0, unavailable: 0 },
  claims = { completed: 0, failed: 0, processed: 0, total: 0, unavailable: 0 },
): WorkbenchStatsImportProgress {
  const processed = usage.processed + claims.processed;
  const total = usage.total + claims.total;
  return {
    claims,
    percent: total ? processed / total * 100 : 100,
    recentFailures: [],
    revision: 0,
    state,
    unsupportedClaimCheckpoints: 0,
    usage,
    version: 2,
  };
}

const discovery = {
  checkpointCommit: "a".repeat(40),
  checkpointRef: "refs/worktree/agents/codex/claim-thread/checkpoints/one",
  harness: "codex" as const,
  observedAt: 1,
  projectId: "project",
  repositoryRoot: "C:/project",
  rootId: "root",
  threadId: "claim-thread",
  workspaceRoot: "C:/project",
};

test("importer alternates claim and usage work while isolating item failures", async () => {
  const order: string[] = [];
  let claimPending = true;
  let usagePending = true;
  let settledClaims = 0;
  let settledUsage = 0;
  const controller = new WorkbenchStatsImportController({
    claims: {
      discover: async () => ({ candidates: [discovery], unsupported: 7 }),
      hydrate: async () => {
        order.push("claims");
        return ["src/file.ts"];
      },
    },
    createRunId: () => "run",
    database: {
      addStatsClaimDiscoveries: async () => progress("running", { completed: 0, failed: 0, processed: 0, total: 1, unavailable: 0 }, { completed: 0, failed: 0, processed: 0, total: 1, unavailable: 0 }),
      beginStatsImport: async () => progress("running", { completed: 0, failed: 0, processed: 0, total: 1, unavailable: 0 }),
      claimStatsClaimImport: async () => {
        if (!claimPending) return null;
        claimPending = false;
        return { ...discovery, kind: "claims" };
      },
      claimStatsUsageImport: async () => {
        if (!usagePending) return null;
        usagePending = false;
        return { harness: "codex", kind: "usage", projectId: "project", threadId: "bad" };
      },
      readStatsImportProgress: async (state) => progress(
        state,
        { completed: 0, failed: settledUsage, processed: settledUsage, total: 1, unavailable: 0 },
        { completed: settledClaims, failed: 0, processed: settledClaims, total: 1, unavailable: 0 },
      ),
      repairStatsAttributions: async () => ({}),
      settleStatsClaimImport: async () => {
        settledClaims += 1;
        return progress("running");
      },
      settleStatsUsageImport: async (_runId, _candidate, settlement) => {
        assert.equal(settlement.state, "failed");
        settledUsage += 1;
        return progress("running");
      },
    },
    harnesses: {
      hydrateUsage: async () => {
        order.push("usage");
        throw new Error("broken");
      },
      listUsageHydrationHarnesses: () => ["codex"],
    },
    yieldToEventLoop: async () => undefined,
  });
  let resolveComplete!: (value: WorkbenchStatsImportProgress) => void;
  const complete = new Promise<WorkbenchStatsImportProgress>((resolve) => { resolveComplete = resolve; });
  controller.subscribe((value) => {
    if (value.state === "complete") resolveComplete(value);
  });
  await controller.start();
  const completed = await complete;
  await controller.dispose();
  assert.deepEqual(order, ["claims", "usage"]);
  assert.equal(completed.claims.completed, 1);
  assert.equal(completed.usage.failed, 1);
  assert.equal(completed.unsupportedClaimCheckpoints, 7);
});

test("importer coalesces concurrent starts into one background run", async () => {
  let beginCalls = 0;
  let releaseBegin!: () => void;
  const beginReleased = new Promise<void>((resolve) => { releaseBegin = resolve; });
  const controller = new WorkbenchStatsImportController({
    claims: { discover: async () => ({ candidates: [], unsupported: 0 }), hydrate: async () => [] },
    database: {
      addStatsClaimDiscoveries: async () => progress("running"),
      beginStatsImport: async () => {
        beginCalls += 1;
        await beginReleased;
        return progress("running");
      },
      claimStatsClaimImport: async () => null,
      claimStatsUsageImport: async () => null,
      readStatsImportProgress: async () => progress("complete"),
      repairStatsAttributions: async () => ({}),
      settleStatsClaimImport: async () => { throw new Error("Unexpected settlement."); },
      settleStatsUsageImport: async () => { throw new Error("Unexpected settlement."); },
    },
    harnesses: {
      hydrateUsage: async () => { throw new Error("Unexpected hydration."); },
      listUsageHydrationHarnesses: () => ["codex"],
    },
  });
  const first = controller.start();
  const second = controller.start();
  assert.equal(beginCalls, 1);
  releaseBegin();
  await Promise.all([first, second]);
  await controller.dispose();
  assert.equal(beginCalls, 1);
});
