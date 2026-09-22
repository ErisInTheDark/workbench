/*
 * Exports:
 * - No production exports; protect daemon transport failure and validated domain results.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { captureTestOutput } from "../../../test/capture-test-output.mts";

import { GitArcFailureException } from "../git/git-arc-failures.ts";
import WorkbenchDaemonClient, { WorkbenchDaemonRequestError } from "./WorkbenchDaemonClient.ts";
import { WorkbenchStatsResponseSchema } from "../stats/workbench-stats-contract.ts";

test("command approval responses reject malformed permissions without leaking their values", async context => {
  const diagnostics: string[] = [];
  context.mock.method(console, "error", (message: string) => { diagnostics.push(message); });
  const client = new WorkbenchDaemonClient({
    request: async <TResponse>() => ({ rules: [{ id: "private-permission", prefix: ["private-script"] }] }) as TResponse,
  });
  const projectId = "a6652caf-f7c1-4a2a-ab55-6b387a19ab05";
  await assert.rejects(client.commandApprovals.read({ projectId }));
  await assert.rejects(client.commandApprovals.remove({ projectId, id: "6ec53578-a9ef-44df-8f4b-bb62f2d8ae4a" }));
  assert.equal(diagnostics.length, 2);
  assert.ok(diagnostics.every(message => !message.includes("private-") && message.length < 1200));
});

test("voice events reject malformed remote data without logging document contents", async context => {
  const diagnostics: string[] = [];
  context.mock.method(console, "error", (message: string) => { diagnostics.push(message); });
  let notify!: (notification: { method: string; params: unknown }) => void;
  const client = new WorkbenchDaemonClient({
    request: async <TResponse>() => ({}) as TResponse,
    onNotification: listener => { notify = listener; return () => {}; },
  });
  const events: string[] = [];
  client.onVoiceEvent(event => events.push(event.type));
  notify({ method: "voice/event", params: {
    type: "document", sessionId: "9d59d847-6d43-4616-8df7-f516abc8e19d",
    revision: "private-transcript-marker", text: "private-document-marker",
  } });
  assert.deepEqual(events, []);
  assert.equal(diagnostics.length, 1);
  assert.ok(diagnostics.every(message => message.length < 1200 && !message.includes("private-")));
  notify({ method: "voice/event", params: {
    type: "document", sessionId: "9d59d847-6d43-4616-8df7-f516abc8e19d", revision: 1, text: "valid",
  } });
  assert.deepEqual(events, ["document"]);
});

test("questionnaire history retains an answer before the first provider item", async () => {
  const entry = {
    threadId: "thread", turnId: "turn", itemId: "question", requestKey: "request",
    insertAfterItemId: null, insertAfterItemIndex: -1, resolvedAt: 1,
    request: {
      id: "request", title: "Continue?", summary: "", submitLabel: "Submit",
      questions: [{ id: "continue", header: "", question: "Continue?", allowOther: true, isSecret: false, options: [] }],
    },
    response: { answers: { continue: { answers: ["yes"] } } },
  };
  const client = new WorkbenchDaemonClient({ request: async <TResponse>() => ({ data: [entry] }) as TResponse });
  assert.deepEqual((await client.threads.history.questionnaires({ threadId: "thread" })).data, [entry]);
});

test("message admission never resends an ambiguous response or transport failure", async (context) => {
  const logged: string[] = [];
  context.mock.method(console, "error", (message: string) => { logged.push(message); });
  for (const outcome of ["invalid", "disconnected"] as const) {
    let sent = 0;
    const client = new WorkbenchDaemonClient({
      request: async <TResponse>() => {
        sent += 1;
        if (outcome === "disconnected") throw new Error("connection closed after sending");
        return { kind: "steered", turnId: { privateMarker: "private-admission-value" } } as TResponse;
      },
    });
    await assert.rejects(client.threads.message({
      threadId: "4fdfc1fa-b939-48ec-a1d8-ff27befa708e",
      clientMessageId: "message",
      input: [{ type: "text", text: "hello", text_elements: [] }],
      intent: "continue",
    }), outcome === "invalid" ? /response was invalid/ : /connection closed/);
    assert.equal(sent, 1);
  }
  assert.equal(logged.length, 1);
  assert.ok(logged.every(message => !message.includes("private-admission-value")));
});

test("profile recency defaults for old servers and rejects malformed values", async (context) => {
  const logged: string[] = [];
  context.mock.method(console, "error", (message: string) => { logged.push(message); });
  const legacy = new WorkbenchDaemonClient({ request: async <TResponse>() => ({ profiles: [{ id: "profile" }] }) as TResponse });
  assert.equal((await legacy.profiles.read()).profiles[0]?.lastUsedAt, null);
  const malformed = new WorkbenchDaemonClient({ request: async <TResponse>() => ({
    profiles: [{ id: "profile", lastUsedAt: "private-recency-marker" }],
  }) as TResponse });
  await assert.rejects(malformed.profiles.read(), /response was invalid/);
  assert.ok(logged.length > 0);
  assert.ok(logged.every(message => message.length < 1200 && !message.includes("private-recency-marker")));
});

test("model capabilities reject invalid bounds at the daemon response boundary", async (context) => {
  const diagnostics = captureTestOutput(context, process.stderr, text => text.startsWith("Rejected models/context/read response:"));
  context.after(() => assert.equal(diagnostics.length, 1));
  const valid = { data: [{ model: "model", defaultTokens: 128000, maximumTokens: 1000000 }] };
  const client = new WorkbenchDaemonClient({ request: async <TResponse>() => valid as TResponse });
  assert.deepEqual(await client.models.context({ provider: "codex" }), valid);
  const malformed = new WorkbenchDaemonClient({ request: async <TResponse>() => ({ data: [{ model: "model", defaultTokens: 1000000, maximumTokens: 128000 }] }) as TResponse });
  await assert.rejects(malformed.models.context({ provider: "codex" }), /response was invalid/);
});

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
      unavailable.localCapabilities.read(),
      /daemon disconnected/u,
    );
    assert.equal(fetches, 0);

    const missingMethod = new WorkbenchDaemonClient({
      request: async () => { throw new WorkbenchDaemonRequestError("method not found", -32601); },
    });
    await assert.rejects(
      missingMethod.localCapabilities.read(),
      /method not found/u,
    );
    assert.equal(fetches, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("sandbox network responses require the complete declared settings snapshot", async (context) => {
  const diagnostics = captureTestOutput(context, process.stderr, text => text.startsWith("Rejected sandbox-network/read response:"));
  context.after(() => assert.equal(diagnostics.length, 1));
  const snapshot = {
    data: [{
      provider: "codex", label: "Sandbox network access",
      effectiveEnabled: false,
      globalEnabled: true,
      projectId: "project",
      projectOverride: false,
    }],
  };
  const valid = new WorkbenchDaemonClient({
    request: async <TResponse>() => snapshot as TResponse,
  });
  assert.deepEqual(
    await valid.sandboxNetwork.read({ projectId: "project" }),
    snapshot,
  );

  const malformed = new WorkbenchDaemonClient({
    request: async <TResponse>() => ({
      data: [{
        provider: "codex", label: "Sandbox network access",
        effectiveEnabled: true,
        globalEnabled: false,
        projectId: "project",
      }],
    }) as TResponse,
  });
  await assert.rejects(
    malformed.sandboxNetwork.read({ projectId: "project" }),
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
    await success.git.arc.compare({
      cwd: "C:/git/web/workbench",
      harness: "codex",
      refs: [],
      roots: [],
      threadId: "thread",
    }),
    comparison,
  );
  const stashResult = { conflictedPaths: ["src/conflict.ts"], phase: "active" as const, stashedPaths: [] };
  const stashClient = new WorkbenchDaemonClient({
    request: async <TResponse>() => stashResult as TResponse,
  });
  assert.deepEqual(await stashClient.git.arc.unstash({
    cwd: "C:/git/web/workbench",
    harness: "codex",
    threadId: "thread",
  }), stashResult);

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
    rejected.git.arc.compare({
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
  assert.deepEqual(await valid.stats.detailed({ projectId: null, range: "7d", tokenTypes: [] }), detailed);
  const logged: string[] = [];
  context.mock.method(console, "error", (message: string) => { logged.push(message); });
  const malformed = new WorkbenchDaemonClient({ request: async <TResponse>() => ({
    ...detailed, cost: { ...detailed.cost, byTokenType: { input: "private-payload-marker", cache: 0, output: 0 } },
  }) as TResponse });
  await assert.rejects(malformed.stats.detailed({ projectId: null, range: "7d" }), /response was invalid/);
  assert.ok(logged.length > 0);
  assert.ok(logged.every((message) => message.length < 1_200 && !message.includes("private-payload-marker")));
  const cacheEfficiency = {
    totals: { inputTokens: 1_000, cachedInputTokens: 940, cacheHitPercent: 94 }, buckets: [], worstThreads: [],
  };
  const enriched = { ...detailed, cacheEfficiency };
  const cacheClient = new WorkbenchDaemonClient({ request: async <TResponse>() => enriched as TResponse });
  assert.deepEqual(await cacheClient.stats.efficiency({ projectId: null, range: "7d" }), enriched);
  const badCache = new WorkbenchDaemonClient({ request: async <TResponse>() => ({
    ...enriched, cacheEfficiency: { ...cacheEfficiency, totals: { ...cacheEfficiency.totals, cacheHitPercent: "private-cache-marker" } },
  }) as TResponse });
  const previousLogs = logged.length;
  await assert.rejects(badCache.stats.efficiency({ projectId: null, range: "7d" }), /response was invalid/);
  assert.ok(logged.length > previousLogs);
  assert.ok(logged.every((message) => message.length < 1_200 && !message.includes("private-cache-marker")));
  const current = { ...enriched, cacheEfficiency: { ...cacheEfficiency,
    worstThreads: [{ ...cacheEfficiency.totals, projectId: "project", threadId: "thread", title: "Thread", cacheWriteInputTokens: 10 }],
  } };
  const currentClient = new WorkbenchDaemonClient({ request: async <TResponse>() => current as TResponse });
  assert.deepEqual(await currentClient.stats.efficiencyV2({ projectId: null, range: "7d" }), current);
  const badWrites = new WorkbenchDaemonClient({ request: async <TResponse>() => ({
    ...current, cacheEfficiency: { ...current.cacheEfficiency,
      worstThreads: [{ ...current.cacheEfficiency.worstThreads[0], cacheWriteInputTokens: "private-write-marker" }],
    },
  }) as TResponse });
  const beforeWriteLogs = logged.length;
  await assert.rejects(badWrites.stats.efficiencyV2({ projectId: null, range: "7d" }), /response was invalid/);
  assert.ok(logged.length > beforeWriteLogs);
  assert.ok(logged.every((message) => message.length < 1_200 && !message.includes("private-write-marker")));
});

test("search responses require the complete discriminated result contract", async (context) => {
  const diagnostics = captureTestOutput(context, process.stderr, text => text.startsWith("Rejected search/query response:"));
  context.after(() => assert.equal(diagnostics.length, 1));
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
  assert.deepEqual(await valid.search.query({ projectId: "", query: "home" }), response);

  const malformed = new WorkbenchDaemonClient({
    request: async <TResponse>() => ({
      results: [{ id: "action:home", kind: "action", title: "Home" }],
    }) as TResponse,
  });
  await assert.rejects(
    malformed.search.query({ projectId: "", query: "home" }),
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
