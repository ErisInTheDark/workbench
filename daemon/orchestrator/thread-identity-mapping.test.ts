/*
 * Keywords: identity, provider boundary, opaque content, structural admission.
 * No exports. Tests protect canonical references without rewriting provider content or reading bodies.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import Database from "better-sqlite3";
import type { Thread } from "workbench-shared/codex/generated/app-server/v2/Thread";
import { readWorkbenchTurnHistory } from "workbench-shared/codex/thread-adapter";
import type { WorkbenchThreadTurnHistoryEntry } from "workbench-shared/types";
import type { ThreadItem } from "workbench-shared/codex/generated/app-server/v2/ThreadItem";
import { getWorkbenchThreadItemIdentityKind } from "workbench-shared/workbench/thread/thread-item-identity";
import { getWorkbenchInputState } from "workbench-shared/workbench/thread/thread-input-item";
import { installWorkbenchDatabaseSchema } from "./database/workbench-database-schema";
import WorkbenchThreadIdentityRepository from "./database/thread-identity/WorkbenchThreadIdentityRepository";
import WorkbenchTranscriptIdentityRepository from "./database/transcript/WorkbenchTranscriptIdentityRepository";
import WorkbenchThreadIdentityController from "./WorkbenchThreadIdentityController";
import WorkbenchTranscriptIdentityController from "./WorkbenchTranscriptIdentityController";
import { admitProviderThreads, admitProviderThreadItems, admitProviderNotifications, mapProviderThread, mapProviderThreadItem, mapProviderTurn, mapProviderNotification } from "./thread-identity-provider-mapping";
import { withWorkbenchTurnAdmission } from "workbench-shared/workbench/thread/thread-admission";
import { admitNativeTranscriptObservations, mapNativeTranscriptObservation } from "./thread-identity-transcript-mapping";
import { mapNativeProviderResponse, mapWorkbenchProviderRequest } from "./thread-identity-workbench-mapping";
import { resolveQuestionnaireHistoryItemId } from "workbench-shared/workbench/thread/thread-questionnaire-identity";
import WorkbenchHarnessController from "./WorkbenchHarnessController";
import WorkbenchWebSocketRequestController from "./WorkbenchWebSocketRequestController";
import type { BridgeClient, JsonRpcRequest } from "./bridge-types";
import WorkbenchTranscriptRepository from "./database/transcript/WorkbenchTranscriptRepository";
import type { WorkbenchTranscriptAtomicObservation } from "./database/transcript/workbench-transcript-types";
import { OpenCodeBridge } from "./opencode-bridge";
import * as opencodeThreadState from "./opencode-thread-state";
import * as opencodeLiveThreadState from "./opencode-live-thread-state";
import type { OrchestratorReloadableModules } from "./orchestrator-runtime-objects";
import type OpenCodeAppServer from "./OpenCodeAppServer";
import type { ServerNotification } from "workbench-shared/codex/generated/app-server/ServerNotification";
import type { V2Event } from "@opencode-ai/sdk/v2";
import WorkbenchThreadGitFeature from "./WorkbenchThreadGitFeature";

async function setup(platform: NodeJS.Platform = process.platform) {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  installWorkbenchDatabaseSchema(database);
  const repository = new WorkbenchThreadIdentityRepository(database, platform);
  const itemRepository = new WorkbenchTranscriptIdentityRepository(database);
  const threads = new WorkbenchThreadIdentityController({
    listThreadIdentities: async () => repository.list(),
    observeThreadIdentities: async (inputs) => repository.observeMany(inputs),
    resolveThreadIdentity: async (input) => repository.resolve(input),
    resolveNativeThreadIdentity: async (input) => repository.resolveNative(input),
    observeTurnIdentities: async (inputs) => repository.observeTurns(inputs),
    resolveTurnIdentity: async (input) => repository.resolveTurn(input),
  }, platform);
  let admissions = 0;
  const items = new WorkbenchTranscriptIdentityController({
    admitTranscriptItemIdentities: async (input) => {
      admissions += 1;
      return itemRepository.admitMany(input);
    },
    resolveTranscriptItemIdentity: async () => { throw new Error("Unexpected projection database read"); },
  });
  const native = { harness: "codex", nativeLocation: "C:/repo", nativeThreadId: "native-parent", nativeTurnId: "native-turn" };
  const parent = await threads.observe({
    native, projectId: "project", projectRoot: "C:/repo", title: "Parent",
    createdAt: 1, updatedAt: 1, activityAt: 1,
  });
  const child = await threads.observe({
    native: { ...native, nativeThreadId: "native-child" },
    projectId: "project", projectRoot: "C:/repo", title: "Child",
    createdAt: 1, updatedAt: 1, activityAt: 1,
  });
  const turn = await threads.observeTurn({
    kind: "turn", threadId: parent.threadId, turnId: native.nativeTurnId, harnessId: native.harness,
    nativeLocation: native.nativeLocation, nativeThreadId: native.nativeThreadId, nativeTurnId: native.nativeTurnId,
    state: "inProgress", createdAt: 1, startedAt: 1, endedAt: null, durationMs: null,
  });
  return { database, owners: { threads, items }, native, parent, child, turn, admissions: () => admissions };
}

test("equivalent Windows paths preserve the admitted turn location at durable recording", async () => {
  const { database, owners, native, parent, turn } = await setup("win32");
  try {
    const observation = mapNativeTranscriptObservation(owners, { ...native, nativeLocation: "\\\\?\\C:\\REPO" }, {
      kind: "turn", threadId: native.nativeThreadId, turnId: native.nativeTurnId,
      harnessId: native.harness, nativeLocation: "\\\\?\\C:\\REPO", nativeThreadId: native.nativeThreadId,
      nativeTurnId: native.nativeTurnId, state: "completed", createdAt: 1, startedAt: 1, endedAt: 2, durationMs: 1,
    });
    assert.equal(observation.kind, "turn");
    if (observation.kind !== "turn") throw new Error("Expected a turn observation.");
    assert.equal(observation.nativeLocation, native.nativeLocation);
    assert.equal(observation.turnId, turn.turnId);
    new WorkbenchTranscriptRepository(database).settle([observation]);
    assert.equal(owners.threads.knownTurn(turn.turnId).threadId, parent.threadId);
    assert.deepEqual(database.pragma("foreign_key_check"), []);
  } finally { owners.threads.dispose(); owners.items.dispose(); database.close(); }
});

test("thread Git resolves public and native callers to the same existing selection", async () => {
  const { database, owners, native, parent } = await setup();
  const selected: string[] = [];
  const feature = new WorkbenchThreadGitFeature({
    identities: owners.threads,
    resolveProjectFromCwd: async () => ({ cwd: "C:/repo", project: { id: "project" } }),
    transitions: { run: async (_root, operation) => operation() },
    createThreadGit: async ({ threadId }) => {
      selected.push(threadId);
      return {
        repoRoot: "C:/repo",
        add: async () => ({ changedPaths: [], selectedPaths: [] }),
        unstage: async () => ({ changedPaths: [], selectedPaths: [] }),
        commit: async () => { throw new Error("Unexpected commit"); },
      };
    },
  });
  try {
    for (const threadId of [native.nativeThreadId, parent.threadId]) {
      assert.equal((await feature.executeRequest({ action: "add", cwd: "C:/repo", threadId, paths: [] })).status, 200);
    }
    assert.deepEqual(selected, [native.nativeThreadId, native.nativeThreadId]);
    assert.equal((await feature.executeRequest({ action: "add", cwd: "C:/repo", threadId: "missing", paths: [] })).status, 400);
    assert.equal(selected.length, 2);
  } finally { database.close(); }
});

test("cold native thread lookup admits exact metadata before public request routing", async () => {
  const { database, owners } = await setup();
  const requests: JsonRpcRequest[] = [];
  const harnesses = new WorkbenchHarnessController([{
    id: "codex", serverMethods: [], recovery: { kind: "none" },
    internal: { request: async (request) => {
      requests.push(request);
      return { id: request.id ?? null, result: { thread: {
        id: "unobserved", cwd: "C:/repo", createdAt: 1, updatedAt: 1,
        name: "Cold", source: "cli", parentThreadId: null, turns: [],
      } as Thread } };
    } },
    browser: { handleBrowserMessage: async () => { throw new Error("Lookup must not open a turn"); } },
    browse: { readThread: async () => { throw new Error("Lookup must not materialise history"); }, steerTurn: async () => null },
  }], {
    identities: owners.threads, itemIdentities: owners.items,
    resolveProject: async () => ({ projectId: "project", projectRoot: "C:/repo" }),
  });
  try {
    const request = { method: "thread/read", params: { threadId: "unobserved", includeTurns: false } };
    const routed = await harnesses.resolvePublicRequest("codex", request);
    const identity = await owners.threads.resolve({ threadId: "unobserved", harness: "codex" });
    assert.ok(identity);
    assert.notEqual(identity.threadId, "unobserved");
    assert.equal((routed.request.params as { threadId: string }).threadId, "unobserved");
    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.method, "thread/read");
    assert.equal((requests[0]!.params as { includeTurns: boolean }).includeTurns, false);
    await harnesses.resolvePublicRequest("codex", { ...request, params: { ...request.params, threadId: identity.threadId } });
    assert.equal(requests.length, 1);
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM thread_items").get() as { count: number }).count, 0);
  } finally { database.close(); }
});

test("OpenCode metadata and live events share admitted identity across bridge handoff", async () => {
  const { database, owners } = await setup();
  let activeOwners = owners;
  const published: ServerNotification[] = [];
  const create = (initialState?: Awaited<ReturnType<OpenCodeBridge["detachForReload"]>>) => new OpenCodeBridge({
    appServer: {} as OpenCodeAppServer,
    getReloadableModules: () => ({ opencodeThreadState, opencodeLiveThreadState }) as OrchestratorReloadableModules,
    projectRoot: "C:/repo", identities: activeOwners, initialState,
    resolveProject: async () => ({ projectId: "project", projectRoot: "C:/repo" }),
    onNotification: (notification) => published.push(mapProviderNotification(activeOwners, { harness: "opencode", nativeLocation: "C:/repo" }, notification as ServerNotification)),
  });
  let bridge = create();
  const handle = (event: V2Event) => (bridge as unknown as { handleEvent(event: V2Event): Promise<void> }).handleEvent(event);
  try {
    await handle({ type: "session.created", data: {
      sessionID: "session", info: { id: "session", directory: "C:/repo", title: "Title", version: "test", time: { created: 1_000, updated: 1_000 } },
    } } as V2Event);
    await handle({ type: "session.next.text.delta", data: {
      sessionID: "session", assistantMessageID: "message", textID: "text", timestamp: 2_000, delta: "first",
    } } as V2Event);
    const handoff = await bridge.detachForReload();
    owners.items.dispose();
    owners.threads.dispose();
    const repository = new WorkbenchThreadIdentityRepository(database);
    const itemRepository = new WorkbenchTranscriptIdentityRepository(database);
    let lookups = 0;
    activeOwners = {
      threads: new WorkbenchThreadIdentityController({
        listThreadIdentities: async () => repository.list(),
        observeThreadIdentities: async (inputs) => repository.observeMany(inputs),
        observeTurnIdentities: async (inputs) => repository.observeTurns(inputs),
        resolveThreadIdentity: async (input) => { lookups++; return repository.resolve(input); },
        resolveNativeThreadIdentity: async (input) => { lookups++; return repository.resolveNative(input); },
        resolveTurnIdentity: async (input) => { lookups++; return repository.resolveTurn(input); },
      }),
      items: new WorkbenchTranscriptIdentityController({
        admitTranscriptItemIdentities: async (inputs) => itemRepository.admitMany(inputs),
        resolveTranscriptItemIdentity: async (input) => { lookups++; return itemRepository.resolve(input); },
      }),
    };
    await activeOwners.threads.start();
    bridge = create(handoff);
    await (bridge as unknown as { restoreLiveIdentities(): Promise<void> }).restoreLiveIdentities();
    const beforeLookups = lookups;
    const before = database.prepare("SELECT total_changes() AS count").get();
    await handle({ type: "session.next.text.delta", data: {
      sessionID: "session", assistantMessageID: "message", textID: "text", timestamp: 2_001, delta: "second",
    } } as V2Event);
    assert.deepEqual(database.prepare("SELECT total_changes() AS count").get(), before);
    assert.equal(lookups, beforeLookups);
    const deltas = published.filter((event) => event.method === "item/agentMessage/delta");
    assert.deepEqual(deltas.map((event) => event.params.delta), ["first", "second"]);
    assert.equal(deltas[0]!.params.itemId, deltas[1]!.params.itemId);
    assert.equal(deltas[0]!.params.threadId, activeOwners.threads.workbenchIdForNative({ harness: "opencode", nativeLocation: "C:/repo", nativeThreadId: "session" }));
    assert.notEqual(deltas[0]!.params.itemId, "opencode:agent:message:text");
  } finally {
    await bridge.stop();
    activeOwners.items.dispose();
    activeOwners.threads.dispose();
    database.close();
  }
});

test("OpenCode identity failure reports the affected thread without publishing an unadmitted item", async () => {
  const { database, owners } = await setup();
  const published: ServerNotification[] = [];
  const bridge = new OpenCodeBridge({
    appServer: {} as OpenCodeAppServer,
    getReloadableModules: () => ({ opencodeThreadState, opencodeLiveThreadState }) as OrchestratorReloadableModules,
    projectRoot: "C:/repo", identities: owners,
    resolveProject: async () => ({ projectId: "project", projectRoot: "C:/repo" }),
    onNotification: (event) => published.push(mapProviderNotification(owners, { harness: "opencode", nativeLocation: "C:/repo" }, event as ServerNotification)),
  });
  const handle = (event: V2Event) => (bridge as unknown as { handleEvent(event: V2Event): Promise<void> }).handleEvent(event);
  try {
    await handle({ type: "session.created", data: {
      sessionID: "session", info: { id: "session", directory: "C:/repo", title: "Title", version: "test", time: { created: 1_000, updated: 1_000 } },
    } } as V2Event);
    published.length = 0;
    owners.items.admit = async () => { throw new Error("Identity write failed"); };
    await assert.rejects(handle({ type: "session.next.text.delta", data: {
      sessionID: "session", assistantMessageID: "message", textID: "text", timestamp: 2_000, delta: "first",
    } } as V2Event), /Identity write failed/u);
    assert.deepEqual(published, [{
      method: "thread/status/changed",
      params: {
        threadId: owners.threads.workbenchIdForNative({ harness: "opencode", nativeLocation: "C:/repo", nativeThreadId: "session" }),
        status: { type: "systemError" },
      },
    }]);
  } finally {
    await bridge.stop();
    owners.items.dispose();
    owners.threads.dispose();
    database.close();
  }
});

test("managed message routing preserves the steer template and rejects explicit cross-thread targets", async () => {
  const { database, owners, native, parent, child } = await setup();
  try {
    for (const threadId of [parent.threadId, native.nativeThreadId]) {
      const steerRequest = { method: "turn/steer", params: {}, workbenchPromptContext: { source: "template" } };
      const request = {
        method: "workbench/codex/message/admit",
        params: {
          threadId,
          resumeRequest: { method: "thread/resume", params: { threadId } },
          startRequest: { method: "turn/start", params: { threadId, input: [] } },
          steerRequest,
        },
      };
      const mapped = await mapWorkbenchProviderRequest(owners.threads, "codex", request);
      const params = mapped.request.params as typeof request.params;
      assert.equal(params.threadId, native.nativeThreadId);
      assert.equal(params.startRequest.params.threadId, native.nativeThreadId);
      assert.equal(params.resumeRequest.params.threadId, native.nativeThreadId);
      assert.deepEqual(params.steerRequest, steerRequest, "The admission owner supplies the active destination later");
      await assert.rejects(mapWorkbenchProviderRequest(owners.threads, "codex", {
        ...request, params: { ...request.params, steerRequest: {
          ...steerRequest, params: { threadId: child.threadId },
        } },
      }), /same thread/);
    }
  } finally { owners.items.dispose(); owners.threads.dispose(); database.close(); }
});

test("pending questionnaire lists use the same public identity as the durable sidebar", async () => {
  const { database, owners, native, parent, turn } = await setup();
  try {
    const [item] = await admitProviderThreadItems(owners, native, [{
      type: "dynamicToolCall", id: "native-question", namespace: null, tool: "request_user_input",
      arguments: {}, status: "inProgress", contentItems: null, success: null, durationMs: null,
    }]);
    const pending = {
      threadId: native.nativeThreadId, turnId: native.nativeTurnId, itemId: "native-question",
      requestKey: "opaque-request-key",
      request: { id: "request", title: "Choose", summary: "", submitLabel: "", questions: [] },
    };
    const response = await mapNativeProviderResponse(owners, "codex", { method: "questionnaire/list" }, {
      id: 1, result: { data: [pending, { ...pending, turnId: null, itemId: null }] },
    });
    const result = response.result as { data: Array<Omit<typeof pending, "turnId" | "itemId"> & { turnId: string | null; itemId: string | null }> };
    assert.deepEqual(result.data, [
      { ...pending, threadId: parent.threadId, turnId: turn.turnId, itemId: item!.id },
      { ...pending, threadId: parent.threadId, turnId: null, itemId: null },
    ]);
  } finally { owners.items.dispose(); owners.threads.dispose(); database.close(); }
});

test("repeated provider catalogues admit only new identity evidence without hiding conflicts", async () => {
  const fixture = await setup();
  const { database, owners, native, parent, turn } = fixture;
  try {
    const message: ThreadItem = { type: "userMessage", id: "native-message", content: [], clientId: null };
    const thread: Thread & { workbenchTurnHistory: WorkbenchThreadTurnHistoryEntry[] } = {
      id: native.nativeThreadId, cwd: native.nativeLocation, createdAt: 1, updatedAt: 2,
      extra: null, sessionId: "native-session", forkedFromId: null, preview: "", ephemeral: false,
      section: null, sectionEnteredAt: null, projectId: null, historyMode: "paginated",
      modelProvider: "openai", model: null, reasoningEffort: null, recencyAt: null,
      status: { type: "idle" }, path: null, cliVersion: "test", canAcceptDirectInput: null,
      threadSource: null, agentNickname: null, agentRole: null, gitInfo: null, name: null,
      source: "cli", parentThreadId: null,
      turns: [{
        id: native.nativeTurnId, items: [message], itemsView: "full", status: "completed",
        error: null, startedAt: 1, completedAt: 2, durationMs: 1,
      }],
      workbenchTurnHistory: [{
        turnId: native.nativeTurnId, loadState: "loaded", status: "completed",
        startedAt: 1, completedAt: 2, durationMs: 1, itemCount: 1, itemIds: [message.id],
      }],
    };
    const admit = () => admitProviderThreads(owners, [{
      metadata: { native, projectId: "project", projectRoot: "C:/repo", title: "Parent",
        createdAt: 1, updatedAt: 2, activityAt: 2 },
      thread,
    }]);
    await admit();
    const itemId = mapProviderThread(owners, native, thread).turns[0]!.items[0]!.id;
    const initialAdmissions = fixture.admissions();
    await admit();
    assert.equal(fixture.admissions(), initialAdmissions, "Unchanged catalogues must not queue database admission");

    message.clientId = "new-client";
    thread.workbenchTurnHistory[0]!.itemTimeline = [{
      itemId: message.id, aliases: ["retained-message"], firstSeenAt: 1, lastSeenAt: 2, startedAt: 1, completedAt: 2,
    }];
    await admit();
    const repository = new WorkbenchTranscriptIdentityRepository(database);
    for (const reference of ["new-client", "retained-message"]) {
      assert.equal(repository.resolve({ threadId: parent.threadId, turnId: turn.turnId, itemId: reference })?.itemId, itemId);
    }
    assert.equal(fixture.admissions(), initialAdmissions + 1);
    await admit();
    assert.equal(fixture.admissions(), initialAdmissions + 1);

    await owners.items.admit([{
      threadId: parent.threadId, sources: [{ turnId: turn.turnId, kind: "client", sourceId: "other-client" }],
      legacyAliases: [],
    }]);
    const otherClientId = repository.resolve({ threadId: parent.threadId, turnId: turn.turnId, itemId: "other-client" })!.itemId;
    message.clientId = "other-client";
    await admit();
    assert.equal(mapProviderThread(owners, native, thread).turns[0]!.items[0]!.id, itemId);
    assert.equal(repository.resolve({ threadId: parent.threadId, turnId: turn.turnId, itemId: "other-client" })?.itemId, otherClientId);
    assert.equal(repository.resolve({ threadId: parent.threadId, turnId: turn.turnId, itemId: "new-client" })?.itemId, itemId);
    assert.deepEqual(database.pragma("foreign_key_check"), []);
  } finally { owners.items.dispose(); owners.threads.dispose(); database.close(); }
});

for (const route of ["catalogue", "event", "recorder"] as const) {
  test(`correlated user identity refreshes warm projection references through ${route} admission`, async (context) => {
    const fixture = await setup();
    const { database, owners, native, parent, turn } = fixture;
    const warnings = context.mock.method(console, "warn", () => undefined);
    try {
      const message: ThreadItem = { type: "userMessage", id: "native-message", clientId: "submitted",
        content: [{ type: "text", text: "preserve my input", text_elements: [] }] };
      const [structural, recorded] = await owners.items.admit([
        { threadId: parent.threadId, sources: [{ turnId: turn.turnId, kind: "stable", sourceId: message.id }], legacyAliases: [] },
        { threadId: parent.threadId, sources: [
          { turnId: turn.turnId, kind: "provisional", sourceId: "item-1" },
          { turnId: turn.turnId, kind: "client", sourceId: message.clientId! },
        ], legacyAliases: [] },
      ]);
      const repository = new WorkbenchTranscriptRepository(database);
      repository.settle([{
        kind: "turn", threadId: parent.threadId, turnId: turn.turnId, harnessId: native.harness,
        nativeLocation: native.nativeLocation, nativeThreadId: native.nativeThreadId, nativeTurnId: native.nativeTurnId,
        state: "completed", createdAt: 1, startedAt: 1, endedAt: 2, durationMs: 1,
      }, {
        kind: "item", threadId: parent.threadId, turnId: turn.turnId, publicItemId: recorded!.itemId,
        lifecycle: "completed", observedAt: 3, item: { ...message, id: "item-1" },
      }]);
      const before = database.prepare("SELECT * FROM thread_items").all();
      const event = { method: "item/completed" as const, params: {
        threadId: native.nativeThreadId, turnId: native.nativeTurnId, item: message, completedAtMs: 2_000,
      } };
      const observation: WorkbenchTranscriptAtomicObservation = {
        kind: "item", threadId: native.nativeThreadId, turnId: native.nativeTurnId,
        lifecycle: "completed", observedAt: 3, item: message,
      };
      const thread: Thread = {
        id: native.nativeThreadId, cwd: native.nativeLocation, createdAt: 1, updatedAt: 2,
        extra: null, sessionId: "native-session", forkedFromId: null, preview: "", ephemeral: false,
        section: null, sectionEnteredAt: null, projectId: null, historyMode: "paginated",
        modelProvider: "openai", model: null, reasoningEffort: null, recencyAt: null,
        status: { type: "idle" }, path: null, cliVersion: "test", canAcceptDirectInput: null,
        threadSource: null, agentNickname: null, agentRole: null, gitInfo: null, name: null,
        source: "cli", parentThreadId: null,
        turns: [{ id: native.nativeTurnId, items: [message], itemsView: "full", status: "completed",
          error: null, startedAt: 1, completedAt: 2, durationMs: 1 }],
      };
      const admit = () => route === "catalogue"
        ? admitProviderThreads(owners, [{ thread, metadata: {
          native, projectId: "project", projectRoot: "C:/repo", title: "Parent",
          createdAt: 1, updatedAt: 2, activityAt: 2,
        } }])
        : route === "event" ? admitProviderNotifications(owners, native, [event])
          : admitNativeTranscriptObservations(owners, [observation]);
      await admit();
      const admissions = fixture.admissions();
      await admit();
      assert.equal(fixture.admissions(), admissions, "The repaired evidence must stop scheduling duplicate admission.");
      for (const reference of [structural!.itemId, recorded!.itemId, message.id, message.clientId!, "item-1"]) {
        assert.equal(owners.items.itemIdForReference(parent.threadId, turn.turnId, reference), recorded!.itemId);
      }
      assert.equal(mapProviderThread(owners, native, thread).turns[0]!.items[0]!.id, recorded!.itemId);
      const mappedEvent = mapProviderNotification(owners, native, event);
      assert.equal(mappedEvent.method, "item/completed");
      if (mappedEvent.method === "item/completed") assert.equal(mappedEvent.params.item.id, recorded!.itemId);
      const mappedObservation = mapNativeTranscriptObservation(owners, native, observation);
      assert.equal(mappedObservation.kind, "item");
      if (mappedObservation.kind === "item") assert.equal(mappedObservation.publicItemId, recorded!.itemId);
      assert.deepEqual(database.prepare("SELECT * FROM thread_items").all(), before);
      assert.deepEqual(database.pragma("foreign_key_check"), []);
      assert.equal(warnings.mock.callCount(), 0);
    } finally { owners.items.dispose(); owners.threads.dispose(); database.close(); }
  });
}

test("provider event batches admit starts before deltas without storing pending turns", async () => {
  const { database, owners, native, parent } = await setup();
  try {
    const pending = withWorkbenchTurnAdmission({
      id: "3201f023-7830-4daf-a77b-23535c40b84b",
      items: [], status: "inProgress" as const, itemsView: "full" as const,
      error: null, startedAt: 1, completedAt: null, durationMs: null,
    }, "providerPending");
    const pendingEvent = { method: "turn/started" as const, params: { threadId: native.nativeThreadId, turn: pending } };
    await admitProviderNotifications(owners, native, [pendingEvent]);
    assert.equal((mapProviderNotification(owners, native, pendingEvent).params as { threadId: string }).threadId, parent.threadId);
    assert.equal(mapProviderTurn(owners, native, pending).id, pending.id);
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM thread_turns WHERE id = ?").get(pending.id) as { count: number }).count, 0);
    const metadata = {
      id: native.nativeThreadId, cwd: native.nativeLocation, name: "Parent",
      createdAt: 1, updatedAt: 1, parentThreadId: null, source: "cli", turns: [pending],
    } as Thread;
    const snapshot = { ...metadata,
      workbenchTurnHistory: [{
        turnId: pending.id, status: pending.status, startedAt: 1, completedAt: null,
        durationMs: null, itemCount: 0, loadState: "loaded",
      }],
    };
    await admitProviderThreads(owners, [{
      metadata: { native, projectId: "project", projectRoot: "C:/repo", title: "Parent", createdAt: 1, updatedAt: 1, activityAt: 1 },
      thread: snapshot,
    }]);
    assert.equal(await owners.threads.resolveTurn({ threadId: parent.threadId, turnId: pending.id }), null);
    assert.deepEqual(readWorkbenchTurnHistory(mapProviderThread(owners, native, snapshot)), []);
    assert.equal(mapProviderThread(owners, native, snapshot).turns[0], pending);
    const turn = { ...pending, id: "next-native-turn", workbenchAdmission: "admitted" as const };
    const item: ThreadItem = { id: "first-reasoning", type: "reasoning", summary: [], content: [] };
    const events = [
      { method: "turn/started" as const, params: { threadId: native.nativeThreadId, turn } },
      { method: "item/started" as const, params: { threadId: native.nativeThreadId, turnId: turn.id, item, startedAtMs: 1_000 } },
      { method: "item/reasoning/textDelta" as const, params: { threadId: native.nativeThreadId, turnId: turn.id, itemId: item.id, delta: "first", contentIndex: 0 } },
    ];
    await admitProviderNotifications(owners, native, events);
    const mapped = events.map((event) => mapProviderNotification(owners, native, event));
    assert.equal((mapped[0]!.params as { threadId: string }).threadId, parent.threadId);
    assert.equal((mapped[1]!.params as { item: ThreadItem }).item.id, (mapped[2]!.params as { itemId: string }).itemId);
    const writes = database.prepare("SELECT total_changes() AS count").get();
    await admitProviderNotifications(owners, native, [events[2]!]);
    assert.deepEqual(database.prepare("SELECT total_changes() AS count").get(), writes);
  } finally {
    owners.items.dispose();
    owners.threads.dispose();
    database.close();
  }
});

test("public socket routing and reload handoff retain native request correlation and canonical live identity", async () => {
  const fixture = await setup();
  const { owners, native, parent, turn } = fixture;
  const emitted: Array<Record<string, unknown>> = [];
  let requested: JsonRpcRequest | undefined;
  const recoveryRequests: JsonRpcRequest[] = [];
  const client: BridgeClient = {
    OPEN: 1, readyState: 1, close() {}, on() {}, once() {},
    send(data, callback) { emitted.push(JSON.parse(String(data))); callback?.(); },
  };
  const harnesses = new WorkbenchHarnessController([{
    id: "codex", serverMethods: [],
    recovery: { kind: "observe", observeNotification() {}, observeRequest(request) { recoveryRequests.push(request); } },
    internal: { request: async () => { throw new Error("Public request changed its send owner"); } },
    browse: {
      readThread: async () => { throw new Error("Unexpected Browse read"); },
      steerTurn: async () => { throw new Error("Unexpected Browse steer"); },
    },
    browser: { handleBrowserMessage: async (request, originalClient) => {
      assert.equal(originalClient, client);
      requested = request;
    } },
  }], { identities: owners.threads, itemIdentities: owners.items });
  const create = (initialState?: ReturnType<WorkbenchWebSocketRequestController["detachForReload"]>) => (
    new WorkbenchWebSocketRequestController({
      harnesses, identities: owners, initialState,
      setTimeout: () => 0 as unknown as ReturnType<typeof setTimeout>, clearTimeout() {},
      reload: { getReloadDirtSnapshot: () => ({ dirtyScopes: [], error: null, pendingScopes: [] }), subscribeReloadDirt: () => () => {} },
      threadState: { acceptIntent: async () => ({ accepted: true, revision: 0 }), disconnect: async () => {},
        handleRequest: async () => { throw new Error("Unexpected thread state request"); } },
      transcript: { read: async () => { throw new Error("Unexpected transcript read"); }, subscribe: async () => {}, unsubscribe() {} },
      writeLine() {},
    })
  );
  let controller = create();
  try {
    const item: ThreadItem = { type: "reasoning", id: "native-reasoning", summary: ["title"], content: [] };
    const [admitted] = await admitProviderThreadItems(owners, native, [item]);
    await controller.handleMessage(client, "socket", Buffer.from(JSON.stringify({
      id: 7, method: "turn/start", params: { threadId: parent.threadId, input: [{ type: "text", text: parent.threadId }] },
    })), false);
    assert.equal((requested?.params as { threadId: string }).threadId, native.nativeThreadId);
    assert.deepEqual(recoveryRequests, [requested]);
    assert.deepEqual((requested?.params as { input: unknown }).input, [{ type: "text", text: parent.threadId }]);
    controller = create(controller.detachForReload());
    await controller.sendJsonToClient(client, { id: 7, result: { turn: {
      id: native.nativeTurnId, items: [item], status: "inProgress", itemsView: "full",
      error: null, startedAt: 1, completedAt: null, durationMs: null,
    } } });
    const response = emitted.find((message) => message.id === 7) as { result: { turn: { id: string; items: ThreadItem[] } } } | undefined;
    assert.equal(response?.result.turn.id, turn.turnId);
    assert.equal(response?.result.turn.items[0]?.id, admitted!.id);
    await controller.sendJsonToClient(client, { workbenchHarness: "codex", method: "item/reasoning/textDelta",
      params: { threadId: native.nativeThreadId, turnId: native.nativeTurnId, itemId: item.id, delta: "native-parent is text" } });
    const event = emitted.find((message) => message.method === "item/reasoning/textDelta");
    assert.deepEqual(event?.params, { threadId: parent.threadId, turnId: turn.turnId, itemId: admitted!.id, delta: "native-parent is text" });
    await controller.sendJsonToClient(client, { method: "workbench/thread-state/updated", params: {
      projectId: "project", revision: 1, error: null, freshness: "fresh",
      entries: [{
        entryKind: "thread", activityAt: 1, title: native.nativeThreadId,
        identity: { harness: "codex", threadId: native.nativeThreadId },
        metadata: { archived: false, pinned: true, snoozed: false },
        lifecycle: { kind: "working", reason: "acceptedIntent", settled: false,
          agent: { agentStatus: "working", turnId: native.nativeTurnId } },
      }],
      displayOrder: { pinned: { [`codex:${native.nativeThreadId}`]: { above: [], below: [] } } },
    } });
    const sidebar = emitted.find((message) => message.method === "workbench/thread-state/updated")?.params as {
      entries: Array<{ identity: { threadId: string }; lifecycle: { agent: { turnId: string } }; title: string }>;
      displayOrder: { pinned: Record<string, object> };
    };
    assert.equal(sidebar.entries[0]?.identity.threadId, parent.threadId);
    assert.equal(sidebar.entries[0]?.lifecycle.agent.turnId, turn.turnId);
    assert.equal(sidebar.entries[0]?.title, native.nativeThreadId);
    assert.deepEqual(Object.keys(sidebar.displayOrder.pinned), [`codex:${parent.threadId}`]);
    await controller.handleMessage(client, "socket", Buffer.from(JSON.stringify({
      id: 8, method: "turn/start", params: { threadId: parent.threadId, input: [] },
    })), false);
    await controller.sendJsonToClient(client, { id: 8, result: { turn: {
      id: "unadmitted-turn", items: [], status: "inProgress", itemsView: "full",
      error: null, startedAt: 1, completedAt: null, durationMs: null,
    } } });
    assert.equal((emitted.find((message) => message.id === 8)?.error as { code?: number })?.code, -32000);
    assert.deepEqual(controller.detachForReload().pending, []);
  } finally {
    controller.dispose();
    owners.items.dispose();
    owners.threads.dispose();
    fixture.database.close();
  }
});

test("provider item admission preserves opaque content and enables synchronous projection", async () => {
  const fixture = await setup();
  try {
    const { owners, native, parent, turn, database } = fixture;
    const source: ThreadItem[] = [
      { type: "reasoning", id: "item-1", summary: ["native-parent"], content: ["native-turn"] },
      { type: "userMessage", id: "native-message", clientId: "client-id", content: [
        { type: "text", text: "native-parent native-turn item-1", text_elements: [] },
      ] },
      { type: "dynamicToolCall", id: "native-tool", namespace: null, tool: "inspect",
        arguments: { threadId: "native-parent", itemId: "native-message" },
        status: "completed", contentItems: null, success: true, durationMs: null },
      { type: "userMessage", id: "workbench:steer-history:failed:native-parent:request",
        clientId: null, content: [{ type: "text", text: "retained steer", text_elements: [] }] },
    ];
    assert.throws(() => mapProviderThreadItem(owners, native, source[0]!), /not been admitted/iu);
    const projected = await admitProviderThreadItems(owners, native, source);
    assert.equal(fixture.admissions(), 1);
    assert.equal(new Set(projected.map((item) => item.id)).size, source.length);
    for (const [index, item] of projected.entries()) {
      assert.notEqual(item.id, source[index]!.id);
      assert.deepEqual(mapProviderThreadItem(owners, native, source[index]!), item);
    }
    assert.equal(getWorkbenchThreadItemIdentityKind(projected[0]!), "provisional");
    assert.deepEqual(getWorkbenchInputState(projected[3]!), { kind: "steer", status: "failed" });
    assert.deepEqual((projected[1] as Extract<ThreadItem, { type: "userMessage" }>).content,
      (source[1] as Extract<ThreadItem, { type: "userMessage" }>).content);
    assert.deepEqual((projected[2] as Extract<ThreadItem, { type: "dynamicToolCall" }>).arguments,
      (source[2] as Extract<ThreadItem, { type: "dynamicToolCall" }>).arguments);
    assert.equal(owners.items.itemIdForSource(parent.threadId, {
      turnId: turn.turnId, kind: "client", sourceId: "client-id",
    }), projected[1]!.id);
    assert.deepEqual(await admitProviderThreadItems(owners, native, source), projected);
    assert.deepEqual(database.prepare("SELECT id FROM thread_items").all(), []);
  } finally {
    fixture.owners.items.dispose();
    fixture.owners.threads.dispose();
    fixture.database.close();
  }
});

test("provider relationship references map without rewriting prompts or hiding unresolved targets", async () => {
  const fixture = await setup();
  try {
    const { owners, native, parent, child } = fixture;
    const item: ThreadItem = {
      type: "collabAgentToolCall", id: "native-collab", tool: "spawnAgent", status: "completed",
      senderThreadId: native.nativeThreadId, receiverThreadIds: ["native-child"],
      prompt: "tell native-child about native-parent", model: null, reasoningEffort: null,
      agentsStates: { "native-child": { status: "completed", message: "native-parent" } },
    };
    const [mapped] = await admitProviderThreadItems(owners, native, [item]);
    assert.equal(mapped?.type, "collabAgentToolCall");
    if (mapped?.type !== "collabAgentToolCall") throw new Error("Expected collaboration item");
    assert.equal(mapped.senderThreadId, parent.threadId);
    assert.deepEqual(mapped.receiverThreadIds, [child.threadId]);
    assert.deepEqual(mapped.agentsStates, { [child.threadId]: item.agentsStates["native-child"] });
    assert.equal(mapped.prompt, item.prompt);
    const elsewhere = await owners.threads.observe({
      native: { harness: "codex", nativeLocation: "C:/another-worktree", nativeThreadId: "remote-child" },
      projectId: "project", projectRoot: "C:/another-worktree", title: "Remote child", createdAt: 1, updatedAt: 1, activityAt: 1,
    });
    const crossDirectory = mapProviderThreadItem(owners, native, { ...item, receiverThreadIds: ["remote-child"] });
    assert.equal(crossDirectory.type, "collabAgentToolCall");
    if (crossDirectory.type !== "collabAgentToolCall") throw new Error("Expected collaboration item");
    assert.deepEqual(crossDirectory.receiverThreadIds, [elsewhere.threadId]);
    assert.throws(() => mapProviderThreadItem(owners, native, {
      ...item, receiverThreadIds: ["unobserved-child"],
    }), /not been admitted/iu);
  } finally {
    fixture.owners.items.dispose();
    fixture.owners.threads.dispose();
    fixture.database.close();
  }
});

test("turn snapshots and consecutive deltas share committed item identity without new admission", async () => {
  const fixture = await setup();
  try {
    const { owners, native, parent, turn } = fixture;
    const item: ThreadItem = { type: "reasoning", id: "item-1", summary: [], content: [] };
    const [mapped] = await admitProviderThreadItems(owners, native, [item]);
    const nativeTurn = {
      id: native.nativeTurnId, items: [item], itemsView: "full" as const,
      status: "inProgress" as const, error: null, startedAt: 1, completedAt: null, durationMs: null,
    };
    const projectedTurn = mapProviderTurn(owners, native, nativeTurn);
    assert.equal(projectedTurn.id, turn.turnId);
    assert.equal(projectedTurn.items[0]?.id, mapped!.id);
    const delta = (text: string) => ({
      method: "item/reasoning/summaryTextDelta" as const,
      params: { threadId: native.nativeThreadId, turnId: native.nativeTurnId,
        itemId: item.id, summaryIndex: 0, delta: text },
    });
    const text = ["native-parent", " native-turn", " item-1"];
    for (const chunk of text) {
      assert.deepEqual(mapProviderNotification(owners, native, delta(chunk)), {
        method: "item/reasoning/summaryTextDelta",
        params: { threadId: parent.threadId, turnId: turn.turnId, itemId: mapped!.id, summaryIndex: 0, delta: chunk },
      });
    }
    assert.deepEqual(mapProviderNotification(owners, native, {
      method: "turn/started", params: { threadId: native.nativeThreadId, turn: nativeTurn },
    }), { method: "turn/started", params: { threadId: parent.threadId, turn: projectedTurn } });
    for (const notification of [
      { method: "item/started" as const, params: { threadId: native.nativeThreadId, turnId: native.nativeTurnId, item, startedAtMs: 1 } },
      { method: "item/completed" as const, params: { threadId: native.nativeThreadId, turnId: native.nativeTurnId, item, completedAtMs: 2 } },
    ]) {
      assert.deepEqual(mapProviderNotification(owners, native, notification), {
        ...notification, params: { ...notification.params, threadId: parent.threadId, turnId: turn.turnId, item: mapped },
      });
    }
    assert.deepEqual(mapProviderNotification(owners, native, {
      method: "serverRequest/resolved", params: { threadId: native.nativeThreadId, requestId: native.nativeTurnId },
    }), { method: "serverRequest/resolved", params: { threadId: parent.threadId, requestId: native.nativeTurnId } });
    assert.deepEqual(mapProviderNotification(owners, native, {
      method: "turn/moderationMetadata",
      params: { threadId: native.nativeThreadId, turnId: native.nativeTurnId, metadata: { itemId: item.id } },
    }), { method: "turn/moderationMetadata",
      params: { threadId: parent.threadId, turnId: turn.turnId, metadata: { itemId: item.id } } });
    assert.equal(fixture.admissions(), 1);
    assert.equal(nativeTurn.items[0]?.id, item.id);
    assert.throws(() => mapProviderNotification(owners, native, {
      ...delta("later"), params: { ...delta("later").params, itemId: "unadmitted" },
    }), /not been admitted/iu);
  } finally {
    fixture.owners.items.dispose();
    fixture.owners.threads.dispose();
    fixture.database.close();
  }
});

test("thread metadata maps known parents without admitting unsupported fork ancestry", async () => {
  const fixture = await setup();
  try {
    const { owners, native, parent, child } = fixture;
    const thread: Thread = {
      id: "native-child", extra: null, sessionId: "native-session", forkedFromId: "unobserved-fork",
      parentThreadId: native.nativeThreadId, preview: "native-parent", ephemeral: false,
      section: null, sectionEnteredAt: null, projectId: null, historyMode: "paginated",
      modelProvider: "openai", model: null, reasoningEffort: null, createdAt: 1, updatedAt: 1, recencyAt: null,
      status: { type: "idle" }, path: null, cwd: "C:/repo", cliVersion: "test", canAcceptDirectInput: null,
      source: { subAgent: { thread_spawn: { parent_thread_id: native.nativeThreadId,
        depth: 1, agent_path: null, agent_nickname: null, agent_role: null } } },
      threadSource: null, agentNickname: null, agentRole: null, gitInfo: null, name: null, turns: [],
    };
    const mapped = mapProviderNotification(owners, native, { method: "thread/started", params: { thread } });
    assert.equal(mapped.method, "thread/started");
    if (mapped.method !== "thread/started") throw new Error("Expected thread metadata");
    assert.equal(mapped.params.thread.id, child.threadId);
    assert.equal(mapped.params.thread.parentThreadId, parent.threadId);
    assert.equal(mapped.params.thread.forkedFromId, null);
    assert.deepEqual(mapped.params.thread.source, { subAgent: { thread_spawn: {
      parent_thread_id: parent.threadId, depth: 1, agent_path: null, agent_nickname: null, agent_role: null,
    } } });
    assert.equal(mapped.params.thread.preview, thread.preview);
    assert.equal(thread.parentThreadId, native.nativeThreadId);
    assert.equal(fixture.admissions(), 0);
    const childNative = { ...native, nativeThreadId: "native-child", nativeTurnId: "child-turn" };
    const childTurn = await owners.threads.observeTurn({
      kind: "turn", threadId: child.threadId, turnId: childNative.nativeTurnId,
      nativeThreadId: childNative.nativeThreadId, nativeTurnId: childNative.nativeTurnId,
      harnessId: native.harness, nativeLocation: native.nativeLocation,
      state: "completed", createdAt: 1, startedAt: 1, endedAt: 2, durationMs: 1,
    });
    const [childItem] = await admitProviderThreadItems(owners, childNative, [
      { type: "reasoning", id: "child-reasoning", summary: ["keep title"], content: [] },
    ]);
    const history: WorkbenchThreadTurnHistoryEntry[] = [{
      turnId: childNative.nativeTurnId, loadState: "loaded", itemCount: 1, itemIds: ["child-reasoning"],
      itemTimeline: [{ itemId: "child-reasoning", firstSeenAt: 1, lastSeenAt: 2, startedAt: 1, completedAt: 2 }],
      startedAt: 1, completedAt: 2, durationMs: 1, status: "completed",
    }];
    const withHistory = mapProviderNotification(owners, native, {
      method: "thread/started", params: { thread: { ...thread, workbenchTurnHistory: history } as Thread },
    });
    if (withHistory.method !== "thread/started") throw new Error("Expected thread metadata");
    assert.deepEqual(readWorkbenchTurnHistory(withHistory.params.thread), [{
      ...history[0], turnId: childTurn.turnId, itemIds: [childItem!.id],
      itemTimeline: [{ ...history[0]!.itemTimeline![0], itemId: childItem!.id }],
    }]);
  } finally {
    fixture.owners.items.dispose();
    fixture.owners.threads.dispose();
    fixture.database.close();
  }
});

test("public request routing resolves thread and turn aliases without touching input or prefix context", async () => {
  const fixture = await setup();
  try {
    const { owners, native, parent, turn, child } = fixture;
    const input = [{ type: "text", text: parent.threadId, text_elements: [] }];
    const request = {
      id: "caller-correlation", method: "turn/steer",
      params: { threadId: parent.threadId, expectedTurnId: turn.turnId, input },
      workbenchPromptContext: { threadId: parent.threadId, prefix: "leave these instructions alone" },
    };
    const routed = await mapWorkbenchProviderRequest(owners.threads, "codex", request);
    assert.deepEqual(routed, { harness: "codex", request: {
      ...request, params: { ...request.params, threadId: native.nativeThreadId, expectedTurnId: native.nativeTurnId },
    } });
    assert.equal(routed.request.params && (routed.request.params as typeof request.params).input, input);
    assert.equal(request.params.threadId, parent.threadId);
    assert.deepEqual(await mapWorkbenchProviderRequest(owners.threads, "codex", {
      ...request, params: { ...request.params, threadId: native.nativeThreadId, expectedTurnId: native.nativeTurnId },
    }), routed);
    await assert.rejects(mapWorkbenchProviderRequest(owners.threads, "codex", {
      ...request, params: { ...request.params, threadId: child.threadId },
    }), /turn.*thread/iu);
    await assert.rejects(mapWorkbenchProviderRequest(owners.threads, "codex", {
      ...request, params: { ...request.params, threadId: "unobserved" },
    }), /thread.*not.*observed/iu);
    const initialise = { id: 1, method: "initialize", params: { clientInfo: { name: "test" } } };
    assert.equal((await mapWorkbenchProviderRequest(owners.threads, "codex", initialise)).request, initialise);
    const admission = {
      id: 2, method: "workbench/codex/message/admit",
      params: { threadId: parent.threadId,
        resumeRequest: { method: "thread/resume", params: { threadId: parent.threadId, baseInstructions: "keep the prefix" } },
        startRequest: { method: "turn/start", params: { threadId: parent.threadId, input } },
        steerRequest: request,
      },
    };
    assert.deepEqual(await mapWorkbenchProviderRequest(owners.threads, "codex", admission), {
      harness: "codex", request: { ...admission, params: {
        threadId: native.nativeThreadId,
        resumeRequest: { method: "thread/resume", params: { threadId: native.nativeThreadId, baseInstructions: "keep the prefix" } },
        startRequest: { method: "turn/start", params: { threadId: native.nativeThreadId, input } },
        steerRequest: routed.request,
      } },
    });
    await assert.rejects(mapWorkbenchProviderRequest(owners.threads, "codex", {
      ...admission, params: { ...admission.params, startRequest: {
        ...admission.params.startRequest, params: { threadId: child.threadId, input },
      } },
    }), /admission.*thread/iu);
    const page = { id: 3, method: "workbench/thread/page/read", params: { threadId: parent.threadId, cursor: turn.turnId } };
    assert.deepEqual(await mapWorkbenchProviderRequest(owners.threads, "codex", page), {
      harness: "codex", request: { ...page, params: { threadId: native.nativeThreadId, cursor: native.nativeTurnId } },
    });
    const nativePage = { ...page, method: "thread/turns/list", params: { ...page.params, cursor: "opaque-provider-cursor" } };
    assert.deepEqual(await mapWorkbenchProviderRequest(owners.threads, "codex", nativePage), {
      harness: "codex", request: { ...nativePage, params: { threadId: native.nativeThreadId, cursor: "opaque-provider-cursor" } },
    });
  } finally {
    fixture.owners.items.dispose();
    fixture.owners.threads.dispose();
    fixture.database.close();
  }
});

for (const deliveryFirst of [true, false]) {
  test(`queued steer identity does not compete with delivered message identity (delivery first: ${deliveryFirst})`, async () => {
    const { database, owners, native, parent, turn } = await setup();
    try {
      const pending = {
        threadId: native.nativeThreadId, turnId: native.nativeTurnId, itemId: randomUUID(),
        entryKey: "queued-steer", input: [{ type: "text" as const, text: "continue", text_elements: [] }],
        status: "pending" as const, attemptedAt: 1, resolvedAt: null, requestId: "request",
        clientUserMessageId: randomUUID(), canonicalItemId: null, error: null,
      };
      await admitNativeTranscriptObservations(owners, [{ kind: "steer", entry: pending, observedAt: 1 }]);
      const source: ThreadItem = {
        type: "userMessage", id: "item-42", clientId: pending.clientUserMessageId, content: pending.input,
      };
      const sent = { ...pending, status: "sent" as const, canonicalItemId: source.id, resolvedAt: 2 };
      if (deliveryFirst) await admitProviderThreadItems(owners, native, [source]);
      await admitNativeTranscriptObservations(owners, [{ kind: "steer", entry: sent, observedAt: 2 }]);
      const [delivered] = await admitProviderThreadItems(owners, native, [source]);
      for (let iteration = 0; iteration < 2; iteration += 1) {
        await admitNativeTranscriptObservations(owners, [{ kind: "steer", entry: sent, observedAt: 2 }]);
        const mapped = mapNativeTranscriptObservation(owners, native, { kind: "steer", entry: sent, observedAt: 2 });
        assert.equal(mapped.kind, "steer");
        if (mapped.kind !== "steer") throw new Error("Expected steer.");
        assert.equal(mapped.publicItemId, delivered!.id);
        assert.equal(mapped.entry.itemId, delivered!.id);
        assert.equal(mapped.entry.canonicalItemId, delivered!.id);
      }
      for (const status of ["failed", "interrupted"] as const) {
        const attempt = { ...pending, status, resolvedAt: 2 };
        await admitNativeTranscriptObservations(owners, [{ kind: "steer", entry: attempt, observedAt: 2 }]);
        const mapped = mapNativeTranscriptObservation(owners, native, {
          kind: "steer", entry: attempt, observedAt: 2,
        });
        if (mapped.kind !== "steer") throw new Error("Expected steer.");
        assert.equal(mapped.publicItemId, pending.itemId);
      }
      assert.equal(owners.items.itemIdForReference(parent.threadId, turn.turnId, pending.itemId), pending.itemId);
      assert.deepEqual(database.pragma("foreign_key_check"), []);
    } finally { owners.items.dispose(); owners.threads.dispose(); database.close(); }
  });
}

for (const evidence of ["provisional", "retained-collision", "client-only"] as const) {
  test(`sent steer page context reuses its admitted message (${evidence})`, async () => {
    const { database, owners, native, parent, turn } = await setup();
    try {
      const source: ThreadItem = {
        type: "userMessage", id: evidence === "client-only" ? "native-message" : "item-42",
        clientId: "submitted-client", content: [{ type: "text", text: "submitted", text_elements: [] }],
      };
      const [message] = await admitProviderThreadItems(owners, native, [source]);
      let retainedWrongId: string | undefined;
      if (evidence === "retained-collision") {
        const [wrong] = await owners.items.admit([{
          threadId: parent.threadId,
          sources: [{ turnId: turn.turnId, kind: "stable", sourceId: source.id }],
          legacyAliases: [],
        }]);
        retainedWrongId = wrong!.itemId;
        assert.notEqual(retainedWrongId, message!.id);
      }
      const entry = {
        threadId: native.nativeThreadId, turnId: native.nativeTurnId,
        entryKey: "submitted-steer", input: source.content, status: "sent" as const,
        attemptedAt: 1, resolvedAt: 2, requestId: "request",
        clientUserMessageId: source.clientId,
        canonicalItemId: evidence === "client-only" ? null : source.id,
        error: null,
      };
      const failed = { ...entry, entryKey: "interrupted-steer", status: "interrupted" as const, canonicalItemId: null };
      await admitNativeTranscriptObservations(owners, [entry, failed].map((entry) => ({
        kind: "steer", entry, observedAt: 2,
      })));
      const providerThread: Thread & { workbenchTurnHistory: WorkbenchThreadTurnHistoryEntry[] } = {
        id: native.nativeThreadId, cwd: native.nativeLocation, createdAt: 1, updatedAt: 2,
        extra: null, sessionId: "native-session", forkedFromId: null, preview: "", ephemeral: false,
        section: null, sectionEnteredAt: null, projectId: null, historyMode: "paginated",
        modelProvider: "openai", model: null, reasoningEffort: null, recencyAt: null,
        status: { type: "idle" }, path: null, cliVersion: "test", canAcceptDirectInput: null,
        threadSource: null, agentNickname: null, agentRole: null, gitInfo: null, name: null,
        source: "cli", parentThreadId: null,
        turns: [{
          id: native.nativeTurnId, items: [source], itemsView: "full", status: "completed",
          error: null, startedAt: 1, completedAt: 2, durationMs: 1,
        }],
        workbenchTurnHistory: [{
          turnId: native.nativeTurnId, loadState: "loaded", status: "completed",
          startedAt: 1, completedAt: 2, durationMs: 1, itemCount: 1, itemIds: [source.id],
          itemTimeline: [{ itemId: source.id, firstSeenAt: 1, lastSeenAt: 2, startedAt: 1, completedAt: 2 }],
        }],
      };
      const response = await mapNativeProviderResponse(owners, "codex", {
        method: "workbench/thread/page/read", params: { threadId: native.nativeThreadId, cursor: null },
      }, { id: 1, result: { thread: providerThread, steerEntries: [entry, failed], questionnaireEntries: [], browseResultEntries: [] } });
      const result = response.result as { thread: Thread; steerEntries: Array<{ itemId: string; canonicalItemId: string | null }> };
      assert.equal(result.steerEntries[0]!.itemId, message!.id);
      assert.deepEqual(readWorkbenchTurnHistory(result.thread)![0]!.itemIds, [message!.id]);
      assert.equal(result.steerEntries[0]!.canonicalItemId, entry.canonicalItemId === null ? null : message!.id);
      assert.notEqual(result.steerEntries[1]!.itemId, message!.id, "Unsent history remains a separate durable fact");
      if (retainedWrongId) {
        assert.ok(database.prepare("SELECT id FROM workbench_transcript_item_identities WHERE id = ?").get(retainedWrongId),
          "Projection must not delete unrelated identity rows to hide the collision");
      }
      await admitNativeTranscriptObservations(owners, [{ kind: "steer", entry, observedAt: 2 }]);
      assert.equal(mapNativeTranscriptObservation(owners, native, { kind: "steer", entry, observedAt: 2 }).kind, "steer");
      assert.deepEqual(new Set((database.prepare("SELECT id FROM workbench_transcript_item_identities").all() as Array<{ id: string }>).map(({ id }) => id)),
        new Set([message!.id, result.steerEntries[1]!.itemId, ...(retainedWrongId ? [retainedWrongId] : [])]));
    } finally { owners.items.dispose(); owners.threads.dispose(); database.close(); }
  });
}

test("live provisional references retain their source kind when another identity shares the spelling", async () => {
  const { database, owners, native, parent, turn } = await setup();
  try {
    const item: ThreadItem = { type: "reasoning", id: "item-1", summary: [], content: [] };
    const [message] = await admitProviderThreadItems(owners, native, [item]);
    await owners.items.admit([{
      threadId: parent.threadId, sources: [{ turnId: turn.turnId, kind: "stable", sourceId: item.id }], legacyAliases: [],
    }]);
    const event = mapProviderNotification(owners, native, {
      method: "item/reasoning/summaryTextDelta",
      params: { threadId: native.nativeThreadId, turnId: native.nativeTurnId, itemId: item.id, summaryIndex: 0, delta: "live" },
    });
    assert.equal(event.method, "item/reasoning/summaryTextDelta");
    if (event.method !== "item/reasoning/summaryTextDelta") throw new Error("Unexpected notification kind");
    assert.equal(event.params.itemId, message!.id);
  } finally { owners.items.dispose(); owners.threads.dispose(); database.close(); }
});

test("canonical recording maps structural references without changing evidence, positions or content", async () => {
  const fixture = await setup();
  try {
    const { owners, native, parent, turn, database } = fixture;
    const sourceItem: ThreadItem = {
      type: "dynamicToolCall", id: "native-tool", namespace: null, tool: "inspect",
      arguments: { threadId: native.nativeThreadId }, status: "completed",
      contentItems: null, success: true, durationMs: null,
    };
    const [item] = await admitProviderThreadItems(owners, native, [sourceItem]);
    const [questionnaire, steer] = await owners.items.admit(["native-questionnaire", "native-steer"].map((alias) => ({
      threadId: parent.threadId, sources: [], legacyAliases: [{ turnId: turn.turnId, alias }],
    })));
    const observations: WorkbenchTranscriptAtomicObservation[] = [
      { kind: "thread", threadId: native.nativeThreadId, projectId: "project", projectRoot: "C:/repo",
        title: "Parent", createdAt: 1, updatedAt: 2, activityAt: 2 },
      { kind: "turn", threadId: native.nativeThreadId, turnId: native.nativeTurnId,
        harnessId: native.harness, nativeLocation: native.nativeLocation, nativeThreadId: native.nativeThreadId,
        nativeTurnId: native.nativeTurnId, state: "completed", createdAt: 1, startedAt: 1, endedAt: 2,
        durationMs: 1, turnIndex: 0 },
      { kind: "item", threadId: native.nativeThreadId, turnId: native.nativeTurnId, item: sourceItem,
        lifecycle: "completed", observedAt: 2, itemPosition: 0 },
      { kind: "questionnaire", observedAt: 3, itemPosition: 1, entry: {
        threadId: native.nativeThreadId, turnId: native.nativeTurnId, itemId: "native-questionnaire",
        requestKey: "request", insertAfterItemId: "unresolved-legacy-aggregate", insertAfterItemIndex: null,
        request: { id: "request", title: "Choose", summary: "", submitLabel: "", questions: [] },
        response: { answers: {} }, resolvedAt: 3,
      } },
      { kind: "steer", observedAt: 4, itemPosition: 2, entry: {
        itemId: "native-steer", entryKey: "steer", threadId: native.nativeThreadId, turnId: native.nativeTurnId,
        input: [{ type: "text", text: "keep native-parent in this text", text_elements: [] }],
        status: "failed", attemptedAt: 3, resolvedAt: 4, requestId: "request",
        canonicalItemId: null, error: "not delivered",
      } },
      { kind: "browse", entry: {
        threadId: native.nativeThreadId, turnId: native.nativeTurnId, commandItemId: sourceItem.id,
        action: "snapshot", actionIndex: 0, assetUrl: null, durationMs: 1, entryKey: "browse",
        recordedAt: 4, session: null, state: "completed",
      } },
      { kind: "nativeEvidence", threadId: native.nativeThreadId, turnId: native.nativeTurnId, itemId: sourceItem.id,
        harnessId: native.harness, nativeLocation: native.nativeLocation, nativeThreadId: native.nativeThreadId,
        nativeTurnId: native.nativeTurnId, nativeItemId: sourceItem.id, nativeEventId: null, clientId: null,
        nativeSequence: null, recordKind: "event", payloadJson: '{"threadId":"native-parent"}', recordedAt: 4 },
    ];
    const original = structuredClone(observations);
    const mapped = mapNativeTranscriptObservation(owners, native, {
      kind: "canonicalWindow", threadId: native.nativeThreadId, contentVersion: 3,
      materializedTurnIds: [native.nativeTurnId], observations,
    });
    assert.equal(mapped.kind, "canonicalWindow");
    if (mapped.kind !== "canonicalWindow") throw new Error("Expected canonical window");
    assert.equal(mapped.threadId, parent.threadId);
    assert.deepEqual(mapped.materializedTurnIds, [turn.turnId]);
    const repository = new WorkbenchTranscriptRepository(database);
    repository.settle([mapped]);
    const snapshot = repository.read({ threadId: parent.threadId, turnLimit: 1 })!;
    assert.deepEqual(snapshot.rows.threadItems.map(({ public_id, item_position }) => [public_id, item_position]),
      [[item!.id, 0], [questionnaire!.itemId, 1], [steer!.itemId, 2]]);
    assert.deepEqual(database.prepare("SELECT native_thread_id, native_item_id, payload_json FROM transcript_native_records").all(),
      [{ native_thread_id: native.nativeThreadId, native_item_id: sourceItem.id, payload_json: '{"threadId":"native-parent"}' }]);
    assert.deepEqual(observations, original);
    assert.deepEqual(snapshot.rows.threadOperationCallableToolSources.map(({ arguments_json }) => arguments_json),
      [JSON.stringify(sourceItem.arguments)]);
    assert.equal(snapshot.rows.threadBrowseEntries[0]?.item_id, snapshot.rows.threadItems[0]?.id);
    const legacyQuestionnaire = {
      ...observations.find((entry) => entry.kind === "questionnaire")!.entry,
      itemId: null, insertAfterItemId: null,
    };
    await owners.items.admit([{
      threadId: parent.threadId, itemId: questionnaire!.itemId, sources: [],
      legacyAliases: [{ turnId: turn.turnId, alias: resolveQuestionnaireHistoryItemId(legacyQuestionnaire) }],
    }]);
    const context = { questionnaireEntries: [legacyQuestionnaire], steerEntries: [], browseResultEntries: [] };
    const response = await mapNativeProviderResponse(owners, "codex", {
      method: "thread/context/read", params: { threadId: native.nativeThreadId },
    }, { id: 1, result: context });
    assert.deepEqual(response.result, {
      ...context, questionnaireEntries: [{
        ...legacyQuestionnaire, threadId: parent.threadId, turnId: turn.turnId, itemId: questionnaire!.itemId,
      }],
    });
    assert.throws(() => mapNativeTranscriptObservation(owners, native, {
      kind: "item", threadId: native.nativeThreadId, turnId: "unobserved-turn", item: sourceItem,
      lifecycle: "completed", observedAt: 4,
    }), /not been admitted/iu);
  } finally {
    fixture.owners.items.dispose();
    fixture.owners.threads.dispose();
    fixture.database.close();
  }
});
