/*
 * No exports. Protect import startup, ordered capture, feedback refresh, claimed-root rename reads, account-limit history,
 * partial refresh, failures, tool prompt cost, and disposal.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type {
  WorkbenchStatsImportProgress,
  WorkbenchStatsReadRequest,
  WorkbenchStatsResponse,
  WorkbenchStatsSection,
  WorkbenchStatsSectionData,
} from "workbench-shared/workbench/stats/workbench-stats-contract";
import { EMPTY_WORKBENCH_STATS_SECTIONS } from "workbench-shared/workbench/stats/workbench-stats-conformance";
import type { WorkbenchFeedbackRecord } from "workbench-shared/workbench/stats/workbench-stats-feedback-contract";
import type { WorkbenchStoredStatsSection } from "../database/stats/WorkbenchStatsRepository.ts";
import { testProjectIds } from "workbench-shared/workbench/test-identities";
import WorkbenchStatsController from "./WorkbenchStatsController.ts";
import type { WorkbenchClaimRenameScope } from "./WorkbenchClaimRenameController.ts";
import { ProjectIdSchema, WorkbenchThreadIdSchema } from "workbench-shared/workbench/identity";
import type WorkbenchProvider from "../WorkbenchProvider";
import { WorkbenchAccountLimitsSchema } from "workbench-shared/workbench/provider/provider-account";

const unused = async (): Promise<never> => { throw new Error("Unexpected provider operation"); };
function providers(read: () => Promise<import("workbench-shared/workbench/provider/provider-account").WorkbenchAccountLimits> = unused) {
  const provider: WorkbenchProvider = {
    threads: {
      reconcile: unused, readLatest: unused, messageAgent: unused,
      create: unused, list: unused, read: unused, submit: unused,
      rename: unused, compact: unused, interrupt: unused, isTurnLive: unused, materialize: unused, latestTurn: unused, admitTurn: unused,
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

function emptyStats(request: { section: WorkbenchStoredStatsSection }, generatedAt = 1): WorkbenchStatsResponse {
  return { ...EMPTY_WORKBENCH_STATS_SECTIONS[request.section], generatedAt };
}

function importPorts() {
  return {
    readClaimStats: async () => ({ kind: "files" as const, page: 1, pages: 1, rows: [] }),
    readFeedback: async () => ({ page: 1, pages: 1, rows: [] }),
    deleteFeedback: async () => 0,
    recordFeedback: async () => 1,
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
  listUsageHydrationHarnesses: async () => [],
};

/** The first refined snapshot of one section, then stop observing. */
function settled<Section extends WorkbenchStatsSection>(
  controller: WorkbenchStatsController,
  request: WorkbenchStatsReadRequest & { section: Section },
) {
  return new Promise<WorkbenchStatsSectionData<Section>>((resolve, reject) => {
    const handle = controller.observe(request, (state) => {
      if (state.phase === "failed") {
        handle.release();
        reject(new Error(state.failure ?? "Statistics failed."));
      } else if (state.data && state.refinement !== "pending") {
        handle.release();
        assert.equal(state.data.section, request.section);
        resolve(state.data as WorkbenchStatsSectionData<Section>);
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
      readStats: async (request, _now, aliases) => { seen.push(aliases); return emptyStats(request); },
      readClaimStats: async (_request, _now, aliases) => { seen.push(aliases); return { kind: "files", page: 1, pages: 1, rows: [] }; },
      recordStatsClaimSnapshot: async () => undefined, recordStatsRateLimits: async () => undefined,
    },
    harnesses,
  });
  const request = { projectIds: [projectId], range: "7d" as const, section: "claims" as const };
  const fileRequest = { projectId, range: "all" as const, file: null, page: 1 };
  try {
    await settled(controller, request);
    await controller.readClaims(fileRequest);
    assert.deepEqual(claimedRequests, [{ projectIds: [projectId], range: "7d" }, { projectIds: [projectId], range: "all" }]);
    assert.deepEqual(scopes[0], [{ projectId, rootId: "root", since: 86_400_000 }]);
    // Counts publish before history is known, then claims re-read with the aliases.
    assert.deepEqual(seen, [[], renames, renames]);
    claimed = [];
    await settled(controller, { ...request, projectIds: null });
    assert.deepEqual(scopes.at(-1), [], "unclaimed scopes must not walk any history");
    claimed = [{ projectId, rootId: "root", earliestClaimedDay: 0 }];
    fail = true;
    assert.deepEqual((await settled(controller, request)).historyFailures, ["History unavailable."]);
    const before = seen.length;
    await assert.rejects(controller.readClaims(fileRequest));
    assert.equal(seen.length, before);
    fail = false;
    assert.deepEqual((await settled(controller, request)).historyFailures, []);
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
      readStats: async (request) => emptyStats(request),
      recordStatsClaimSnapshot: async () => undefined,
      recordStatsRateLimits: async () => undefined,
    },
    harnesses,
  });
  controller.start();
  // Begin follows the asynchronous provider capability probe.
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(starts, 1);
  await controller.dispose();
});

test("the status section carries durable import status without reading SQLite stats", async () => {
  const progress = { ...importProgress, revision: 42 };
  const controller = new WorkbenchStatsController({
    claims,
    providers: providers(),
    database: {
      ...importPorts(), readStatsImportProgress: async () => progress,
      readStats: unused,
      recordStatsClaimSnapshot: async () => undefined, recordStatsRateLimits: async () => undefined,
    },
    harnesses,
  });
  try {
    assert.equal((await settled(controller, { projectIds: null, range: "7d", section: "status" })).historyImport.revision, 42);
  } finally { await controller.dispose(); }
});

test("the tools section lists every catalogued tool with its prompt cost, and still counts calls without a catalogue", async () => {
  const calls = { ...EMPTY_WORKBENCH_STATS_SECTIONS.tools, tools: {
    bucketStarts: [10, 20], catalogue: null, threadCount: 2, threads: [],
    workbench: [
      { buckets: [3, 1], bucketThreads: [], calls: 4, docsTokens: 0, failed: 1, specTokens: null, threads: 2, tool: "rg" },
      { buckets: [0, 1], bucketThreads: [], calls: 1, docsTokens: 0, failed: 0, specTokens: null, threads: 1, tool: "retired_tool" },
    ],
  } };
  let catalogueFails = false;
  const logs: string[] = [];
  const controller = new WorkbenchStatsController({
    claims,
    providers: providers(),
    database: {
      ...importPorts(),
      readStats: async () => calls,
      recordStatsClaimSnapshot: async () => undefined, recordStatsRateLimits: async () => undefined,
    },
    harnesses,
    log: (message) => logs.push(message),
    toolCatalogue: {
      read: async () => {
        if (catalogueFails) throw new Error("mcp reloading");
        return {
          docsTokens: 30, specTokens: 150,
          tools: new Map([["rg", { docsTokens: 20, specTokens: 100 }], ["git_add", { docsTokens: 10, specTokens: 50 }]]),
        };
      },
    },
  });
  const request = { projectIds: null, range: "7d" as const, section: "tools" as const };
  try {
    const { tools } = await settled(controller, request);
    assert.deepEqual(tools.catalogue, { docsTokens: 30, specTokens: 150, tools: 2 });
    assert.deepEqual(tools.workbench.map(({ calls, specTokens, tool }) => [tool, calls, specTokens]), [
      ["rg", 4, 100], ["retired_tool", 1, null], ["git_add", 0, 50],
    ]);
    assert.deepEqual(tools.workbench.find(({ tool }) => tool === "git_add")?.buckets, [0, 0], "unused tools still chart an empty range");

    catalogueFails = true;
    const degraded = await settled(controller, request);
    await settled(controller, request);
    assert.equal(degraded.tools.catalogue, null);
    assert.deepEqual(degraded.tools.workbench.map(({ tool }) => tool), ["rg", "retired_tool"]);
    assert.equal(logs.filter((message) => message.includes("mcp reloading")).length, 1, "a repeated failure warns once");
  } finally { await controller.dispose(); }
});

test("recorded feedback refreshes open observations and failed writes reach the caller", async () => {
  let reads = 0;
  let fail = false;
  const controller = new WorkbenchStatsController({
    claims,
    providers: providers(),
    database: {
      ...importPorts(),
      readStats: async (request) => emptyStats(request, ++reads),
      recordFeedback: async () => {
        if (fail) throw new Error("disk full");
        return 7;
      },
      recordStatsClaimSnapshot: async () => undefined, recordStatsRateLimits: async () => undefined,
    },
    harnesses,
  });
  const entry: WorkbenchFeedbackRecord = {
    category: "bug", channel: "wb", harness: "codex", model: null, projectId: testProjectIds.project,
    reasoningEffort: null, report: "broken", threadId: WorkbenchThreadIdSchema.parse("thread"), title: "Stats action fails",
  };
  try {
    const published: number[] = [];
    let initial!: () => void;
    let refreshed!: () => void;
    const ready = new Promise<void>((resolve) => { initial = resolve; });
    const refresh = new Promise<void>((resolve) => { refreshed = resolve; });
    const handle = controller.observe({ projectIds: null, range: "7d", section: "feedback" }, (state) => {
      if (state.data && state.refinement !== "pending") published.push(state.data.generatedAt);
      if (published.length === 1) initial();
      if (published.length === 2) refreshed();
    });
    await ready;
    assert.equal(await controller.recordFeedback(entry), 7);
    await refresh;
    assert.deepEqual(published, [1, 2]);
    handle.release();
    fail = true;
    await assert.rejects(controller.recordFeedback(entry), /disk full/u);
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
      readStats: async (request) => emptyStats(request),
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
      readStats: async (request) => emptyStats(request),
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
  const result = await settled(controller, { projectIds: null, range: "7d", section: "status" });
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
      readStats: async (request) => emptyStats(request, ++reads),
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
  const handle = controller.observe({ projectIds: null, range: "7d", section: "usage" }, (state) => {
    if (state.data && state.refinement !== "pending") published.push(state.data.generatedAt);
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
