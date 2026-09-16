/*
 * No exports. Protect import startup, ordered capture, rename-aware reads, partial refresh, failures, and disposal.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type {
  WorkbenchStatsImportProgress,
  WorkbenchStatsResponse,
} from "workbench-shared/workbench/stats/workbench-stats-contract";
import WorkbenchStatsController from "./WorkbenchStatsController.ts";
import type { WorkbenchStatsDetailedResponse } from "workbench-shared/workbench/stats/workbench-stats-detail-contract";
import { ProjectIdSchema } from "workbench-shared/workbench/identity";
import type WorkbenchProvider from "../WorkbenchProvider";
import { WorkbenchAccountLimitsSchema } from "workbench-shared/workbench/provider/provider-account";

const unused = async (): Promise<never> => { throw new Error("Unexpected provider operation"); };
function providers(read: () => Promise<import("workbench-shared/workbench/provider/provider-account").WorkbenchAccountLimits> = unused) {
  const provider: WorkbenchProvider = {
    threads: {
      readLatest: unused, messageAgent: unused,
      create: unused, list: unused, read: unused, page: unused, submit: unused,
      rename: unused, compact: unused, interrupt: unused, materialize: unused, latestTurn: unused, admitTurn: unused,
      history: { materialize: unused, questionnaires: unused, steers: unused, browse: unused },
    },
    configuration: { models: { read: unused }, modelContext: { read: unused }, guidance: { contains: unused } },
    account: { limits: { read } },
  };
  return { get: () => provider };
}

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
    readClaimStats: async () => ({ kind: "files" as const, page: 1, pages: 1, rows: [] }),
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

test("all stats routes receive rename projections and only UI reads can recover from unavailable history", async () => {
  const projectId = ProjectIdSchema.parse("project");
  const renames = [{ projectId, rootId: "root", from: "old", to: "current" }];
  let fail = false;
  let disposed = false;
  const seen: Array<readonly object[] | undefined> = [];
  const controller = new WorkbenchStatsController({
    claims,
    providers: providers(),
    renames: {
      read: async () => fail
        ? { renames: [], failures: [{ projectId, rootId: "root", message: "History unavailable." }] }
        : { renames, failures: [] },
      dispose: async () => { disposed = true; },
    },
    database: {
      ...importPorts(),
      readStats: async (_request, _now, aliases) => { seen.push(aliases); return emptyStats(); },
      readStatsDetailed: async (_request, _now, aliases) => {
        seen.push(aliases);
        const base = emptyStats();
        return { ...base, cost: { ...base.cost, buckets: [], byTokenType: { input: 0, cache: 0, output: 0 } } };
      },
      readClaimStats: async (_request, _now, aliases) => { seen.push(aliases); return { kind: "files", page: 1, pages: 1, rows: [] }; },
      recordStatsClaimSnapshot: async () => undefined, recordStatsRateLimits: async () => undefined,
    },
    harnesses: {
      hydrateUsage: async () => ({ state: "unavailable" }),
      listUsageHydrationHarnesses: () => [],
    },
  });
  const request = { projectId, range: "7d" as const };
  const fileRequest = { ...request, file: null, page: 1 };
  try {
    await controller.read(request);
    await controller.readDetailed(request);
    await controller.readClaims(fileRequest);
    assert.deepEqual(seen, [renames, renames, renames]);
    fail = true;
    assert.equal((await controller.read(request)).failures.length, 1);
    assert.equal((await controller.readDetailed(request)).failures.length, 1);
    const before = seen.length;
    await assert.rejects(controller.readClaims(fileRequest));
    assert.equal(seen.length, before);
    fail = false;
    assert.equal((await controller.read(request)).failures.length, 0);
  } finally { await controller.dispose(); }
  assert.equal(disposed, true);
});

test("controller startup begins the resumable import in the background", async () => {
  let starts = 0;
  const controller = new WorkbenchStatsController({
    claims,
    providers: providers(),
    database: {
      ...importPorts(),
      beginStatsImport: async () => {
        starts += 1;
        return importProgress;
      },
      readStats: async () => emptyStats(),
      readStatsDetailed: async () => { throw new Error("Detailed read not used by this test"); },
      recordStatsClaimSnapshot: async () => undefined,
      recordStatsRateLimits: async () => undefined,
    },
    harnesses: {
      hydrateUsage: async () => ({ state: "unavailable" }),
      listUsageHydrationHarnesses: () => [],
    },
  });
  controller.start();
  assert.equal(starts, 1);
  await controller.dispose();
});

test("detailed reads preserve category costs and include durable import status", async () => {
  const base = emptyStats();
  const detailed: WorkbenchStatsDetailedResponse = {
    ...base, cost: { ...base.cost, buckets: [], byTokenType: { input: 0, cache: 0, output: 0 } },
  };
  const progress = { ...importProgress, revision: 42 };
  const controller = new WorkbenchStatsController({
    claims,
    providers: providers(),
    database: {
      ...importPorts(), readStatsImportProgress: async () => progress,
      readStats: async () => base,
      readStatsDetailed: async (request) => {
        assert.deepEqual(request.tokenTypes, ["cache"]);
        return detailed;
      },
      recordStatsClaimSnapshot: async () => undefined, recordStatsRateLimits: async () => undefined,
    },
    harnesses: {
      hydrateUsage: async () => ({ state: "unavailable" }),
      listUsageHydrationHarnesses: () => [],
    },
  });
  try {
    const result = await controller.readDetailed({ projectId: null, range: "7d", tokenTypes: ["cache"] });
    assert.deepEqual(result.cost, detailed.cost);
    assert.equal(result.historyImport.revision, 42);
  } finally { await controller.dispose(); }
});

test("claim writes stay ordered and disposal flushes the queue", async () => {
  const writes: string[] = [];
  let releaseFirst!: () => void;
  const firstPending = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const controller = new WorkbenchStatsController({
    claims,
    providers: providers(),
    database: {
      ...importPorts(),
      readStats: async () => emptyStats(),
      readStatsDetailed: async () => { throw new Error("Detailed read not used by this test"); },
      recordStatsClaimSnapshot: async (snapshot) => {
        if (snapshot.roots[0]?.paths[0] === "one") await firstPending;
        writes.push(snapshot.roots[0]?.paths[0] ?? "empty");
      },
      recordStatsRateLimits: async () => undefined,
    },
    harnesses: {
      hydrateUsage: async () => ({ state: "unavailable" }),
      listUsageHydrationHarnesses: () => [],
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

test("rate refresh records actual windows and retains earlier capture when refresh fails", async () => {
  const observations: Array<{ harness: string; secondary: object | null }> = [];
  let offline = false;
  const controller = new WorkbenchStatsController({
    claims,
    providers: providers(async () => {
      if (offline) throw new Error("offline");
      return WorkbenchAccountLimitsSchema.parse({
        rateLimits: {
          limitId: "codex", limitName: null, credits: null, planType: null,
          primary: { resetsAt: 1_800_000_000, usedPercent: 25, windowDurationMins: 10_080 },
          secondary: null,
        },
        rateLimitsByLimitId: null,
      });
    }),
    database: {
      ...importPorts(),
      readStats: async () => emptyStats(),
      readStatsDetailed: async () => { throw new Error("Detailed read not used by this test"); },
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
      listUsageHydrationHarnesses: () => [],
    },
  });
  await controller.refreshRateLimits();
  assert.deepEqual(observations, [{ harness: "codex", secondary: null }]);
  offline = true;
  await controller.refreshRateLimits();
  assert.deepEqual(observations, [{ harness: "codex", secondary: null }]);
  const result = await controller.read({ projectId: null, range: "7d" });
  assert.match(result.failures[0]?.message ?? "", /offline/u);
  await controller.dispose();
});
