/*
 * Exports:
 * - No production exports; tests protect provider normalization, SQLite store routing, relationship projection, progressive reconciliation, Git projection and retention routing, managed resume, and controller-owned title mutation. Keywords: provider, sidebar, sqlite, subagent, title, resume, reconciliation, git, retention, test.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { WorkbenchHarness, WorkbenchSubagentRelationship } from "../lib/types";
import type { WorkbenchThreadStateSnapshot } from "../lib/workbench/thread/thread-state";
import type { WorkbenchDatabaseMutation, WorkbenchDatabaseQuery, WorkbenchDatabaseRow, WorkbenchDatabaseValue } from "workbench-shared/database/workbench-database-statements";
import type { JsonRpcRequest, JsonRpcResponse } from "./bridge-types";
import { encodeTranscriptPathSegment } from "./codex-transcript-normalizers";
import WorkbenchThreadStateFeature, { mapProviderActivityNotification, mapProviderLifecycleNotification, normalizeProviderSidebarEntry, normalizeSubagentProviderLifecycle } from "./WorkbenchThreadStateFeature";

async function waitFor(predicate: () => boolean | Promise<boolean>, message: string) {
  const deadline = Date.now() + 1_000;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function deferred<TValue>() {
  let resolve!: (value: TValue) => void;
  const promise = new Promise<TValue>((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
}

function createHarnesses(
  request: (harness: WorkbenchHarness, value: JsonRpcRequest) => Promise<JsonRpcResponse>,
  resumeThread: (harness: WorkbenchHarness, threadId: string) => Promise<void> = async () => undefined,
) {
  return {
    listHarnesses: () => ["codex", "copilot", "opencode"] satisfies WorkbenchHarness[],
    request,
    resumeThread,
  };
}

function createThreadStateDatabase() {
  const rowsByTable = new Map<string, Array<Record<string, WorkbenchDatabaseValue>>>();
  const operations: string[] = [];
  return {
    executeTransaction: async (statements: readonly WorkbenchDatabaseMutation[]) => {
      for (const statement of statements) {
        operations.push(`${statement.kind}:${statement.tableName}`);
        if (statement.kind !== "upsert") throw new Error(`Unexpected test database mutation: ${statement.kind}`);
        const rows = rowsByTable.get(statement.tableName) ?? [];
        const incoming = Object.fromEntries(statement.values);
        const existing = rows.find((row) => statement.conflictColumns.every((column) => row[column] === incoming[column]));
        if (existing) {
          for (const column of statement.updateColumns) existing[column] = incoming[column]!;
        } else {
          rows.push(incoming);
          rowsByTable.set(statement.tableName, rows);
        }
      }
      return { changes: statements.length };
    },
    query: async <Row extends WorkbenchDatabaseRow>(statement: WorkbenchDatabaseQuery<Row>) => {
      operations.push(`${statement.kind}:${statement.tableName}`);
      const rows = rowsByTable.get(statement.tableName) ?? [];
      return rows.filter((row) => (
        statement.where.every(([column, value]) => row[column] === value)
        && statement.whereIn.every(([column, values]) => values.includes(row[column] as Exclude<WorkbenchDatabaseValue, null>))
      )).map((row) => ({ ...row }) as Row);
    },
    operations,
  };
}

test("provider sidebar normalization converts seconds at the reloadable feature boundary", () => {
  const entry = normalizeProviderSidebarEntry("codex", {
    id: "thread",
    recencyAt: 1_700_000_000,
    status: { type: "idle" },
    turns: [{ startedAt: 1_710_000_000 }, { startedAt: 1_720_000_000 }],
    updatedAt: 1_723_456_789,
  });
  assert.equal(entry?.activityAt, 1_723_456_789_000);
  assert.equal(entry?.entryKind === "thread" ? entry.orderAt : null, 1_720_000_000_000);
  const fallback = normalizeProviderSidebarEntry("codex", { id: "fallback", recencyAt: 1_700_000_000, status: { type: "idle" }, turns: [], updatedAt: 1_723_456_789 });
  assert.equal(fallback?.entryKind === "thread" ? fallback.orderAt : null, 1_700_000_000_000);
});

test("provider sidebar normalization replaces identifier titles with first-message previews", () => {
  const id = "123e4567-e89b-42d3-a456-426614174000";
  const entry = normalizeProviderSidebarEntry("codex", { id, name: id, preview: "First request", status: { type: "idle" }, updatedAt: 1 });
  assert.equal(entry?.title, "First request");
});

test("inactive subagents remain completed but unsettled until an explicit settlement overlay exists", () => {
  assert.deepEqual(normalizeSubagentProviderLifecycle({ kind: "completed", reason: "providerInactive", settled: true }), {
    kind: "completed",
    reason: "providerInactive",
    settled: false,
  });
  const explicitlySettled = { agent: { agentStatus: "completed" as const, turnId: "turn" }, kind: "completed" as const, reason: "agentCompleted" as const, settled: true };
  assert.equal(normalizeSubagentProviderLifecycle(explicitlySettled), explicitlySettled);
});

test("provider lifecycle notification mapping is exact and bounded", () => {
  assert.deepEqual(mapProviderLifecycleNotification({
    method: "item/started",
    params: { item: { id: "user", type: "userMessage" }, threadId: "child", turnId: "turn" },
  }), {
    event: { kind: "userInputDelivered", turnId: "turn" }, threadId: "child",
  });
  assert.deepEqual(mapProviderLifecycleNotification({
    method: "turn/started",
    params: { threadId: "child", turn: { id: "new-turn", items: [{ id: "user", type: "userMessage" }] } },
  }), {
    event: { kind: "userInputDelivered", turnId: "new-turn" }, threadId: "child",
  });
  assert.deepEqual(mapProviderLifecycleNotification({ method: "turn/completed", params: { threadId: "child", turn: { id: "turn", status: "completed" } } }), {
    event: { kind: "turnCompleted", status: "completed", turnId: "turn" }, threadId: "child",
  });
  assert.deepEqual(mapProviderLifecycleNotification({ method: "questionnaire/requested", params: { requestKey: "question", threadId: "child", turnId: null } }), {
    event: { kind: "pendingInput", questionnaire: null, requestKey: "question", turnId: null }, threadId: "child",
  });
  assert.equal(mapProviderLifecycleNotification({
    method: "item/completed",
    params: { item: { id: "agent", type: "agentMessage" }, threadId: "child", turnId: "turn" },
  }), null);
  assert.equal(mapProviderLifecycleNotification({ method: "turn/completed", params: { threadId: "child", turn: { id: "turn", status: "inProgress" } } }), null);
});

test("provider notification observation returns the persisted lifecycle result", async () => {
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-thread-observation-result-"));
  const database = createThreadStateDatabase();
  const feature = new WorkbenchThreadStateFeature({
    database,
    getProjectCatalog: () => ({ data: [], rootPath: storageRoot }),
    gitArcs: { findActiveClaim: async () => null, listActiveClaims: async () => [] },
    harnesses: createHarnesses(async (_harness, request) => ({ id: request.id ?? null, result: { data: [], nextCursor: null } })),
    listSubagents: async () => ({ subagents: [] }),
    projectState: {
      getCurrentUpdate: () => null,
      handleRequest: async () => ({ accepted: true }),
      observe: () => () => undefined,
    },
    publish: () => undefined,
    resolveProjectById: async () => ({ id: "project", rootPath: storageRoot }),
    resolveProjectFromCwd: async (cwd) => ({ cwd, project: { id: "project", rootPath: storageRoot } }),
    storageRoot,
    transitions: { run: async (_key, operation) => await operation() },
  });
  await feature.controller.ensureProviderEntry("project", {
    activityAt: 1,
    entryKind: "thread",
    identity: { harness: "codex", threadId: "thread" },
    lifecycle: { agent: { agentStatus: "working", turnId: "turn" }, kind: "working", reason: "acceptedIntent", settled: false },
    metadata: { archived: false, pinned: false, snoozed: false },
    title: "Thread",
  });

  assert.deepEqual(await feature.observeProviderNotification("codex", {
    method: "turn/completed",
    params: { threadId: "thread", turn: { id: "turn", status: "completed" } },
  }), {
    event: { kind: "turnCompleted", status: "completed", turnId: "turn" },
    lifecycle: { kind: "needsAttention", reason: "noActiveTurn", settled: false },
    threadId: "thread",
  });
  assert.equal(database.operations.includes("upsert:workbench_thread_state_projects"), true);

  await feature.dispose();
  await fs.rm(storageRoot, { force: true, recursive: true });
});

test("provider activity mapping observes meaningful cross-provider work without token deltas", () => {
  assert.deepEqual(mapProviderActivityNotification({ method: "turn/started", params: { threadId: "thread", turn: { id: "turn", startedAt: 1_723_456_789 } } }), {
    kind: "turnStarted", startedAt: 1_723_456_789_000, threadId: "thread",
  });
  assert.deepEqual(mapProviderActivityNotification({ method: "turn/started", params: { threadId: "thread", turn: { id: "turn" } } }), {
    kind: "turnStarted", startedAt: null, threadId: "thread",
  });
  assert.deepEqual(mapProviderActivityNotification({ method: "item/completed", params: { threadId: "thread", turnId: "turn" } }), {
    kind: "activity", threadId: "thread",
  });
  assert.equal(mapProviderActivityNotification({ method: "item/agentMessage/delta", params: { threadId: "thread", turnId: "turn" } }), null);
});

test("Codex MCP admission reads thread metadata without hydrating transcript turns", async () => {
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-thread-mcp-admission-"));
  const requests: JsonRpcRequest[] = [];
  const feature = new WorkbenchThreadStateFeature({
    database: createThreadStateDatabase(),
    getProjectCatalog: () => ({ data: [], rootPath: storageRoot }),
    gitArcs: { findActiveClaim: async () => null, listActiveClaims: async () => [] },
    harnesses: createHarnesses(async (_harness, request) => {
      requests.push(request);
      return {
        id: request.id ?? null,
        result: {
          thread: {
            cwd: storageRoot,
            id: "thread",
            name: "Thread",
            status: { type: "idle" },
            turns: [],
            updatedAt: 1,
          },
        },
      };
    }),
    listSubagents: async () => ({ subagents: [] }),
    projectState: {
      getCurrentUpdate: () => null,
      handleRequest: async () => ({ accepted: true }),
      observe: () => () => undefined,
    },
    publish: () => undefined,
    resolveProjectById: async () => ({ id: "project", rootPath: storageRoot }),
    resolveProjectFromCwd: async (cwd) => ({ cwd, project: { id: "project", rootPath: storageRoot } }),
    storageRoot,
    transitions: { run: async (_key, operation) => await operation() },
  });

  assert.deepEqual(await feature.getCodexMcpState("thread"), {
    generation: null,
    projectId: "project",
  });
  assert.deepEqual(requests, [{
    id: 0,
    method: "thread/read",
    params: { includeTurns: false, threadId: "thread" },
  }]);

  await feature.dispose();
  await fs.rm(storageRoot, { force: true, recursive: true });
});

test("a relationship committed during provider pagination remains a subagent after final reconciliation", async () => {
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-thread-subagent-race-"));
  const secondPageStarted = deferred<void>();
  const releaseSecondPage = deferred<void>();
  let relationships: WorkbenchSubagentRelationship[] = [];
  const relationship: WorkbenchSubagentRelationship = {
    createdAt: 1,
    cwd: storageRoot,
    directSubagentIndex: 0,
    harness: "codex",
    name: "Mimi",
    parentThreadId: "parent",
    profileId: "profile",
    profileName: "Lily",
    projectId: "project",
    threadId: "child",
    title: "Inspect code",
    updatedAt: 2,
  };
  const feature = new WorkbenchThreadStateFeature({
    database: createThreadStateDatabase(),
    getProjectCatalog: () => ({ data: [], rootPath: storageRoot }),
    gitArcs: { findActiveClaim: async () => null, listActiveClaims: async () => [] },
    harnesses: createHarnesses(async (harness, request) => {
      if (request.method === "thread/read") {
        return { id: request.id ?? null, result: { thread: { cwd: storageRoot, id: "child", name: "Child", status: { type: "idle" }, turns: [], updatedAt: 2 } } };
      }
      const cursor = (request.params as { cursor?: string | null }).cursor ?? null;
      if (harness !== "codex") return { id: request.id ?? null, result: { data: [], nextCursor: null } };
      if (!cursor) return { id: request.id ?? null, result: { data: [{ id: "child", name: "Child", status: { type: "idle" }, updatedAt: 2 }], nextCursor: "next" } };
      secondPageStarted.resolve();
      await releaseSecondPage.promise;
      return { id: request.id ?? null, result: { data: [], nextCursor: null } };
    }),
    listSubagents: async () => ({ subagents: relationships }),
    projectState: {
      getCurrentUpdate: () => null,
      handleRequest: async () => ({ accepted: true }),
      observe: () => () => undefined,
    },
    publish: () => undefined,
    resolveProjectById: async () => ({ id: "project", rootPath: storageRoot }),
    resolveProjectFromCwd: async (cwd) => ({ cwd, project: { id: "project", rootPath: storageRoot } }),
    storageRoot,
    transitions: { run: async (_key, operation) => await operation() },
  });

  await feature.controller.open("observer", "project");
  await secondPageStarted.promise;
  relationships = [relationship];
  await feature.installSubagentRelationship(relationship);
  releaseSecondPage.resolve();
  await waitFor(async () => (await feature.controller.getSnapshot("project")).freshness === "fresh", "Final provider reconciliation did not finish.");
  const child = (await feature.controller.getSnapshot("project")).entries.find((entry) => entry.entryKind !== "draft" && entry.identity.threadId === "child");
  assert.equal(child?.entryKind, "subagent");
  await feature.dispose();
  await fs.rm(storageRoot, { force: true, recursive: true });
});

test("provider reconciliation starts concurrently and publishes each successful harness without waiting for failures", async () => {
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-thread-feature-"));
  const publications: WorkbenchThreadStateSnapshot[] = [];
  const starts: string[] = [];
  const codexCursors: Array<string | null> = [];
  const codexRequests: Array<Record<string, unknown>> = [];
  let releaseCodexNext = () => undefined;
  const codexNextGate = new Promise<void>((resolve) => { releaseCodexNext = resolve; });
  let releaseCopilot = () => undefined;
  const copilotGate = new Promise<void>((resolve) => { releaseCopilot = resolve; });
  const activeClaim = {
    checkpointCommit: "a".repeat(40),
    claimedPaths: ["one.txt"],
    harness: "codex" as const,
    intentDescription: "Keep the parent claim visible.",
    intentName: "parent claim",
    proposalId: "proposal-one",
    proposalStatus: "proposed" as const,
    reloadScopes: ["server:mcp" as const],
    threadId: "parent",
    updatedAt: "2026-08-19T00:00:00.000Z",
  };
  const lifecycleState = {
    checkpointCommit: "a".repeat(40),
    claimedPaths: ["one.txt"],
    harness: "codex" as const,
    intentDescription: "Keep the parent claim visible.",
    intentName: "parent claim",
    phase: "active" as const,
    proposals: [
      { proposalId: "proposal-one", status: "proposed" as const },
      { proposalId: "proposal-two", status: "committed" as const },
    ],
    reloadScopes: ["server:mcp" as const],
    threadId: "parent",
    updatedAt: "2026-08-19T00:00:00.000Z",
  };
  const planState = {
    checkpointCommit: "b".repeat(40),
    harness: "codex" as const,
    intentDescription: "Plan around the active owner.",
    intentName: "planned overlap",
    scopePaths: ["one.txt", "two.txt"],
    reloadScopes: ["server:core" as const],
    threadId: "parent",
    updatedAt: "2026-08-20T00:00:00.000Z",
  };
  let lifecycleListCalls = 0;
  const gitArcs = {
    findActiveClaim: async () => activeClaim,
    findLifecycleState: async () => lifecycleState,
    findPlanState: async () => planState,
    listActiveClaims: async () => [activeClaim],
    listLifecycleStates: async () => { lifecycleListCalls += 1; return [lifecycleState]; },
    listPlanStates: async () => [planState],
  };
  const feature = new WorkbenchThreadStateFeature({
    database: createThreadStateDatabase(),
    getProjectCatalog: () => ({ data: [], rootPath: "C:/projects" }),
    gitArcs,
    listSubagents: async () => ({
      subagents: [{
        createdAt: 1,
        cwd: "C:/projects/project",
        directSubagentIndex: 0,
        harness: "codex",
        name: "Child",
        parentThreadId: "parent",
        profileId: "default",
        profileName: "Default",
        projectId: "project",
        threadId: "child",
        title: "Child",
        updatedAt: 2,
      }],
    }),
    projectState: {
      getCurrentUpdate: () => null,
      handleRequest: async () => ({ accepted: true }),
      observe: () => () => undefined,
    },
    publish: (_connectionId, snapshot) => { publications.push(snapshot); },
    harnesses: createHarnesses(async (harness, request) => {
      const params = request.params as { cursor?: string | null };
      if (!starts.includes(harness)) starts.push(harness);
      if (harness === "codex") {
        codexRequests.push(request);
        codexCursors.push(params.cursor ?? null);
        if (params.cursor) {
          await codexNextGate;
          return { id: request.id ?? null, result: { data: [{ id: "parent", name: "Parent", status: { type: "idle" }, updatedAt: 3 }], nextCursor: null } };
        }
        return { id: request.id ?? null, result: { data: [{ id: "child", name: "Child provider", status: { type: "idle" }, updatedAt: 2 }], nextCursor: "codex-next" } };
      }
      if (harness === "copilot") {
        await copilotGate;
        return { id: request.id ?? null, result: { data: [{ id: "copilot-thread", name: "Copilot", status: { type: "idle" }, updatedAt: 4 }], nextCursor: null } };
      }
      return { error: { code: -32000, message: "OpenCode unavailable" }, id: request.id ?? null };
    }),
    resolveProjectById: async () => ({ id: "project", rootPath: storageRoot }),
    resolveProjectFromCwd: async () => { throw new Error("Not used by this test."); },
    storageRoot,
    transitions: { run: async (_key, operation) => await operation() },
  });

  await feature.controller.open("observer", "project");
  await waitFor(() => starts.length === 3, "Provider reconciliations did not start concurrently.");
  await waitFor(() => publications.some((snapshot) => "entries" in snapshot && snapshot.entries.some((entry) => entry.entryKind !== "draft" && entry.identity.harness === "codex")), "Codex snapshot did not publish while Copilot remained pending.");
  assert.deepEqual(new Set(starts), new Set(["codex", "copilot", "opencode"]));
  assert.deepEqual(codexCursors, [null, "codex-next"]);
  assert.equal(codexRequests[0]?.workbenchRequestSource, "autoRefresh");
  assert.deepEqual(codexRequests[0]?.params, {
    archived: false,
    cursor: null,
    cwd: storageRoot,
    limit: 50,
    sortDirection: "desc",
    sortKey: "updated_at",
    useStateDbOnly: true,
  });
  const progressive = [...publications].reverse().find((snapshot) => "entries" in snapshot && snapshot.entries.some((entry) => entry.entryKind === "subagent"));
  assert.equal(progressive && "entries" in progressive ? progressive.freshness : null, "partial");

  releaseCodexNext();
  releaseCopilot();
  await waitFor(() => publications.some((snapshot) => "entries" in snapshot && snapshot.error?.includes("opencode")), "Final partial provider result did not publish.");
  await waitFor(() => publications.some((snapshot) => "entries" in snapshot && snapshot.entries.some((entry) => entry.entryKind !== "draft" && entry.identity.threadId === "parent")), "Deep Codex page did not publish its claimed parent.");
  const final = [...publications].reverse().find((snapshot) => "entries" in snapshot);
  assert.ok(final && "entries" in final);
  assert.equal(final.freshness, "partial");
  assert.match(final.error ?? "", /opencode: OpenCode unavailable/u);
  assert.equal(final.entries.some((entry) => entry.entryKind !== "draft" && entry.identity.threadId === "copilot-thread"), true);
  assert.equal(final.entries.some((entry) => entry.entryKind === "subagent" && entry.identity.threadId === "child"), true);
  const parent = final.entries.find((entry) => entry.entryKind !== "draft" && entry.identity.threadId === "parent");
  assert.ok(parent && parent.entryKind !== "draft");
  assert.deepEqual({ gitArc: parent.gitArc, gitArcPlan: parent.gitArcPlan, lifecycleListCalls }, {
    gitArc: {
      checkpointCommit: lifecycleState.checkpointCommit,
      claimedPaths: ["one.txt"],
      intentDescription: lifecycleState.intentDescription,
      intentName: lifecycleState.intentName,
      phase: "active",
      proposals: lifecycleState.proposals,
      updatedAt: lifecycleState.updatedAt,
    },
    gitArcPlan: {
      checkpointCommit: planState.checkpointCommit,
      intentDescription: planState.intentDescription,
      intentName: planState.intentName,
      scopePaths: planState.scopePaths,
      updatedAt: planState.updatedAt,
    },
    lifecycleListCalls: 2,
  });
  const refreshedParent = await feature.controller.refreshGitArcState("project", "codex", "parent");
  assert.equal(refreshedParent?.identity.threadId, "parent");
  assert.deepEqual((refreshedParent as { gitArc?: unknown } | null)?.gitArc, {
    checkpointCommit: lifecycleState.checkpointCommit,
    claimedPaths: ["one.txt"],
    intentDescription: lifecycleState.intentDescription,
    intentName: lifecycleState.intentName,
    phase: "active",
    proposals: lifecycleState.proposals,
    updatedAt: lifecycleState.updatedAt,
  });
  assert.deepEqual(refreshedParent?.entryKind === "thread" ? refreshedParent.gitArcPlan : null, {
    checkpointCommit: planState.checkpointCommit,
    intentDescription: planState.intentDescription,
    intentName: planState.intentName,
    scopePaths: planState.scopePaths,
    updatedAt: planState.updatedAt,
  });
  await feature.dispose();
  await fs.rm(storageRoot, { force: true, recursive: true });
});

test("deep provider pages serialize across projects while both newest pages start immediately", async () => {
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-thread-pagination-"));
  const projectRoots = new Map([
    ["project-a", path.join(storageRoot, "project-a")],
    ["project-b", path.join(storageRoot, "project-b")],
  ]);
  await Promise.all([...projectRoots.values()].map((rootPath) => fs.mkdir(rootPath)));
  const firstDeepGate = deferred<void>();
  const secondDeepGate = deferred<void>();
  const firstPages: string[] = [];
  const deepPages: string[] = [];
  let activeDeepPages = 0;
  let maximumActiveDeepPages = 0;
  const feature = new WorkbenchThreadStateFeature({
    database: createThreadStateDatabase(),
    getProjectCatalog: () => ({ data: [], rootPath: "C:/projects" }),
    gitArcs: { findActiveClaim: async () => null, listActiveClaims: async () => [] },
    listSubagents: async () => ({ subagents: [] }),
    projectState: {
      getCurrentUpdate: () => null,
      handleRequest: async () => ({ accepted: true }),
      observe: () => () => undefined,
    },
    publish: () => undefined,
    harnesses: createHarnesses(async (harness, request) => {
      const params = request.params as { cursor?: string | null; cwd: string };
      if (harness !== "codex") return { id: request.id ?? null, result: { data: [], nextCursor: null } };
      if (!params.cursor) {
        firstPages.push(params.cwd);
        return { id: request.id ?? null, result: { data: [], nextCursor: "next" } };
      }
      deepPages.push(params.cwd);
      activeDeepPages += 1;
      maximumActiveDeepPages = Math.max(maximumActiveDeepPages, activeDeepPages);
      await (deepPages.length === 1 ? firstDeepGate.promise : secondDeepGate.promise);
      activeDeepPages -= 1;
      return { id: request.id ?? null, result: { data: [], nextCursor: null } };
    }),
    resolveProjectById: async (projectId) => ({ id: projectId, rootPath: projectRoots.get(projectId) ?? storageRoot }),
    resolveProjectFromCwd: async () => { throw new Error("Not used by this test."); },
    storageRoot,
    transitions: { run: async (_key, operation) => await operation() },
  });

  await Promise.all([feature.controller.open("a", "project-a"), feature.controller.open("b", "project-b")]);
  await waitFor(() => firstPages.length === 2 && deepPages.length === 1, "Newest pages did not start before serialized continuation work.");
  assert.deepEqual(new Set(firstPages), new Set(projectRoots.values()));
  assert.equal(maximumActiveDeepPages, 1);
  firstDeepGate.resolve();
  await waitFor(() => deepPages.length === 2, "Second deep page did not start after the first completed.");
  assert.equal(maximumActiveDeepPages, 1);
  secondDeepGate.resolve();
  await feature.dispose();
  await fs.rm(storageRoot, { force: true, recursive: true });
});

test("managed title commands use the validated provider title as the mutation precondition", async () => {
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-thread-managed-title-"));
  const requests: Array<{ harness: string; method: string; params: unknown }> = [];
  let providerName: string | null = "Current task";
  let providerPreview: string | null = "Initial request";
  const feature = new WorkbenchThreadStateFeature({
    database: createThreadStateDatabase(),
    getProjectCatalog: () => ({ data: [], rootPath: "C:/projects" }),
    gitArcs: { findActiveClaim: async () => null, listActiveClaims: async () => [] },
    listSubagents: async () => ({ subagents: [] }),
    projectState: {
      getCurrentUpdate: () => null,
      handleRequest: async () => ({ accepted: true }),
      observe: () => () => undefined,
    },
    publish: () => undefined,
    harnesses: createHarnesses(async (harness, request) => {
      requests.push({ harness, method: request.method, params: request.params });
      if (harness !== "codex") return { id: request.id ?? null, error: { code: -32000, message: "Not found" } };
      if (request.method === "thread/name/set") {
        providerName = String((request.params as { name?: unknown }).name ?? "");
        return { id: request.id ?? null, result: {} };
      }
      return {
        id: request.id ?? null,
        result: {
          thread: {
            cwd: "C:/workspace",
            id: "thread-one",
            name: providerName,
            preview: providerPreview,
          },
        },
      };
    }),
    resolveProjectById: async () => ({ id: "project", rootPath: "C:/workspace" }),
    resolveProjectFromCwd: async (cwd) => ({ cwd, project: { id: "project", rootPath: "C:/workspace" } }),
    storageRoot,
    transitions: { run: async (_key, operation) => await operation() },
  });

  const response = await feature.handleManagedThreadRequest({
    id: 1,
    method: "workbench/thread/title",
    params: { action: "get", callerThreadId: "thread-one", cwd: "C:/workspace" },
  });

  assert.deepEqual(response, {
    id: 1,
    result: { harness: "codex", threadId: "thread-one", title: "Current task" },
  });
  assert.deepEqual(requests[0], {
    harness: "codex",
    method: "thread/read",
    params: { cwd: "C:/workspace", includeTurns: true, threadId: "thread-one" },
  });
  await waitFor(() => requests.length === 4, "Provider reconciliation did not run after the managed title read.");
  assert.deepEqual(requests.slice(1).map(({ harness, method }) => ({ harness, method })), [
    { harness: "codex", method: "thread/list" },
    { harness: "copilot", method: "thread/list" },
    { harness: "opencode", method: "thread/list" },
  ]);

  requests.length = 0;
  const missingCurrentTitle = await feature.handleManagedThreadRequest({
    id: 2,
    method: "workbench/thread/title",
    params: { action: "set", callerThreadId: "thread-one", cwd: "C:/workspace", title: "Narrow sidequest" },
  });
  assert.equal(missingCurrentTitle.id, 2);
  assert.equal(missingCurrentTitle.error?.code, -32000);
  assert.match(missingCurrentTitle.error?.message ?? "", /Current title: "Current task"/u);

  const staleCurrentTitle = await feature.handleManagedThreadRequest({
    id: 3,
    method: "workbench/thread/title",
    params: {
      action: "set",
      callerThreadId: "thread-one",
      currentTitle: "Wrong title",
      cwd: "C:/workspace",
      title: "Narrow sidequest",
    },
  });
  assert.equal(staleCurrentTitle.id, 3);
  assert.equal(staleCurrentTitle.error?.code, -32000);
  assert.match(staleCurrentTitle.error?.message ?? "", /Current title: "Current task"/u);
  assert.equal(requests.some(({ method }) => method === "thread/name/set"), false);

  const renamed = await feature.handleManagedThreadRequest({
    id: 4,
    method: "workbench/thread/title",
    params: {
      action: "set",
      callerThreadId: "thread-one",
      currentTitle: "Current task",
      cwd: "C:/workspace",
      title: "New overarching task",
    },
  });
  assert.deepEqual(renamed, {
    id: 4,
    result: { harness: "codex", threadId: "thread-one", title: "New overarching task" },
  });
  assert.equal(requests.filter(({ method }) => method === "thread/name/set").length, 1);

  providerName = "New thread";
  providerPreview = "Initial request";
  const initiallyUntitled = await feature.handleManagedThreadRequest({
    id: 5,
    method: "workbench/thread/title",
    params: { action: "get", callerThreadId: "thread-one", cwd: "C:/workspace" },
  });
  assert.deepEqual(initiallyUntitled, {
    id: 5,
    result: { harness: "codex", threadId: "thread-one", title: "" },
  });

  const initiallyNamed = await feature.handleManagedThreadRequest({
    id: 6,
    method: "workbench/thread/title",
    params: { action: "set", callerThreadId: "thread-one", cwd: "C:/workspace", title: "First useful title" },
  });
  assert.deepEqual(initiallyNamed, {
    id: 6,
    result: { harness: "codex", threadId: "thread-one", title: "First useful title" },
  });
  assert.equal(requests.filter(({ method }) => method === "thread/name/set").length, 2);
  await feature.dispose();
  await fs.rm(storageRoot, { force: true, recursive: true });
});

test("Git snapshot reconciliation failures reach the bounded feature log", async () => {
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-thread-git-failure-"));
  const logs: string[] = [];
  const feature = new WorkbenchThreadStateFeature({
    database: createThreadStateDatabase(),
    getProjectCatalog: () => ({ data: [], rootPath: "C:/projects" }),
    gitArcs: {
      findActiveClaim: async () => null,
      listActiveClaims: async () => [],
      listLifecycleStates: async () => { throw new Error("Git snapshot exploded."); },
    },
    listSubagents: async () => ({ subagents: [] }),
    log: (message) => logs.push(message),
    projectState: {
      getCurrentUpdate: () => null,
      handleRequest: async () => ({ accepted: true }),
      observe: () => () => undefined,
    },
    publish: () => undefined,
    harnesses: createHarnesses(async () => { throw new Error("Provider reconciliation must not start after the initial Git snapshot fails."); }),
    resolveProjectById: async () => ({ id: "project", rootPath: "C:/workspace" }),
    resolveProjectFromCwd: async (cwd) => ({ cwd, project: { id: "project", rootPath: "C:/workspace" } }),
    storageRoot,
    transitions: { run: async (_key, operation) => await operation() },
  });

  await feature.controller.open("observer", "project");
  await waitFor(() => logs.length === 1, "Git snapshot reconciliation failure was not logged.");
  assert.match(logs[0] ?? "", /reconciliation failed project=project error=Git snapshot exploded\./u);
  assert.equal((await feature.controller.getSnapshot("project")).error, "Git snapshot exploded.");
  await feature.dispose();
  await fs.rm(storageRoot, { force: true, recursive: true });
});

test("expired settled threads reach repository retention through the feature boundary", async () => {
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-thread-retention-feature-"));
  const statePath = path.join(storageRoot, ".workbench", "runtime", "thread-state", `${encodeTranscriptPathSegment("project")}.json`);
  const identity = { harness: "codex" as const, threadId: "expired-thread" };
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, JSON.stringify({
    drafts: [],
    records: [{
      activityAt: 1,
      entryKind: "thread",
      identity,
      lifecycle: { kind: "completed", reason: "userCompleted", settled: true },
      metadata: { archived: false, pinned: false, snoozed: false },
      providerObserved: true,
      settledAt: Date.now() - (15 * 24 * 60 * 60 * 1_000),
      title: "Expired thread",
    }],
    version: 3,
  }), "utf8");
  const pruned: Array<{ cwd: string; identities: ReadonlyArray<{ harness: WorkbenchHarness; threadId: string }> }> = [];
  const feature = new WorkbenchThreadStateFeature({
    database: createThreadStateDatabase(),
    getProjectCatalog: () => ({ data: [], rootPath: storageRoot }),
    gitArcs: {
      findActiveClaim: async () => null,
      listActiveClaims: async () => [],
      listLifecycleStates: async () => [],
      pruneThreadHistories: async (cwd, identities) => { pruned.push({ cwd, identities }); },
    },
    harnesses: createHarnesses(async (_harness, request) => ({ id: request.id ?? null, result: { data: [], nextCursor: null } })),
    listSubagents: async () => ({ subagents: [] }),
    projectState: {
      getCurrentUpdate: () => null,
      handleRequest: async () => ({ accepted: true }),
      observe: () => () => undefined,
    },
    publish: () => undefined,
    resolveProjectById: async () => ({ id: "project", rootPath: "C:/workspace" }),
    resolveProjectFromCwd: async (cwd) => ({ cwd, project: { id: "project", rootPath: "C:/workspace" } }),
    storageRoot,
    transitions: { run: async (_key, operation) => await operation() },
  });

  await feature.controller.open("observer", "project");
  await waitFor(() => pruned.length === 1, "Expired thread did not reach Git retention through the feature.");
  assert.deepEqual(pruned, [{ cwd: "C:/workspace", identities: [identity] }]);
  await feature.dispose();
  await fs.rm(storageRoot, { force: true, recursive: true });
});

test("provider reconciliation cannot overwrite a newer resolved Git arc projection", async () => {
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-thread-git-reconcile-"));
  const secondPageGate = deferred<void>();
  let resolved = false;
  let secondPageStarted = false;
  let transitionCount = 0;
  const activeClaim = {
    checkpointCommit: "a".repeat(40), claimedPaths: ["owned.ts"], harness: "codex" as const,
    intentDescription: "", intentName: "settle projection", proposalId: "proposal-one",
    proposalStatus: "proposed" as const, threadId: "thread-one", updatedAt: "2026-08-23T00:00:00.000Z",
  };
  const lifecycleState = () => ({
    checkpointCommit: resolved ? "b".repeat(40) : activeClaim.checkpointCommit,
    claimedPaths: resolved ? [] : activeClaim.claimedPaths,
    harness: "codex" as const,
    intentDescription: "",
    intentName: "settle projection",
    phase: resolved ? "resolved" as const : "active" as const,
    proposals: resolved
      ? [{ proposalId: "proposal-two", status: "committed" as const }]
      : [{ proposalId: "proposal-one", status: "proposed" as const }],
    threadId: "thread-one",
    updatedAt: resolved ? "2026-08-23T00:01:00.000Z" : activeClaim.updatedAt,
  });
  const planState = {
    checkpointCommit: "c".repeat(40), harness: "codex" as const, intentDescription: "",
    intentName: "old plan", scopePaths: ["owned.ts"], threadId: "thread-one", updatedAt: "2026-08-23T00:00:00.000Z",
  };
  const feature = new WorkbenchThreadStateFeature({
    database: createThreadStateDatabase(),
    getProjectCatalog: () => ({ data: [], rootPath: storageRoot }),
    gitArcs: {
      findActiveClaim: async () => resolved ? null : activeClaim,
      findLifecycleState: async () => lifecycleState(),
      findPlanState: async () => resolved ? null : planState,
      listActiveClaims: async () => resolved ? [] : [activeClaim],
      listLifecycleStates: async () => [lifecycleState()],
      listPlanStates: async () => resolved ? [] : [planState],
    },
    listSubagents: async () => ({ subagents: [] }),
    projectState: {
      getCurrentUpdate: () => null,
      handleRequest: async () => ({ accepted: true }),
      observe: () => () => undefined,
    },
    publish: () => undefined,
    harnesses: createHarnesses(async (harness, request) => {
      if (harness !== "codex") return { error: { code: -32000, message: `${harness} unavailable` }, id: request.id ?? null };
      const cursor = (request.params as { cursor?: string | null }).cursor;
      if (cursor) {
        secondPageStarted = true;
        await secondPageGate.promise;
        return { id: request.id ?? null, result: { data: [], nextCursor: null } };
      }
      return {
        id: request.id ?? null,
        result: { data: [{ id: "thread-one", name: "Thread one", status: { type: "idle" }, updatedAt: 1 }], nextCursor: "next" },
      };
    }),
    resolveProjectById: async () => ({ id: "project", rootPath: storageRoot }),
    resolveProjectFromCwd: async () => { throw new Error("Not used by this test."); },
    storageRoot,
    transitions: {
      run: async (_key, operation) => {
        transitionCount += 1;
        return await operation();
      },
    },
  });

  await feature.controller.ensureProviderEntry("project", {
    activityAt: 1,
    entryKind: "thread",
    gitArc: {
      checkpointCommit: "d".repeat(40), claimedPaths: ["stale.ts"], intentDescription: "", intentName: "stale arc",
      phase: "active", proposals: [{ proposalId: "stale-proposal", status: "proposed" }], updatedAt: "2026-08-22T00:00:00.000Z",
    },
    gitArcPlan: {
      checkpointCommit: "e".repeat(40), intentDescription: "", intentName: "stale plan",
      scopePaths: ["stale.ts"], updatedAt: "2026-08-22T00:00:00.000Z",
    },
    identity: { harness: "codex", threadId: "thread-one" },
    lifecycle: { kind: "completed", reason: "providerInactive", settled: false },
    metadata: { archived: false, pinned: false, snoozed: false },
    title: "Thread one",
  });
  await feature.controller.open("observer", "project");
  await waitFor(async () => {
    const snapshot = await feature.controller.getSnapshot("project");
    const entry = snapshot.entries.find((candidate) => candidate.entryKind !== "draft" && candidate.identity.threadId === "thread-one");
    return transitionCount === 1 && secondPageStarted && entry?.entryKind === "thread"
      && entry.gitArc?.checkpointCommit === activeClaim.checkpointCommit
      && entry.gitArcPlan?.checkpointCommit === planState.checkpointCommit;
  }, "The initial Git snapshot did not repair stale state before provider pagination.");
  resolved = true;
  const refreshed = await feature.controller.refreshGitArcState("project", "codex", "thread-one");
  assert.equal(refreshed?.entryKind === "thread" ? refreshed.gitArc?.phase : null, "resolved");
  secondPageGate.resolve();
  await waitFor(async () => {
    const snapshot = await feature.controller.getSnapshot("project");
    const entry = snapshot.entries.find((candidate) => candidate.entryKind !== "draft" && candidate.identity.threadId === "thread-one");
    return transitionCount === 2 && entry?.entryKind === "thread" && entry.gitArc?.phase === "resolved" && entry.gitArcPlan === null;
  }, "The final reconciliation did not preserve the resolved Git projection.");
  assert.equal(transitionCount, 2);
  const final = await feature.controller.getSnapshot("project");
  const thread = final.entries.find((entry) => entry.entryKind !== "draft" && entry.identity.threadId === "thread-one");
  assert.ok(thread && thread.entryKind === "thread");
  assert.deepEqual(thread.gitArc, {
    checkpointCommit: "b".repeat(40), claimedPaths: [], intentDescription: "", intentName: "settle projection",
    phase: "resolved", proposals: [{ proposalId: "proposal-two", status: "committed" }], updatedAt: "2026-08-23T00:01:00.000Z",
  });
  assert.equal(thread.gitArcPlan, null);
  await feature.dispose();
  await fs.rm(storageRoot, { force: true, recursive: true });
});

test("managed resume validates the provider thread before requesting lifecycle-owned replacement", async () => {
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-thread-managed-resume-"));
  const resumes: Array<{ harness: string; threadId: string }> = [];
  const feature = new WorkbenchThreadStateFeature({
    database: createThreadStateDatabase(),
    getProjectCatalog: () => ({ data: [], rootPath: storageRoot }),
    gitArcs: { findActiveClaim: async () => null, listActiveClaims: async () => [] },
    listSubagents: async () => ({ subagents: [] }),
    projectState: {
      getCurrentUpdate: () => null,
      handleRequest: async () => ({ accepted: true }),
      observe: () => () => undefined,
    },
    publish: () => undefined,
    harnesses: createHarnesses(async (harness, request) => {
      if (request.method === "thread/read" && harness === "codex") {
        return {
          id: request.id ?? null,
          result: {
            thread: {
              cwd: storageRoot,
              id: "thread-one",
              name: "Current task",
              preview: "Initial request",
              status: { type: "active" },
              turns: [{ id: "turn-one", status: "inProgress" }],
              updatedAt: 1,
            },
          },
        };
      }
      return { id: request.id ?? null, result: { data: [], nextCursor: null } };
    }, async (harness, threadId) => { resumes.push({ harness, threadId }); }),
    resolveProjectById: async () => ({ id: "project", rootPath: storageRoot }),
    resolveProjectFromCwd: async (cwd) => ({ cwd, project: { id: "project", rootPath: storageRoot } }),
    storageRoot,
    transitions: { run: async (_key, operation) => await operation() },
  });

  const response = await feature.handleManagedThreadRequest({
    id: 2,
    method: "workbench/thread/resume",
    params: { callerThreadId: "thread-one", cwd: storageRoot },
  });

  assert.deepEqual(response, {
    id: 2,
    result: { accepted: true, threadId: "thread-one", turnId: "turn-one" },
  });
  assert.deepEqual(resumes, [{ harness: "codex", threadId: "thread-one" }]);
  await feature.dispose();
  await fs.rm(storageRoot, { force: true, recursive: true });
});

test("observed title mutations update the provider and published sidebar together", async () => {
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-thread-title-"));
  const publications: WorkbenchThreadStateSnapshot[] = [];
  const titleRequests: Array<{ harness: string; params: unknown }> = [];
  let rejectTitle = false;
  const feature = new WorkbenchThreadStateFeature({
    database: createThreadStateDatabase(),
    getProjectCatalog: () => ({ data: [], rootPath: storageRoot }),
    gitArcs: { findActiveClaim: async () => null, listActiveClaims: async () => [] },
    listSubagents: async () => ({ subagents: [] }),
    projectState: {
      getCurrentUpdate: () => null,
      handleRequest: async () => ({ accepted: true }),
      observe: () => () => undefined,
    },
    publish: (_connectionId, snapshot) => { publications.push(snapshot); },
    harnesses: createHarnesses(async (harness, request) => {
      if (request.method === "thread/name/set") {
        titleRequests.push({ harness, params: request.params });
        return rejectTitle
          ? { error: { code: -32000, message: "Provider rejected title" }, id: request.id ?? null }
          : { id: request.id ?? null, result: {} };
      }
      return {
        id: request.id ?? null,
        result: {
          data: harness === "codex"
            ? [{ id: "thread-one", name: "Old title", status: { type: "idle" }, updatedAt: 1 }]
            : [],
          nextCursor: null,
        },
      };
    }),
    resolveProjectById: async () => ({ id: "project", rootPath: storageRoot }),
    resolveProjectFromCwd: async (cwd) => ({ cwd, project: { id: "project", rootPath: storageRoot } }),
    storageRoot,
    transitions: { run: async (_key, operation) => await operation() },
  });

  await feature.controller.open("observer", "project");
  await waitFor(() => publications.some((snapshot) => (
    "entries" in snapshot
    && snapshot.entries.some((entry) => entry.entryKind !== "draft" && entry.identity.threadId === "thread-one")
  )), "Provider title entry did not load.");
  publications.length = 0;

  const renamed = await feature.controller.handleRequest("observer", {
    identity: { harness: "codex", threadId: "thread-one" },
    method: "workbench/thread-state/title/set",
    projectId: "project",
    title: '  "Renamed   thread..."  ',
  });

  assert.deepEqual(renamed, {
    result: { identity: { harness: "codex", threadId: "thread-one" }, ok: true, title: "Renamed thread" },
  });
  assert.deepEqual(titleRequests, [{
    harness: "codex",
    params: { cwd: storageRoot, name: "Renamed thread", threadId: "thread-one" },
  }]);
  const renamedEntry = (await feature.controller.getSnapshot("project")).entries.find((entry) => entry.entryKind !== "draft" && entry.identity.threadId === "thread-one");
  assert.equal(renamedEntry?.title, "Renamed thread");
  const lastPublication = publications.at(-1);
  const publishedEntry = lastPublication && "entries" in lastPublication
    ? lastPublication.entries.find((entry) => entry.entryKind !== "draft" && entry.identity.threadId === "thread-one")
    : null;
  assert.equal(publishedEntry?.title, "Renamed thread");

  rejectTitle = true;
  const publicationCount = publications.length;
  const rejected = await feature.controller.handleRequest("observer", {
    identity: { harness: "codex", threadId: "thread-one" },
    method: "workbench/thread-state/title/set",
    projectId: "project",
    title: "Rejected title",
  });
  assert.deepEqual(rejected, { error: { code: "threadTitleMutationFailed", message: "Provider rejected title" } });
  assert.equal(publications.length, publicationCount);
  assert.equal((await feature.controller.getSnapshot("project")).entries.find((entry) => entry.entryKind !== "draft" && entry.identity.threadId === "thread-one")?.title, "Renamed thread");

  await feature.dispose();
  await fs.rm(storageRoot, { force: true, recursive: true });
});
