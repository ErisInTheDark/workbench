/*
 * No production exports. Tests protect stats range bounds, v2 response geometry, and reload-order compatibility. Keywords: stats, contract, zod, test.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  WorkbenchStatsImportProgressSchema,
  WorkbenchStatsReadRequestSchema,
  WorkbenchStatsResponseSchema,
} from "./workbench-stats-contract.ts";

test("stats requests accept every supported range and install usage filter defaults", () => {
  for (const range of ["7d", "14d", "30d", "90d", "365d"] as const) {
    assert.deepEqual(WorkbenchStatsReadRequestSchema.parse({ projectId: null, range }), {
      model: null,
      projectId: null,
      provider: null,
      range,
    });
  }
  assert.equal(WorkbenchStatsReadRequestSchema.safeParse({ projectId: null, range: "forever" }).success, false);
});

test("v2 responses admit all ninety daily buckets with non-overlapping token categories", () => {
  const buckets = Array.from({ length: 90 }, (_, index) => ({
    all: index * 4,
    cachedInput: index,
    cacheWriteInput: index,
    input: index * 3,
    output: index,
    startedAt: index,
    uncachedInput: index,
  }));
  const response = {
    bucketUnit: "day",
    claimHotspots: [{ path: "app/components", projectId: "project", rootId: "root", threadCount: 2 }],
    cost: {
      basis: {
        defaultModelTokens: 0,
        exactModelTokens: 0,
        projectInferredModelTokens: 0,
        threadInferredModelTokens: 0,
      },
      buckets: buckets.map(({ startedAt }) => ({ startedAt, totalUsd: 0 })),
      totalUsd: 0,
    },
    failures: [],
    generatedAt: 1_000,
    models: [],
    pricingCatalogDate: "2026-09-05",
    projectId: null,
    rateLimits: [],
    range: "90d",
    startedAt: 0,
    summary: { cacheHitPercent: 0, threadCount: 0, turnCount: 0 },
    tokens: {
      buckets,
      totals: {
        all: 0,
        cachedInput: 0,
        cacheWriteInput: 0,
        input: 0,
        output: 0,
        uncachedInput: 0,
      },
    },
    topThreads: [],
    usageFilters: { models: [], providers: [] },
    version: 2,
  };
  assert.equal(WorkbenchStatsResponseSchema.safeParse(response).success, true);
});

test("legacy stats responses normalise without losing bucket timestamps", () => {
  const parsed = WorkbenchStatsResponseSchema.parse({
    bucketUnit: "day",
    claimHotspots: [],
    cost: { buckets: [], pricedTokens: 5, totalUsd: 1, unpricedTokens: 7 },
    failures: [],
    generatedAt: 1,
    pricingCatalogDate: "2026-09-04",
    projectId: null,
    rateLimits: [],
    range: "7d",
    recordingStartedAt: null,
    startedAt: 0,
    tokens: {
      buckets: [{ all: 12, cachedInput: 3, input: 10, output: 2, startedAt: 99 }],
      totals: { all: 12, cachedInput: 3, input: 10, output: 2 },
    },
  });
  assert.equal(parsed.version, 2);
  assert.equal(parsed.tokens.buckets[0]?.startedAt, 99);
  assert.equal(parsed.tokens.buckets[0]?.uncachedInput, 7);
  assert.deepEqual(parsed.cost.basis, {
    defaultModelTokens: 7,
    exactModelTokens: 5,
    projectInferredModelTokens: 0,
    threadInferredModelTokens: 0,
  });
});

test("legacy import progress normalises into split usage and claim sources", () => {
  const progress = WorkbenchStatsImportProgressSchema.parse({
    completedThreads: 3,
    failedThreads: 1,
    percent: 80,
    processedThreads: 4,
    recentFailures: [{ harness: "codex", message: "bad journal", threadId: "thread-4" }],
    revision: 7,
    state: "running",
    totalThreads: 5,
    unavailableThreads: 0,
  });
  assert.equal(progress.usage.processed, 4);
  assert.equal(progress.claims.total, 0);
  assert.equal(progress.recentFailures[0]?.source, "usage");
  assert.equal(WorkbenchStatsImportProgressSchema.safeParse({ ...progress, percent: 101 }).success, false);
});
