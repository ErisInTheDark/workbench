/*
 * No production exports. Tests protect background import startup, ordered capture, partial rate refresh, bounded failures, and disposal. Keywords: stats, controller, lifecycle, test.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type {
  WorkbenchStatsImportProgress,
  WorkbenchStatsResponse,
} from "workbench-shared/workbench/stats/workbench-stats-contract";
import WorkbenchStatsController from "./WorkbenchStatsController.ts";

const importProgress: WorkbenchStatsImportProgress = {
  claims: { completed: 0, failed: 0, processed: 0, total: 0, unavailable: 0 },
  percent: 100,
  recentFailures: [],
  revision: 0,
  state: "idle",
  unsupportedClaimCheckpoints: 0,
  usage: { completed: 0, failed: 0, processed: 0, total: 0, unavailable: 0 },
  version: 2,
};

function emptyStats(): WorkbenchStatsResponse {
  return {
    bucketUnit: "day",
    claimHotspots: [],
    cost: {
      basis: {
        defaultModelTokens: 0,
        exactModelTokens: 0,
        projectInferredModelTokens: 0,
        threadInferredModelTokens: 0,
      },
      buckets: [],
      totalUsd: 0,
    },
    failures: [],
    generatedAt: 1,
    historyImport: importProgress,
    models: [],
    pricingCatalogDate: "2026-09-05",
    projectId: null,
    range: "7d",
    rateLimits: [],
    startedAt: 1,
    summary: { cacheHitPercent: 0, threadCount: 0, turnCount: 0 },
    tokens: {
      buckets: [],
      totals: { all: 0, cachedInput: 0, cacheWriteInput: 0, input: 0, output: 0, uncachedInput: 0 },
    },
    topThreads: [],
    usageFilters: { models: [], providers: [] },
    version: 2,
  };
}

function importPorts() {
  return {
    addStatsClaimDiscoveries: async () => importProgress,
    beginStatsImport: async () => importProgress,
    claimStatsClaimImport: async () => null,
    claimStatsUsageImport: async () => null,
    readStatsImportProgress: async () => importProgress,
    repairStatsAttributions: async () => ({}),
    settleStatsClaimImport: async () => importProgress,
    settleStatsUsageImport: async () => importProgress,
  };
}

const claims = {
  discover: async () => ({ candidates: [], unsupported: 0 }),
  hydrate: async () => [],
};

test("controller startup begins the resumable import in the background", async () => {
  let starts = 0;
  const controller = new WorkbenchStatsController({
    claims,
    database: {
      ...importPorts(),
      beginStatsImport: async () => {
        starts += 1;
        return importProgress;
      },
      readStats: async () => emptyStats(),
      recordStatsClaimSnapshot: async () => undefined,
      recordStatsRateLimits: async () => undefined,
    },
    harnesses: {
      hydrateUsage: async () => ({ state: "unavailable" }),
      listHarnesses: () => [],
      listUsageHydrationHarnesses: () => [],
      request: async () => ({ id: "unused", result: null }),
    },
  });
  controller.start();
  assert.equal(starts, 1);
  await controller.dispose();
});

test("claim writes stay ordered and disposal flushes the queue", async () => {
  const writes: string[] = [];
  let releaseFirst!: () => void;
  const firstPending = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const controller = new WorkbenchStatsController({
    claims,
    database: {
      ...importPorts(),
      readStats: async () => emptyStats(),
      recordStatsClaimSnapshot: async (snapshot) => {
        if (snapshot.roots[0]?.paths[0] === "one") await firstPending;
        writes.push(snapshot.roots[0]?.paths[0] ?? "empty");
      },
      recordStatsRateLimits: async () => undefined,
    },
    harnesses: {
      hydrateUsage: async () => ({ state: "unavailable" }),
      listHarnesses: () => [],
      listUsageHydrationHarnesses: () => [],
      request: async () => ({ id: "unused", result: null }),
    },
  });
  const snapshot = (path: string) => controller.observeClaimSnapshot({
    harness: "codex",
    observedAt: 1,
    projectId: "project",
    roots: [{ paths: [path], rootId: "root" }],
    threadId: "thread",
  });
  snapshot("one");
  snapshot("two");
  const disposal = controller.dispose();
  assert.deepEqual(writes, []);
  releaseFirst();
  await disposal;
  assert.deepEqual(writes, ["one", "two"]);
});

test("rate refresh records actual windows and preserves partial harness failures", async () => {
  const observations: Array<{ harness: string; secondary: object | null }> = [];
  const controller = new WorkbenchStatsController({
    claims,
    database: {
      ...importPorts(),
      readStats: async () => emptyStats(),
      recordStatsClaimSnapshot: async () => undefined,
      recordStatsRateLimits: async (observation) => {
        observations.push({
          harness: observation.harness,
          secondary: observation.snapshots[0]?.secondary ?? null,
        });
      },
    },
    harnesses: {
      hydrateUsage: async () => ({ state: "unavailable" }),
      listHarnesses: () => ["codex", "copilot"],
      listUsageHydrationHarnesses: () => [],
      request: async (harness) => {
        if (harness === "copilot") throw new Error("offline");
        return {
          id: harness,
          result: {
            rateLimits: {
              limitId: "codex",
              primary: { resetsAt: 1_800_000_000, usedPercent: 25, windowDurationMins: 10_080 },
              secondary: null,
            },
          },
        };
      },
    },
  });
  await controller.refreshRateLimits();
  assert.deepEqual(observations, [{ harness: "codex", secondary: null }]);
  const result = await controller.read({ projectId: null, range: "7d" });
  assert.match(result.failures[0]?.message ?? "", /offline/u);
  await controller.dispose();
});
