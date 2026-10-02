/*
 * No exports. Protect import startup, ordered capture, claimed-root rename reads, account-limit history, partial refresh, failures, and disposal.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type {
  WorkbenchStatsImportProgress,
  WorkbenchStatsReadRequest,
  WorkbenchStatsResponse,
} from "workbench-shared/workbench/stats/workbench-stats-contract";
import WorkbenchStatsController from "./WorkbenchStatsController.ts";
import type { WorkbenchClaimRenameScope } from "./WorkbenchClaimRenameController.ts";
import { ProjectIdSchema } from "workbench-shared/workbench/identity";
import type WorkbenchProvider from "../WorkbenchProvider";
import { WorkbenchAccountLimitsSchema } from "workbench-shared/workbench/provider/provider-account";

const unused = async (): Promise<never> => { throw new Error("Unexpected provider operation"); };
function providers(read: () => Promise<import("workbench-shared/workbench/provider/provider-account").WorkbenchAccountLimits> = unused) {
  const provider: WorkbenchProvider = {
    threads: {
      reconcile: unused, readLatest: unused, messageAgent: unused,
      create: unused, list: unused, read: unused, submit: unused,
      rename: unused, compact: unused, interrupt: unused, materialize: unused, latestTurn: unused, admitTurn: unused,
      history: { materialize: unused },
    },
    configuration: { models: { read: unused }, modelContext: { read: unused }, guidance: { contains: unused } },
    account: { limits: { read } },
  };
  return { get: (key: string) => key === "codex" ? provider : { ...provider, account: undefined } };
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
  const tokens = { all: 0, cachedInput: 0, cacheWriteInput: 0, input: 0, output: 0, uncachedInput: 0 };
  return {
    bucketUnit: "day",
    cacheEfficiency: { buckets: [], totals: { cacheHitPercent: null, cachedInputTokens: 0, inputTokens: 0 }, worstThreads: [] },
    claimHotspots: [],
    cost: {
      basis: { exactModelTokens: 0, projectInferredModelTokens: 0, threadInferredModelTokens: 0, unpricedTokens: 0 },
      buckets: [], byTokenType: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }, totalUsd: 0, unpricedModels: [],
    },
    failures: [],
    generatedAt: 1,
    historyImport: importProgress,
    models: [],
    previous: { costUsd: 0, threadCount: 0, tokens: 0, turnCount: 0 },
    pricingCatalogDate: "2026-10-01",
    projectIds: null,
    projects: [],
    providers: [],
    range: "7d",
    rateLimits: [],
    startedAt: 1,
    summary: { buckets: [], threadCount: 0, turnCount: 0 },
    tokens: { buckets: [], totals: tokens },
    topThreads: [],
    usageFilters: { models: [], providers: [] },
    version: 3,
  };
}

function importPorts() {
  return {
    readClaimStats: async () => ({ kind: "files" as const, page: 1, pages: 1, rows: [] }),
    readStatsClaimedRoots: async () => [],
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

const harnesses = {
  hydrateUsage: async () => ({ state: "unavailable" as const }),
  listUsageHydrationHarnesses: () => [],
};

/** The first snapshot whose claims are no longer pending, then stop observing. */
function settled(controller: WorkbenchStatsController, request: WorkbenchStatsReadRequest) {
  return new Promise<WorkbenchStatsResponse>((resolve, reject) => {
    const handle = controller.observe(request, (state) => {
      if (state.phase === "failed") {
        handle.release();
        reject(new Error(state.failure ?? "Statistics failed."));
      } else if (state.data && state.claimsPhase !== "pending") {
        handle.release();
        resolve(state.data);
      }
    });
  });
}

test("reads walk rename history only for claimed roots from their earliest claim, and only UI reads tolerate failures", async () => {
  const projectId = ProjectIdSchema.parse("project");
  const renames = [{ projectId, rootId: "root", from: "old", to: "current" }];
  let fail = false;
  let disposed = false;
  let claimed = [{ projectId, rootId: "root", earliestClaimedDay: 86_400_000 }];
  const scopes: Array<readonly WorkbenchClaimRenameScope[]> = [];
  const claimedRequests: Array<{ projectIds: readonly string[] | null; range: string }> = [];
  const seen: Array<readonly object[] | undefined> = [];
  const controller = new WorkbenchStatsController({
    claims,
    providers: providers(),
    renames: {
      read: async (requested) => {
        scopes.push(requested);
        return fail
          ? { renames: [], failures: [{ projectId, rootId: "root", message: "History unavailable." }] }
          : { renames: requested.length ? renames : [], failures: [] };
      },
      dispose: async () => { disposed = true; },
    },
    database: {
      ...importPorts(),
      readStatsClaimedRoots: async (projectIds, range) => { claimedRequests.push({ projectIds, range }); return claimed; },
      readStats: async (_request, _now, aliases) => { seen.push(aliases); return emptyStats(); },
      readClaimStats: async (_request, _now, aliases) => { seen.push(aliases); return { kind: "files", page: 1, pages: 1, rows: [] }; },
      recordStatsClaimSnapshot: async () => undefined, recordStatsRateLimits: async () => undefined,
    },
    harnesses,
  });
  const request = { projectIds: [projectId], range: "7d" as const };
  const fileRequest = { projectId, range: "all" as const, file: null, page: 1 };
  try {
    await settled(controller, request);
    await controller.readClaims(fileRequest);
    assert.deepEqual(claimedRequests, [{ projectIds: [projectId], range: "7d" }, { projectIds: [projectId], range: "all" }]);
    assert.deepEqual(scopes[0], [{ projectId, rootId: "root", since: 86_400_000 }]);
    // Usage publishes before history is known, then claims re-read with the aliases.
    assert.deepEqual(seen, [[], renames, renames]);
    claimed = [];
    await settled(controller, { projectIds: null, range: "7d" });
    assert.deepEqual(scopes.at(-1), [], "unclaimed scopes must not walk any history");
    claimed = [{ projectId, rootId: "root", earliestClaimedDay: 0 }];
    fail = true;
    assert.equal((await settled(controller, request)).failures.length, 1);
    const before = seen.length;
    await assert.rejects(controller.readClaims(fileRequest));
    assert.equal(seen.length, before);
    fail = false;
    assert.equal((await settled(controller, request)).failures.length, 0);
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
      recordStatsClaimSnapshot: async () => undefined,
      recordStatsRateLimits: async () => undefined,
    },
    harnesses,
  });
  controller.start();
  assert.equal(starts, 1);
  await controller.dispose();
});

test("reads include durable import status", async () => {
  const progress = { ...importProgress, revision: 42 };
  const controller = new WorkbenchStatsController({
    claims,
    providers: providers(),
    database: {
      ...importPorts(), readStatsImportProgress: async () => progress,
      readStats: async () => emptyStats(),
      recordStatsClaimSnapshot: async () => undefined, recordStatsRateLimits: async () => undefined,
    },
    harnesses,
  });
  try {
    assert.equal((await settled(controller, { projectIds: null, range: "7d" })).historyImport.revision, 42);
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
      recordStatsClaimSnapshot: async (snapshot) => {
        if (snapshot.roots[0]?.paths[0] === "one") await firstPending;
        writes.push(snapshot.roots[0]?.paths[0] ?? "empty");
      },
      recordStatsRateLimits: async () => undefined,
    },
    harnesses,
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

test("rate refresh and read-only account limits record actual windows and retain earlier capture when refresh fails", async () => {
  const observations: Array<{ harness: string; secondary: object | null }> = [];
  let offline = false;
  const limits = WorkbenchAccountLimitsSchema.parse({
    rateLimits: {
      limitId: "codex", limitName: null, credits: null, planType: null,
      primary: { resetsAt: 1_800_000_000, usedPercent: 25, windowDurationMins: 10_080 },
      secondary: null,
    },
    rateLimitsByLimitId: null,
  });
  const controller = new WorkbenchStatsController({
    claims,
    providers: providers(async () => {
      if (offline) throw new Error("offline");
      return limits;
    }),
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
    harnesses,
  });
  await controller.refreshRateLimits();
  assert.deepEqual(observations, [{ harness: "codex", secondary: null }]);
  controller.observeAccountLimits("claude", limits);
  offline = true;
  await controller.refreshRateLimits();
  assert.deepEqual(observations, [{ harness: "codex", secondary: null }, { harness: "claude", secondary: null }]);
  const result = await settled(controller, { projectIds: null, range: "7d" });
  assert.match(result.failures[0]?.message ?? "", /offline/u);
  await controller.dispose();
});

test("observations publish usage while capture writes are still queued, then refresh once they land", async () => {
  let releaseWrite!: () => void;
  const writeBlocked = new Promise<void>((resolve) => { releaseWrite = resolve; });
  let reads = 0;
  const controller = new WorkbenchStatsController({
    claims,
    providers: providers(),
    database: {
      ...importPorts(),
      readStats: async () => ({ ...emptyStats(), generatedAt: ++reads }),
      recordStatsClaimSnapshot: async () => { await writeBlocked; },
      recordStatsRateLimits: async () => undefined,
    },
    harnesses,
  });
  controller.observeClaimSnapshot({ harness: "codex", observedAt: 1, projectId: "project", roots: [{ paths: ["a"], rootId: "root" }], threadId: "t" });
  const published: number[] = [];
  let first!: () => void;
  let landed!: () => void;
  const usage = new Promise<void>((resolve) => { first = resolve; });
  const refreshed = new Promise<void>((resolve) => { landed = resolve; });
  const handle = controller.observe({ projectIds: null, range: "7d" }, (state) => {
    if (state.data && state.claimsPhase !== "pending") published.push(state.data.generatedAt);
    if (published.length === 1) first();
    if (published.length === 2) landed();
  });
  try {
    // Resolving at all proves usage did not wait behind the blocked claim write.
    await usage;
    releaseWrite();
    await refreshed;
    assert.ok(published[1]! > published[0]!, "the landed write must trigger a fresh read");
  } finally {
    handle.release();
    releaseWrite();
    await controller.dispose();
  }
});
