/*
 * Keywords: daemon, rpc, validation, stats, sanitised diagnostics, tests.
 * Exports:
 * - No production exports; tests protect daemon transport failure and domain result boundaries. Keywords: daemon, rpc, failure, test.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { GitArcFailureException } from "../git/git-arc-failures.ts";
import WorkbenchDaemonClient, { WorkbenchDaemonRequestError } from "./WorkbenchDaemonClient.ts";
import { WorkbenchStatsResponseSchema } from "../stats/workbench-stats-contract.ts";

test("transport failures never fall back to app HTTP", async () => {
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches += 1;
    return Response.json({ localCapabilities: { browseRawCommandsEnabled: true } });
  };
  try {
    const unavailable = new WorkbenchDaemonClient({ request: async () => { throw new Error("daemon disconnected"); } });
    await assert.rejects(
      unavailable.request("local-capabilities/read", {}),
      /daemon disconnected/u,
    );
    assert.equal(fetches, 0);

    const missingMethod = new WorkbenchDaemonClient({
      request: async () => { throw new WorkbenchDaemonRequestError("method not found", -32601); },
    });
    await assert.rejects(
      missingMethod.request("local-capabilities/read", {}),
      /method not found/u,
    );
    assert.equal(fetches, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Codex sandbox network responses require the complete server-owned settings snapshot", async () => {
  const snapshot = {
    codexSandboxNetwork: {
      effectiveEnabled: false,
      globalEnabled: true,
      projectId: "project",
      projectOverride: false,
    },
  };
  const valid = new WorkbenchDaemonClient({
    request: async <TResponse>() => snapshot as TResponse,
  });
  assert.deepEqual(
    await valid.request("codex-sandbox-network/read", { projectId: "project" }),
    snapshot,
  );

  const malformed = new WorkbenchDaemonClient({
    request: async <TResponse>() => ({
      codexSandboxNetwork: {
        effectiveEnabled: true,
        globalEnabled: false,
        projectId: "project",
      },
    }) as TResponse,
  });
  await assert.rejects(
    malformed.request("codex-sandbox-network/read", { projectId: "project" }),
    /response was invalid/u,
  );
});

test("Git arc requests return exact domain results and preserve structured failures", async () => {
  const comparison = {
    changes: [],
    checkpointCommit: "a".repeat(40),
    checkpointRef: "refs/workbench/arc",
    intentName: "typed Git request",
    repoRoot: "C:/git/web/workbench",
    scopePaths: ["webapp"],
  };
  const success = new WorkbenchDaemonClient({
    request: async <TResponse>() => comparison as TResponse,
  });
  assert.deepEqual(
    await success.requestGitArc("git/arc/compare", {
      cwd: "C:/git/web/workbench",
      harness: "codex",
      refs: [],
      roots: [],
      threadId: "thread",
    }),
    comparison,
  );

  const failure = {
    action: "compare" as const,
    code: "operationRejected" as const,
    message: "Comparison was rejected.",
    version: 1 as const,
  };
  const rejected = new WorkbenchDaemonClient({
    request: async () => {
      throw new WorkbenchDaemonRequestError("Comparison was rejected.", -32000, { gitArcFailure: failure });
    },
  });
  await assert.rejects(
    rejected.requestGitArc("git/arc/compare", {
      cwd: "C:/git/web/workbench",
      harness: "codex",
      refs: [],
      roots: [],
      threadId: "thread",
    }),
    (error) => error instanceof GitArcFailureException
      && assert.deepEqual(error.failure, failure) === undefined,
  );
});

test("detailed stats retain category costs and reject malformed remote values with sanitised diagnostics", async (context) => {
  const legacy = WorkbenchStatsResponseSchema.parse({
    bucketUnit: "day", claimHotspots: [], cost: { buckets: [], pricedTokens: 0, totalUsd: 0, unpricedTokens: 0 },
    failures: [], generatedAt: 1, pricingCatalogDate: "2026-09-05", projectId: null, rateLimits: [],
    range: "7d", recordingStartedAt: null, startedAt: 0,
    tokens: { buckets: [], totals: { all: 0, cachedInput: 0, input: 0, output: 0 } },
  });
  const detailed = { ...legacy, cost: { ...legacy.cost, buckets: [], byTokenType: { input: 0, cache: 0, output: 0 } } };
  const valid = new WorkbenchDaemonClient({ request: async <TResponse>() => detailed as TResponse });
  assert.deepEqual(await valid.request("stats/read/detailed", { projectId: null, range: "7d", tokenTypes: [] }), detailed);
  const logged: string[] = [];
  context.mock.method(console, "error", (message: string) => { logged.push(message); });
  const malformed = new WorkbenchDaemonClient({ request: async <TResponse>() => ({
    ...detailed, cost: { ...detailed.cost, byTokenType: { input: "private-payload-marker", cache: 0, output: 0 } },
  }) as TResponse });
  await assert.rejects(malformed.request("stats/read/detailed", { projectId: null, range: "7d" }), /response was invalid/);
  assert.ok(logged.length > 0);
  assert.ok(logged.every((message) => message.length < 1_200 && !message.includes("private-payload-marker")));
  const cacheEfficiency = {
    totals: { inputTokens: 1_000, cachedInputTokens: 940, cacheHitPercent: 94 }, buckets: [], worstThreads: [],
  };
  const enriched = { ...detailed, cacheEfficiency };
  const cacheClient = new WorkbenchDaemonClient({ request: async <TResponse>() => enriched as TResponse });
  assert.deepEqual(await cacheClient.request("stats/read/efficiency", { projectId: null, range: "7d" }), enriched);
  const badCache = new WorkbenchDaemonClient({ request: async <TResponse>() => ({
    ...enriched, cacheEfficiency: { ...cacheEfficiency, totals: { ...cacheEfficiency.totals, cacheHitPercent: "private-cache-marker" } },
  }) as TResponse });
  const previousLogs = logged.length;
  await assert.rejects(badCache.request("stats/read/efficiency", { projectId: null, range: "7d" }), /response was invalid/);
  assert.ok(logged.length > previousLogs);
  assert.ok(logged.every((message) => message.length < 1_200 && !message.includes("private-cache-marker")));
  const current = { ...enriched, cacheEfficiency: { ...cacheEfficiency,
    worstThreads: [{ ...cacheEfficiency.totals, projectId: "project", threadId: "thread", title: "Thread", cacheWriteInputTokens: 10 }],
  } };
  const currentClient = new WorkbenchDaemonClient({ request: async <TResponse>() => current as TResponse });
  assert.deepEqual(await currentClient.request("stats/read/efficiency/v2", { projectId: null, range: "7d" }), current);
  const badWrites = new WorkbenchDaemonClient({ request: async <TResponse>() => ({
    ...current, cacheEfficiency: { ...current.cacheEfficiency,
      worstThreads: [{ ...current.cacheEfficiency.worstThreads[0], cacheWriteInputTokens: "private-write-marker" }],
    },
  }) as TResponse });
  const beforeWriteLogs = logged.length;
  await assert.rejects(badWrites.request("stats/read/efficiency/v2", { projectId: null, range: "7d" }), /response was invalid/);
  assert.ok(logged.length > beforeWriteLogs);
  assert.ok(logged.every((message) => message.length < 1_200 && !message.includes("private-write-marker")));
});

test("search responses require the complete discriminated result contract", async () => {
  const response = {
    results: [{
      actionId: "home",
      detail: "Ctrl+H",
      id: "action:home",
      kind: "action" as const,
      title: "Home",
    }],
  };
  const valid = new WorkbenchDaemonClient({
    request: async <TResponse>() => response as TResponse,
  });
  assert.deepEqual(await valid.request("search/query", { projectId: "", query: "home" }), response);

  const malformed = new WorkbenchDaemonClient({
    request: async <TResponse>() => ({
      results: [{ id: "action:home", kind: "action", title: "Home" }],
    }) as TResponse,
  });
  await assert.rejects(
    malformed.request("search/query", { projectId: "", query: "home" }),
    /response was invalid/u,
  );
});

test("stats import progress notifications cross the typed browser boundary", () => {
  let notify: (notification: { method: string; params: unknown }) => void = () => undefined;
  const client = new WorkbenchDaemonClient({
    onNotification: (listener) => { notify = listener; return () => { notify = () => undefined; }; },
    request: async <TResponse>() => ({}) as TResponse,
  });
  const received: number[] = [];
  const unsubscribe = client.onStatsImportProgress((progress) => received.push(progress.revision));
  notify({
    method: "workbench/stats/import/updated",
    params: {
      completedThreads: 1, failedThreads: 0, percent: 100, processedThreads: 1,
      recentFailures: [], revision: 2, state: "complete", totalThreads: 1, unavailableThreads: 0,
    },
  });
  assert.deepEqual(received, [2]);
  unsubscribe();
});
