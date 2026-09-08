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
import { legacyStatsResponse, WorkbenchStatsDetailedReadRequestSchema, WorkbenchStatsDetailedResponseSchema } from "./workbench-stats-detail-contract.ts";

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
  assert.deepEqual(WorkbenchStatsDetailedReadRequestSchema.parse({ projectId: null, range: "7d" }).tokenTypes, ["input", "cache", "output"]);
  assert.deepEqual(WorkbenchStatsDetailedReadRequestSchema.parse({ projectId: null, range: "7d", tokenTypes: [] }).tokenTypes, []);
  assert.equal(WorkbenchStatsDetailedReadRequestSchema.safeParse({ projectId: null, range: "7d", tokenTypes: ["all"] }).success, false);
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
  const detailed = WorkbenchStatsDetailedResponseSchema.parse({
    ...response,
    cost: {
      ...response.cost, byTokenType: { input: 0, cache: 0, output: 0 },
      buckets: response.cost.buckets.map((bucket) => ({ ...bucket, byTokenType: { input: 0, cache: 0, output: 0 } })),
    },
  });
  assert.deepEqual(WorkbenchStatsResponseSchema.parse(legacyStatsResponse(detailed)), WorkbenchStatsResponseSchema.parse(response));
  assert.equal(WorkbenchStatsDetailedResponseSchema.safeParse(response).success, false);
  assert.equal(WorkbenchStatsDetailedResponseSchema.safeParse({
    ...detailed, cost: { ...detailed.cost, byTokenType: { input: 0, cache: -1, output: 0 } },
  }).success, false);
  const cacheEfficiency = {
    totals: { inputTokens: 1_000, cachedInputTokens: 940, cacheHitPercent: 94 },
    buckets: [{ startedAt: 0, inputTokens: 0, cachedInputTokens: 0, cacheHitPercent: null }],
    worstThreads: [{ projectId: "project", threadId: "thread", title: "Thread",
      inputTokens: 1_000, cachedInputTokens: 940, cacheWriteInputTokens: 10, cacheHitPercent: 94 }],
  };
  const enriched = WorkbenchStatsDetailedResponseSchema.safeParse({ ...detailed, cacheEfficiency });
  assert.ok(enriched.success, "Complete cache efficiency must survive response validation");
  assert.deepEqual(WorkbenchStatsResponseSchema.parse(legacyStatsResponse(enriched.data)), WorkbenchStatsResponseSchema.parse(response));
  assert.equal(WorkbenchStatsDetailedResponseSchema.safeParse({
    ...detailed, cacheEfficiency: { ...cacheEfficiency, totals: { ...cacheEfficiency.totals, cacheHitPercent: 101 } },
  }).success, false);
  assert.equal(WorkbenchStatsDetailedResponseSchema.safeParse({
    ...detailed, cacheEfficiency: { ...cacheEfficiency, totals: { ...cacheEfficiency.totals, cachedInputTokens: -1 } },
  }).success, false);
  const older = WorkbenchStatsDetailedResponseSchema.safeParse({
    ...detailed,
    cacheEfficiency: { ...cacheEfficiency, worstThreads: cacheEfficiency.worstThreads.map(({ cacheWriteInputTokens: _writes, ...thread }) => thread) },
  });
  assert.ok(older.success, "Older cache responses remain usable without invented cache-write counts");
  assert.equal(older.data.cacheEfficiency?.worstThreads[0]?.cacheWriteInputTokens, undefined);
  assert.equal(WorkbenchStatsDetailedResponseSchema.safeParse({
    ...detailed,
    cacheEfficiency: { ...cacheEfficiency, worstThreads: [{ ...cacheEfficiency.worstThreads[0], cacheWriteInputTokens: -1 }] },
  }).success, false);
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
