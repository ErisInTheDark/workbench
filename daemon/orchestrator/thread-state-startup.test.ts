/*
 * Keywords: startup, stored sidebar, cold identities, metadata, restart.
 * No exports. Tests open retained thread state with cold database-backed identity owners.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import type { Thread } from "workbench-shared/codex/generated/app-server/v2/Thread";
import type { Turn } from "workbench-shared/codex/generated/app-server/v2/Turn";
import { installWorkbenchDatabaseSchema } from "./database/workbench-database-schema";
import WorkbenchThreadIdentityRepository from "./database/thread-identity/WorkbenchThreadIdentityRepository";
import WorkbenchTranscriptIdentityRepository from "./database/transcript/WorkbenchTranscriptIdentityRepository";
import WorkbenchThreadIdentityController from "./WorkbenchThreadIdentityController";
import WorkbenchTranscriptIdentityController from "./WorkbenchTranscriptIdentityController";
import WorkbenchHarnessController from "./WorkbenchHarnessController";
import WorkbenchThreadStateController from "./WorkbenchThreadStateController";
import { mapNativeThreadStateResult } from "./thread-identity-workbench-mapping";
import type { WorkbenchThreadStateOpenResult } from "workbench-shared/workbench/thread/thread-state";
import type { WorkbenchThreadIdentityLookup } from "./database/thread-identity/workbench-thread-identity-types";
import type { JsonRpcRequest } from "./bridge-types";

async function fixture(database: Database.Database, failMetadata = false, crossProviderChild = false, foreignThread = false) {
  const repository = new WorkbenchThreadIdentityRepository(database);
  const itemRepository = new WorkbenchTranscriptIdentityRepository(database);
  const threads = new WorkbenchThreadIdentityController({
    listThreadIdentities: async () => repository.list(),
    observeThreadIdentities: async (input) => repository.observeMany(input),
    resolveThreadIdentity: async (input) => repository.resolve(input),
    resolveNativeThreadIdentity: async (input) => repository.resolveNative(input),
    observeTurnIdentities: async (input) => repository.observeTurns(input),
    resolveTurnIdentity: async (input) => repository.resolveTurn(input),
  });
  const items = new WorkbenchTranscriptIdentityController({
    admitTranscriptItemIdentities: async (input) => itemRepository.admitMany(input),
    resolveTranscriptItemIdentity: async (input) => itemRepository.resolve(input),
  });
  await threads.start();
  const requests: JsonRpcRequest[] = [];
  const harnesses = new WorkbenchHarnessController((["codex", "opencode"] as const).map((id) => ({
    id, serverMethods: [], recovery: { kind: "none" as const },
    internal: { request: async (request) => {
      requests.push(request);
      const params = request.params as { threadId: string; includeTurns?: boolean; itemsView?: string };
      if (failMetadata) return { id: request.id ?? null, error: { code: -32000, message: "Metadata unavailable" } };
      if (request.method === "thread/read") {
        assert.equal(params.includeTurns, false, "Startup must not request transcript bodies");
        assert.equal(id, params.threadId === "native-child" ? "opencode" : "codex", "Parent provider must not come from its child");
        return { id: request.id ?? null, result: { thread: {
          id: params.threadId, cwd: params.threadId === "foreign-thread" ? "/other" : "/repo", createdAt: 1, updatedAt: 2, name: "Saved",
          source: "cli", parentThreadId: null, turns: [],
        } as Thread } };
      }
      assert.equal(request.method, "thread/turns/list");
      assert.equal(params.itemsView, "notLoaded");
      return { id: request.id ?? null, result: { data: [{
        id: "native-turn", status: "completed", startedAt: 1, completedAt: 2, durationMs: 1000,
        items: [], error: null,
      } as Turn], nextCursor: null } };
    } },
    browser: { handleBrowserMessage: async () => { throw new Error("Startup must not resume or start a turn"); } },
    browse: { readThread: async () => { throw new Error("Startup must not load a transcript"); }, steerTurn: async () => null },
  })), {
    identities: threads, itemIdentities: items,
    resolveProject: async (cwd) => ({ projectId: cwd === "/other" ? "other" : "project", projectRoot: cwd }),
  });
  const document = {
    version: 4, drafts: [], newThreadProfile: null,
    records: [...(foreignThread ? [{
      entryKind: "thread", identity: { harness: "codex", threadId: "foreign-thread" },
      title: "Foreign", activityAt: 1, metadata: { archived: false, pinned: true, snoozed: false },
      lifecycle: { kind: "completed", reason: "providerInactive", settled: true },
    }] : []), ...(crossProviderChild ? [{
      entryKind: "subagent", identity: { harness: "opencode", threadId: "native-child" },
      parentThreadId: "native-thread", name: "Child", profileId: "profile", profileName: "Profile",
      cwd: "/repo", title: "Child", activityAt: 2, createdAt: 1, updatedAt: 2,
      metadata: { archived: false, pinned: false, snoozed: false }, pinned: false,
      lifecycle: { kind: "completed", reason: "providerInactive", settled: true },
    }] : []), {
      entryKind: "thread", identity: { harness: "codex", threadId: "native-thread" },
      title: "Saved", activityAt: 2,
      metadata: { archived: false, pinned: true, snoozed: false },
      lifecycle: { kind: "completed", reason: "agentCompleted", settled: false,
        agent: { agentStatus: "completed", turnId: "native-turn" } },
    }],
    displayOrder: { pinned: { "codex:native-thread": { above: foreignThread ? ["codex:foreign-thread"] : [], below: [] } } },
  };
  const state = new WorkbenchThreadStateController({
    getProjectCatalog: () => ({ data: [], rootPath: "/repo" }),
    hasLiveGitArcClaims: async () => false,
    resolveGitArc: async () => null, resolveGitArcPlan: async () => null,
    runGitArcReadTransition: async (_projectId, operation) => await operation(),
    projectState: { getCurrentUpdate: () => null, handleRequest: async () => ({}), observe: () => () => undefined },
    publish: () => undefined, reconcileProject: async () => [],
    threadStateStore: {
      readProject: async () => structuredClone(document), readTitleHistories: async () => [],
      readGlobal: async () => null, writeGlobal: async () => undefined, writeProject: async () => undefined,
    },
  });
  const owners = {
    threads, items,
    resolveThreadIdentity: (input: WorkbenchThreadIdentityLookup) => harnesses.resolveThreadIdentity(input),
    resolveTurnIdentity: (input: WorkbenchThreadIdentityLookup & { turnId: string }) => harnesses.resolveTurnIdentity(input),
  };
  return {
    requests,
    open: async () => await mapNativeThreadStateResult(owners, await state.open("client", "project")) as WorkbenchThreadStateOpenResult,
    close: async () => { await state.dispose(); threads.dispose(); items.dispose(); },
  };
}

test("cold startup publishes saved sidebar and layout with stable WB identities without reading bodies", async () => {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  installWorkbenchDatabaseSchema(database);
  let current = await fixture(database);
  try {
    const first = await current.open();
    const entry = first.sidebar.entries[0]!;
    assert.equal(entry.entryKind, "thread");
    if (entry.entryKind !== "thread") throw new Error("Saved thread disappeared");
    assert.notEqual(entry.identity.threadId, "native-thread");
    assert.equal(entry.lifecycle.kind, "completed");
    assert.ok("agent" in entry.lifecycle && entry.lifecycle.agent);
    assert.notEqual(entry.lifecycle.agent.turnId, "native-turn");
    assert.deepEqual(database.prepare("SELECT COUNT(*) AS count FROM thread_items").get(), { count: 0 });
    assert.equal(current.requests.filter(({ method }) => method === "thread/read").length, 1);
    assert.equal(current.requests.filter(({ method }) => method === "thread/turns/list").length, 1);
    await current.close();
    current = await fixture(database);
    const reopened = await current.open();
    assert.deepEqual(reopened.sidebar.entries, first.sidebar.entries);
    assert.equal(current.requests.length, 0, "Warm restart must use durable identity metadata");
    assert.deepEqual(database.pragma("foreign_key_check"), []);
  } finally { await current.close(); database.close(); }
});

test("cold startup resolves a cross-provider parent independently of the child and sidebar order", async () => {
  const database = new Database(":memory:");
  installWorkbenchDatabaseSchema(database);
  const current = await fixture(database, false, true);
  try {
    const opened = await current.open();
    const child = opened.sidebar.entries.find((entry) => entry.entryKind === "subagent");
    const parent = opened.sidebar.entries.find((entry) => entry.entryKind === "thread");
    assert.ok(child?.entryKind === "subagent");
    assert.ok(parent?.entryKind === "thread");
    assert.equal(child.parentThreadId, parent.identity.threadId);
    assert.notEqual(child.identity.threadId, parent.identity.threadId);
    assert.equal(child.identity.harness, "opencode");
    assert.equal(parent.identity.harness, "codex");
  } finally { await current.close(); database.close(); }
});

test("failed cold metadata admission leaves the saved sidebar recoverable on a later open", async () => {
  const database = new Database(":memory:");
  installWorkbenchDatabaseSchema(database);
  let current = await fixture(database, true);
  try {
    await assert.rejects(current.open(), /Metadata unavailable/);
    assert.deepEqual(database.prepare("SELECT COUNT(*) AS count FROM workbench_threads").get(), { count: 0 });
    await current.close();
    current = await fixture(database);
    assert.equal((await current.open()).sidebar.entries.length, 1);
  } finally { await current.close(); database.close(); }
});

test("stale foreign-project sidebar references do not acquire the wrong owner or block local threads", async () => {
  const database = new Database(":memory:");
  installWorkbenchDatabaseSchema(database);
  const current = await fixture(database, false, false, true);
  try {
    const opened = await current.open();
    assert.equal(opened.sidebar.entries.length, 1);
    assert.equal(opened.sidebar.entries[0]?.title, "Saved");
    assert.ok(!JSON.stringify(opened.sidebar.displayOrder).includes("foreign-thread"));
    const foreign = database.prepare("SELECT t.project_id FROM workbench_threads t JOIN workbench_pending_import_threads p ON p.thread_id = t.id WHERE p.native_thread_id = ?").get("foreign-thread");
    assert.deepEqual(foreign, { project_id: "other" });
  } finally { await current.close(); database.close(); }
});
