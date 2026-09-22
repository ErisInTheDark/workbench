/* Exports: none. Tests protect provider normalization, state routing, relationships, reconciliation, Git projection, retention, resume, and titles. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { WorkbenchHarness, WorkbenchSubagentRelationship } from "workbench-shared/types";
import type { WorkbenchDurableQuestionnaire, WorkbenchThreadSidebarEntry, WorkbenchThreadStateSnapshot } from "workbench-shared/workbench/thread/thread-state";
import type { JsonRpcNotification, JsonRpcRequest, JsonRpcResponse } from "./bridge-types";
import WorkbenchThreadStateFeature, { normalizeProviderSidebarEntry as normalizeSidebar, normalizeSubagentProviderLifecycle } from "./WorkbenchThreadStateFeature";
import { mapProviderActivityNotification as mapActivity, mapProviderLifecycleNotification as mapLifecycle } from "./CodexProviderObservations";
import type { ThreadReadResponse } from "workbench-shared/codex/generated/app-server/v2/ThreadReadResponse";
import { createThreadStateTestDatabase } from "./workbench-thread-state-test-database";
import * as fixtureIdentitySchemas from "workbench-shared/workbench/identity";
import { testProjectIds } from "workbench-shared/workbench/test-identities";
import CodexThreadOperations from "./CodexThreadOperations";
import type WorkbenchProvider from "./WorkbenchProvider";

const canonicalFixtureLookup = {
  knownThread: (reference: fixtureIdentitySchemas.ThreadReference) => ({ threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse(reference) }),
  knownTurn: (reference: fixtureIdentitySchemas.TurnReference) => ({ turnId: fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse(reference) }),
};
const storedRecordDefaults = {
  gitHistoryCleanedAt: null, mcpGeneration: null, profile: null, settledAt: null, snoozedUntil: null,
};
const mapProviderActivityNotification = (notification: JsonRpcNotification) => mapActivity(notification, canonicalFixtureLookup);
const mapProviderLifecycleNotification = (notification: JsonRpcNotification) => mapLifecycle(notification, canonicalFixtureLookup);
const normalizeProviderSidebarEntry = (harness: WorkbenchHarness, value: unknown) => normalizeSidebar(harness, value, canonicalFixtureLookup);

const fixtureIdentityValues = {
  NativeThreadId: {
    "thread": fixtureIdentitySchemas.NativeThreadIdSchema.parse("thread"),
  },
  ProjectId: {
    "project": testProjectIds.project,
    "project-a": testProjectIds.first,
    "project-b": testProjectIds.second,
  },
  WorkbenchThreadId: {
    "child": fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("child"),
    "parent": fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("parent"),
    "thread": fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("thread"),
  },
  WorkbenchTurnId: {
    "turn": fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("turn"),
  },
};

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

function createThreadStateDatabase(cwd?: string, threads: readonly [string, WorkbenchHarness][] = []) {
  const database = createThreadStateTestDatabase();
  database.sqlite.prepare("INSERT INTO workbench_projects(id) VALUES (?)").run(fixtureIdentityValues.ProjectId.project);
  for (const [threadId, harness] of threads) {
    database.admitThread(fixtureIdentityValues.ProjectId.project, threadId, harness, `native:${threadId}`, cwd);
  }
  return database;
}

function providerThread(cwd: string, threadId: string, fields: Partial<ThreadReadResponse["thread"]> = {}): ThreadReadResponse["thread"] {
  return {
    cwd, id: `native:${threadId}`, projectId: null, status: { type: "idle" }, turns: [], updatedAt: 1,
    agentNickname: null, agentRole: null, canAcceptDirectInput: null, cliVersion: "", createdAt: 1,
    ephemeral: false, extra: null, forkedFromId: null, gitInfo: null, historyMode: "legacy",
    model: null, modelProvider: "openai", name: null, parentThreadId: null, path: null, preview: "",
    reasoningEffort: null, recencyAt: null, section: null, sectionEnteredAt: null,
    sessionId: `native:${threadId}`, source: "cli", threadSource: null, ...fields,
  };
}

function createFeature(options: Omit<ConstructorParameters<typeof WorkbenchThreadStateFeature>[0], "identities" | "database" | "providers" | "harnesses"> & {
  database: ReturnType<typeof createThreadStateDatabase>;
  harnesses: ReturnType<typeof createHarnesses>;
  interruptRetainingQuestionnaire?: (threadId: string, requestKey: string, interrupt: () => Promise<boolean>) => Promise<boolean>;
}) {
  const operationsByHarness = new Map<WorkbenchHarness, CodexThreadOperations>();
  const getOperations = (harness: WorkbenchHarness) => {
    let operations = operationsByHarness.get(harness);
    if (operations) return operations;
    operations = new CodexThreadOperations({
      reconciliation: { reconcile: async () => { throw new Error("Unexpected recovery"); } },
      bridge: {
        reconcileSqliteTranscriptWindow: async () => { throw new Error("Unexpected native recovery"); },
        canDeliverQuestionnaire: () => false,
        ensureInitialized: async () => {},
        handleServerRequest: request => options.harnesses.request(harness, request),
      },
      identities: options.database.identities,
      resolveProject: async cwd => (await options.resolveProjectFromCwd(cwd)).project,
      questionnaires: {
        canDeliver: () => false,
        deliver: async () => { throw new Error("Unexpected questionnaire delivery"); },
        interruptRetainingQuestionnaire: options.interruptRetainingQuestionnaire ?? (async () => {
          throw new Error("Unexpected questionnaire interruption");
        }),
      },
    });
    operationsByHarness.set(harness, operations);
    return operations;
  };
  const unused = async (): Promise<never> => { throw new Error("Unexpected configuration read"); };
  const getProvider = (harness: WorkbenchHarness): WorkbenchProvider => {
    const operations = getOperations(harness);
    return {
      threads: operations, interactions: operations.interactions,
      recovery: { refresh: threadId => options.harnesses.resumeThread(harness, threadId) },
      configuration: { modelContext: { read: unused }, models: { read: unused }, guidance: { contains: unused } },
    };
  };
  const feature = new WorkbenchThreadStateFeature({
    ...options, identities: options.database.identities,
    providers: { get: getProvider },
    getProjectCatalog: () => {
      const catalog = options.getProjectCatalog();
      const admitted = options.database.sqlite.prepare("SELECT id FROM workbench_projects ORDER BY id").all() as { id: string }[];
      return { ...catalog, aliases: [...catalog.aliases ?? [], ...admitted.map(({ id }) => ({
        alias: `fixture/${encodeURIComponent(id)}`, projectId: fixtureIdentitySchemas.ProjectIdSchema.parse(id),
      }))] };
    },
  });
  return Object.assign(feature, { observeThread: (thread: ThreadReadResponse["thread"]) => getOperations("codex").observeThread(thread) });
}

test("browser project admission rejects unknown owners before loading or replacing observations", async () => {
  const database = createThreadStateDatabase("C:/project", [["thread", "codex"]]);
  const projectId = fixtureIdentityValues.ProjectId.project;
  const stopped: string[] = [];
  const feature = createFeature({
    database,
    getProjectCatalog: () => ({ data: [], aliases: [{ alias: "old/project", projectId }], rootPath: "C:/" }),
    gitArcs: { findActiveClaim: async () => null, listActiveClaims: async () => [] },
    listSubagents: async () => ({ subagents: [] }),
    projectState: { getCurrentUpdate: () => null, handleRequest: async () => ({}), observe: id => () => { stopped.push(id); } },
    publish: () => {},
    harnesses: createHarnesses(async () => ({ id: null, result: { data: [] } })),
    resolveProjectById: async id => {
      assert.equal(id, projectId);
      return { id: projectId, rootPath: "C:/project" };
    },
    resolveProjectFromCwd: async cwd => ({ cwd, project: { id: projectId, rootPath: "C:/project" } }),
    transitions: { run: async (_key, operation) => operation() },
  });
  try {
    await feature.controller.open("client", fixtureIdentitySchemas.ProjectIdSchema.parse("old/project"), 1);
    const before = database.sqlite.prepare("SELECT * FROM workbench_sidebar_project_layouts").all();
    database.operations.length = 0;
    for (const id of ["remote:/example.test/project", "remote://example.test/unregistered"]) {
      await assert.rejects(feature.controller.handleRequest("client", {
        method: "workbench/thread-state/open", projectId: fixtureIdentitySchemas.ProjectIdSchema.parse(id), version: 2,
      }), /project/i);
    }
    assert.deepEqual(stopped, []);
    assert.deepEqual(database.operations, []);
    assert.deepEqual(database.sqlite.prepare("SELECT * FROM workbench_sidebar_project_layouts").all(), before);
  } finally { await feature.dispose(); }
});

async function questionnaireHarness(harness: WorkbenchHarness = "codex") {
  const requests: JsonRpcRequest[] = [];
  const releases: string[] = [];
  const questionnaire: WorkbenchDurableQuestionnaire = {
    itemId: "b5bf699f-ea4b-45cf-9583-7449b536ea44",
    requestKey: "workbench-mcp:question",
    turnId: fixtureIdentityValues.WorkbenchTurnId["turn"],
    request: {
      id: "question", title: "Choose", summary: "", submitLabel: "Submit",
      questions: [{ id: "choice", header: "choice", question: "Proceed?", options: [], allowOther: true, isSecret: false }],
    },
  };
  const provider: Extract<WorkbenchThreadSidebarEntry, { entryKind: "thread" }> = {
    activityAt: 1, entryKind: "thread", identity: { harness, threadId: fixtureIdentityValues.WorkbenchThreadId["thread"] },
    lifecycle: { kind: "needsAttention", reason: "pendingInput", requestKey: questionnaire.requestKey, settled: false, turnId: fixtureIdentityValues.WorkbenchTurnId["turn"] },
    metadata: { archived: false, pinned: false, snoozed: false }, title: "Task", pendingQuestionnaire: questionnaire,
  };
  const state = {
    turn: { id: "native:turn", status: "inProgress", items: [] },
    failInterrupt: false,
    retainingQuestionnaire: false,
    beforeRelease: async () => {},
  };
  const options = {
    database: createThreadStateDatabase(),
    getProjectCatalog: () => ({ data: [], rootPath: "C:/workspace" }),
    gitArcs: { findActiveClaim: async () => null, listActiveClaims: async () => [] },
    listSubagents: async () => ({ subagents: [] }),
    projectState: { getCurrentUpdate: () => null, handleRequest: async () => ({}), observe: () => () => {} },
    publish: () => {},
    interruptRetainingQuestionnaire: async (_threadId: string, requestKey: string, interrupt: () => Promise<boolean>) => {
      await state.beforeRelease();
      state.retainingQuestionnaire = true;
      try {
        return await interrupt();
      } finally {
        state.retainingQuestionnaire = false;
        releases.push(requestKey);
      }
    },
    harnesses: createHarnesses(async (_harness, request) => {
      requests.push(request);
      if (request.method === "thread/turns/list") return { id: request.id ?? null, result: { data: [state.turn], nextCursor: null } };
      if (request.method === "thread/read") return { id: request.id ?? null, result: { thread:
        { ...providerThread("C:/workspace", "thread"), turns: [state.turn] },
      } };
      if (request.method === "thread/list" && _harness === harness) {
        return { id: request.id ?? null, result: { data: [{
          id: "native:thread", cwd: "C:/workspace", createdAt: 1, name: "Task", status: { type: "active" },
          currentTurnId: state.turn.id, turns: [state.turn], updatedAt: 1,
        }], nextCursor: null } };
      }
      if (request.method === "turn/interrupt" && harness === "codex") {
        assert.equal(state.retainingQuestionnaire, true);
      }
      if (request.method === "turn/interrupt" && state.failInterrupt) throw new Error("interrupt failed");
      return { id: request.id ?? null, result: { data: [], nextCursor: null } };
    }),
    resolveProjectById: async () => ({ id: fixtureIdentityValues.ProjectId.project, rootPath: "C:/workspace" }),
    resolveProjectFromCwd: async (cwd: string) => ({ cwd, project: { id: fixtureIdentityValues.ProjectId.project, rootPath: cwd } }),
    transitions: { run: async <T>(_: string, operation: () => Promise<T>) => await operation() },
  };
  options.database.admitThread(fixtureIdentityValues.ProjectId.project, "thread", harness, "native:thread", "C:/workspace");
  options.database.admitThread(fixtureIdentityValues.ProjectId.project, "parent", harness, "native:parent", "C:/workspace");
  options.database.admitRecord({ ...storedRecordDefaults, ...provider, providerObserved: true });
  for (const turnId of ["new-turn", "resumed"]) {
    options.database.admitRecord({ ...storedRecordDefaults, ...provider, providerObserved: true,
      lifecycle: { kind: "working", reason: "acceptedIntent", settled: false,
        agent: { agentStatus: "working", turnId: fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse(turnId) } },
    });
  }
  await options.database.identities.threads.start();
  for (const turnId of ["turn", "new-turn", "resumed"]) {
    await options.database.identities.threads.resolveTurn({
      threadId: provider.identity.threadId, turnId: fixtureIdentitySchemas.TurnReferenceSchema.parse(turnId),
    });
  }
  const feature = createFeature(options);
  await feature.controller.open("observer", fixtureIdentityValues.ProjectId["project"]);
  await feature.controller.refresh(fixtureIdentityValues.ProjectId["project"]);
  await feature.controller.ensureProviderEntry(fixtureIdentityValues.ProjectId["project"], provider);
  await feature.controller.observeLifecycle(harness, fixtureIdentityValues.WorkbenchThreadId["thread"], {
    kind: "pendingInput", questionnaire, requestKey: questionnaire.requestKey, turnId: fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("turn"),
  });
  requests.length = 0;
  return {
    feature, provider, questionnaire, releases, requests, state,
    read: async () => (await feature.controller.getSnapshot(fixtureIdentityValues.ProjectId["project"])).entries.find((entry) => entry.entryKind === "thread"),
    complete: () => feature.controller.handleRequest("observer", {
      identity: provider.identity, method: "workbench/thread-state/status/set", projectId: fixtureIdentityValues.ProjectId.project, status: "completed",
    }),
  };
}

test("manual questionnaire completion preserves its question and survives a late interrupted notification", async () => {
  const h = await questionnaireHarness();
  try {
    const response = await h.complete();
    assert.deepEqual(response, { result: { accepted: true, revision: (await h.feature.controller.getSnapshot(fixtureIdentityValues.ProjectId["project"])).revision } });
    assert.deepEqual(h.releases, [h.questionnaire.requestKey]);
    await h.feature.observeProviderNotification("codex", {
      lifecycle: { threadId: fixtureIdentityValues.WorkbenchThreadId.thread, event: {
        kind: "turnCompleted", turnId: fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("turn"), status: "interrupted",
      } }, activity: null, displayLabel: null,
    });
    const entry = await h.read();
    assert.ok(entry && entry.entryKind === "thread");
    assert.equal(entry.lifecycle.kind, "completed");
    assert.deepEqual(entry.pendingQuestionnaire, h.questionnaire);
  } finally { await h.feature.dispose(); }
});

test("completing an agent-blocked sidebar questionnaire fences late events from its interrupted turn", async () => {
  const h = await questionnaireHarness();
  try {
    await h.feature.controller.observeLifecycle("codex", fixtureIdentityValues.WorkbenchThreadId["thread"], { kind: "agentStatus", status: "blocked", turnId: fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("turn") });
    await h.complete();
    await h.feature.observeProviderNotification("codex", {
      lifecycle: { threadId: fixtureIdentityValues.WorkbenchThreadId.thread, event: {
        kind: "turnCompleted", turnId: fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("turn"), status: "interrupted",
      } }, activity: null, displayLabel: null,
    });
    assert.equal((await h.read())?.lifecycle.kind, "completed");
  } finally { await h.feature.dispose(); }
});

test("failed interruption cannot mark the thread complete or discard its question", async () => {
  const h = await questionnaireHarness();
  try {
    h.state.failInterrupt = true;
    await assert.rejects(h.complete(), /interrupt failed/u);
    const entry = await h.read();
    assert.equal(entry?.lifecycle.kind, "needsAttention");
    assert.deepEqual(entry?.entryKind === "thread" && entry.pendingQuestionnaire, h.questionnaire);
  } finally { await h.feature.dispose(); }
});

test("composer snooze preserves provider questionnaires and fences failures or raced answers", async () => {
  for (const harness of ["codex"] as const) {
    for (const outcome of ["snooze", "fail", "answer"] as const) {
      const h = await questionnaireHarness(harness);
      try {
        h.state.failInterrupt = outcome === "fail";
        if (outcome === "answer" && harness === "codex") h.state.beforeRelease = async () => {
          await h.feature.controller.observeLifecycle(harness, fixtureIdentityValues.WorkbenchThreadId["thread"], { kind: "inputResolved", requestKey: h.questionnaire.requestKey });
        };
        const snooze = h.feature.controller.handleRequest("observer", {
          method: "workbench/thread-state/questionnaire/snooze", projectId: fixtureIdentityValues.ProjectId.project,
          identity: { harness, threadId: "thread" }, requestKey: h.questionnaire.requestKey,
        });
        if (outcome === "fail") await assert.rejects(snooze, /interrupt failed/u);
        else {
          const response = await snooze;
          assert.equal("result" in response && (response.result as { accepted: boolean }).accepted, outcome !== "answer" || harness !== "codex");
        }
        const entry = await h.read();
        assert.ok(entry?.entryKind === "thread");
        const answered = outcome === "answer" && harness === "codex";
        assert.equal(entry.metadata.snoozed, outcome !== "fail" && !answered);
        if (!answered) assert.deepEqual(entry.pendingQuestionnaire, h.questionnaire);
        if (outcome === "snooze") {
          await h.feature.controller.observeLifecycle(harness, fixtureIdentityValues.WorkbenchThreadId["thread"], { kind: "acceptedIntent", turnId: fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("resumed") });
          const resumed = await h.read();
          assert.ok(resumed?.entryKind === "thread");
          assert.equal(resumed.metadata.snoozed, false);
        }
      } finally { await h.feature.dispose(); }
    }
  }
});

test("a retained questionnaire can be snoozed after its thread was marked complete", async () => {
  const h = await questionnaireHarness();
  try {
    await h.complete();
    const response = await h.feature.controller.handleRequest("observer", {
      method: "workbench/thread-state/questionnaire/snooze", projectId: fixtureIdentityValues.ProjectId.project,
      identity: h.provider.identity, requestKey: h.questionnaire.requestKey,
    });
    assert.equal("result" in response && (response.result as { accepted: boolean }).accepted, true);
    const entry = await h.read();
    assert.ok(entry?.entryKind === "thread");
    assert.equal(entry.metadata.snoozed, true);
    assert.equal(entry.lifecycle.kind, "needsAttention");
    assert.deepEqual(entry.pendingQuestionnaire, h.questionnaire);
  } finally { await h.feature.dispose(); }
});

test("questionnaire completion interrupts current work rather than its historical turn", async () => {
  for (const newer of [false, true]) {
    const h = await questionnaireHarness();
    try {
      h.state.turn = newer ? { id: "native:new-turn", status: "inProgress", items: [] } : { id: "native:turn", status: "interrupted", items: [] };
      const response = await h.complete();
      assert.equal("result" in response && (response.result as { accepted: boolean }).accepted, true);
      assert.deepEqual(h.requests.map(request => request.method), newer
        ? ["thread/turns/list", "thread/goal/clear", "turn/interrupt"] : ["thread/turns/list"]);
      assert.deepEqual(h.releases, [h.questionnaire.requestKey]);
      if (newer) assert.equal((h.requests.at(-1)?.params as { turnId: string }).turnId, "native:new-turn");
    } finally { await h.feature.dispose(); }
  }
});

test("unrecognised provider turn status cannot release a question or report completion", async () => {
  const h = await questionnaireHarness();
  try {
    h.state.turn.status = "unexpected";
    await assert.rejects(h.complete(), /turn metadata/u);
    assert.deepEqual(h.releases, []);
    assert.equal((await h.read())?.lifecycle.kind, "needsAttention");
  } finally { await h.feature.dispose(); }
});

test("answer or newer-turn observations during release prevent stale completion without blocking the mutation queue", async () => {
  for (const answer of [false, true]) {
    const h = await questionnaireHarness();
    try {
      h.state.beforeRelease = async () => {
        await h.feature.controller.observeLifecycle("codex", fixtureIdentityValues.WorkbenchThreadId["thread"], answer
          ? { kind: "inputResolved", requestKey: h.questionnaire.requestKey }
          : { kind: "acceptedIntent", turnId: fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("new-turn") });
      };
      const response = await h.complete();
      assert.equal("result" in response && (response.result as { accepted: boolean }).accepted, false);
      assert.equal(h.requests.some(request => request.method === "turn/interrupt"), false);
    } finally { await h.feature.dispose(); }
  }
});

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

test("WB active flags retain working sidebar state", () => {
  const entry = normalizeProviderSidebarEntry("codex", {
    id: "thread", status: "active:waitingOnUserInput", updatedAt: 1, turns: [],
  });
  assert.ok(entry?.entryKind === "thread");
  assert.equal(entry.lifecycle.kind, "working");
});

test("provider sidebar normalization keeps provider names as display labels only", () => {
  const id = "123e4567-e89b-42d3-a456-426614174000";
  const entry = normalizeProviderSidebarEntry("codex", { id, name: id, preview: "First request", status: { type: "idle" }, updatedAt: 1 });
  assert.equal(entry?.title, "First request");
  assert.equal(entry && "workbenchTitle" in entry ? entry.workbenchTitle : undefined, undefined);
  const named = normalizeProviderSidebarEntry("codex", { id: "thread", name: "First request", preview: "First request", updatedAt: 1 });
  assert.equal(named?.title, "First request");
  assert.equal(named && "workbenchTitle" in named ? named.workbenchTitle : undefined, undefined);
  for (const provider of [{}, { name: "New thread" }, { name: "thread" }, { preview: "First request" }]) {
    const fallback = normalizeProviderSidebarEntry("codex", { id: "thread", ...provider, updatedAt: 1 });
    assert.equal(fallback && "workbenchTitle" in fallback ? fallback.workbenchTitle : undefined, undefined);
  }
});

test("inactive subagents remain completed but unsettled until an explicit settlement overlay exists", () => {
  assert.deepEqual(normalizeSubagentProviderLifecycle({ kind: "completed", reason: "providerInactive", settled: true }), {
    kind: "completed",
    reason: "providerInactive",
    settled: false,
  });
  const explicitlySettled = { agent: { agentStatus: "completed" as const, turnId: fixtureIdentityValues.WorkbenchTurnId.turn }, kind: "completed" as const, reason: "agentCompleted" as const, settled: true };
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
  const database = createThreadStateDatabase(storageRoot, [["thread", "codex"]]);
  const provider: Extract<WorkbenchThreadSidebarEntry, { entryKind: "thread" }> = {
    activityAt: 1,
    entryKind: "thread" as const,
    identity: { harness: "codex" as const, threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("thread") },
    lifecycle: { agent: { agentStatus: "working" as const, turnId: fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("turn") }, kind: "working" as const, reason: "acceptedIntent" as const, settled: false },
    metadata: { archived: false, pinned: false, snoozed: false },
    title: "Thread",
  };
  database.admitRecord({ ...storedRecordDefaults, ...provider, providerObserved: true });
  await database.identities.threads.start();
  const feature = createFeature({
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
    resolveProjectById: async () => ({ id: fixtureIdentityValues.ProjectId.project, rootPath: storageRoot }),
    resolveProjectFromCwd: async (cwd) => ({ cwd, project: { id: fixtureIdentityValues.ProjectId.project, rootPath: storageRoot } }),
    transitions: { run: async (_key, operation) => await operation() },
  });
  await feature.controller.ensureProviderEntry(fixtureIdentityValues.ProjectId["project"], provider);

  assert.deepEqual(await feature.observeProviderNotification("codex", {
    lifecycle: { threadId: fixtureIdentityValues.WorkbenchThreadId.thread, event: {
      kind: "turnCompleted", turnId: fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("turn"), status: "completed",
    } }, activity: null, displayLabel: null,
  }), {
    event: { kind: "turnCompleted", status: "completed", turnId: "turn" },
    lifecycle: { kind: "needsAttention", reason: "noActiveTurn", settled: false },
    threadId: "thread",
  });
  assert.deepEqual((await database.readThreadStateRecords({
    selection: "threads", projectId: fixtureIdentityValues.ProjectId["project"], threadIds: [fixtureIdentityValues.WorkbenchThreadId["thread"]],
  }))[0]?.lifecycle, { kind: "needsAttention", reason: "noActiveTurn", settled: false });

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

test("creation installs captured settings before first admission and refreshes only on continuation", async () => {
  for (const harness of ["codex", "copilot", "opencode"] as const) {
    const projectId = fixtureIdentityValues.ProjectId.project;
    const settings = { harness, model: "captured-model", agentPath: null, agentSource: null, reasoningEffort: "high", serviceTier: null };
    let model = "later-definition";
    let catalogueReads = 0;
    const database = createThreadStateDatabase();
    await database.seedProject(fixtureIdentityValues.ProjectId["project-b"], { version: 4 });
    const feature = createFeature({
      database,
      getProjectCatalog: () => ({ data: [], rootPath: "C:/workspace" }),
      gitArcs: { findActiveClaim: async () => null, listActiveClaims: async () => [] },
      harnesses: createHarnesses(async () => ({ id: 0, result: { data: [], nextCursor: null } })),
      listSubagents: async () => ({ subagents: [] }),
      projectState: { getCurrentUpdate: () => null, handleRequest: async () => ({}), observe: () => () => {} },
      publish: () => {},
      readComposerProfiles: async () => {
        catalogueReads++;
        return { profiles: [{ ...settings, model, id: "profile", name: "Profile", scope: { kind: "global" }, createdAt: 1, updatedAt: 1 }] };
      },
      resolveProjectById: async () => ({ id: projectId, rootPath: "C:/workspace" }),
      resolveProjectFromCwd: async cwd => ({ cwd, project: { id: projectId, rootPath: "C:/workspace" } }),
      transitions: { run: async (_key, operation) => operation() },
    });
    try {
      const captured = await feature.captureCreationProfile(harness, "C:/workspace", {
        kind: "snapshot", selection: { kind: "profile", profileId: "profile", settings },
      });
      const native = { ...await feature.observeThread(providerThread("C:/workspace", "created")), harness };
      await feature.installCreatedProfile(harness, native, captured.selection);
      assert.equal(catalogueReads, 0);
      assert.deepEqual((await feature.readProviderProfile(harness, native)).selection, captured.selection);
      const signal = new AbortController().signal;
      const first = await feature.withProviderProfileAdmission(harness, native, async profile => {
        assert.equal(profile.selection.settings.model, "captured-model");
        return { accepted: true, result: "first" };
      }, signal, false);
      assert.equal(first.result, "first");
      assert.equal(catalogueReads, 0);
      await feature.withProviderProfileAdmission(harness, native, async profile => {
        assert.equal(profile.selection.settings.model, "later-definition");
        return { accepted: true, result: "continued" };
      }, signal);
      assert.equal(catalogueReads, 1);
      assert.equal((await feature.readProviderProfile(harness, native)).selection.settings.model, "later-definition");
      const entries = (await feature.controller.getSnapshot(projectId)).entries;
      const created = entries.find(entry => entry.entryKind !== "draft");
      assert.ok(created);
      const slot = { kind: "thread" as const, projectId, harness, threadId: created.identity.threadId };
      model = "preview-definition";
      assert.equal((await feature.controller.readComposerProfileTarget(slot))?.settings.model, model);
      assert.equal((await feature.readProviderProfile(harness, native)).selection.settings.model, "later-definition");
      model = "rejected-definition";
      await assert.rejects(feature.withProviderProfileAdmission(harness, native, async () => {
        throw new Error("Native admission failed");
      }, signal), /Native admission failed/);
      assert.equal((await feature.readProviderProfile(harness, native)).selection.settings.model, "later-definition");
      assert.equal((await feature.controller.readComposerProfileTarget(slot))?.settings.model, model);
      await assert.rejects(feature.captureCreationProfile(harness, "C:/workspace", {
        kind: "target", slot: { kind: "new-thread", projectId: fixtureIdentityValues.ProjectId["project-b"] },
      }), /another project/);
    } finally { await feature.dispose(); }
  }
});

test("unchanged questionnaires can be snoozed while newer work is active", async () => {
  const h = await questionnaireHarness();
  try {
    await h.feature.controller.observeLifecycle("codex", h.provider.identity.threadId, {
      kind: "acceptedIntent", turnId: fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("new-turn"),
    });
    h.state.turn = { id: "native:new-turn", status: "inProgress", items: [] };
    const result = await h.feature.controller.handleRequest("observer", {
      method: "workbench/thread-state/questionnaire/snooze", projectId: fixtureIdentityValues.ProjectId.project,
      identity: h.provider.identity, requestKey: h.questionnaire.requestKey,
    });
    assert.equal("result" in result && (result.result as { accepted: boolean }).accepted, true);
    const entry = await h.read();
    assert.ok(entry?.entryKind === "thread" && entry.metadata.snoozed);
    assert.deepEqual(entry.pendingQuestionnaire, h.questionnaire);
  } finally { await h.feature.dispose(); }
});

test("agent status is a canonical thread mutation without provider reads", async () => {
  const h = await questionnaireHarness();
  try {
    await h.feature.controller.observeLifecycle("codex", h.provider.identity.threadId, { kind: "recoveryFailed" });
    h.requests.length = 0;
    const result = await h.feature.handleManagedThreadRequest({
      id: "status", method: "workbench/thread/status",
      params: { callerThreadId: h.provider.identity.threadId, cwd: "C:/workspace", status: "completed" },
    });
    assert.equal(result.error, undefined);
    assert.equal((await h.read())?.lifecycle.kind, "completed");
    assert.deepEqual(h.requests, []);
  } finally { await h.feature.dispose(); }
});

test("MCP admission consumes translated metadata without additional provider reads", async () => {
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-thread-mcp-admission-"));
  const requests: JsonRpcRequest[] = [];
  const resolvedCwds: string[] = [];
  const feature = createFeature({
    database: createThreadStateDatabase(),
    getProjectCatalog: () => ({ data: [], rootPath: storageRoot }),
    gitArcs: { findActiveClaim: async () => null, listActiveClaims: async () => [] },
    harnesses: createHarnesses(async (_harness, request) => {
      requests.push(request);
      return {
        id: request.id ?? null,
        result: {
          thread: providerThread(storageRoot, "thread", {
            id: "thread",
            name: "Thread",
            status: { type: "idle" },
            turns: [],
            updatedAt: 1,
            createdAt: 1,
          }),
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
    resolveProjectById: async () => ({ id: fixtureIdentityValues.ProjectId.project, rootPath: storageRoot }),
    resolveProjectFromCwd: async (cwd) => {
      resolvedCwds.push(cwd);
      if (cwd !== storageRoot) throw new Error("Unowned cwd");
      return { cwd, project: { id: fixtureIdentityValues.ProjectId.project, rootPath: storageRoot } };
    },
    transitions: { run: async (_key, operation) => await operation() },
  });

  const observed = await feature.observeThread(providerThread(storageRoot, "thread", { id: "thread" }));
  assert.deepEqual(await feature.getProviderMcpState(observed), {
    generation: null,
    projectId: fixtureIdentityValues.ProjectId.project,
  });
  assert.deepEqual(requests, []);
  const selection = {
    kind: "custom" as const,
    settings: {
      agentPath: "library:agents/lily.md", agentSource: "library" as const, harness: "codex" as const,
      model: "daemon-model", reasoningEffort: null, serviceTier: null,
    },
  };
  const savedEntry = (await feature.controller.getSnapshot(fixtureIdentityValues.ProjectId["project"])).entries.find(entry => entry.entryKind === "thread");
  assert.ok(savedEntry?.entryKind === "thread");
  await feature.controller.setComposerProfileTarget({ kind: "thread", projectId: fixtureIdentityValues.ProjectId["project"], ...savedEntry.identity }, selection);
  const provider: ThreadReadResponse["thread"] = {
    cwd: storageRoot, id: "thread", projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("untrusted-provider-project"), status: { type: "notLoaded" }, turns: [], updatedAt: 1,
    agentNickname: null, agentRole: null, canAcceptDirectInput: null, cliVersion: "", createdAt: 1,
    ephemeral: false, extra: null, forkedFromId: null, gitInfo: null, historyMode: "legacy",
    model: null, modelProvider: "openai", name: null, parentThreadId: null, path: null, preview: "",
    reasoningEffort: null, recencyAt: null, section: null, sectionEnteredAt: null,
    sessionId: "thread", source: "cli", threadSource: null,
  };
  assert.deepEqual(await feature.prepareProviderProfile(await feature.observeThread(provider)), {
    cwd: storageRoot, projectId: fixtureIdentityValues.ProjectId.project, selection, subagentName: null,
  });
  assert.equal(resolvedCwds.at(-1), storageRoot);
  await assert.rejects(async () => feature.prepareProviderProfile(await feature.observeThread({ ...provider, cwd: "/unowned" })), /Unowned cwd/u);

  await feature.dispose();
  await fs.rm(storageRoot, { force: true, recursive: true });
});

for (const foreignPage of ["first", "last"] as const) {
  test(`foreign provider rows on the ${foreignPage} page cannot poison Codex message preparation`, async () => {
    const projectId = fixtureIdentityValues.ProjectId["project-a"];
    const otherProjectId = fixtureIdentityValues.ProjectId["project-b"];
    const database = createThreadStateDatabase();
    await database.seedProject(projectId, { version: 4 });
    await database.seedProject(otherProjectId, { version: 4 });
    const local = providerThread("C:/project-a", "local");
    const neighbour = providerThread("C:/project-a", "copilot-neighbour");
    const foreign = providerThread("C:/project-b", "foreign");
    const releaseListing = deferred<void>();
    const reconciled = deferred<void>();
    const selection = {
      kind: "custom" as const,
      settings: {
        agentPath: null, agentSource: null, harness: "codex" as const,
        model: "selected-model", reasoningEffort: null, serviceTier: null,
      },
    };
    const feature = createFeature({
      database,
      getProjectCatalog: () => ({ data: [], rootPath: "C:/" }),
      gitArcs: { findActiveClaim: async () => null, listActiveClaims: async () => [] },
      harnesses: createHarnesses(async (harness, request) => {
        if (request.method === "thread/read") return { id: request.id ?? null, result: { thread: local } };
        await releaseListing.promise;
        if (harness !== "codex") return { id: request.id ?? null, result: { data: [], nextCursor: null } };
        const last = Boolean((request.params as { cursor?: string }).cursor);
        return { id: request.id ?? null, result: {
          data: [...(!last ? [neighbour] : []), ...(last === (foreignPage === "last") ? [foreign] : [])],
          nextCursor: last ? null : "last",
        } };
      }),
      listSubagents: async () => ({ subagents: [] }),
      projectState: { getCurrentUpdate: () => null, handleRequest: async () => ({}), observe: () => () => {} },
      publish: (_connection, snapshot) => {
        if ("freshness" in snapshot && (snapshot.freshness === "fresh" || snapshot.error)) reconciled.resolve();
      },
      resolveProjectById: async id => ({ id: fixtureIdentitySchemas.ProjectIdSchema.parse(id), rootPath: id === projectId ? local.cwd : foreign.cwd }),
      resolveProjectFromCwd: async cwd => ({ cwd, project: {
        id: cwd === local.cwd ? projectId : otherProjectId, rootPath: cwd,
      } }),
      transitions: { run: async (_key, operation) => operation() },
    });
    try {
      await feature.controller.setComposerProfileTarget({ kind: "new-thread", projectId }, selection);
      await feature.controller.open("observer", projectId);
      releaseListing.resolve();
      await reconciled.promise;
      const observed = await feature.observeThread(local);
      await feature.getProviderMcpState(observed);
      const localIdentity = await database.identities.threads.resolve({
        threadId: fixtureIdentitySchemas.NativeThreadIdSchema.parse(local.id), harness: "codex",
      });
      assert.ok(localIdentity);
      await feature.controller.setComposerProfileTarget({ kind: "thread", projectId, harness: "codex", threadId: localIdentity.threadId }, selection);
      const neighbourIdentity = await database.identities.threads.resolve({
        threadId: fixtureIdentitySchemas.NativeThreadIdSchema.parse(neighbour.id), harness: "codex",
      });
      assert.ok(neighbourIdentity);
      const neighbourBefore = database.repository.readRecords({ selection: "threads", threadIds: [neighbourIdentity.threadId] });
      const commit = database.commitThreadState.bind(database);
      database.commitThreadState = async changes => {
        assert.ok(changes.records?.every(record => record.identity.threadId !== neighbourIdentity.threadId) ?? true);
        await commit(changes);
      };
      assert.deepEqual(await feature.prepareProviderProfile(observed), {
        cwd: local.cwd, projectId, selection, subagentName: null,
      });
      assert.deepEqual(await feature.getProviderMcpState(observed), { generation: null, projectId });
      await feature.setProviderMcpGeneration(projectId, "codex", localIdentity.threadId, "generation");
      assert.deepEqual(await feature.getProviderMcpState(observed), { generation: "generation", projectId });
      const snapshot = await feature.controller.getSnapshot(projectId);
      assert.equal(snapshot.error, null);
      assert.equal(snapshot.entries.length, 2);
      const foreignIdentity = await database.identities.threads.resolve({
        threadId: fixtureIdentitySchemas.NativeThreadIdSchema.parse(foreign.id), harness: "codex",
      });
      assert.equal(foreignIdentity?.projectId, otherProjectId);
      assert.equal(database.repository.readProject(projectId).records.length, 2);
      assert.deepEqual(database.repository.readRecords({ selection: "threads", threadIds: [neighbourIdentity.threadId] }), neighbourBefore);
      assert.equal(database.repository.readProject(otherProjectId).records.length, 0);
    } finally {
      releaseListing.resolve();
      await feature.dispose();
    }
  });
}

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
    parentThreadId: fixtureIdentityValues.WorkbenchThreadId["parent"],
    profileId: "profile",
    profileName: "Lily",
    projectId: fixtureIdentityValues.ProjectId["project"],
    threadId: fixtureIdentityValues.WorkbenchThreadId["child"],
    title: "Inspect code",
    updatedAt: 2,
  };
  const feature = createFeature({
    database: createThreadStateDatabase(storageRoot, [["child", "codex"], ["parent", "codex"]]),
    getProjectCatalog: () => ({ data: [], rootPath: storageRoot }),
    gitArcs: { findActiveClaim: async () => null, listActiveClaims: async () => [] },
    harnesses: createHarnesses(async (harness, request) => {
      if (request.method === "thread/read") {
        return { id: request.id ?? null, result: { thread: providerThread(storageRoot, "child", { name: "Child", updatedAt: 2 }) } };
      }
      const cursor = (request.params as { cursor?: string | null }).cursor ?? null;
      if (harness !== "codex") return { id: request.id ?? null, result: { data: [], nextCursor: null } };
      if (!cursor) return { id: request.id ?? null, result: { data: [providerThread(storageRoot, "child", { name: "Child", updatedAt: 2 })], nextCursor: "next" } };
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
    resolveProjectById: async () => ({ id: fixtureIdentityValues.ProjectId.project, rootPath: storageRoot }),
    resolveProjectFromCwd: async (cwd) => ({ cwd, project: { id: fixtureIdentityValues.ProjectId.project, rootPath: storageRoot } }),
    transitions: { run: async (_key, operation) => await operation() },
  });

  await feature.controller.open("observer", fixtureIdentityValues.ProjectId["project"]);
  await secondPageStarted.promise;
  relationships = [relationship];
  await feature.installSubagentRelationship(relationship);
  releaseSecondPage.resolve();
  await waitFor(async () => (await feature.controller.getSnapshot(fixtureIdentityValues.ProjectId["project"])).freshness === "fresh", "Final provider reconciliation did not finish.");
  const child = (await feature.controller.getSnapshot(fixtureIdentityValues.ProjectId["project"])).entries.find((entry) => entry.entryKind !== "draft" && entry.identity.threadId === "child");
  assert.equal(child?.entryKind, "subagent");
  await feature.dispose();
  await fs.rm(storageRoot, { force: true, recursive: true });
});

test("provider reconciliation publishes its first page before deeper history and retains relationship and git state", async () => {
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-thread-feature-"));
  const publications: WorkbenchThreadStateSnapshot[] = [];
  const starts: string[] = [];
  const codexCursors: Array<string | null> = [];
  const codexRequests: Array<Record<string, unknown>> = [];
  let releaseCodexNext = () => undefined;
  const codexNextGate = new Promise<void>((resolve) => { releaseCodexNext = resolve; });
  const activeClaim = {
    checkpointCommit: "a".repeat(40),
    claimedPaths: ["one.txt"],
    harness: "codex" as const,
    intentDescription: "Keep the parent claim visible.",
    intentName: "parent claim",
    proposalId: "proposal-one",
    proposalStatus: "proposed" as const,
    reloadScopes: ["server:mcp" as const],
    threadId: fixtureIdentityValues.WorkbenchThreadId.parent,
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
    threadId: fixtureIdentityValues.WorkbenchThreadId.parent,
    updatedAt: "2026-08-19T00:00:00.000Z",
  };
  const planState = {
    checkpointCommit: "b".repeat(40),
    harness: "codex" as const,
    intentDescription: "Plan around the active owner.",
    intentName: "planned overlap",
    scopePaths: ["one.txt", "two.txt"],
    reloadScopes: ["server:core" as const],
    threadId: fixtureIdentityValues.WorkbenchThreadId.parent,
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
  const feature = createFeature({
    database: createThreadStateDatabase(storageRoot, [["parent", "codex"], ["child", "codex"]]),
    getProjectCatalog: () => ({ data: [], rootPath: "C:/projects" }),
    gitArcs,
    listSubagents: async () => ({
      subagents: [{
        createdAt: 1,
        cwd: "C:/projects/project",
        directSubagentIndex: 0,
        harness: "codex",
        name: "Child",
        parentThreadId: fixtureIdentityValues.WorkbenchThreadId.parent,
        profileId: "default",
        profileName: "Default",
        projectId: fixtureIdentityValues.ProjectId.project,
        threadId: fixtureIdentityValues.WorkbenchThreadId.child,
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
          return { id: request.id ?? null, result: { data: [providerThread(storageRoot, "parent", { name: "Parent", updatedAt: 3 })], nextCursor: null } };
        }
        return { id: request.id ?? null, result: { data: [providerThread(storageRoot, "child", { name: "Child provider", updatedAt: 2 })], nextCursor: "codex-next" } };
      }
      return { id: request.id ?? null, result: { data: [], nextCursor: null } };
    }),
    resolveProjectById: async () => ({ id: fixtureIdentityValues.ProjectId.project, rootPath: storageRoot }),
    resolveProjectFromCwd: async cwd => ({ cwd, project: { id: fixtureIdentityValues.ProjectId.project, rootPath: storageRoot } }),
    transitions: { run: async (_key, operation) => await operation() },
  });

  await feature.controller.open("observer", fixtureIdentityValues.ProjectId["project"]);
  await waitFor(() => publications.some((snapshot) => "entries" in snapshot && snapshot.entries.some((entry) => entry.entryKind !== "draft" && entry.identity.harness === "codex")), "First page did not publish while deeper history remained pending.");
  assert.deepEqual(starts, ["codex", "opencode"]);
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
  await waitFor(() => publications.some((snapshot) => "entries" in snapshot && snapshot.entries.some((entry) => entry.entryKind !== "draft" && entry.identity.threadId === "parent")), "Deep Codex page did not publish its claimed parent.");
  const final = [...publications].reverse().find((snapshot) => "entries" in snapshot);
  assert.ok(final && "entries" in final);
  assert.equal(final.freshness, "fresh");
  assert.equal(final.error, null);
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
  const refreshedParent = await feature.controller.refreshGitArcState(fixtureIdentityValues.ProjectId["project"], "codex", fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("parent"));
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
  const projectRoots = new Map<string, string>([
    [fixtureIdentityValues.ProjectId["project-a"], path.join(storageRoot, "project-a")],
    [fixtureIdentityValues.ProjectId["project-b"], path.join(storageRoot, "project-b")],
  ]);
  await Promise.all([...projectRoots.values()].map((rootPath) => fs.mkdir(rootPath)));
  const firstDeepGate = deferred<void>();
  const secondDeepGate = deferred<void>();
  const firstPages: string[] = [];
  const deepPages: string[] = [];
  let activeDeepPages = 0;
  let maximumActiveDeepPages = 0;
  const database = createThreadStateDatabase();
  for (const id of projectRoots.keys()) await database.seedProject(fixtureIdentitySchemas.ProjectIdSchema.parse(id), { version: 4 });
  const feature = createFeature({
    database,
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
    resolveProjectById: async (projectId) => ({ id: fixtureIdentitySchemas.ProjectIdSchema.parse(projectId), rootPath: projectRoots.get(projectId) ?? storageRoot }),
    resolveProjectFromCwd: async () => { throw new Error("Not used by this test."); },
    transitions: { run: async (_key, operation) => await operation() },
  });

  await Promise.all([feature.controller.open("a", fixtureIdentityValues.ProjectId["project-a"]), feature.controller.open("b", fixtureIdentityValues.ProjectId["project-b"])]);
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

test("managed title commands use the workbench-recorded title as the mutation precondition", async () => {
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-thread-managed-title-"));
  const requests: Array<{ harness: string; method: string; params: unknown }> = [];
  let providerName: string | null = "Current task";
  let providerPreview: string | null = "Initial request";
  const feature = createFeature({
    database: createThreadStateDatabase("C:/workspace", [["thread-one", "codex"]]),
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
          thread: providerThread("C:/workspace", "thread-one", {
            name: providerName,
            preview: providerPreview ?? "",
          }),
        },
      };
    }),
    resolveProjectById: async () => ({ id: fixtureIdentityValues.ProjectId.project, rootPath: "C:/workspace" }),
    resolveProjectFromCwd: async (cwd) => ({ cwd, project: { id: fixtureIdentityValues.ProjectId.project, rootPath: "C:/workspace" } }),
    transitions: { run: async (_key, operation) => await operation() },
  });

  const response = await feature.handleManagedThreadRequest({
    id: 1,
    method: "workbench/thread/title",
    params: { action: "get", callerThreadId: "thread-one", cwd: "C:/workspace" },
  });

  assert.deepEqual(response, {
    id: 1,
    result: { harness: "codex", threadId: "thread-one", title: "" },
  });
  assert.deepEqual(requests[0], {
    harness: "codex",
    method: "thread/read",
    params: { includeTurns: false, threadId: "native:thread-one" },
  });
  await waitFor(
    () => requests.some(({ method }) => method === "thread/list"),
    "Provider reconciliation did not run after the managed title read.",
  );

  requests.length = 0;
  const initiallyNamed = await feature.handleManagedThreadRequest({
    id: 2,
    method: "workbench/thread/title",
    params: { action: "set", callerThreadId: "thread-one", cwd: "C:/workspace", title: "Current task" },
  });
  assert.deepEqual(initiallyNamed, {
    id: 2,
    result: { harness: "codex", threadId: "thread-one", title: "Current task" },
  });

  const named = await feature.handleManagedThreadRequest({
    id: 3,
    method: "workbench/thread/title",
    params: { action: "get", callerThreadId: "thread-one", cwd: "C:/workspace" },
  });
  assert.deepEqual(named, {
    id: 3,
    result: { harness: "codex", threadId: "thread-one", title: "Current task" },
  });

  const missingCurrentTitle = await feature.handleManagedThreadRequest({
    id: 4,
    method: "workbench/thread/title",
    params: { action: "set", callerThreadId: "thread-one", cwd: "C:/workspace", title: "Narrow sidequest" },
  });
  assert.equal(missingCurrentTitle.id, 4);
  assert.equal(missingCurrentTitle.error?.code, -32000);
  assert.match(missingCurrentTitle.error?.message ?? "", /Current title: "Current task"/u);

  const staleCurrentTitle = await feature.handleManagedThreadRequest({
    id: 5,
    method: "workbench/thread/title",
    params: {
      action: "set",
      callerThreadId: "thread-one",
      currentTitle: "Wrong title",
      cwd: "C:/workspace",
      title: "Narrow sidequest",
    },
  });
  assert.equal(staleCurrentTitle.id, 5);
  assert.equal(staleCurrentTitle.error?.code, -32000);
  assert.match(staleCurrentTitle.error?.message ?? "", /Current title: "Current task"/u);

  const renamed = await feature.handleManagedThreadRequest({
    id: 6,
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
    id: 6,
    result: { harness: "codex", threadId: "thread-one", title: "New overarching task" },
  });
  // Only the two accepted sets may rename the provider.
  assert.equal(requests.filter(({ method }) => method === "thread/name/set").length, 2);

  const titleEntry = (await feature.controller.getSnapshot(fixtureIdentityValues.ProjectId["project"])).entries.find((entry) => (
    entry.entryKind !== "draft" && entry.identity.threadId === "thread-one"
  ));
  assert.deepEqual(
    titleEntry && "previousTitles" in titleEntry
      ? (titleEntry.previousTitles as Array<{ title: string }>).map((entry) => entry.title)
      : [],
    ["Current task"],
  );

  providerName = "New thread";
  providerPreview = "Initial request";
  const providerLabelCannotClear = await feature.handleManagedThreadRequest({
    id: 7,
    method: "workbench/thread/title",
    params: { action: "get", callerThreadId: "thread-one", cwd: "C:/workspace" },
  });
  assert.deepEqual(providerLabelCannotClear, {
    id: 7,
    result: { harness: "codex", threadId: "thread-one", title: "New overarching task" },
  });

  const stillNamed = await feature.handleManagedThreadRequest({
    id: 8,
    method: "workbench/thread/title",
    params: { action: "set", callerThreadId: "thread-one", cwd: "C:/workspace", title: "Second useful title" },
  });
  assert.equal(stillNamed.error?.code, -32000);
  assert.match(stillNamed.error?.message ?? "", /Current title: "New overarching task"/u);
  assert.equal(requests.filter(({ method }) => method === "thread/name/set").length, 2);
  await feature.dispose();
  await fs.rm(storageRoot, { force: true, recursive: true });
});

test("Git snapshot reconciliation failures reach the bounded feature log", async () => {
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-thread-git-failure-"));
  const logs: string[] = [];
  const feature = createFeature({
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
    resolveProjectById: async () => ({ id: fixtureIdentityValues.ProjectId.project, rootPath: "C:/workspace" }),
    resolveProjectFromCwd: async (cwd) => ({ cwd, project: { id: fixtureIdentityValues.ProjectId.project, rootPath: "C:/workspace" } }),
    transitions: { run: async (_key, operation) => await operation() },
  });

  await feature.controller.open("observer", fixtureIdentityValues.ProjectId["project"]);
  await waitFor(() => logs.length === 1, "Git snapshot reconciliation failure was not logged.");
  assert.ok(logs[0]?.includes(fixtureIdentityValues.ProjectId.project));
  assert.match(logs[0] ?? "", /reconciliation failed .*error=Git snapshot exploded\./u);
  assert.equal((await feature.controller.getSnapshot(fixtureIdentityValues.ProjectId["project"])).error, "Git snapshot exploded.");
  await feature.dispose();
  await fs.rm(storageRoot, { force: true, recursive: true });
});

test("expired settled threads reach repository retention through the feature boundary", async () => {
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-thread-retention-feature-"));
  const identity = { harness: "codex" as const, threadId: "expired-thread" };
  const database = createThreadStateDatabase();
  await database.seedProject(fixtureIdentityValues.ProjectId.project, {
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
  });
  const pruned: Array<{ cwd: string; identities: ReadonlyArray<{ harness: WorkbenchHarness; threadId: string }> }> = [];
  const feature = createFeature({
    database,
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
    resolveProjectById: async () => ({ id: fixtureIdentityValues.ProjectId.project, rootPath: "C:/workspace" }),
    resolveProjectFromCwd: async (cwd) => ({ cwd, project: { id: fixtureIdentityValues.ProjectId.project, rootPath: "C:/workspace" } }),
    transitions: { run: async (_key, operation) => await operation() },
  });

  await feature.controller.open("observer", fixtureIdentityValues.ProjectId["project"]);
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
    proposalStatus: "proposed" as const, threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("thread-one"), updatedAt: "2026-08-23T00:00:00.000Z",
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
    threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("thread-one"),
    updatedAt: resolved ? "2026-08-23T00:01:00.000Z" : activeClaim.updatedAt,
  });
  const planState = {
    checkpointCommit: "c".repeat(40), harness: "codex" as const, intentDescription: "",
    intentName: "old plan", scopePaths: ["owned.ts"], threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("thread-one"), updatedAt: "2026-08-23T00:00:00.000Z",
  };
  const feature = createFeature({
    database: createThreadStateDatabase(storageRoot, [["thread-one", "codex"]]),
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
        result: { data: [providerThread(storageRoot, "thread-one", { name: "Thread one" })], nextCursor: "next" },
      };
    }),
    resolveProjectById: async () => ({ id: fixtureIdentityValues.ProjectId.project, rootPath: storageRoot }),
    resolveProjectFromCwd: async cwd => ({ cwd, project: { id: fixtureIdentityValues.ProjectId.project, rootPath: storageRoot } }),
    transitions: {
      run: async (_key, operation) => {
        transitionCount += 1;
        return await operation();
      },
    },
  });

  await feature.controller.ensureProviderEntry(fixtureIdentityValues.ProjectId["project"], {
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
    identity: { harness: "codex", threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("thread-one") },
    lifecycle: { kind: "completed", reason: "providerInactive", settled: false },
    metadata: { archived: false, pinned: false, snoozed: false },
    title: "Thread one",
  });
  await feature.controller.open("observer", fixtureIdentityValues.ProjectId["project"]);
  await waitFor(async () => {
    const snapshot = await feature.controller.getSnapshot(fixtureIdentityValues.ProjectId["project"]);
    const entry = snapshot.entries.find((candidate) => candidate.entryKind !== "draft" && candidate.identity.threadId === "thread-one");
    return transitionCount === 1 && secondPageStarted && entry?.entryKind === "thread"
      && entry.gitArc?.checkpointCommit === activeClaim.checkpointCommit
      && entry.gitArcPlan?.checkpointCommit === planState.checkpointCommit;
  }, "The initial Git snapshot did not repair stale state before provider pagination.");
  resolved = true;
  const refreshed = await feature.controller.refreshGitArcState(fixtureIdentityValues.ProjectId["project"], "codex", fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("thread-one"));
  assert.equal(refreshed?.entryKind === "thread" ? refreshed.gitArc?.phase : null, "resolved");
  secondPageGate.resolve();
  await waitFor(async () => {
    const snapshot = await feature.controller.getSnapshot(fixtureIdentityValues.ProjectId["project"]);
    const entry = snapshot.entries.find((candidate) => candidate.entryKind !== "draft" && candidate.identity.threadId === "thread-one");
    return transitionCount === 2 && entry?.entryKind === "thread" && entry.gitArc?.phase === "resolved" && entry.gitArcPlan === null;
  }, "The final reconciliation did not preserve the resolved Git projection.");
  assert.equal(transitionCount, 2);
  const final = await feature.controller.getSnapshot(fixtureIdentityValues.ProjectId["project"]);
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
  const database = createThreadStateDatabase(storageRoot, [["thread-one", "codex"]]);
  database.admitRecord({
    ...storedRecordDefaults,
    identity: { harness: "codex", threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("thread-one") },
    entryKind: "thread", activityAt: 1, title: "Current task", providerObserved: true,
    metadata: { archived: false, pinned: false, snoozed: false },
    lifecycle: { kind: "working", reason: "acceptedIntent", settled: false,
      agent: { agentStatus: "working", turnId: fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("turn-one") } },
  });
  const feature = createFeature({
    database,
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
      if (request.method === "thread/turns/list") {
        assert.deepEqual(request.params, {
          threadId: "native:thread-one", itemsView: "notLoaded", limit: 1, sortDirection: "desc",
        });
        return { id: request.id ?? null, result: { data: [{ id: "native:turn-one", status: "inProgress", items: [] }], nextCursor: null } };
      }
      if (request.method === "thread/read" && harness === "codex") {
        assert.equal((request.params as { includeTurns: boolean }).includeTurns, false);
        return {
          id: request.id ?? null,
          result: {
            thread: providerThread(storageRoot, "thread-one", {
              name: "Current task",
              preview: "Initial request",
              status: { type: "active", activeFlags: [] },
              turns: [],
              updatedAt: 1,
            }),
          },
        };
      }
      return { id: request.id ?? null, result: { data: [], nextCursor: null } };
    }, async (harness, threadId) => { resumes.push({ harness, threadId }); }),
    resolveProjectById: async () => ({ id: fixtureIdentityValues.ProjectId.project, rootPath: storageRoot }),
    resolveProjectFromCwd: async (cwd) => ({ cwd, project: { id: fixtureIdentityValues.ProjectId.project, rootPath: storageRoot } }),
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
  const feature = createFeature({
    database: createThreadStateDatabase(storageRoot, [["thread-one", "codex"]]),
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
            ? [providerThread(storageRoot, "thread-one", { name: "Old title" })]
            : [],
          nextCursor: null,
        },
      };
    }),
    resolveProjectById: async () => ({ id: fixtureIdentityValues.ProjectId.project, rootPath: storageRoot }),
    resolveProjectFromCwd: async (cwd) => ({ cwd, project: { id: fixtureIdentityValues.ProjectId.project, rootPath: storageRoot } }),
    transitions: { run: async (_key, operation) => await operation() },
  });

  await feature.controller.open("observer", fixtureIdentityValues.ProjectId["project"]);
  await waitFor(() => publications.some((snapshot) => (
    "entries" in snapshot
    && snapshot.entries.some((entry) => entry.entryKind !== "draft" && entry.identity.threadId === "thread-one")
  )), "Provider title entry did not load.");
  publications.length = 0;

  const renamed = await feature.controller.handleRequest("observer", {
    identity: { harness: "codex", threadId: "thread-one" },
    method: "workbench/thread-state/title/set",
    projectId: fixtureIdentityValues.ProjectId.project,
    title: '  "Renamed   thread..."  ',
  });

  assert.deepEqual(renamed, {
    result: { identity: { harness: "codex", threadId: "thread-one" }, ok: true, title: "Renamed thread" },
  });
  assert.deepEqual(titleRequests, [{
    harness: "codex",
    params: { name: "Renamed thread", threadId: "native:thread-one" },
  }]);
  const renamedEntry = (await feature.controller.getSnapshot(fixtureIdentityValues.ProjectId["project"])).entries.find((entry) => entry.entryKind !== "draft" && entry.identity.threadId === "thread-one");
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
    projectId: fixtureIdentityValues.ProjectId.project,
    title: "Rejected title",
  });
  assert.deepEqual(rejected, { error: { code: "threadTitleMutationFailed", message: "Provider rejected title" } });
  assert.equal(publications.length, publicationCount);
  assert.equal((await feature.controller.getSnapshot(fixtureIdentityValues.ProjectId["project"])).entries.find((entry) => entry.entryKind !== "draft" && entry.identity.threadId === "thread-one")?.title, "Renamed thread");

  await feature.dispose();
  await fs.rm(storageRoot, { force: true, recursive: true });
});
