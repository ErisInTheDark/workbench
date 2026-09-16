/*
 * No exports. Tests cover Codex bridge requests, questionnaire liveness, lifecycle, transcript projection, and reload recovery.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { captureTestOutput } from "../../test/capture-test-output.mts";

import Database from "better-sqlite3";

import type CodexAppServer from "./CodexAppServer";
import type { Thread } from "workbench-shared/codex/generated/app-server/v2/Thread";
import type { ThreadItem } from "workbench-shared/codex/generated/app-server/v2/ThreadItem";
import type { WorkbenchBrowseResultEntry, WorkbenchQuestionnaireHistoryEntry } from "workbench-shared/types";
import {
  createWorkbenchFileChangeFailureSystemMessage,
  type WorkbenchFileChangeItem,
} from "workbench-shared/workbench/thread/workbench-file-change";
import type { WorkbenchThreadPageResponse } from "workbench-shared/workbench/thread/workbench-thread-page";
import type { BridgeClient, JsonRpcNotification, JsonRpcRequest, JsonRpcResponse } from "./bridge-types";
import { WORKBENCH_TOOL_CONTEXT_METHOD, readWorkbenchToolOutput } from "workbench-shared/workbench/thread/thread-tool-output";
import { installWorkbenchDatabaseSchema } from "./database/workbench-database-schema";
import WorkbenchTranscriptRepository from "./database/transcript/WorkbenchTranscriptRepository";
import WorkbenchTranscriptAssetStore from "./database/transcript/WorkbenchTranscriptAssetStore";
import CodexSqliteTranscriptReader from "./CodexSqliteTranscriptReader";
import type { CodexThreadWindowStore } from "./CodexThreadWindowLoader";
import WorkbenchDatabaseController from "./database/WorkbenchDatabaseController";
import WorkbenchTranscriptController from "./database/transcript/WorkbenchTranscriptController";
import WorkbenchTranscriptCaptureGapController from "./database/transcript/WorkbenchTranscriptCaptureGapController";
import type { WorkbenchTranscriptObservation } from "./database/transcript/workbench-transcript-types";
import WorkbenchThreadIdentityRepository from "./database/thread-identity/WorkbenchThreadIdentityRepository";
import WorkbenchTranscriptIdentityRepository from "./database/transcript/WorkbenchTranscriptIdentityRepository";
import WorkbenchThreadIdentityController from "./WorkbenchThreadIdentityController";
import WorkbenchTranscriptIdentityController from "./WorkbenchTranscriptIdentityController";
import { mapProviderNotification } from "./thread-identity-provider-mapping";
import { projectWorkbenchTranscript } from "workbench-shared/workbench/transcript/workbench-transcript-projection";
import type { ServerNotification } from "workbench-shared/codex/generated/app-server/ServerNotification";
import { NativeThreadIdSchema, ProjectIdSchema, type NativeThreadId, type NativeTurnId } from "workbench-shared/workbench/identity";
import * as fixtureIdentitySchemas from "workbench-shared/workbench/identity";
import { resolveQuestionnaireHistoryItemId } from "workbench-shared/workbench/thread/thread-questionnaire-identity";
import CodexRecoveryController from "./CodexRecoveryController";
import WorkbenchTurnRecoveryController from "./WorkbenchTurnRecoveryController";
import { recoverCodexTurn } from "./codex-turn-recovery";

const fixtureIdentityValues = {
  NativeThreadId: {
    "thread": fixtureIdentitySchemas.NativeThreadIdSchema.parse("thread"),
  },
  NativeTurnId: {
    "turn": fixtureIdentitySchemas.NativeTurnIdSchema.parse("turn"),
  },
  ProjectId: {
    "project": fixtureIdentitySchemas.ProjectIdSchema.parse("local:///project"),
  },
};

const originalWorkbenchLibraryRoot = process.env.WORKBENCH_LIBRARY_ROOT;
let testWorkbenchLibraryRoot = "";
let databaseImage: Buffer;
let CodexStdioBridge: typeof import("./CodexStdioBridge.js").default;
let WorkbenchCodexInstructionAdapter: (typeof import("./WorkbenchCodexInstructionAdapter.js"))["default"];

beforeEach(context => {
  assert.ok("mock" in context);
  captureTestOutput(context, process.stdout, text =>
    text.startsWith("[daemon] WS codex:thread/start phase (")
    || /^\[codex-transcript\] capture recovery (?:started|completed) thread=/u.test(text));
});

before(async () => {
  const template = new Database(":memory:");
  try {
    template.pragma("foreign_keys = ON");
    installWorkbenchDatabaseSchema(template);
    databaseImage = template.serialize();
  } finally {
    template.close();
  }
  testWorkbenchLibraryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-bridge-library-test-"));
  process.env.WORKBENCH_LIBRARY_ROOT = testWorkbenchLibraryRoot;
  await fs.mkdir(path.join(testWorkbenchLibraryRoot, "instructions"), { recursive: true });
  await fs.mkdir(path.join(testWorkbenchLibraryRoot, "agents"), { recursive: true });
  await fs.writeFile(
    path.join(testWorkbenchLibraryRoot, "instructions", "universal.md"),
    "COLD RESUME UNIVERSAL INSTRUCTION",
    "utf8",
  );
  await fs.writeFile(
    path.join(testWorkbenchLibraryRoot, "agents", "lily.md"),
    "---\nname: Lily test agent\ndescription: Test-only prefix identity.\n---\nLILY PREFIX SENTINEL",
    "utf8",
  );
  const [bridgeModule, instructionModule] = await Promise.all([
    import("./CodexStdioBridge.js"),
    import("./WorkbenchCodexInstructionAdapter.js"),
  ]);
  CodexStdioBridge = bridgeModule.default as unknown as typeof CodexStdioBridge;
  WorkbenchCodexInstructionAdapter = instructionModule.default as unknown as typeof WorkbenchCodexInstructionAdapter;
});

after(async () => {
  if (originalWorkbenchLibraryRoot === undefined) delete process.env.WORKBENCH_LIBRARY_ROOT;
  else process.env.WORKBENCH_LIBRARY_ROOT = originalWorkbenchLibraryRoot;
  if (testWorkbenchLibraryRoot) {
    await fs.rm(testWorkbenchLibraryRoot, { force: true, recursive: true });
  }
});

function deferred<TValue>() {
  let resolve!: (value: TValue) => void;
  const promise = new Promise<TValue>((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
}

function assetPorts(database: InstanceType<typeof Database>) {
  const store = new WorkbenchTranscriptAssetStore(database);
  return {
    writeTranscriptAsset: async (input: Parameters<typeof store.write>[0]) => store.write(input),
    readTranscriptAsset: async (input: Parameters<typeof store.read>[0]) => store.read(input),
  };
}

async function rejectWorkbenchRequest(request: JsonRpcRequest) {
  return { id: request.id ?? null, error: { code: -32000, message: "Workbench request is not expected in this test." } };
}

function bridgeThread(items: ThreadItem[] = []) {
  return {
    agentNickname: null,
    agentRole: null,
    canAcceptDirectInput: null,
    cliVersion: "test",
    createdAt: 1,
    cwd: "C:/repo",
    ephemeral: false,
    extra: null,
    forkedFromId: null,
    gitInfo: null,
    historyMode: "legacy" as const,
    id: "thread",
    modelProvider: "openai",
    model: null,
    projectId: null,
    reasoningEffort: null,
    name: null,
    parentThreadId: null,
    path: null,
    preview: "",
    recencyAt: null,
    section: null,
    sectionEnteredAt: null,
    sessionId: "session",
    source: "appServer" as const,
    status: { activeFlags: [], type: "active" as const },
    threadSource: null,
    turns: [{
      completedAt: null,
      durationMs: null,
      error: null,
      id: "turn",
      items,
      itemsView: "full" as const,
      startedAt: 1,
      status: "inProgress" as const,
    }],
    updatedAt: 1,
  };
}

for (const route of ["managed-creation", "internal", "browser"] as const) {
  for (const failed of [false, true]) {
    test(`${route} preserves caller correlation for provider ${failed ? "errors" : "results"}`, async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-bridge-correlation-"));
      const sent: unknown[] = [];
      const upstreamIds: JsonRpcRequest["id"][] = [];
      const payload = failed
        ? { error: { code: -32000, message: "Provider refused the request." } }
        : { result: route === "managed-creation" ? { thread: { ...bridgeThread(), turns: [] } } : { data: [] } };
      const bridge = new CodexStdioBridge({
        appServer: { send(request: JsonRpcRequest) {
          upstreamIds.push(request.id);
          queueMicrotask(() => void bridge.handleUpstreamMessage({ ...payload, id: request.id ?? null }));
        } } as unknown as CodexAppServer,
        bridgeUrl: "ws://127.0.0.1:1",
        createThread: (request, create) => create(request),
        resolveProjectFromCwd: async () => ({
          cwd: "C:/repo",
          project: { id: fixtureIdentityValues.ProjectId.project, kind: "git", root: "C:/repo", rootPath: "C:/repo", roots: [] },
          root: { id: "root", name: "repo", root: "C:/repo", rootPath: "C:/repo" },
        }),
        handleWorkbenchRequest: rejectWorkbenchRequest,
        instructions: new WorkbenchCodexInstructionAdapter("ws://127.0.0.1:1", root),
        onNotification() {},
        sendToClient(_client, response) { sent.push(response); },
        storageRoot: root,
      });
      try {
        const request = {
          id: "caller-request",
          method: route === "managed-creation" ? "thread/start" : "model/list",
          params: { cwd: "C:/repo" },
        };
        let response: unknown;
        if (route === "browser") {
          await bridge.forwardRequest(request, {} as BridgeClient, "browser-request");
          await bridge.waitForIdle();
          assert.equal(sent.length, 1);
          response = sent[0];
        } else {
          response = route === "managed-creation"
            ? await bridge.handleBridgeRequest(request)
            : await bridge.handleServerRequest(request);
        }
        assert.equal(upstreamIds.length, 1);
        assert.notEqual(upstreamIds[0], request.id);
        assert.equal((response as JsonRpcResponse).id, route === "browser" ? "browser-request" : request.id);
        if (failed || route !== "managed-creation") {
          assert.deepEqual(response, { ...payload, id: route === "browser" ? "browser-request" : request.id });
        } else {
          assert.equal(((response as JsonRpcResponse).result as { thread: Thread }).thread.id, "thread");
        }
      } finally {
        await bridge.dispose();
        await fs.rm(root, { recursive: true, force: true });
      }
    });
  }
}

function databaseFixture() {
  const database = new Database(databaseImage);
  database.pragma("foreign_keys = ON");
  return database;
}

test("bridge admits public identity before structural publication and records the same identity without blocking deltas on bodies", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-bridge-identity-"));
  const database = databaseFixture();
  const repository = new WorkbenchThreadIdentityRepository(database);
  const itemRepository = new WorkbenchTranscriptIdentityRepository(database);
  let writes = 0;
  const threads = new WorkbenchThreadIdentityController({
    listThreadIdentities: async () => repository.list(),
    observeThreadIdentities: async (inputs) => { writes++; return repository.observeMany(inputs); },
    observeTurnIdentities: async (inputs) => { writes++; return repository.observeTurns(inputs); },
    resolveThreadIdentity: async (input) => repository.resolve(input),
    resolveNativeThreadIdentity: async (input) => repository.resolveNative(input),
    resolveTurnIdentity: async (input) => repository.resolveTurn(input),
  });
  const items = new WorkbenchTranscriptIdentityController({
    admitTranscriptItemIdentities: async (inputs) => { writes++; return itemRepository.admitMany(inputs); },
    resolveTranscriptItemIdentity: async (input) => itemRepository.resolve(input),
  });
  const identities = { threads, items };
  const publicEvents: ServerNotification[] = [];
  const facts: WorkbenchTranscriptObservation[] = [];
  const body = deferred<void>();
  const bodyEntered = deferred<void>();
  const native = { harness: "codex", nativeLocation: "C:/repo", nativeThreadId: fixtureIdentitySchemas.NativeThreadIdSchema.parse("thread") };
  let readPage = false;
  const pageTurn = { ...bridgeThread().turns[0]!, id: "historical-page-turn" };
  const bridge = new CodexStdioBridge({
    appServer: { send(request: JsonRpcRequest) {
      if (!readPage || request.method !== "thread/turns/list") throw new Error("Identity admission must not request provider history");
      queueMicrotask(() => void bridge.handleUpstreamMessage({ id: request.id, result: { data: [pageTurn], nextCursor: null } }));
    } } as unknown as CodexAppServer,
    initialState: {
      upstreamInitialized: true, initializeResult: {}, requestIdAllocator: { next: 100 },
      pendingResponses: new Map(), pendingUserInputRequests: new Map(),
    },
    bridgeUrl: "ws://127.0.0.1:1", handleWorkbenchRequest: rejectWorkbenchRequest,
    ...{ identities }, transcriptAssets: assetPorts(database),
    onNotification(notification) {
      publicEvents.push(notification as ServerNotification);
    },
    recordSqliteTranscript: async (batch) => {
      facts.push(...batch);
      if (batch.some((fact) => fact.kind === "item")) {
        bodyEntered.resolve();
        await body.promise;
      }
    },
    resolveProjectFromCwd: async () => ({
      cwd: "C:/repo", project: { id: fixtureIdentityValues.ProjectId.project, kind: "git", root: "C:/repo", rootPath: "C:/repo", roots: [] },
      root: { id: "root", name: "repo", root: "C:/repo", rootPath: "C:/repo" },
    }),
    sendToClient() {}, storageRoot: root,
  });
  try {
    await bridge.handleUpstreamMessage({ method: "thread/started", params: { thread: { ...bridgeThread(), turns: [] } } });
    await bridge.handleUpstreamMessage({ method: "turn/started", params: { threadId: "thread", turn: bridgeThread().turns[0] } });
    const item: ThreadItem = { type: "agentMessage", id: "native-message", text: "", phase: "commentary", memoryCitation: null, delivery: null, questions: null };
    await bridge.handleUpstreamMessage({ method: "item/started", params: { threadId: "thread", turnId: "turn", item } });
    await bodyEntered.promise;
    const beforeDeltas = writes;
    for (const delta of ["first ", "second"]) {
      await bridge.handleUpstreamMessage({ method: "item/agentMessage/delta", params: {
        threadId: "thread", turnId: "turn", itemId: item.id, delta,
      } });
    }
    assert.equal(writes, beforeDeltas);
    const start = publicEvents.find((event) => event.method === "item/started");
    assert.equal(start?.method, "item/started");
    if (start?.method !== "item/started") throw new Error("Missing public start");
    assert.notEqual(start.params.item.id, item.id);
    const recorded = facts.find((fact) => fact.kind === "item");
    assert.equal(recorded?.kind, "item");
    if (recorded?.kind !== "item") throw new Error("Missing recorded item");
    assert.equal(recorded.publicItemId, start.params.item.id);
    assert.equal(recorded.threadId, start.params.threadId);
    assert.equal(recorded.turnId, start.params.turnId);
    assert.equal(recorded.item.id, item.id);
    assert.deepEqual(publicEvents.filter((event) => event.method === "item/agentMessage/delta").map((event) => event.params), [
      { threadId: start.params.threadId, turnId: start.params.turnId, itemId: start.params.item.id, delta: "first " },
      { threadId: start.params.threadId, turnId: start.params.turnId, itemId: start.params.item.id, delta: "second" },
    ]);
    const patch = {
      method: "item/fileChange/patchUpdated" as const,
      params: { threadId: "thread", turnId: "turn", itemId: "patch-preview",
        changes: [{ path: "example.ts", kind: { type: "add" as const }, diff: "+preview" }] },
    };
    await bridge.handleUpstreamMessage(patch);
    const preview = publicEvents.at(-1);
    assert.equal(preview?.method, patch.method);
    if (preview?.method !== patch.method) throw new Error("Missing public patch preview");
    assert.notEqual(preview.params.itemId, patch.params.itemId);
    const afterFirstPreview = writes;
    await bridge.handleUpstreamMessage(patch);
    assert.equal(writes, afterFirstPreview, "Repeated previews must not re-admit identity or record bodies");
    const canonicalPatch: ThreadItem = {
      type: "fileChange", id: patch.params.itemId, changes: patch.params.changes, status: "inProgress",
    };
    await bridge.handleUpstreamMessage({
      method: "item/started", params: { threadId: "thread", turnId: "turn", item: canonicalPatch },
    });
    const patchStart = publicEvents.at(-1);
    assert.equal(patchStart?.method, "item/started");
    if (patchStart?.method !== "item/started") throw new Error("Missing public patch start");
    assert.equal(patchStart.params.item.id, preview.params.itemId);
    readPage = true;
    await bridge.handleServerRequest({ id: 1, method: "thread/turns/list", params: { threadId: "thread", itemsView: "full" } });
    const pageIdentity = threads.findNativeTurn({ ...native, nativeTurnId: fixtureIdentitySchemas.NativeTurnIdSchema.parse(pageTurn.id) });
    assert.ok(pageIdentity);
    for (const pageItem of pageTurn.items) {
      assert.ok(items.itemIdForReference(pageIdentity.threadId, pageIdentity.turnId, fixtureIdentitySchemas.ItemReferenceSchema.parse(pageItem.id)));
    }
    const bytes = Buffer.from("canonical browse asset");
    const digest = createHash("sha256").update(bytes).digest("hex");
    const encodedNative = Buffer.from("thread").toString("base64url");
    await assetPorts(database).writeTranscriptAsset({ threadId: "thread", bytes, mimeType: "image/png" });
    const verify = (bridge as unknown as {
      readSqliteBrowseAsset(threadId: string, url: string): Promise<{ digest: string }>;
    }).readSqliteBrowseAsset.bind(bridge);
    for (const urlThreadId of [encodedNative, start.params.threadId]) {
      assert.equal((await verify("thread", `/api/transcript-assets/codex/${urlThreadId}/${digest}.png`)).digest, digest);
    }
    await assert.rejects(verify("thread", `/api/transcript-assets/codex/unrelated/${digest}.png`), /not found/u);
  } finally {
    body.resolve();
    await bridge.disposeImmediately();
    items.dispose();
    threads.dispose();
    database.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("database replacement preserves ordered live events and usage without replaying provider starts", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-cold-live-identity-"));
  const database = databaseFixture();
  const repository = new WorkbenchThreadIdentityRepository(database);
  const itemRepository = new WorkbenchTranscriptIdentityRepository(database);
  const transcripts = new WorkbenchTranscriptRepository(database);
  const createOwners = () => ({
    threads: new WorkbenchThreadIdentityController({
      listThreadIdentities: async () => repository.list(),
      observeThreadIdentities: async (inputs) => repository.observeMany(inputs),
      observeTurnIdentities: async (inputs) => repository.observeTurns(inputs),
      resolveThreadIdentity: async (input) => repository.resolve(input),
      resolveNativeThreadIdentity: async (input) => repository.resolveNative(input),
      resolveTurnIdentity: async (input) => repository.resolveTurn(input),
    }),
    items: new WorkbenchTranscriptIdentityController({
      admitTranscriptItemIdentities: async (inputs) => itemRepository.admitMany(inputs),
      resolveTranscriptItemIdentity: async (input) => itemRepository.resolve(input),
    }),
  });
  let identities = createOwners();
  const native = { harness: "codex", nativeLocation: "C:/repo", nativeThreadId: fixtureIdentitySchemas.NativeThreadIdSchema.parse("thread") };
  const published: ServerNotification[] = [];
  const message: ThreadItem = { type: "agentMessage", id: "cold-message", text: "first", phase: "commentary", memoryCitation: null, delivery: null, questions: null };
  const reasoning: ThreadItem = { type: "reasoning", id: "cold-reasoning", summary: ["title"], content: [] };
  const createBridge = (initialState?: ConstructorParameters<typeof CodexStdioBridge>[0]["initialState"]) => new CodexStdioBridge({
    appServer: { send() { throw new Error("Cold identity lookup must not request provider history"); } } as unknown as CodexAppServer,
    initialState, identities,
    bridgeUrl: "ws://127.0.0.1:1", handleWorkbenchRequest: rejectWorkbenchRequest,
    onNotification(event) { published.push(event as ServerNotification); },
    recordSqliteTranscript: async (batch) => { transcripts.settle(batch); },
    resolveProjectFromCwd: async () => ({
      cwd: "C:/repo", project: { id: fixtureIdentityValues.ProjectId.project, kind: "git", root: "C:/repo", rootPath: "C:/repo", roots: [] },
      root: { id: "root", name: "repo", root: "C:/repo", rootPath: "C:/repo" },
    }),
    sendToClient() {}, storageRoot: root,
  });
  let bridge = createBridge();
  try {
    await bridge.handleUpstreamMessage({ method: "thread/started", params: { thread: { ...bridgeThread(), turns: [] } } });
    await bridge.handleUpstreamMessage({ method: "turn/started", params: { threadId: "thread", turn: bridgeThread().turns[0] } });
    for (const item of [message, reasoning]) {
      await bridge.handleUpstreamMessage({ method: "item/started", params: { threadId: "thread", turnId: "turn", item } });
    }
    const threadId = identities.threads.workbenchIdForNative(native);
    const turnId = identities.threads.workbenchTurnIdForNative({ ...native, nativeTurnId: fixtureIdentityValues.NativeTurnId["turn"] });
    const messageId = identities.items.itemIdForReference(threadId, turnId, fixtureIdentitySchemas.ItemReferenceSchema.parse(message.id));
    const reasoningId = identities.items.itemIdForReference(threadId, turnId, fixtureIdentitySchemas.ItemReferenceSchema.parse(reasoning.id));
    const tokens = { inputTokens: 100, outputTokens: 40, cachedInputTokens: 20, cacheWriteInputTokens: 5, reasoningOutputTokens: 10, totalTokens: 140 };
    const events: ServerNotification[] = [
      { method: "item/agentMessage/delta", params: { threadId: "thread", turnId: "turn", itemId: message.id, delta: "continued" } },
      { method: "item/reasoning/summaryTextDelta", params: { threadId: "thread", turnId: "turn", itemId: reasoning.id, summaryIndex: 0, delta: "continued thought" } },
      { method: "thread/tokenUsage/updated", params: { threadId: "thread", turnId: "turn", tokenUsage: { last: tokens, total: tokens, modelContextWindow: null } } },
      { method: "item/completed", params: { threadId: "thread", turnId: "turn", item: { ...message, text: "firstcontinued" }, completedAtMs: 2000 } },
    ];
    for (const event of events) {
      const state = await bridge.detachForReload();
      identities.items.dispose();
      identities.threads.dispose();
      identities = createOwners();
      await identities.threads.start();
      bridge = createBridge(state);
      const before = published.length;
      await bridge.handleUpstreamMessage(event);
      await bridge.handleUpstreamMessage(event);
      assert.equal(published.length, before + 2, "Every event must reach publication without replayed start events");
      const expected = mapProviderNotification(identities, native, event);
      assert.deepEqual(published.slice(before), [expected, expected]);
      assert.equal(identities.threads.workbenchTurnIdForNative({ ...native, nativeTurnId: fixtureIdentityValues.NativeTurnId["turn"] }), turnId);
      if ("itemId" in event.params) {
        assert.equal(identities.items.itemIdForReference(threadId, turnId, fixtureIdentitySchemas.ItemReferenceSchema.parse(event.params.itemId)),
          event.params.itemId === message.id ? messageId : reasoningId);
      }
    }
    await bridge.detachForReload();
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM thread_turn_usage WHERE turn_id = ?").get(turnId) as { count: number }).count, 1);
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM thread_items WHERE turn_id = ?").get(turnId) as { count: number }).count, 2);
  } finally {
    await bridge.disposeImmediately();
    identities.items.dispose();
    identities.threads.dispose();
    database.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

for (const settlement of ["accepted", "failed", "resolved", "cancelled", "reload", "restart", "ended-before-delivery"] as const) {
  test(`automatic patch recovery settles ${settlement} through the pending response owner`, async (context) => {
    const diagnostics = captureTestOutput(context, process.stderr, text =>
      text === "[codex-tool-context] injection rejected\n"
      || text === "[codex-tool-context] Codex app-server restarted before the upstream response arrived.\n");
    context.after(() => assert.equal(diagnostics.length, settlement === "failed" || settlement === "restart" ? 1 : 0));
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-bridge-file-approval-"));
    const sql = await recordingFixture(root);
    await fs.writeFile(path.join(root, "target.txt"), "new\n");
    const upstreamMessages: JsonRpcRequest[] = [];
    const notifications: Array<{ method?: string; params?: unknown }> = [];
    const pendingUserInputRequests = new Map();
    const metadata = { ...bridgeThread(), cwd: root, turns: [],
      status: bridgeThread().status as import("workbench-shared/codex/generated/app-server/v2/Thread").Thread["status"],
    };
    const options: ConstructorParameters<typeof CodexStdioBridge>[0] = {
      ...sql.ports,
      appServer: { send(message: JsonRpcRequest) {
        upstreamMessages.push(message);
        if (message.method === "thread/read" || message.method === "thread/turns/list") {
          queueMicrotask(() => void (async () => {
            if (settlement === "ended-before-delivery" && message.method === "thread/read") {
              metadata.status = { type: "idle" };
              await bridge.handleUpstreamMessage({ method: "turn/completed", params: {
                threadId: "thread", turn: { ...bridgeThread().turns[0], status: "completed", items: [] },
              } });
            }
            await bridge.handleUpstreamMessage({
              id: message.id,
              result: message.method === "thread/read" ? { thread: metadata } : { data: bridgeThread().turns },
            });
          })());
        }
      } } as unknown as CodexAppServer,
      bridgeUrl: "ws://127.0.0.1:1",
      handleWorkbenchRequest: rejectWorkbenchRequest,
      initialState: {
        initializeResult: {}, pendingResponses: new Map(), pendingUserInputRequests,
        requestIdAllocator: { next: 100 }, upstreamInitialized: true,
      },
      onNotification(notification) { notifications.push(notification); },
      resolveProjectFromCwd: async () => ({
        cwd: root,
        project: { id: fixtureIdentityValues.ProjectId.project, kind: "git", root, rootPath: root, roots: [{ id: "root", name: "repo", root, rootPath: root }] },
        root: { id: "root", name: "repo", root, rootPath: root },
      }),
      sendToClient() {}, storageRoot: root,
    };
    let bridge = new CodexStdioBridge(options);
    try {
      await bridge.handleUpstreamMessage({ method: "thread/started", params: { thread: metadata } });
      await bridge.handleUpstreamMessage({ method: "turn/started", params: { threadId: "thread", turn: bridgeThread().turns[0] } });
      await bridge.handleUpstreamMessage({ method: "item/started", params: {
        threadId: "thread", turnId: "turn",
        item: { id: "failed-patch", type: "fileChange", status: "inProgress", changes: [
          { path: "target.txt", kind: { type: "update", move_path: null }, diff: "@@ -1 +1 @@\n-old\n+new\n" },
        ] },
      } });
      await bridge.handleUpstreamMessage({
        id: 10, method: "item/fileChange/requestApproval",
        params: {
          grantRoot: null, itemId: "failed-patch", reason: "command failed; retry without sandbox?",
          startedAtMs: 1, threadId: "thread", turnId: "turn",
        },
      });
      await bridge.waitForIdle();
      const injection = upstreamMessages.find((message) => message.method === "thread/inject_items");
      assert.ok(injection, "recovery must be injected before the approval is answered");
      assert.equal(upstreamMessages.some((message) => message.id === 10), false);
      const items = (injection.params as { items: Array<{ id: string; name: string; namespace: string; output: string; call_id?: string }> }).items;
      assert.equal(items.length, 1);
      assert.equal(items[0].name, "patch_recovery");
      assert.equal(items[0].namespace, "workbench");
      assert.equal(items[0].call_id, undefined);
      assert.match(items[0].output, /target\.txt.*present/);
      if (settlement === "resolved") {
        await bridge.handleUpstreamMessage({ method: "serverRequest/resolved", params: { threadId: "thread", requestId: 10 } });
      } else if (settlement === "cancelled") {
        await bridge.handleUpstreamMessage({ method: "turn/completed", params: {
          threadId: "thread", turn: { ...bridgeThread().turns[0], status: "interrupted", items: [] },
        } });
      } else if (settlement === "reload" || settlement === "restart") {
        const initialState = await bridge.detachForReload({ restartingAppServer: settlement === "restart" });
        await bridge.retireAfterHandoff({ restartingAppServer: settlement === "restart" });
        bridge = new CodexStdioBridge({ ...options, initialState });
        await bridge.settleRestartedResponses();
      }
      await bridge.handleUpstreamMessage(settlement === "failed"
        ? { id: injection.id, error: { code: -32000, message: "injection rejected" } }
        : { id: injection.id, result: {} });
      await bridge.waitForIdle();
      const decisions = upstreamMessages.filter((message) => message.id === 10);
      assert.equal(decisions.length, ["resolved", "cancelled", "restart", "ended-before-delivery"].includes(settlement) ? 0 : 1);
      if (decisions.length) assert.deepEqual(decisions[0], { id: 10, result: { decision: "decline" } });
      assert.equal(upstreamMessages.some((message) => message.method === "turn/steer" || message.method === "turn/start"), false);
      const { snapshot, projection } = sql.project();
      const itemId = snapshot.rows.threadItems.find(item => item.source_id === "failed-patch")?.public_id;
      const patch = projection.turns.flatMap(turn => turn.items).find(item => item.id === itemId) as WorkbenchFileChangeItem;
      assert.equal(patch.workbenchPolicy, "automaticEscalation");
      assert.equal(patch.changes[0]?.workbenchAnalysis?.outcome, "present");
      assert.equal(patch.workbenchRecovery?.state, settlement === "failed" || settlement === "restart" ? "failed" : "queued");

      const before = upstreamMessages.length;
      await bridge.handleUpstreamMessage({
        id: 11, method: "item/fileChange/requestApproval",
        params: {
          grantRoot: "C:/outside", itemId: "real-permission-request", reason: "write outside the workspace",
          startedAtMs: 2, threadId: "thread", turnId: "turn",
        },
      });
      assert.equal(upstreamMessages.length, before);
      assert.equal(notifications.at(-1)?.method, "questionnaire/requested");
    } finally {
      await bridge.dispose();
      await fs.rm(root, { force: true, recursive: true });
    }
  });
}

for (const origin of ["active", "idle", "changed", "failed"] as const) {
  test(`passive screenshot context handles ${origin} origin without user input or a new turn`, async (context) => {
    const diagnostics = captureTestOutput(context, process.stderr, text =>
      text === "[codex-tool-context] Passive context requires an active originating turn; no turn was started.\n"
      || text === "[codex-tool-context] The originating turn is no longer active; passive context was not sent.\n"
      || text === "[codex-tool-context] rejected\n");
    context.after(() => assert.equal(diagnostics.length, origin === "active" ? 0 : 1));
    const sql = await recordingFixture();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-passive-context-"));
    const requests: JsonRpcRequest[] = [];
    const facts: WorkbenchTranscriptObservation[] = [];
    const visible: unknown[] = [];
    const metadata = { ...bridgeThread(), turns: [], status: origin === "idle" ? { type: "idle" as const } : bridgeThread().status };
    const bridge = new CodexStdioBridge({
      ...sql.ports,
      appServer: { send(message: JsonRpcRequest) {
        requests.push(message);
        if (message.method === "thread/read" || message.method === "thread/turns/list") {
          queueMicrotask(() => void bridge.handleUpstreamMessage({ id: message.id, result: message.method === "thread/read"
            ? { thread: metadata }
            : { data: [{ ...bridgeThread().turns[0], id: origin === "changed" ? "new-turn" : "turn" }] },
          }));
        }
      } } as unknown as CodexAppServer,
      bridgeUrl: "ws://127.0.0.1:1", handleWorkbenchRequest: rejectWorkbenchRequest,
      onNotification(message) { visible.push(message); },
      recordSqliteTranscript: async (batch) => { facts.push(...batch); await sql.ports.recordSqliteTranscript(batch); },
      resolveProjectFromCwd: async () => ({
        cwd: "C:/repo", project: { id: fixtureIdentityValues.ProjectId.project, kind: "git", root: "C:/repo", rootPath: "C:/repo", roots: [] },
        root: { id: "root", name: "repo", root: "C:/repo", rootPath: "C:/repo" },
      }),
      sendToClient() {}, storageRoot: root,
    });
    try {
      await bridge.handleUpstreamMessage({ method: "thread/started", params: { thread: metadata } });
      await bridge.handleUpstreamMessage({ method: "turn/started", params: { threadId: "thread", turn: bridgeThread().turns[0] } });
      await bridge.waitForIdle();
      const before = visible.length;
      const output = { name: "screenshot", namespace: "workbench", output: [
        { type: "input_image" as const, image_url: "data:image/png;base64,aGVsbG8=" },
      ] };
      const delivery = bridge.handleServerRequest({ id: "screenshot", method: WORKBENCH_TOOL_CONTEXT_METHOD, params: {
        threadId: "thread", expectedTurnId: "turn", toolOutput: output,
      } });
      await bridge.waitForIdle();
      assert.equal(visible.length, before, "nothing is admitted before acknowledgement");
      const injection = requests.find(({ method }) => method === "thread/inject_items");
      if (origin === "idle" || origin === "changed") {
        assert.equal(injection, undefined);
        assert.ok((await delivery).error);
      } else {
        assert.ok(injection);
        const submitted = (injection.params as { items: Array<{ id: string }> }).items[0];
        assert.ok(submitted.id);
        await bridge.handleUpstreamMessage(origin === "failed"
          ? { id: injection.id, error: { code: -32000, message: "rejected" } }
          : { id: injection.id, result: {} });
        const response = await delivery;
        if (origin === "failed") {
          assert.ok(response.error);
          assert.equal(visible.length, before);
        } else {
          assert.equal(response.error, undefined);
          const accepted = facts.flatMap((fact) => fact.kind === "item" ? [readWorkbenchToolOutput(fact.item)] : []).find(Boolean)!;
          assert.equal(accepted.id, submitted.id);
          assert.equal(typeof accepted.workbenchInjectionAcceptedAt, "number");
          assert.ok(Array.isArray(accepted.output));
          await bridge.handleUpstreamMessage({ method: "item/completed", params: {
            threadId: "thread", turnId: "turn", item: { ...output, id: submitted.id, type: "functionCallOutput" },
          } });
          await bridge.waitForIdle();
          const echo = facts.flatMap((fact) => fact.kind === "item" ? [readWorkbenchToolOutput(fact.item)] : []).filter(Boolean).at(-1)!;
          assert.deepEqual(echo.output, accepted.output, "inline provider echoes must use the same asset identity before persistence merging");
          const stored = await sql.ports.sqliteReader.read(bridgeThread(), null);
          const outputs = stored?.thread.turns[0].items.filter((item) => item.type === "functionCallOutput") ?? [];
          assert.equal(outputs.length, 1);
          assert.equal(readWorkbenchToolOutput(outputs[0])?.workbenchInjectionAcceptedAt, accepted.workbenchInjectionAcceptedAt);
        }
      }
      assert.equal(requests.some(({ method }) => method === "turn/steer" || method === "turn/start"), false);
    } finally {
      await bridge.dispose();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
}

test("stopping before passive-context preparation dispatches no provider work", async (context) => {
  const diagnostics = captureTestOutput(context, process.stderr, text =>
    text === "[codex-tool-context] Codex bridge stopped before the upstream response arrived.\n");
  context.after(() => assert.equal(diagnostics.length, 1));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-stop-context-"));
  const requests: JsonRpcRequest[] = [];
  const bridge = new CodexStdioBridge({
    appServer: { send(message: JsonRpcRequest) {
      requests.push(message);
      throw new Error("Provider is stopped.");
    } } as unknown as CodexAppServer,
    bridgeUrl: "ws://127.0.0.1:1", handleWorkbenchRequest: rejectWorkbenchRequest,
    onNotification() {}, sendToClient() {}, resolveProjectFromCwd: async () => null, storageRoot: root,
  });
  try {
    const delivery = bridge.handleServerRequest({
      method: WORKBENCH_TOOL_CONTEXT_METHOD, params: {
        threadId: "thread", expectedTurnId: "turn",
        toolOutput: { name: "screenshot", namespace: "workbench", output: "capture" },
      },
    });
    bridge.beginStopping();
    assert.ok((await delivery).error);
    await bridge.waitForIdle();
    assert.deepEqual(requests, []);
  } finally {
    await bridge.disposeImmediately();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("ordinary failed patches receive current-file findings without automatic rejection attribution", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-terminal-patch-"));
  const sql = await recordingFixture(root);
  await fs.writeFile(path.join(root, "target"), "new\n");
  const requests: JsonRpcRequest[] = [];
  const metadata = { ...bridgeThread(), cwd: root, turns: [] };
  const bridge = new CodexStdioBridge({
    ...sql.ports,
    appServer: { send(message: JsonRpcRequest) {
      requests.push(message);
      queueMicrotask(() => void bridge.handleUpstreamMessage({ id: message.id, result: { thread: metadata } }));
    } } as unknown as CodexAppServer,
    bridgeUrl: "ws://127.0.0.1:1", handleWorkbenchRequest: rejectWorkbenchRequest,
    onNotification() {}, sendToClient() {}, storageRoot: root,
    resolveProjectFromCwd: async () => ({
      cwd: root, project: { id: fixtureIdentityValues.ProjectId.project, kind: "git", root, rootPath: root, roots: [{ id: "root", name: "repo", root, rootPath: root }] },
      root: { id: "root", name: "repo", root, rootPath: root },
    }),
  });
  try {
    await bridge.handleUpstreamMessage({ method: "thread/started", params: { thread: metadata } });
    await bridge.handleUpstreamMessage({ method: "turn/started", params: { threadId: "thread", turn: bridgeThread().turns[0] } });
    await bridge.handleUpstreamMessage({ method: "item/completed", params: { threadId: "thread", turnId: "turn", item: {
      id: "patch", type: "fileChange", status: "failed", changes: [
        { path: "target", kind: { type: "update", move_path: null }, diff: "@@ -1 +1 @@\n-old\n+new\n" },
      ],
    } } });
    await bridge.waitForIdle();
    const item = sql.project().projection.turns[0].items[0] as WorkbenchFileChangeItem;
    assert.equal(item.changes[0].workbenchAnalysis?.outcome, "present");
    assert.equal(item.workbenchPolicy, undefined);
    assert.equal(item.workbenchRecovery, undefined);
    assert.equal(requests.some(({ method }) => method !== "thread/read"), false);
  } finally {
    await bridge.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("bridge-only reload preserves the initialized app-server generation", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-bridge-capability-"));
  const bridge = new CodexStdioBridge({
    appServer: { send() {} } as unknown as CodexAppServer,
    bridgeUrl: "ws://127.0.0.1:1",
    handleWorkbenchRequest: rejectWorkbenchRequest,
    initialState: {
      initializeResult: { preserved: "upstream" },
      pendingResponses: new Map(),
      pendingUserInputRequests: new Map(),
      requestIdAllocator: { next: 1 },
      upstreamInitialized: true,
    },
    onNotification() {},
    resolveProjectFromCwd: async () => null,
    sendToClient() {},
    storageRoot: root,
  });
  let replacement: InstanceType<typeof CodexStdioBridge> | null = null;
  try {
    const state = await bridge.detachForReload();
    let sent = false;
    replacement = new CodexStdioBridge({
      appServer: { send() { sent = true; } } as unknown as CodexAppServer,
      bridgeUrl: "ws://127.0.0.1:1",
      handleWorkbenchRequest: rejectWorkbenchRequest,
      initialState: state,
      onNotification() {},
      resolveProjectFromCwd: async () => null,
      sendToClient() {},
      storageRoot: root,
    });
    await replacement.ensureInitialized({ id: 0, method: "initialize", params: {} });
    const initializeResult = replacement.getInitializeResult() as { preserved?: string };
    assert.equal(initializeResult.preserved, "upstream");
    assert.equal(sent, false);
  } finally {
    await replacement?.disposeImmediately();
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("app-server restart detachment drops process-bound state", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-bridge-app-server-restart-"));
  const bridge = new CodexStdioBridge({
    appServer: { send() {} } as unknown as CodexAppServer,
    bridgeUrl: "ws://127.0.0.1:1",
    handleWorkbenchRequest: rejectWorkbenchRequest,
    initialState: {
      initializeResult: { stale: "generation" },
      pendingResponses: new Map(),
      pendingUserInputRequests: new Map(),
      requestIdAllocator: { next: 7 },
      upstreamInitialized: true,
    },
    onNotification() {},
    resolveProjectFromCwd: async () => null,
    sendToClient() {},
    storageRoot: root,
  });
  try {
    const state = await bridge.detachForReload({ restartingAppServer: true });
    assert.equal(state.upstreamInitialized, false);
    assert.equal(state.initializeResult, null);
    assert.equal(state.pendingResponses.size, 0);
    assert.equal(state.pendingUserInputRequests.size, 0);
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("server request resolution detaches ordinary questionnaires but resolves approvals", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-bridge-request-resolution-"));
  const notifications: JsonRpcNotification[] = [];
  const bridge = new CodexStdioBridge({
    appServer: { send() {} } as unknown as CodexAppServer,
    bridgeUrl: "ws://127.0.0.1:1",
    handleWorkbenchRequest: rejectWorkbenchRequest,
    onNotification(notification) { notifications.push(notification); },
    resolveProjectFromCwd: async () => null,
    sendToClient() {},
    storageRoot: root,
  });
  try {
    await bridge.handleUpstreamMessage({
      id: "question",
      method: "item/tool/requestUserInput",
      params: {
        itemId: "question-item",
        questions: [{
          allowOther: true,
          header: "choice",
          id: "choice",
          isSecret: false,
          options: [],
          question: "continue?",
        }],
        threadId: "thread",
        turnId: "turn",
      },
    });
    await bridge.handleUpstreamMessage({
      method: "serverRequest/resolved",
      params: { requestId: "question", threadId: "thread" },
    });
    const questionnaireNotifications = () => notifications
      .map(({ method }) => method)
      .filter(method => method?.startsWith("questionnaire/"));
    assert.deepEqual(questionnaireNotifications(), ["questionnaire/requested"]);

    await bridge.handleUpstreamMessage({
      id: "approval",
      method: "item/fileChange/requestApproval",
      params: {
        grantRoot: "C:/outside",
        itemId: "approval-item",
        reason: "write outside the workspace",
        threadId: "thread",
        turnId: "turn",
      },
    });
    await bridge.handleUpstreamMessage({
      method: "serverRequest/resolved",
      params: { requestId: "approval", threadId: "thread" },
    });
    assert.deepEqual(questionnaireNotifications(), [
      "questionnaire/requested",
      "questionnaire/requested",
      "questionnaire/resolved",
    ]);
  } finally {
    await bridge.disposeImmediately();
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("replacement bridge sanitizes legacy handoff state and initializes the new generation", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-bridge-app-server-upgrade-"));
  const legacyState = {
    initializeResult: { stale: "generation" },
    pendingResponses: new Map(),
    pendingUserInputRequests: new Map(),
    requestIdAllocator: { next: 7 },
    upstreamInitialized: true,
  };
  let replacement: InstanceType<typeof CodexStdioBridge> | null = null;
  try {
    const upstreamRequests: JsonRpcRequest[] = [];
    const appServer = {
      send(message: JsonRpcRequest) {
        upstreamRequests.push(message);
        queueMicrotask(() => {
          void replacement!.handleUpstreamMessage({ id: message.id ?? null, result: { fresh: "generation" } });
        });
      },
    } as unknown as CodexAppServer;
    replacement = new CodexStdioBridge({
      appServer,
      bridgeUrl: "ws://127.0.0.1:1",
      handleWorkbenchRequest: rejectWorkbenchRequest,
      initialState: legacyState,
      onNotification() {},
      restartingAppServer: true,
      resolveProjectFromCwd: async () => null,
      sendToClient() {},
      storageRoot: root,
    });
    assert.equal(replacement.getInitializeResult(), null);
    await replacement.ensureInitialized({ id: 0, method: "initialize", params: {} });
    assert.deepEqual(upstreamRequests.map(({ method }) => method), ["initialize", "initialized"]);
    assert.deepEqual(replacement.getInitializeResult(), { fresh: "generation" });
  } finally {
    await replacement?.disposeImmediately();
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("thread pages map first and continuation reads into Codex-owned hydration", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-bridge-thread-page-"));
  const upstreamRequests: JsonRpcRequest[] = [];
  const contextRequests: JsonRpcRequest[] = [];
  let bridge!: InstanceType<typeof CodexStdioBridge>;
  const appServer = {
    send(message: JsonRpcRequest) {
      upstreamRequests.push(message);
      queueMicrotask(() => {
        void bridge.handleUpstreamMessage({
          id: message.id ?? null,
          result: {
            model: "gpt-test",
            reasoningEffort: "high",
            serviceTier: "fast",
            thread: { ...bridgeThread(), turns: [] },
          },
        });
      });
    },
  } as unknown as CodexAppServer;
  bridge = new CodexStdioBridge({
    appServer,
    bridgeUrl: "ws://127.0.0.1:1",
    handleWorkbenchRequest: rejectWorkbenchRequest,
    instructions: new WorkbenchCodexInstructionAdapter("ws://127.0.0.1:1", root),
    onNotification() {},
    resolveProjectFromCwd: async () => null,
    sendToClient() {},
    storageRoot: root,
  });
  const pageOwner = bridge as unknown as {
    readThreadContext(message: JsonRpcRequest): Promise<{
      browseResultEntries: [];
      questionnaireEntries: [];
      steerEntries: [];
      thread: Thread;
    }>;
  };
  pageOwner.readThreadContext = async (message) => {
    contextRequests.push(message);
    return {
      browseResultEntries: [],
      questionnaireEntries: [],
      steerEntries: [],
      thread: {
        ...bridgeThread(),
        turns: [bridgeThread().turns[0]!],
        workbenchTurnHistory: [
          { completedAt: 1, durationMs: 1, itemCount: 0, loadState: "unloaded", startedAt: 1, status: "completed", turnId: "older" },
          { completedAt: null, durationMs: null, itemCount: 0, loadState: "loaded", startedAt: 1, status: "inProgress", turnId: "turn" },
        ],
      },
    };
  };

  try {
    const first = await bridge.handleBridgeRequest({
      id: 1,
      method: "workbench/thread/page/read",
      params: { cursor: null, cwd: "C:/repo", threadId: "thread" },
      workbenchPromptContext: {
        cwd: "C:/repo",
        harness: "codex",
        threadId: "thread",
        workflowIds: ["default"],
      },
    });
    assert.deepEqual(upstreamRequests, []);
    assert.deepEqual(contextRequests[0], {
      method: "thread/context/read",
      params: { includeTurns: false, threadId: "thread" },
      workbenchThreadContextEntries: { mode: "hydratedTurns" },
      workbenchThreadHydration: { mode: "latest" },
    });
    assert.equal((first?.result as { nextCursor?: string }).nextCursor, "turn");

    await bridge.handleBridgeRequest({
      id: 2,
      method: "workbench/thread/page/read",
      params: { cursor: "turn", threadId: "thread" },
    });
    assert.equal(upstreamRequests.length, 0);
    assert.deepEqual(contextRequests[1]?.workbenchThreadHydration, {
      beforeTurnId: "turn",
      mode: "previous",
    });

    await bridge.handleBridgeRequest({
      id: 3,
      method: "workbench/thread/page/read",
      params: { cursor: null, cwd: "C:/repo", readScope: "subagentBackground", threadId: "thread" },
    });
    assert.equal(upstreamRequests.length, 0);
  } finally {
    await bridge.waitForIdle();
    await bridge.disposeImmediately();
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("foreground thread pages durably repair a newer turn omitted by an inactive provider catalog", async (context) => {
  const sql = await recordingFixture();
  context.mock.method(console, "warn", () => undefined);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-bridge-foreground-turn-repair-"));
  const recordingStarted = deferred<void>();
  const releaseRecording = deferred<void>();
  const upstreamRequests: JsonRpcRequest[] = [];
  let holdRecording = false;
  const predecessor = {
    ...bridgeThread().turns[0]!,
    completedAt: 2,
    durationMs: 1_000,
    id: "predecessor",
    items: [],
    itemsView: "notLoaded" as const,
    status: "completed" as const,
  };
  const reasoningItem: ThreadItem = {
    content: ["private trace"],
    id: "rs-native",
    summary: ["reasoning summary"],
    type: "reasoning",
  };
  const mcpItem: ThreadItem = {
    appContext: null,
    arguments: { path: "docs/invariants/ownership.md" },
    durationMs: null,
    error: null,
    id: "exec-native",
    pluginId: null,
    readOnlyHint: true,
    result: null,
    server: "wb",
    status: "inProgress",
    tool: "shell",
    type: "mcpToolCall",
  };
  const latest = {
    ...bridgeThread([reasoningItem, mcpItem]).turns[0]!,
    id: "latest",
    startedAt: 3,
  };
  const providerThread = {
    ...bridgeThread(),
    status: { type: "notLoaded" as const },
    turns: [],
    updatedAt: 5,
  };
  let bridge!: InstanceType<typeof CodexStdioBridge>;
  const appServer = {
    send(message: JsonRpcRequest) {
      upstreamRequests.push(message);
      queueMicrotask(() => {
        const params = message.params as { itemsView?: string };
        const result = message.method === "thread/read"
          ? { thread: providerThread }
          : message.method === "thread/turns/list"
            ? {
              data: [params.itemsView === "full"
                ? { ...predecessor, itemsView: "full" as const }
                : predecessor],
              nextCursor: "before-predecessor",
            }
            : {};
        void bridge.handleUpstreamMessage({ id: message.id ?? null, result });
      });
    },
  } as unknown as CodexAppServer;
  bridge = new CodexStdioBridge({
    ...sql.ports,
    appServer,
    bridgeUrl: "ws://127.0.0.1:1",
    handleWorkbenchRequest: rejectWorkbenchRequest,
    onNotification() {},
    recordSqliteTranscript: async (observations) => {
      if (holdRecording) {
        recordingStarted.resolve();
        await releaseRecording.promise;
      }
      await sql.ports.recordSqliteTranscript(observations);
    },
    sendToClient() {},
    storageRoot: root,
  });
  try {
    await bridge.handleUpstreamMessage({
      method: "thread/started",
      params: { thread: { ...bridgeThread(), turns: [] } },
    });
    await bridge.handleUpstreamMessage({
      method: "turn/completed",
      params: {
        threadId: "thread",
        turn: { ...predecessor, itemsView: "full" },
      },
    });
    await bridge.handleUpstreamMessage({
      method: "turn/started",
      params: { threadId: "thread", turn: latest },
    });
    await bridge.waitForIdle();
    const beforeRecovery = sql.project().projection.turns.at(-1);
    assert.ok(beforeRecovery);
    const originalItemIds = beforeRecovery.items.map(({ id }) => id);
    assert.equal(originalItemIds.length, 2);
    upstreamRequests.length = 0;
    holdRecording = true;
    let responseResolved = false;
    const responsePromise = bridge.handleBridgeRequest({
      id: 1,
      method: "workbench/thread/page/read",
      params: { cursor: null, threadId: "thread" },
    }).then(response => {
      responseResolved = true;
      return response;
    });

    await recordingStarted.promise;
    assert.equal(responseResolved, false, "foreground page response must await repaired SQLite settlement");
    releaseRecording.resolve();
    const response = await responsePromise;
    const repaired = (response?.result as WorkbenchThreadPageResponse).thread.turns.at(-1);
    const expectedLatestId = sql.ports.identities.threads.workbenchTurnIdForNative({
      harness: "codex",
      nativeLocation: "C:/repo",
      nativeThreadId: fixtureIdentityValues.NativeThreadId.thread,
      nativeTurnId: fixtureIdentitySchemas.NativeTurnIdSchema.parse(latest.id),
    });
    const expectedThreadId = sql.ports.identities.threads.workbenchIdForNative({
      harness: "codex",
      nativeLocation: "C:/repo",
      nativeThreadId: fixtureIdentityValues.NativeThreadId.thread,
    });
    assert.equal(repaired?.id, expectedLatestId);
    assert.equal(repaired?.status, "interrupted");
    assert.deepEqual(upstreamRequests.map(({ method, params }) => ({
      itemsView: (params as { itemsView?: string }).itemsView,
      method,
    })), [
      { itemsView: undefined, method: "thread/read" },
      { itemsView: "notLoaded", method: "thread/turns/list" },
    ]);
    const stored = sql.project().projection;
    const storedLatest = stored.turns.at(-1);
    assert.equal(storedLatest?.status, "interrupted");
    assert.deepEqual(storedLatest?.items.map(({ id }) => id), originalItemIds);
    for (const [itemId, nativeSourceId] of originalItemIds.map((itemId, index) => (
      [itemId, [reasoningItem.id, mcpItem.id][index]!] as const
    ))) {
      const identity = await sql.ports.identities.items.resolve({
        itemId: fixtureIdentitySchemas.WorkbenchItemIdSchema.parse(itemId),
        threadId: expectedThreadId,
        turnId: expectedLatestId,
      });
      assert.ok(identity);
      assert.equal(identity.sources.some(({ sourceId }) => sourceId === nativeSourceId), true);
      assert.equal(identity.sources.some(({ sourceId }) => sourceId === itemId), false);
    }
  } finally {
    releaseRecording.resolve();
    await bridge.waitForIdle();
    await bridge.disposeImmediately();
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("background thread pages await SQL repair without losing later live facts", async () => {
  const sql = await recordingFixture();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-bridge-thread-recovery-"));
  const recordingStarted = deferred<void>();
  const releaseRecording = deferred<void>();
  const laterProviderFactRecorded = deferred<void>();
  let holdRecording = false;
  const sqliteBatches: WorkbenchTranscriptObservation[][] = [];
  const upstreamRequests: JsonRpcRequest[] = [];
  const userItem: ThreadItem = {
    clientId: null,
    content: [{ text: "hello", text_elements: [], type: "text" }],
    id: "user",
    type: "userMessage",
  };
  const assistantItem: ThreadItem = {
    id: "assistant",
    memoryCitation: null,
    phase: "commentary",
    text: "recovered tail",
    delivery: null,
    questions: null,
    type: "agentMessage",
  };
  const staleTurn = {
    ...bridgeThread([userItem]).turns[0]!,
    items: [userItem],
  };
  const providerTurn = {
    ...staleTurn,
    completedAt: 3,
    durationMs: 2_000,
    items: [userItem, assistantItem],
    status: "interrupted" as const,
  };
  const providerThread = {
    ...bridgeThread(),
    status: { type: "idle" as const },
    turns: [],
  };
  let bridge!: InstanceType<typeof CodexStdioBridge>;
  const appServer = {
    send(message: JsonRpcRequest) {
      upstreamRequests.push(message);
      queueMicrotask(() => {
        const result = message.method === "thread/read"
          ? { thread: providerThread }
          : message.method === "thread/turns/list"
            ? { data: [providerTurn], nextCursor: null }
            : {};
        void bridge.handleUpstreamMessage({ id: message.id ?? null, result });
      });
    },
  } as unknown as CodexAppServer;
  bridge = new CodexStdioBridge({
    ...sql.ports,
    appServer,
    bridgeUrl: "ws://127.0.0.1:1",
    handleWorkbenchRequest: rejectWorkbenchRequest,
    onNotification() {},
    recordSqliteTranscript: async (observations) => {
      if (holdRecording) {
        recordingStarted.resolve();
        await releaseRecording.promise;
      }
      await sql.ports.recordSqliteTranscript(observations);
      sqliteBatches.push([...observations]);
      if (observations.length === 1 && observations[0]?.kind === "item") {
        laterProviderFactRecorded.resolve();
      }
    },
    resolveProjectFromCwd: async () => {
      return {
        cwd: "C:/repo",
        project: { id: fixtureIdentityValues.ProjectId.project, kind: "git", root: "C:/repo", rootPath: "C:/repo", roots: [] },
        root: { id: "root", name: "repo", root: "C:/repo", rootPath: "C:/repo" },
      };
    },
    sendToClient() {},
    storageRoot: root,
  });
  try {
    await bridge.handleUpstreamMessage({ method: "thread/started", params: { thread: { ...bridgeThread(), turns: [] } } });
    await bridge.handleUpstreamMessage({ method: "turn/started", params: { threadId: "thread", turn: staleTurn } });
    await bridge.waitForIdle();
    sqliteBatches.length = 0;
    holdRecording = true;
    let responseResolved = false;
    const responsePromise = bridge.handleBridgeRequest({
      id: 1,
      method: "workbench/thread/page/read",
      params: {
        cursor: null,
        readScope: "subagentBackground",
        threadId: "thread",
      },
    }).then(response => { responseResolved = true; return response; });
    await recordingStarted.promise;
    assert.equal(responseResolved, false, "page response must await durable settlement");
    await bridge.handleUpstreamMessage({
      id: "later-provider-fact",
      method: "item/tool/call",
      params: {
        arguments: { query: "later" },
        callId: "later-call",
        namespace: "workbench",
        threadId: "thread",
        tool: "search",
        turnId: "turn",
      },
    });
    releaseRecording.resolve();
    const response = await responsePromise;
    await laterProviderFactRecorded.promise;

    const recovered = (response?.result as WorkbenchThreadPageResponse).thread.turns[0]!;
    assert.equal(recovered.status, "interrupted");
    assert.deepEqual(recovered.items.map(({ type }) => type), ["userMessage", "agentMessage"]);
    assert.ok(recovered.items.some(item => item.type === "agentMessage" && item.text === "recovered tail"));
    assert.deepEqual(upstreamRequests.map(({ method }) => method), [
      "thread/read",
      "thread/turns/list",
    ]);
    assert.deepEqual(sqliteBatches.map((batch) => batch.map(({ kind }) => kind)), [
      ["providerTurnScope", "providerCursor"],
      ["item"],
    ]);
    const recoveredScope = sqliteBatches[0]?.[0];
    assert.equal(recoveredScope?.kind, "providerTurnScope");
    assert.deepEqual(
      recoveredScope?.kind === "providerTurnScope"
        ? recoveredScope.observations.map(({ kind }) => kind)
        : [],
      ["thread", "turn", "item", "item"],
    );
    assert.equal(sqliteBatches.flat().some(({ kind }) => kind === "canonicalWindow"), false);
  } finally {
    releaseRecording.resolve();
    await bridge.waitForIdle();
    await bridge.disposeImmediately();
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("provider catalog identities and the materialized page record as one SQL fact", async () => {
  const sql = await recordingFixture();
  const fixtureIdentities = sql.ports.identities;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-bridge-provider-window-"));
  const sqliteBatches: WorkbenchTranscriptObservation[][] = [];
  const pageItem: ThreadItem = {
    id: "assistant",
    memoryCitation: null,
    phase: "commentary",
    text: "latest",
    delivery: null,
    questions: null,
    type: "agentMessage",
  };
  const latest = bridgeThread([pageItem]).turns[0]!;
  const older = {
    ...latest,
    completedAt: 1,
    durationMs: 1,
    id: "older",
    items: [],
    itemsView: "notLoaded" as const,
    status: "completed" as const,
  };
  const metadata = { ...bridgeThread(), turns: [] } as Thread;
  const bridge = new CodexStdioBridge({
    ...sql.ports,
    appServer: { send() {} } as unknown as CodexAppServer,
    bridgeUrl: "ws://127.0.0.1:1",
    handleWorkbenchRequest: rejectWorkbenchRequest,
    onNotification() {},
    recordSqliteTranscript: async (observations) => {
      sqliteBatches.push([...observations]);
      await sql.ports.recordSqliteTranscript(observations);
    },
    resolveProjectFromCwd: async () => ({
      cwd: "C:/repo",
      project: { id: fixtureIdentityValues.ProjectId.project, kind: "git", root: "C:/repo", rootPath: "C:/repo", roots: [] },
      root: { id: "root", name: "repo", root: "C:/repo", rootPath: "C:/repo" },
    }),
    sendToClient() {},
    storageRoot: root,
  });
  const owner = bridge as unknown as {
    createThreadWindowStore(): {
      recordWindow(recording: {
        catalog: {
          boundary: { cursor: string | null; turnId: string };
          turns: Thread["turns"];
        };
        page: { previousCursor: string | null; turn: Thread["turns"][number] };
        source: "provider";
        thread: Thread;
      }): void;
    };
  };
  try {
    await owner.createThreadWindowStore().recordWindow({
      catalog: {
        boundary: { cursor: "before-latest", turnId: latest.id },
        turns: [older, latest],
      },
      page: { previousCursor: "before-latest", turn: latest },
      source: "provider",
      thread: metadata,
    });
    await bridge.waitForIdle();

    assert.deepEqual(sqliteBatches.map((batch) => batch.map(({ kind }) => kind)), [["providerTurnScope", "providerCursor"]]);
    const providerScope = sqliteBatches[0]?.[0];
    assert.equal(providerScope?.kind, "providerTurnScope");
    assert.deepEqual(
      providerScope?.kind === "providerTurnScope"
        ? providerScope.observations.map(({ kind }) => kind)
        : [],
      ["thread", "turn", "turn", "item"],
    );
    assert.deepEqual(
      providerScope?.kind === "providerTurnScope" ? providerScope.completeTurnIds : [],
      [fixtureIdentities.threads.workbenchTurnIdForNative({
        harness: "codex", nativeLocation: "C:/repo", nativeThreadId: fixtureIdentityValues.NativeThreadId.thread,
        nativeTurnId: fixtureIdentityValues.NativeTurnId.turn,
      })],
    );
    const { snapshot, projection } = sql.project(1);
    assert.deepEqual(snapshot.turns.map(turn => turn.native_turn_id), ["older", "turn"]);
    assert.deepEqual(projection.turns[0]?.items.map(item => item.type), ["agentMessage"]);
  } finally {
    await bridge.disposeImmediately();
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("non-empty terminal provider turns record as complete replacement scopes", async () => {
  const fixtureIdentities = await recordingIdentities();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-bridge-provider-turn-scope-"));
  const batches: WorkbenchTranscriptObservation[][] = [];
  const item: ThreadItem = {
    id: "answer",
    memoryCitation: null,
    phase: "final_answer",
    text: "done",
    delivery: null,
    questions: null,
    type: "agentMessage",
  };
  const bridge = new CodexStdioBridge({
    identities: fixtureIdentities,
    appServer: { send() {} } as unknown as CodexAppServer,
    bridgeUrl: "ws://127.0.0.1:1",
    handleWorkbenchRequest: rejectWorkbenchRequest,
    onNotification() {},
    recordSqliteTranscript: async (observations) => {
      batches.push([...observations]);
    },
    resolveProjectFromCwd: async () => ({
      cwd: "C:/repo",
      project: { id: fixtureIdentityValues.ProjectId.project, kind: "git", root: "C:/repo", rootPath: "C:/repo", roots: [] },
      root: { id: "root", name: "repo", root: "C:/repo", rootPath: "C:/repo" },
    }),
    sendToClient() {},
    storageRoot: root,
  });
  try {
    await bridge.handleUpstreamMessage({
      method: "thread/started",
      params: { thread: bridgeThread([]) },
    });
    await bridge.handleUpstreamMessage({
      method: "turn/completed",
      params: {
        threadId: "thread",
        turn: {
          ...bridgeThread([item]).turns[0]!,
          completedAt: 3,
          durationMs: 2_000,
          status: "completed",
        },
      },
    });
    await bridge.waitForIdle();

    const scope = batches.at(-1)?.[0];
    assert.equal(scope?.kind, "providerTurnScope");
    assert.deepEqual(
      scope?.kind === "providerTurnScope" ? scope.completeTurnIds : [],
      [fixtureIdentities.threads.workbenchTurnIdForNative({
        harness: "codex", nativeLocation: "C:/repo", nativeThreadId: fixtureIdentityValues.NativeThreadId.thread,
        nativeTurnId: fixtureIdentityValues.NativeTurnId.turn,
      })],
    );
    assert.deepEqual(
      scope?.kind === "providerTurnScope"
        ? scope.observations.map((observation) => observation.kind)
        : [],
      ["turn", "item"],
    );
  } finally {
    await bridge.disposeImmediately();
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("usage context follows resolved defaults, reloads, overrides and queued model changes without provider reads", async () => {
  const fixtureIdentities = await recordingIdentities();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-bridge-model-"));
  const observations: WorkbenchTranscriptObservation[] = [];
  const requests: string[] = [];
  let bridge!: InstanceType<typeof CodexStdioBridge>;
  let nextTurn = 0;
  const createBridge = (
    initialState?: import("./CodexStdioBridge").CodexStdioBridgeReloadState,
    restartingAppServer = false,
  ) => new CodexStdioBridge({
    identities: fixtureIdentities,
    appServer: {
      send(message: JsonRpcRequest) {
        requests.push(message.method!);
        const result = message.method === "thread/start" || message.method === "thread/resume"
          ? { thread: { ...bridgeThread([]), turns: [] }, model: "resolved", serviceTier: "fast" }
          : message.method === "turn/start"
            ? { turn: { ...bridgeThread([]).turns[0], id: `model-turn-${++nextTurn}` } }
            : null;
        queueMicrotask(() => { void bridge.handleUpstreamMessage({ id: message.id ?? null, result }); });
      },
    } as unknown as CodexAppServer,
    bridgeUrl: "ws://127.0.0.1:1", handleWorkbenchRequest: rejectWorkbenchRequest,
    instructions: new WorkbenchCodexInstructionAdapter("ws://127.0.0.1:1", root),
    initialState, restartingAppServer, onNotification() {}, sendToClient() {}, storageRoot: root,
    recordSqliteTranscript: async (batch) => { observations.push(...batch); },
    resolveProjectFromCwd: async () => ({
      cwd: "C:/repo",
      project: { id: fixtureIdentityValues.ProjectId.project, kind: "git", root: "C:/repo", rootPath: "C:/repo", roots: [] },
      root: { id: "root", name: "repo", root: "C:/repo", rootPath: "C:/repo" },
    }),
  });
  const startTurn = async (overrides = {}) => {
    const provider = bridge as unknown as {
      dispatchManagedProviderRequest(request: JsonRpcRequest): Promise<JsonRpcResponse>;
    };
    const response = await provider.dispatchManagedProviderRequest({ id: 20, method: "turn/start", params: {
      threadId: "thread", input: [], ...overrides,
    } });
    assert.equal(response.error, undefined);
    await bridge.waitForIdle();
    return observations.filter((observation) => observation.kind === "turnUsageContext").at(-1)!;
  };
  try {
    bridge = createBridge();
    await bridge.handleServerRequest({ id: 1, method: "thread/start", params: { cwd: "C:/repo" } });
    assert.equal((await startTurn()).model, "resolved");
    bridge = createBridge(await bridge.detachForReload());
    assert.equal((await startTurn()).model, "resolved");
    assert.equal((await startTurn({
      model: "plain", collaborationMode: { settings: { model: "collaboration" } },
    })).model, "collaboration");
    await bridge.handleUpstreamMessage({ method: "turn/started", params: {
      threadId: "thread", turn: { ...bridgeThread([]).turns[0], id: "model-turn-3" },
    } });
    await bridge.handleUpstreamMessage({ method: "thread/settings/updated", params: {
      threadId: "thread", threadSettings: { model: "changed", serviceTier: "fast" },
    } });
    await bridge.handleUpstreamMessage({ method: "turn/completed", params: {
      threadId: "thread", turn: { ...bridgeThread([]).turns[0], id: "model-turn-3", status: "completed" },
    } });
    await bridge.waitForIdle();
    assert.ok(observations.some((observation) => observation.kind === "turnUsageContext"
      && fixtureIdentities.threads.knownTurn(observation.turnId).native.nativeTurnId === "model-turn-3"
      && observation.model === "changed" && observation.modelChanged));
    bridge = createBridge(await bridge.detachForReload({ restartingAppServer: true }), true);
    assert.equal((await startTurn()).model, null);
    const provider = bridge as unknown as {
      dispatchManagedProviderRequest(request: JsonRpcRequest): Promise<JsonRpcResponse>;
    };
    const resumed = await provider.dispatchManagedProviderRequest({ id: 2, method: "thread/resume", params: { threadId: "thread" } });
    assert.equal(resumed.error, undefined);
    assert.equal((await startTurn()).model, "resolved");
    assert.deepEqual(requests, [
      "thread/start", "turn/start", "turn/start", "turn/start", "turn/start", "thread/resume", "turn/start",
    ]);
  } finally {
    await bridge.disposeImmediately();
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("live provider observations and active baselines stay ordered across a bridge reload", async () => {
  const fixtureIdentities = await recordingIdentities();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-bridge-sqlite-transcript-"));
  const batches: object[][] = [];
  let activeRecords = 0;
  let bridge!: InstanceType<typeof CodexStdioBridge>;
  const createBridge = (
    initialState?: import("./CodexStdioBridge").CodexStdioBridgeReloadState,
  ) => new CodexStdioBridge({
    identities: fixtureIdentities,
    appServer: {
      send(message: JsonRpcRequest) {
        if (message.method !== "thread/read" && message.method !== "thread/turns/list") return;
        queueMicrotask(() => {
          void bridge.handleUpstreamMessage({
            id: message.id ?? null,
            result: message.method === "thread/turns/list"
              ? { data: bridgeThread().turns, nextCursor: null }
              : { thread: { ...bridgeThread(), turns: [] } },
          });
        });
      },
    } as unknown as CodexAppServer,
    bridgeUrl: "ws://127.0.0.1:1",
    handleWorkbenchRequest: rejectWorkbenchRequest,
    initialState,
    onNotification() {},
    recordSqliteTranscript: async (observations) => {
      activeRecords += 1;
      assert.equal(activeRecords, 1);
      batches.push([...observations]);
      await Promise.resolve();
      activeRecords -= 1;
    },
    resolveProjectFromCwd: async () => ({
      cwd: "C:/repo",
      project: { id: fixtureIdentityValues.ProjectId.project, kind: "git", root: "C:/repo", rootPath: "C:/repo", roots: [] },
      root: { id: "root", name: "repo", root: "C:/repo", rootPath: "C:/repo" },
    }),
    sendToClient() {},
    storageRoot: root,
  });
  const item: ThreadItem = {
    type: "agentMessage",
    id: "message",
    text: "hello",
    phase: "commentary",
    memoryCitation: null,
    delivery: null,
    questions: null,
  };
  try {
    bridge = createBridge();
    await bridge.handleUpstreamMessage({ method: "thread/started", params: { thread: bridgeThread([]) } });
    await bridge.handleUpstreamMessage({
      method: "turn/started",
      params: { threadId: "thread", turn: bridgeThread([]).turns[0] },
    });
    assert.deepEqual(bridge.activeSqliteTranscriptThreadIds, [fixtureIdentities.threads.workbenchIdForNative({
      harness: "codex", nativeLocation: "C:/repo", nativeThreadId: fixtureIdentityValues.NativeThreadId.thread,
    })]);
    await bridge.handleUpstreamMessage({
      method: "item/completed",
      params: { completedAtMs: 2_000, item, threadId: "thread", turnId: "turn" },
    });
    await bridge.waitForIdle();
    assert.deepEqual(batches.flatMap((batch) => batch.map((observation) => (
      (observation as { kind: string }).kind
    ))), ["thread", "turn", "turn", "item"]);
    const bootstrap = batches[0] as Array<{ kind: string; turnIndex?: number }>;
    assert.deepEqual(
      bootstrap.map(({ kind, turnIndex }) => ({ kind, turnIndex })),
      [{ kind: "thread", turnIndex: undefined }, { kind: "turn", turnIndex: 0 }],
    );

    const state = await bridge.detachForReload();
    bridge = createBridge(state);
    assert.deepEqual(bridge.activeSqliteTranscriptThreadIds, [fixtureIdentities.threads.workbenchIdForNative({
      harness: "codex", nativeLocation: "C:/repo", nativeThreadId: fixtureIdentityValues.NativeThreadId.thread,
    })]);
    const batchesBeforeBaseline = batches.length;
    await bridge.baselineSqliteTranscriptThread("thread");
    assert.ok(batches.length > batchesBeforeBaseline);
    assert.deepEqual(
      batches.at(-1)?.map((observation) => (observation as { kind?: string }).kind),
      ["providerTurnScope"],
    );
    await bridge.handleUpstreamMessage({
      method: "turn/completed",
      params: {
        threadId: "thread",
        turn: {
          ...bridgeThread([]).turns[0],
          completedAt: null,
          durationMs: null,
          startedAt: null,
          status: "completed",
        },
      },
    });
    await bridge.waitForIdle();
    assert.deepEqual(bridge.activeSqliteTranscriptThreadIds, []);
    assert.equal((batches.at(-1)?.[0] as { kind?: string })?.kind, "turn");

    const replacementState = await bridge.detachForReload();
    bridge = createBridge(replacementState);
    await bridge.handleUpstreamMessage({
      method: "turn/completed",
      params: {
        threadId: "thread",
        turn: {
          ...bridgeThread([]).turns[0],
          completedAt: 3,
          durationMs: 2_000,
          status: "completed",
        },
      },
    });
    await bridge.waitForIdle();
    assert.equal((batches.at(-1)?.[0] as { kind?: string })?.kind, "turn");
  } finally {
    await bridge.disposeImmediately();
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("blocked SQLite recording holds bridge detach", async () => {
  const fixtureIdentities = await recordingIdentities();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-bridge-blocked-shadow-"));
  const sqliteStarted = deferred<void>();
  const releaseSqlite = deferred<void>();
  const bridge = new CodexStdioBridge({
    identities: fixtureIdentities,
    appServer: { send() {} } as unknown as CodexAppServer,
    bridgeUrl: "ws://127.0.0.1:1",
    handleWorkbenchRequest: rejectWorkbenchRequest,
    onNotification() {},
    recordSqliteTranscript: async () => {
      sqliteStarted.resolve();
      await releaseSqlite.promise;
    },
    resolveProjectFromCwd: async () => ({
      cwd: "C:/repo",
      project: { id: fixtureIdentityValues.ProjectId.project, kind: "git", root: "C:/repo", rootPath: "C:/repo", roots: [] },
      root: { id: "root", name: "repo", root: "C:/repo", rootPath: "C:/repo" },
    }),
    sendToClient() {},
    storageRoot: root,
  });
  try {
    await bridge.handleUpstreamMessage({ method: "thread/started", params: { thread: bridgeThread([]) } });
    await sqliteStarted.promise;
    let detached = false;
    const detach = bridge.detachForReload().then((state) => {
      detached = true;
      return state;
    });
    await Promise.resolve();
    assert.equal(detached, false);
    releaseSqlite.resolve();
    const state = await detach;
    assert.equal(state.upstreamInitialized, false);
  } finally {
    releaseSqlite.resolve();
    await bridge.disposeImmediately();
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("provider-live transcript bursts bypass durable recording until item settlement", async () => {
  const sql = await recordingFixture();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-bridge-live-only-transcript-"));
  const notifications: string[] = [];
  const sqliteBatches: WorkbenchTranscriptObservation[][] = [];
  const bridge = new CodexStdioBridge({
    ...sql.ports,
    appServer: { send() {} } as unknown as CodexAppServer,
    bridgeUrl: "ws://127.0.0.1:1",
    handleWorkbenchRequest: rejectWorkbenchRequest,
    onNotification(notification) {
      notifications.push(notification.method ?? "");
    },
    recordSqliteTranscript: async (observations) => {
      sqliteBatches.push([...observations]);
      await sql.ports.recordSqliteTranscript(observations);
    },
    resolveProjectFromCwd: async () => ({
      cwd: "C:/repo",
      project: { id: fixtureIdentityValues.ProjectId.project, kind: "git", root: "C:/repo", rootPath: "C:/repo", roots: [] },
      root: { id: "root", name: "repo", root: "C:/repo", rootPath: "C:/repo" },
    }),
    sendToClient() {},
    storageRoot: root,
  });
  const streamingItem: ThreadItem = {
    id: "message",
    memoryCitation: null,
    phase: "commentary",
    text: "",
    delivery: null,
    questions: null,
    type: "agentMessage",
  };
  try {
    await bridge.handleUpstreamMessage({
      method: "thread/started",
      params: { thread: { ...bridgeThread(), turns: [] } },
    });
    await bridge.handleUpstreamMessage({
      method: "turn/started",
      params: { threadId: "thread", turn: bridgeThread().turns[0] },
    });
    await bridge.handleUpstreamMessage({
      method: "item/started",
      params: { item: streamingItem, startedAtMs: 1_000, threadId: "thread", turnId: "turn" },
    });
    await bridge.waitForIdle();
    const durableBatchCount = sqliteBatches.length;

    for (let index = 0; index < 200; index += 1) {
      await bridge.handleUpstreamMessage({
        method: "item/agentMessage/delta",
        params: { delta: String(index % 10), itemId: "message", threadId: "thread", turnId: "turn" },
      });
    }
    await bridge.handleUpstreamMessage({
      method: "turn/diff/updated",
      params: { diff: "large cumulative diff", threadId: "thread", turnId: "turn" },
    });
    await bridge.handleUpstreamMessage({
      method: "turn/plan/updated",
      params: { explanation: null, plan: [], threadId: "thread", turnId: "turn" },
    });
    await bridge.handleUpstreamMessage({
      method: "item/plan/delta",
      params: { delta: "native delta", itemId: "native-plan", threadId: "thread", turnId: "turn" },
    });
    const nativePlan: ThreadItem = { id: "native-plan", text: "native plan", type: "plan" };
    await bridge.handleUpstreamMessage({
      method: "item/started",
      params: { item: nativePlan, startedAtMs: 1_500, threadId: "thread", turnId: "turn" },
    });
    await bridge.handleUpstreamMessage({
      method: "item/completed",
      params: { completedAtMs: 1_600, item: nativePlan, threadId: "thread", turnId: "turn" },
    });
    await bridge.waitForIdle();

    assert.equal(notifications.filter((method) => method === "item/agentMessage/delta").length, 200);
    assert.equal(notifications.includes("turn/diff/updated"), true);
    assert.equal(notifications.includes("turn/plan/updated"), false);
    assert.equal(notifications.includes("item/plan/delta"), false);
    assert.equal(notifications.filter((method) => method === "item/started").length, 1);
    assert.equal(notifications.filter((method) => method === "item/completed").length, 0);
    assert.equal(sqliteBatches.length, durableBatchCount);
    const liveOnlyWindow = sql.project().projection;
    assert.equal(liveOnlyWindow?.turns[0]?.items[0]?.type, "agentMessage");
    assert.equal(
      liveOnlyWindow?.turns[0]?.items[0]?.type === "agentMessage"
        ? liveOnlyWindow.turns[0].items[0].text
        : null,
      "",
    );

    const completedItem = { ...streamingItem, text: "settled" };
    await bridge.handleUpstreamMessage({
      method: "item/completed",
      params: { completedAtMs: 2_000, item: completedItem, threadId: "thread", turnId: "turn" },
    });
    await bridge.waitForIdle();

    assert.equal(sqliteBatches.length, durableBatchCount + 1);
    const settledWindow = sql.project().projection;
    assert.equal(
      settledWindow?.turns[0]?.items[0]?.type === "agentMessage"
        ? settledWindow.turns[0].items[0].text
        : null,
      "settled",
    );
  } finally {
    await bridge.disposeImmediately();
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("only explicit SQLite recovery reads close the exact provider gap after settlement", async () => {
  const fixtureIdentities = await recordingIdentities();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-bridge-transcript-recovery-"));
  const contexts: Array<{ recoveryBoundary?: boolean; source: string }> = [];
  const upstreamMessages: JsonRpcRequest[] = [];
  const sqliteStarted = deferred<void>();
  const releaseSqlite = deferred<void>();
  let bridge!: InstanceType<typeof CodexStdioBridge>;
  const appServer = {
    send(message: JsonRpcRequest) {
      upstreamMessages.push(message);
      queueMicrotask(() => {
        void bridge.handleUpstreamMessage({
          id: message.id ?? null,
          result: message.method === "thread/turns/list"
            ? { data: bridgeThread().turns, nextCursor: null }
            : { thread: { ...bridgeThread(), turns: [] } },
        });
      });
    },
  } as unknown as CodexAppServer;
  bridge = new CodexStdioBridge({
    identities: fixtureIdentities,
    appServer,
    bridgeUrl: "ws://127.0.0.1:1",
    handleWorkbenchRequest: rejectWorkbenchRequest,
    onNotification() {},
    recordSqliteTranscript: async (_observations, context) => {
      contexts.push(context);
      sqliteStarted.resolve();
      await releaseSqlite.promise;
    },
    resolveProjectFromCwd: async () => ({
      cwd: "C:/repo",
      project: { id: fixtureIdentityValues.ProjectId.project, kind: "git", root: "C:/repo", rootPath: "C:/repo", roots: [] },
      root: { id: "root", name: "repo", root: "C:/repo", rootPath: "C:/repo" },
    }),
    sendToClient() {},
    storageRoot: root,
  });
  try {
    let requestSettled = false;
    const request = bridge.recoverSqliteTranscriptThread("thread").then(() => {
      requestSettled = true;
    });
    await sqliteStarted.promise;
    await Promise.resolve();
    assert.equal(requestSettled, false);
    releaseSqlite.resolve();
    await request;
    await bridge.waitForIdle();
    await bridge.handleServerRequest({
      id: "ordinary-read",
      method: "thread/read",
      params: { includeTurns: true, threadId: "thread" },
    });
    await bridge.waitForIdle();
    assert.equal(upstreamMessages.length, 4);
    assert.equal(upstreamMessages[0]?.method, "thread/read");
    assert.deepEqual(upstreamMessages[0]?.params, { includeTurns: false, threadId: "thread" });
    assert.deepEqual(contexts, [
      { source: "provider" },
      { source: "provider" },
      { recoveryBoundary: true, source: "provider" },
    ]);
  } finally {
    releaseSqlite.resolve();
    await bridge.disposeImmediately();
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("failed process replacement resumes the retained initialized bridge", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-bridge-rollback-"));
  let sent = false;
  const bridge = new CodexStdioBridge({
    appServer: { send() { sent = true; } } as unknown as CodexAppServer,
    bridgeUrl: "ws://127.0.0.1:1",
    handleWorkbenchRequest: rejectWorkbenchRequest,
    initialState: {
      initializeResult: { retained: true },
      pendingResponses: new Map(),
      pendingUserInputRequests: new Map(),
      requestIdAllocator: { next: 7 },
      upstreamInitialized: true,
    },
    onNotification() {},
    resolveProjectFromCwd: async () => null,
    sendToClient() {},
    storageRoot: root,
  });
  try {
    const candidateState = await bridge.detachForReload({ restartingAppServer: true });
    assert.equal(candidateState.upstreamInitialized, false);
    bridge.resumeAfterReloadFailure();
    await bridge.ensureInitialized({ id: 0, method: "initialize", params: {} });
    assert.deepEqual(bridge.getInitializeResult(), { retained: true });
    assert.equal(sent, false);
  } finally {
    await bridge.disposeImmediately();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("rollback starts a fresh initialization without letting the old attempt overwrite it", async () => {
  const oldResponse = deferred<JsonRpcResponse>();
  const bridge = new CodexStdioBridge({
    appServer: { send() {} } as unknown as CodexAppServer,
    bridgeUrl: "ws://127.0.0.1:1", handleWorkbenchRequest: rejectWorkbenchRequest,
    onNotification() {}, resolveProjectFromCwd: async () => null, sendToClient() {},
    storageRoot: testWorkbenchLibraryRoot,
  });
  let attempts = 0;
  const owner = bridge as unknown as { dispatchRequest(): Promise<{ response: Promise<JsonRpcResponse> }> };
  owner.dispatchRequest = async () => ({
    response: ++attempts === 1 ? oldResponse.promise : Promise.resolve({ id: 2, result: { fresh: true } }),
  });
  const first = bridge.ensureInitialized({ method: "initialize" }).catch(error => error);
  let second: Promise<void> | undefined;
  try {
    bridge.expireForReload();
    bridge.resumeAfterReloadFailure();
    second = bridge.ensureInitialized({ method: "initialize" });
    assert.equal(attempts, 2);
    await second;
    oldResponse.resolve({ id: 1, result: { stale: true } });
    assert.match(String(await first), /retired/);
    assert.deepEqual(bridge.getInitializeResult(), { fresh: true });
  } finally {
    oldResponse.resolve({ id: 1, result: { stale: true } });
    await first;
    await second?.catch(() => undefined);
    await bridge.disposeImmediately();
  }
});

test("an expired page read cannot begin transcript hydration after the old provider reply arrives", async () => {
  const entered = deferred<void>();
  const upstream = deferred<JsonRpcResponse>();
  const finished = deferred<void>();
  const bridge = new CodexStdioBridge({
    appServer: { send() {} } as unknown as CodexAppServer,
    bridgeUrl: "ws://127.0.0.1:1",
    handleWorkbenchRequest: rejectWorkbenchRequest,
    onNotification() {},
    resolveProjectFromCwd: async () => null,
    sendToClient() {},
    storageRoot: testWorkbenchLibraryRoot,
  });
  const owner = bridge as unknown as {
    dispatchRequest(): Promise<{ response: Promise<JsonRpcResponse> }>;
    readSqliteThreadContext(): Promise<never>;
    readThreadContext(...args: [JsonRpcRequest, AbortSignal?]): Promise<object>;
  };
  let hydrationStarted = false;
  owner.dispatchRequest = async () => { entered.resolve(); return { response: upstream.promise }; };
  owner.readSqliteThreadContext = async () => { hydrationStarted = true; throw new Error("late hydration"); };
  const readContext = owner.readThreadContext.bind(bridge);
  owner.readThreadContext = async (...args) => {
    try { return await readContext(...args); }
    finally { finished.resolve(); }
  };
  try {
    const reading = bridge.handleBridgeRequest({ id: 1, method: "workbench/thread/page/read", params: { threadId: "thread", cursor: null } });
    await entered.promise;
    bridge.expireForReload();
    assert.match((await reading)?.error?.message ?? "", /retired/);
    bridge.resumeAfterReloadFailure();
    upstream.resolve({ id: 1, result: { thread: bridgeThread() } });
    await finished.promise;
    assert.equal(hydrationStarted, false);
  } finally {
    upstream.resolve({ id: 1, error: { code: -32000, message: "cleanup" } });
    await bridge.disposeImmediately();
  }
});

test("expired command preparation cannot send through a bridge resumed after rollback", async () => {
  const entered = deferred<void>();
  const release = deferred<void>();
  const instructions = new WorkbenchCodexInstructionAdapter("ws://127.0.0.1:1", testWorkbenchLibraryRoot);
  instructions.augment = async message => { entered.resolve(); await release.promise; return message; };
  let sends = 0;
  const bridge = new CodexStdioBridge({
    appServer: { send() { sends++; } } as unknown as CodexAppServer,
    bridgeUrl: "ws://127.0.0.1:1", instructions,
    handleWorkbenchRequest: rejectWorkbenchRequest, onNotification() {},
    resolveProjectFromCwd: async () => null, sendToClient() {},
    storageRoot: testWorkbenchLibraryRoot,
  });
  const client: BridgeClient = { OPEN: 1, readyState: 1, send() {}, close() {}, on() {}, once() {} };
  try {
    const preparing = bridge.forwardRequest({ id: 1, method: "thread/read", params: { threadId: "thread" } }, client, 1);
    const rejected = assert.rejects(preparing, /retired/);
    await entered.promise;
    bridge.expireForReload();
    bridge.resumeAfterReloadFailure();
    release.resolve();
    await rejected;
    assert.equal(sends, 0);
  } finally {
    release.resolve();
    await bridge.disposeImmediately();
  }
});

test("SQLite recovery rejects unknown WB identity before contacting the provider", async () => {
  const upstream: JsonRpcRequest[] = [];
  const bridge = new CodexStdioBridge({
    appServer: { send: (request: JsonRpcRequest) => {
      upstream.push(request);
      queueMicrotask(() => void bridge.handleUpstreamMessage({
        id: request.id, error: { code: -32000, message: "thread not loaded" },
      }));
    } } as unknown as CodexAppServer,
    bridgeUrl: "ws://127.0.0.1:1",
    handleWorkbenchRequest: rejectWorkbenchRequest,
    identities: { threads: { resolve: async () => null } } as unknown as NonNullable<ConstructorParameters<typeof CodexStdioBridge>[0]["identities"]>,
    onNotification() {}, sendToClient() {}, resolveProjectFromCwd: async () => null, storageRoot: ".",
  });
  try {
    await assert.rejects(bridge.recoverSqliteTranscriptThread("missing-wb-id"), /binding|identity/);
    assert.deepEqual(upstream, []);
  } finally {
    await bridge.disposeImmediately();
  }
});

test("paged recovery shares one worker across independent thread histories", async parent => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-real-recovery-"));
  const database = new WorkbenchDatabaseController({ databasePath: path.join(root, "database.sqlite3") });
  const gaps = new WorkbenchTranscriptCaptureGapController({ database });
  const transcript = new WorkbenchTranscriptController(database, gaps);
  const identities = {
    threads: new WorkbenchThreadIdentityController(database),
    items: new WorkbenchTranscriptIdentityController(database),
  };
  parent.after(async () => {
    transcript.dispose();
    identities.threads.dispose();
    identities.items.dispose();
    await database.close();
    await fs.rm(root, { force: true, recursive: true });
  });
  await transcript.start();
  await identities.threads.start();
  for (const interruption of ["none", "recorder failure", "cancellation"] as const) {
    await parent.test(`paged recovery settles real WB identities and preserves the marker after ${interruption}`, async (context) => {
      const diagnostics = captureTestOutput(context, process.stderr, text =>
        text.startsWith("[codex-transcript] capture failed sqlite-recovery-page:") && text.includes("cause=page recording failed"));
      context.after(() => assert.equal(diagnostics.length, interruption === "recorder failure" ? 1 : 0));
      const nativeThreadId = NativeThreadIdSchema.parse(`thread-${interruption.replaceAll(" ", "-")}`);
      const requests: JsonRpcRequest[] = [];
      const cancellation = new AbortController();
      const turns = ["old", "new"].map((id, index) => ({
        ...bridgeThread([{
          type: "agentMessage", id: `${id}-message`, text: id, phase: "commentary",
          memoryCitation: null, delivery: null, questions: null,
        }]).turns[0]!,
        id, startedAt: index + 1,
      }));
      let pages = 0;
      let interrupt = interruption;
      const bridge = new CodexStdioBridge({
        appServer: { send(request: JsonRpcRequest) {
          requests.push(request);
          const params = request.params as { threadId: string; cursor?: string; itemsView?: string };
          assert.equal(params.threadId, nativeThreadId, "only the native binding goes upstream");
          queueMicrotask(() => void bridge.handleUpstreamMessage({
            id: request.id,
            result: request.method === "thread/read"
              ? { thread: { ...bridgeThread(), id: nativeThreadId, turns: [] } }
              : params.itemsView === "notLoaded"
                ? { data: [...turns].reverse().map((turn) => ({ ...turn, items: [], itemsView: "notLoaded" })), nextCursor: null }
                : { data: [params.cursor ? turns[0] : turns[1]], nextCursor: params.cursor ? null : "older" },
          }));
        } } as unknown as CodexAppServer,
        bridgeUrl: "ws://127.0.0.1:1", handleWorkbenchRequest: rejectWorkbenchRequest,
        identities, onNotification() {}, sendToClient() {}, storageRoot: root,
        resolveProjectFromCwd: async () => ({
          cwd: "C:/repo", project: { id: fixtureIdentityValues.ProjectId.project, kind: "git", root: "C:/repo", rootPath: "C:/repo", roots: [] },
          root: { id: "root", name: "repo", root: "C:/repo", rootPath: "C:/repo" },
        }),
        recordSqliteTranscript: async (observations, context) => {
          const fullPage = observations.some((entry) => entry.kind === "providerTurnScope" && entry.completeTurnIds.length > 0);
          if (context.recoveryBoundary) {
            assert.equal(pages, 2, "no gap closure before both full pages settle");
          } else if (fullPage) {
            pages++;
            assert.equal((await gaps.pendingRecoveryThreadIds).length, 1);
            if (interrupt === "recorder failure") throw new Error("page recording failed");
          }
          await transcript.record(observations, context);
          if (fullPage && interrupt === "cancellation") cancellation.abort(new Error("retiring"));
        },
      });
      try {
        const identity = await identities.threads.observe({
          native: { harness: "codex", nativeLocation: "C:/repo", nativeThreadId },
          projectId: fixtureIdentityValues.ProjectId["project"], projectRoot: "C:/repo", title: "recovery",
          createdAt: 1, updatedAt: 2, activityAt: 2,
        });
        await gaps.captureFailure({
          error: new Error("retained gap"), recoverability: "provider", threadId: identity.threadId, turnId: null,
        });
        if (interruption !== "none") {
          await assert.rejects(bridge.recoverSqliteTranscriptThread(identity.threadId, cancellation.signal));
          assert.deepEqual(await gaps.pendingRecoveryThreadIds, [identity.threadId]);
          assert.equal(requests.filter(({ method }) => method === "thread/turns/list").length, 2);
          interrupt = "none";
          pages = 0;
        }
        await bridge.recoverSqliteTranscriptThread(identity.threadId);
        assert.deepEqual(await gaps.pendingRecoveryThreadIds, []);
        const snapshot = await transcript.read({ threadId: identity.threadId, turnLimit: 10 });
        assert.equal(snapshot?.thread.id, identity.threadId);
        assert.ok(snapshot);
        const projection = projectWorkbenchTranscript(snapshot);
        assert.ok(projection.success);
        assert.deepEqual(projection.data.turns.flatMap(({ items }) => items.map((item) => (
          item.type === "agentMessage" ? item.text : item.type
        ))), ["old", "new"]);
        assert.ok(projection.data.turns.every((turn) => turn.id !== "old" && turn.id !== "new"));
        assert.ok(requests.every(({ method, params }) => (
          method !== "thread/read" || (params as { includeTurns: boolean }).includeTurns === false
        )));
      } finally {
        await bridge.disposeImmediately();
      }
    });
  }
});

async function recordingIdentities(options: { database?: InstanceType<typeof Database>; existingTurn?: boolean; nativeLocation?: string } = {}) {
  const database = options.database ?? databaseFixture();
  const nativeLocation = options.nativeLocation ?? "C:/repo";
  const repository = new WorkbenchThreadIdentityRepository(database);
  const itemRepository = new WorkbenchTranscriptIdentityRepository(database);
  const thread = repository.observe({
    native: { harness: "codex", nativeLocation, nativeThreadId: fixtureIdentityValues.NativeThreadId.thread },
    projectId: fixtureIdentityValues.ProjectId.project, projectRoot: nativeLocation,
    title: "", createdAt: 1, updatedAt: 1, activityAt: 1,
  });
  const threads = new WorkbenchThreadIdentityController({
    listThreadIdentities: async () => repository.list(),
    observeThreadIdentities: async inputs => repository.observeMany(inputs),
    observeTurnIdentities: async inputs => repository.observeTurns(inputs),
    resolveThreadIdentity: async input => repository.resolve(input),
    resolveNativeThreadIdentity: async input => repository.resolveNative(input),
    resolveTurnIdentity: async input => repository.resolveTurn(input),
  });
  const items = new WorkbenchTranscriptIdentityController({
    admitTranscriptItemIdentities: async inputs => itemRepository.admitMany(inputs),
    resolveTranscriptItemIdentity: async input => itemRepository.resolve(input),
  });
  after(() => {
    threads.dispose();
    items.dispose();
    if (database.open) database.close();
  });
  await threads.start();
  if (options.existingTurn) await threads.observeTurn({
    kind: "turn",
    threadId: thread.threadId, turnId: fixtureIdentityValues.NativeTurnId.turn,
    harnessId: "codex", nativeLocation,
    nativeThreadId: fixtureIdentityValues.NativeThreadId.thread, nativeTurnId: fixtureIdentityValues.NativeTurnId.turn,
    state: "inProgress", createdAt: 1, startedAt: 1, endedAt: null, durationMs: null,
  });
  return { threads, items };
}

async function recordingFixture(nativeLocation = "C:/repo", existingTurn = false) {
  const database = databaseFixture();
  const identities = await recordingIdentities({ database, nativeLocation, existingTurn });
  const repository = new WorkbenchTranscriptRepository(database);
  const sqliteReader = new CodexSqliteTranscriptReader(
    async request => repository.read(request), async threadId => repository.readContext(threadId),
  );
  return {
    repository,
    ports: {
      identities, sqliteReader,
      transcriptAssets: assetPorts(database),
      resolveProjectFromCwd: async () => ({
        cwd: nativeLocation,
        project: { id: fixtureIdentityValues.ProjectId.project, kind: "git" as const, root: nativeLocation, rootPath: nativeLocation, roots: [] },
        root: { id: "root", name: "repo", root: nativeLocation, rootPath: nativeLocation },
      }),
      recordSqliteTranscript: async (observations: readonly WorkbenchTranscriptObservation[]) => { repository.settle(observations); },
      readSqliteProviderCursor: async (threadId: string, turnId: string) => repository.readProviderPreviousCursor(threadId, turnId),
      readSqliteTranscriptMaterializedTurnIds: async (threadId: string, turnIds: readonly string[]) => repository.readMaterializedTurnIds(threadId, turnIds),
    },
    project(turnLimit = 100) {
      const snapshot = repository.read({ threadId: "thread", turnLimit });
      assert.ok(snapshot);
      const result = projectWorkbenchTranscript(snapshot);
      assert.ok(result.success);
      return { snapshot, projection: result.data };
    },
  };
}

test("SQL context pages settle provider bodies and then read without legacy storage", async () => {
  const database = databaseFixture();
  const identities = await recordingIdentities({ database });
  const repository = new WorkbenchTranscriptRepository(database);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-sql-context-"));
  const requests: JsonRpcRequest[] = [];
  const reader = new CodexSqliteTranscriptReader(async request => repository.read(request), async id => repository.readContext(id));
  const item: ThreadItem = { id: "reply", type: "agentMessage", text: "complete retained reply", phase: "commentary", memoryCitation: null, delivery: null, questions: null };
  const fullTurn = { ...bridgeThread([item]).turns[0]!, status: "completed" as const };
  let providerTurns = [fullTurn];
  let bridge!: InstanceType<typeof CodexStdioBridge>;
  bridge = new CodexStdioBridge({
    identities, sqliteReader: reader,
    readSqliteProviderCursor: async (threadId, turnId) => repository.readProviderPreviousCursor(threadId, turnId),
    readSqliteTranscriptMaterializedTurnIds: async (threadId, turnIds) => repository.readMaterializedTurnIds(threadId, turnIds),
    recordSqliteTranscript: async observations => { repository.settle(observations); },
    appServer: { send(request: JsonRpcRequest) {
      requests.push(request);
      const params = request.params as { includeTurns?: boolean; itemsView?: string; cursor?: string; limit?: number };
      if (request.method === "thread/read") assert.equal(params.includeTurns, false);
      const offset = Number(params.cursor ?? 0);
      const data = providerTurns.slice().reverse().slice(offset, offset + (params.limit ?? 100));
      const result = request.method === "thread/read"
        ? { thread: { ...bridgeThread(), turns: [] } }
        : { data: data.map(turn => params.itemsView === "full" ? turn : { ...turn, items: [], itemsView: "notLoaded" }),
          nextCursor: offset + data.length < providerTurns.length ? String(offset + data.length) : null };
      queueMicrotask(() => void bridge.handleUpstreamMessage({ id: request.id, result }));
    } } as unknown as CodexAppServer,
    bridgeUrl: "ws://127.0.0.1:1", handleWorkbenchRequest: rejectWorkbenchRequest,
    onNotification() {}, sendToClient() {}, storageRoot: root,
    resolveProjectFromCwd: async () => ({
      cwd: "C:/repo",
      project: { id: fixtureIdentityValues.ProjectId.project, kind: "git", root: "C:/repo", rootPath: "C:/repo", roots: [] },
      root: { id: "root", name: "repo", root: "C:/repo", rootPath: "C:/repo" },
    }),
  });
  try {
    for (let pass = 0; pass < 2; pass++) {
      const response = await bridge.handleBridgeRequest({
        id: pass, method: "workbench/thread/page/read", params: { threadId: "thread", cursor: null },
      });
      assert.equal(response?.error, undefined);
      const result = response?.result as WorkbenchThreadPageResponse;
      assert.notEqual(result.thread.id, "thread");
      assert.equal(result.thread.turns[0]?.items[0]?.type, "agentMessage");
      const reply = result.thread.turns[0]?.items[0];
      assert.equal(reply?.type === "agentMessage" && reply.text, item.text);
      const context = await reader.history(result.thread.id);
      assert.deepEqual(context.questionnaireEntries, []);
      assert.equal(await repository.readProviderPreviousCursor(result.thread.id, result.thread.turns[0]!.id), null);
    }
    assert.equal(requests.filter(request => (request.params as { itemsView?: string }).itemsView === "full").length, 1);
    const oldTurn = { ...fullTurn, id: "older", startedAt: 2,
      items: [{ ...item, id: "old-reply", text: "historical reply" }] };
    const afterTurn = { ...fullTurn, id: "after", startedAt: 3,
      items: [{ ...item, id: "after-reply", text: "latest reply" }] };
    providerTurns = [fullTurn, oldTurn, afterTurn];
    const windows = (bridge as unknown as {
      createThreadWindowStore(): CodexThreadWindowStore;
    }).createThreadWindowStore();
    await windows.recordWindow({
      thread: { ...bridgeThread(), turns: [] },
      source: "provider",
      catalog: { turns: providerTurns
        .map(turn => ({ ...turn, items: [], itemsView: "notLoaded" })) },
    });
    assert.deepEqual(repository.readMaterializedTurnIds("thread", ["older"]), []);
    const catalog = await reader.catalog("thread");
    assert.deepEqual(catalog?.turns.map(turn => turn.native_turn_id), ["turn", "older", "after"]);
    const boundary = catalog?.turns.find(turn => turn.native_turn_id === "after")?.id;
    assert.ok(boundary);
    for (let pass = 0; pass < 2; pass++) {
      const response = await bridge.handleBridgeRequest({
        id: `historical-${pass}`, method: "workbench/thread/page/read",
        params: { threadId: "thread", cursor: boundary },
      });
      assert.equal(response?.error, undefined);
      const reply = (response?.result as WorkbenchThreadPageResponse).thread.turns[0]?.items[0];
      assert.equal(reply?.type, "agentMessage");
      assert.equal(reply?.type === "agentMessage" && reply.text, "historical reply");
    }
    assert.equal(requests.filter(request => (request.params as { itemsView?: string }).itemsView === "full").length, 2);
    const complete = await bridge.handleBridgeRequest({
      id: "complete", method: "thread/context/read", params: { threadId: "thread", includeTurns: true },
    });
    assert.equal(complete?.error, undefined);
    const completeThread = (complete?.result as { thread: Thread }).thread;
    assert.deepEqual(completeThread.turns.flatMap(turn => turn.items.filter(item => item.type === "agentMessage").map(item => item.text)),
      ["complete retained reply", "historical reply", "latest reply"]);
    assert.equal(requests.filter(request => (request.params as { itemsView?: string }).itemsView === "full").length, 3);
  } finally {
    await bridge.disposeImmediately();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("SQLite recording cannot bypass canonical admission when the identity owner is absent", async () => {
  let writes = 0;
  const bridge = new CodexStdioBridge({
    appServer: { send() { throw new Error("Unexpected provider request"); } } as unknown as CodexAppServer,
    bridgeUrl: "ws://127.0.0.1:1",
    handleWorkbenchRequest: rejectWorkbenchRequest,
    onNotification() {},
    resolveProjectFromCwd: async () => null,
    storageRoot: os.tmpdir(),
    recordSqliteTranscript: async () => { writes++; },
    sendToClient() {},
  });
  try {
    const recording = bridge as unknown as {
      recordTranscript(observations: readonly WorkbenchTranscriptObservation<NativeThreadId, NativeTurnId>[], context: { source: "workbench" }): Promise<void>;
    };
    await assert.rejects(recording.recordTranscript([{
        kind: "thread", threadId: NativeThreadIdSchema.parse("native-thread"), projectId: fixtureIdentityValues.ProjectId.project,
        projectRoot: "C:/repo", title: "Thread", createdAt: 1, updatedAt: 1, activityAt: 1,
      }], { source: "workbench" }), { message: "SQLite transcript recording failed." });
    assert.equal(writes, 0);
  } finally {
    await bridge.disposeImmediately();
  }
});

test("ordinary page reads restore context without activity and isolate context read failures", async (context) => {
  const diagnostics = captureTestOutput(context, process.stderr, text =>
    text === "[codex-context-usage] Unable to restore context usage; thread content remains available.\n");
  context.after(() => assert.equal(diagnostics.length, 1));
  const sql = await recordingFixture();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-context-page-"));
  const usage = {
    last: { inputTokens: 10, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 2, reasoningOutputTokens: 0, totalTokens: 12 },
    total: { inputTokens: 100, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 20, reasoningOutputTokens: 0, totalTokens: 120 },
    modelContextWindow: 1000,
  };
  const requests: string[] = [];
  let fails = false;
  let bridge!: InstanceType<typeof CodexStdioBridge>;
  bridge = new CodexStdioBridge({
    ...sql.ports,
    appServer: { send(request: JsonRpcRequest) {
      requests.push(request.method!);
      const result = request.method === "thread/read"
        ? { thread: { ...bridgeThread(), status: { type: "idle" }, turns: [] } }
        : { data: [], nextCursor: null };
      queueMicrotask(() => void bridge.handleUpstreamMessage({ id: request.id, result }));
    } } as unknown as CodexAppServer,
    initialState: {
      upstreamInitialized: true, initializeResult: {}, requestIdAllocator: { next: 100 },
      pendingResponses: new Map(), pendingUserInputRequests: new Map(),
    },
    ...{ readSqliteContextUsage: async () => {
      if (fails) throw new Error("context read unavailable");
      return { tokenUsage: usage };
    } },
    bridgeUrl: "ws://127.0.0.1:1", handleWorkbenchRequest: rejectWorkbenchRequest,
    onNotification() {}, resolveProjectFromCwd: sql.ports.resolveProjectFromCwd, sendToClient() {}, storageRoot: root,
  });
  try {
    const read = () => bridge.handleBridgeRequest({
      id: 1, method: "workbench/thread/page/read", params: { threadId: "thread", cursor: null },
    });
    const response = await read();
    assert.equal(response?.error, undefined);
    assert.deepEqual((response?.result as { tokenUsage?: typeof usage })?.tokenUsage, usage);
    fails = true;
    const failedUsage = await read();
    assert.equal(failedUsage?.error, undefined);
    assert.equal((failedUsage?.result as { thread: Thread })?.thread.id, (response?.result as { thread: Thread }).thread.id);
    assert.equal((failedUsage?.result as { tokenUsage?: typeof usage })?.tokenUsage, undefined);
    assert.ok(requests.every((method) => method === "thread/read" || method === "thread/turns/list"));
  } finally {
    await bridge.waitForIdle();
    await bridge.disposeImmediately();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Workbench questionnaires share native listing, response, and transcript history routes", async () => {
  const fixtureIdentities = await recordingIdentities({ existingTurn: true });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-bridge-owned-questionnaire-"));
  const sqliteBatches: WorkbenchTranscriptObservation[][] = [];
  const upstreamMessages: unknown[] = [];
  const request = {
    id: "workbench-mcp:question",
    questions: [{
      allowOther: true,
      header: "details",
      id: "details",
      isSecret: false,
      options: [],
      question: "What should change?",
    }],
    submitLabel: "Submit",
    summary: "",
    title: "Questionnaire",
  };
  const pending = {
    itemId: null,
    request,
    requestKey: "workbench-mcp:question",
    threadId: fixtureIdentityValues.NativeThreadId.thread,
    turnId: fixtureIdentityValues.NativeTurnId.turn,
  };
  let receivedResponse: unknown = null;
  const bridge = new CodexStdioBridge({
    identities: fixtureIdentities,
    appServer: { send(message: unknown) { upstreamMessages.push(message); } } as unknown as CodexAppServer,
    bridgeUrl: "ws://127.0.0.1:1",
    handleWorkbenchRequest: rejectWorkbenchRequest,
    onNotification() {},
    questionnaires: {
      list: () => ({ data: [pending] }),
      respond: async (response) => {
        if (response.requestKey !== pending.requestKey || response.threadId !== pending.threadId) return null;
        receivedResponse = response;
        return { ...pending, response: response.response };
      },
    },
    recordSqliteTranscript: async (observations) => {
      sqliteBatches.push([...observations]);
    },
    resolveProjectFromCwd: async () => null,
    sendToClient() {},
    storageRoot: root,
  });
  try {
    const listed = await bridge.handleBridgeRequest({
      id: "list",
      method: "questionnaire/list",
      params: null,
    });
    assert.deepEqual(listed?.result, { data: [pending] });

    const response = { answers: { details: { answers: ["Keep one owner."] } } };
    const settled = await bridge.handleBridgeRequest({
      id: "answer",
      method: "questionnaire/respond",
      params: {
        requestKey: pending.requestKey,
        response,
        threadId: pending.threadId,
        turnId: pending.turnId,
      },
    });
    assert.deepEqual(receivedResponse, {
      requestKey: pending.requestKey,
      response,
      threadId: pending.threadId,
    });
    assert.deepEqual(settled?.result, { ok: true });
    assert.equal(upstreamMessages.length, 0);
    assert.equal(sqliteBatches.length, 1);
    const native = fixtureIdentities.threads.knownNativeBinding("codex", pending.threadId);
    const threadId = fixtureIdentities.threads.workbenchIdForNative(native);
    const turnId = fixtureIdentities.threads.workbenchTurnIdForNative({ ...native, nativeTurnId: pending.turnId });
    const itemId = fixtureIdentities.items.itemIdForSource(threadId, {
      turnId, kind: "stable", sourceId: resolveQuestionnaireHistoryItemId(pending),
    });
    assert.deepEqual(sqliteBatches[0]?.[0], {
      entry: {
        insertAfterItemId: null,
        insertAfterItemIndex: null,
        itemId,
        request,
        requestKey: pending.requestKey,
        resolvedAt: (sqliteBatches[0]?.[0] as { observedAt?: number } | undefined)?.observedAt,
        response,
        threadId,
        turnId,
      },
      kind: "questionnaire",
      publicItemId: itemId,
      observedAt: (sqliteBatches[0]?.[0] as { observedAt?: number } | undefined)?.observedAt,
    });
  } finally {
    await bridge.disposeImmediately();
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("SQLite transcript failure does not block steer or questionnaire side effects", async (context) => {
  const diagnostics = captureTestOutput(context, process.stderr, text =>
    text.startsWith("[codex-transcript] capture failed client-request:") && text.includes("cause=SQLite transcript failed"));
  context.after(() => assert.equal(diagnostics.length, 1));
  const fixtureIdentities = await recordingIdentities({ existingTurn: true });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-bridge-transcript-failed-"));
  const upstreamMessages: unknown[] = [];
  const client: BridgeClient = {
    OPEN: 1, close() {}, on() {}, once() {}, readyState: 1, send() {},
  };
  const bridge = new CodexStdioBridge({
    identities: fixtureIdentities,
    appServer: { send(message: unknown) { upstreamMessages.push(message); } } as unknown as CodexAppServer,
    bridgeUrl: "ws://127.0.0.1:1",
    handleWorkbenchRequest: rejectWorkbenchRequest,
    onNotification() {},
    recordSqliteTranscript: async () => { throw new Error("SQLite transcript failed"); },
    resolveProjectFromCwd: async () => null,
    sendToClient() {},
    storageRoot: root,
  });
  try {
    await bridge.forwardRequest({
      id: "steer",
      method: "turn/steer",
      params: {
        expectedTurnId: "turn",
        input: [{ text: "hello", text_elements: [], type: "text" }],
        threadId: "thread",
      },
    }, client, "steer");
    assert.equal((upstreamMessages[0] as { method?: string } | undefined)?.method, "turn/steer");

    await bridge.handleUpstreamMessage({
      id: "questionnaire",
      method: "item/tool/requestUserInput",
      params: {
        itemId: "tool",
        questions: [{
          allowOther: false,
          header: "choice",
          id: "choice",
          isSecret: false,
          options: [{ description: "continue", label: "yes" }],
          question: "continue?",
        }],
        threadId: "thread",
        turnId: "turn",
      },
    });
    const response = await bridge.handleBridgeRequest({
      id: "answer",
      method: "questionnaire/respond",
      params: {
        requestKey: "questionnaire",
        response: { answers: { choice: { answers: ["yes"] } } },
        threadId: "thread",
        turnId: "turn",
      },
    });
    assert.equal(response?.error, undefined);
    assert.deepEqual(response?.result, {
      ok: true,
      warning: "Your response was sent, but Workbench could not save it to SQLite transcript history.",
    });
    assert.equal((upstreamMessages[1] as { id?: string } | undefined)?.id, "questionnaire");
  } finally {
    await bridge.disposeImmediately();
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("detached questionnaire history records directly without answering a provider request", async () => {
  const sql = await recordingFixture("C:/repo", true);
  const fixtureIdentities = sql.ports.identities;
  const native = fixtureIdentities.threads.knownNativeBinding("codex", fixtureIdentityValues.NativeThreadId.thread);
  const threadId = fixtureIdentities.threads.workbenchIdForNative(native);
  const turnId = fixtureIdentities.threads.workbenchTurnIdForNative({ ...native, nativeTurnId: fixtureIdentityValues.NativeTurnId.turn });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-bridge-detached-questionnaire-"));
  const sqliteBatches: WorkbenchTranscriptObservation[][] = [];
  const upstreamMessages: unknown[] = [];
  const bridge = new CodexStdioBridge({
    ...sql.ports,
    appServer: { send(message: unknown) { upstreamMessages.push(message); } } as unknown as CodexAppServer,
    bridgeUrl: "ws://127.0.0.1:1",
    handleWorkbenchRequest: rejectWorkbenchRequest,
    onNotification() {},
    recordSqliteTranscript: async (observations) => {
      sqliteBatches.push([...observations]);
      await sql.ports.recordSqliteTranscript(observations);
    },
    resolveProjectFromCwd: sql.ports.resolveProjectFromCwd,
    sendToClient() {},
    storageRoot: root,
  });
  const entry: WorkbenchQuestionnaireHistoryEntry = {
    insertAfterItemId: "prompt",
    insertAfterItemIndex: 0,
    itemId: "questionnaire",
    request: {
      id: "questionnaire",
      questions: [{
        allowOther: false,
        header: "choice",
        id: "choice",
        isSecret: false,
        options: [{ description: "continue", label: "yes" }],
        question: "continue?",
      }],
      submitLabel: "Submit",
      summary: "Choose",
      title: "Questionnaire",
    },
    requestKey: "detached",
    resolvedAt: 2,
    response: { answers: { choice: { answers: ["yes"] } } },
    threadId: "thread",
    turnId: "turn",
  };

  try {
    await bridge.handleUpstreamMessage({ method: "thread/started", params: { thread: bridgeThread() } });
    await bridge.waitForIdle();
    sqliteBatches.length = 0;
    const response = await bridge.handleBridgeRequest({
      id: "record",
      method: "questionnaire/history/record",
      params: entry,
    });
    assert.deepEqual(response?.result, { ok: true });
    const itemId = fixtureIdentities.items.itemIdForSource(threadId, {
      turnId, kind: "stable", sourceId: resolveQuestionnaireHistoryItemId(entry),
    });
    assert.deepEqual(sqliteBatches, [[{
      entry: { ...entry, threadId, turnId, itemId, insertAfterItemId: null, insertAfterItemIndex: null },
      kind: "questionnaire",
      observedAt: entry.resolvedAt,
      publicItemId: itemId,
    }]]);
    assert.deepEqual(upstreamMessages, []);

    const history = await bridge.handleBridgeRequest({
      id: "history",
      method: "questionnaire/history/list",
      params: { threadId: "thread" },
    });
    assert.deepEqual(history?.result, { data: [{
      ...entry, threadId, turnId, itemId, insertAfterItemId: null, insertAfterItemIndex: -1,
    }] });

    const invalid = await bridge.handleBridgeRequest({
      id: "invalid",
      method: "questionnaire/history/record",
      params: { response: { secret: "must not escape" } },
    });
    assert.deepEqual(invalid?.error, {
      code: -32000,
      message: "Invalid questionnaire/history/record params.",
    });
    assert.equal(sqliteBatches.length, 1);
  } finally {
    await bridge.disposeImmediately();
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("repeated provider misses report one SQLite capture failure with a bounded sanitised root cause", async (t) => {
  const fixtureIdentities = await recordingIdentities({ existingTurn: true });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-bridge-transcript-report-"));
  const records = captureTestOutput(t, process.stderr, text => text.startsWith("[codex-transcript] capture failed"));
  const bridge = new CodexStdioBridge({
    identities: fixtureIdentities,
    appServer: { send() {} } as unknown as CodexAppServer,
    bridgeUrl: "ws://127.0.0.1:1",
    handleWorkbenchRequest: rejectWorkbenchRequest,
    onNotification() {},
    recordSqliteTranscript: async () => {
      throw new Error("SQLite transcript failed", {
        cause: new Error(`constraint failed at C:/private/storage.sqlite token=credential ${"x".repeat(1_000)}`),
      });
    },
    resolveProjectFromCwd: async () => null,
    sendToClient() {},
    storageRoot: root,
  });
  const item = {
    id: "message",
    memoryCitation: null,
    phase: "commentary" as const,
    text: "hello",
    delivery: null,
    questions: null,
    type: "agentMessage" as const,
  };
  try {
    await bridge.handleUpstreamMessage({
      method: "item/started",
      params: { item, threadId: "thread", turnId: "turn" },
    });
    await bridge.handleUpstreamMessage({
      method: "item/completed",
      params: { item, threadId: "thread", turnId: "turn" },
    });
    await bridge.waitForIdle();
    const failures = records.filter(line => line.startsWith("[codex-transcript] capture failed"));
    assert.equal(failures.length, 1);
    const cause = failures[0]!;
    assert.ok(cause.includes("constraint failed"));
    assert.ok(cause.length < 1_250);
    assert.ok(!cause.includes("credential") && !cause.includes("storage.sqlite"));
  } finally {
    await bridge.disposeImmediately();
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("Browse settlement verifies Workbench transcript assets before forwarding their SQLite observation", async () => {
  const database = databaseFixture();
  const fixtureIdentities = await recordingIdentities({ database, existingTurn: true });
  const native = fixtureIdentities.threads.knownNativeBinding("codex", fixtureIdentityValues.NativeThreadId.thread);
  const threadId = fixtureIdentities.threads.workbenchIdForNative(native);
  const turnId = fixtureIdentities.threads.workbenchTurnIdForNative({ ...native, nativeTurnId: fixtureIdentityValues.NativeTurnId.turn });
  const [command] = await fixtureIdentities.items.admit([{
    threadId, sources: [{ turnId, kind: "stable", sourceId: "command" }], legacyAliases: [],
  }]);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-bridge-browse-asset-"));
  const observations: object[] = [];
  const notifications: object[] = [];
  const bytes = Buffer.from("verified browse image");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const encodedThreadId = Buffer.from("thread", "utf8").toString("base64url");
  const assetUrl = `/api/transcript-assets/codex/${encodedThreadId}/${digest}.png`;
  await assetPorts(database).writeTranscriptAsset({ threadId: "thread", bytes, mimeType: "image/png" });

  const bridge = new CodexStdioBridge({
    identities: fixtureIdentities,
    transcriptAssets: assetPorts(database),
    appServer: { send() {} } as unknown as CodexAppServer,
    bridgeUrl: "ws://127.0.0.1:1",
    handleWorkbenchRequest: rejectWorkbenchRequest,
    onNotification(notification) { notifications.push(notification); },
    recordSqliteTranscript: async (batch) => {
      observations.push(...batch);
    },
    resolveProjectFromCwd: async () => ({
      cwd: "C:/repo",
      project: { id: fixtureIdentityValues.ProjectId.project, kind: "git", root: "C:/repo", rootPath: "C:/repo", roots: [] },
      root: { id: "root", name: "repo", root: "C:/repo", rootPath: "C:/repo" },
    }),
    sendToClient() {},
    storageRoot: root,
  });
  const entry: WorkbenchBrowseResultEntry = {
    action: "screenshot",
    actionIndex: 0,
    assetUrl,
    commandItemId: "command",
    detailKind: "result",
    detailLabel: "Screenshot",
    detailText: null,
    durationMs: 12,
    entryKey: "browse-entry",
    recordedAt: 100,
    session: "research",
    state: "completed",
    threadId: "thread",
    turnId: "turn",
  };

  try {
    await bridge.handleUpstreamMessage({ method: "thread/started", params: { thread: bridgeThread([]) } });
    await bridge.waitForIdle();
    observations.length = 0;
    notifications.length = 0;
    await bridge.recordBrowseResultForBrowse(entry);
    assert.deepEqual(observations, [{
      kind: "browse",
      entry: { ...entry, threadId, turnId, commandItemId: command!.itemId },
      asset: {
        byteLength: bytes.byteLength,
        digest,
        mimeType: "image/png",
        storageKey: assetUrl,
      },
    }]);
    assert.deepEqual(notifications, [{
      method: "browse/result/recorded",
      params: { threadId, turnId },
    }]);

    database.prepare("UPDATE transcript_asset_content SET bytes = ? WHERE digest = ?").run(Buffer.from("tampered"), digest);
    await assert.rejects(
      bridge.recordBrowseResultForBrowse({ ...entry, entryKey: "tampered" }),
      /bytes do not match/u,
    );
    assert.equal(observations.length, 1);
    assert.equal(notifications.length, 1);
  } finally {
    await bridge.disposeImmediately();
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("SQLite transcript failure does not block Browse settlement", async (context) => {
  const diagnostics = captureTestOutput(context, process.stderr, text =>
    text.startsWith("[codex-transcript] capture failed workbench-browse-settlement:") && text.includes("cause=SQLite transcript failed"));
  context.after(() => assert.equal(diagnostics.length, 1));
  const fixtureIdentities = await recordingIdentities({ existingTurn: true });
  const native = fixtureIdentities.threads.knownNativeBinding("codex", fixtureIdentityValues.NativeThreadId.thread);
  const threadId = fixtureIdentities.threads.workbenchIdForNative(native);
  const turnId = fixtureIdentities.threads.workbenchTurnIdForNative({ ...native, nativeTurnId: fixtureIdentityValues.NativeTurnId.turn });
  await fixtureIdentities.items.admit([{
    threadId, sources: [{ turnId, kind: "stable", sourceId: "command" }], legacyAliases: [],
  }]);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-bridge-browse-sqlite-failure-"));
  const notifications: object[] = [];
  const bridge = new CodexStdioBridge({
    identities: fixtureIdentities,
    appServer: { send() {} } as unknown as CodexAppServer,
    bridgeUrl: "ws://127.0.0.1:1",
    handleWorkbenchRequest: rejectWorkbenchRequest,
    onNotification(notification) { notifications.push(notification); },
    recordSqliteTranscript: async () => { throw new Error("SQLite transcript failed"); },
    resolveProjectFromCwd: async () => null,
    sendToClient() {},
    storageRoot: root,
  });
  try {
    await bridge.recordBrowseResultForBrowse({
      action: "click",
      actionIndex: 0,
      assetUrl: null,
      commandItemId: "command",
      detailKind: "result",
      detailLabel: "Clicked",
      detailText: "button",
      durationMs: 12,
      entryKey: "browse-entry",
      recordedAt: 100,
      session: "research",
      state: "completed",
      threadId: "thread",
      turnId: "turn",
    });
    assert.deepEqual(notifications, [{
      method: "browse/result/recorded",
      params: { threadId, turnId },
    }]);
  } finally {
    await bridge.disposeImmediately();
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("live transcript recording and reload use only SQL and preserve image assets", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-bridge-live-transcript-"));
  const database = databaseFixture();
  const fixtureIdentities = await recordingIdentities({ database });
  const repository = new WorkbenchTranscriptRepository(database);
  const sqliteBatches: WorkbenchTranscriptObservation[][] = [];
  const sqliteFailures: Error[] = [];
  const upstreamRequests: JsonRpcRequest[] = [];
  const publications: Parameters<ConstructorParameters<typeof CodexStdioBridge>[0]["onNotification"]>[] = [];
  const streamed: import("workbench-shared/workbench/transcript/thread-transcript-stream").TranscriptTextUpdate[] = [];
  let bridge!: InstanceType<typeof CodexStdioBridge>;
  const client: BridgeClient = {
    OPEN: 1, close() {}, on() {}, once() {}, readyState: 1, send() {},
  };
  const appServer = {
    send(message: JsonRpcRequest) {
      if (typeof message.method === "string") upstreamRequests.push(message);
    },
  } as unknown as CodexAppServer;
  const createBridge = (
    initialState?: import("./CodexStdioBridge").CodexStdioBridgeReloadState,
  ) => new CodexStdioBridge({
    identities: fixtureIdentities,
    transcriptAssets: assetPorts(database),
    appServer,
    bridgeUrl: "ws://127.0.0.1:1",
    handleWorkbenchRequest: rejectWorkbenchRequest,
    initialState,
    onNotification(...publication) { publications.push(publication); },
    onTranscriptLiveUpdate(update) { if (update.kind === "text") streamed.push(update); },
    readSqliteTranscriptMaterializedTurnIds: async (threadId, turnIds) => (
      repository.readMaterializedTurnIds(threadId, turnIds)
    ),
    recordSqliteTranscript: async (observations) => {
      sqliteBatches.push([...observations]);
      try {
        repository.settle(observations);
      } catch (error) {
        sqliteFailures.push(error instanceof Error ? error : new Error(String(error)));
        throw error;
      }
    },
    resolveProjectFromCwd: async () => ({
      cwd: "C:/repo",
      project: { id: fixtureIdentityValues.ProjectId.project, kind: "git", root: "C:/repo", rootPath: "C:/repo", roots: [] },
      root: { id: "root", name: "repo", root: "C:/repo", rootPath: "C:/repo" },
    }),
    sendToClient() {},
    storageRoot: root,
  });
  const item: ThreadItem = {
    id: "message",
    memoryCitation: null,
    phase: "commentary",
    text: "live",
    delivery: null,
    questions: null,
    type: "agentMessage",
  };
  const liveTurn = bridgeThread().turns[0]!;
  const assetBytes = Buffer.from("live browse image");
  const assetDigest = createHash("sha256").update(assetBytes).digest("hex");
  const encodedThreadId = Buffer.from("thread", "utf8").toString("base64url");
  const assetUrl = `/api/transcript-assets/codex/${encodedThreadId}/${assetDigest}.png`;
  await assetPorts(database).writeTranscriptAsset({ threadId: "thread", bytes: assetBytes, mimeType: "image/png" });

  try {
    bridge = createBridge();
    await bridge.handleUpstreamMessage({
      method: "thread/started",
      params: { thread: { ...bridgeThread(), turns: [] } },
    });
    await bridge.handleUpstreamMessage({
      method: "turn/started",
      params: { threadId: "thread", turn: liveTurn },
    });
    await bridge.handleUpstreamMessage({
      method: "item/started",
      params: { item, startedAtMs: 1_000, threadId: "thread", turnId: "turn" },
    });
    await bridge.withTranscriptBoundary(async () => {});
    const beforeDelta = sqliteBatches.length;
    await bridge.handleUpstreamMessage({
      method: "item/agentMessage/delta",
      params: { delta: " text", itemId: item.id, threadId: "thread", turnId: "turn" },
    });
    await bridge.withTranscriptBoundary(async () => {
      assert.equal(streamed.length, 1, "bootstrap must observe already admitted text");
      assert.equal(streamed[0]!.text, " text");
      assert.notEqual(streamed[0]!.threadId, "thread");
      assert.notEqual(streamed[0]!.itemId, item.id);
      assert.equal(sqliteBatches.length, beforeDelta, "text must not create a durable settlement");
    });
    await bridge.handleUpstreamMessage({
      method: "item/completed",
      params: { completedAtMs: 2_000, item, threadId: "thread", turnId: "turn" },
    });
    await bridge.handleUpstreamMessage({
      method: "item/completed",
      params: {
        completedAtMs: 2_100,
        item: {
          aggregatedOutput: "done",
          command: "browse",
          commandActions: [],
          cwd: "C:/repo",
          durationMs: 100,
          exitCode: 0,
          id: "command",
          pluginId: null,
          processId: "process",
          scriptPath: null,
          source: "agent",
          status: "completed",
          type: "commandExecution",
        },
        threadId: "thread",
        turnId: "turn",
      },
    });
    await bridge.handleUpstreamMessage({
      id: "dynamic",
      method: "item/tool/call",
      params: {
        arguments: { query: "live" },
        callId: "dynamic-call",
        namespace: "workbench",
        threadId: "thread",
        tool: "search",
        turnId: "turn",
      },
    });
    await bridge.handleUpstreamMessage({
      id: "questionnaire",
      method: "item/tool/requestUserInput",
      params: {
        autoResolutionMs: null,
        isBlocking: true,
        itemId: "questionnaire-item",
        questions: [{
          header: "choice",
          id: "choice",
          isOther: false,
          isSecret: false,
          options: [{ description: "continue", label: "yes" }],
          question: "continue?",
        }],
        threadId: "thread",
        turnId: "turn",
      },
    });
    await bridge.handleBridgeRequest({
      id: "questionnaire-response",
      method: "questionnaire/respond",
      params: {
        requestKey: "questionnaire",
        response: { answers: { choice: { answers: ["yes"] } } },
        threadId: "thread",
        turnId: "turn",
      },
    });
    await bridge.forwardRequest({
      id: "failed-steer",
      method: "turn/steer",
      params: {
        clientUserMessageId: "failed",
        expectedTurnId: "turn",
        input: [{ text: "fail", text_elements: [], type: "text" }],
        threadId: "thread",
      },
    }, client, "failed-steer");
    const failedSteer = upstreamRequests.slice().reverse().find((request) => request.method === "turn/steer")!;
    await bridge.handleUpstreamMessage({
      error: { code: -32000, message: "rejected" },
      id: failedSteer.id ?? null,
    });
    await bridge.forwardRequest({
      id: "interrupted-steer",
      method: "turn/steer",
      params: {
        clientUserMessageId: "interrupted",
        expectedTurnId: "turn",
        input: [{ text: "interrupt", text_elements: [], type: "text" }],
        threadId: "thread",
      },
    }, client, "interrupted-steer");
    const interruptedSteer = upstreamRequests.slice().reverse().find((request) => request.method === "turn/steer")!;
    await bridge.handleUpstreamMessage({
      id: interruptedSteer.id ?? null,
      result: { turnId: "turn" },
    });
    await bridge.recordBrowseResultForBrowse({
      action: "screenshot",
      actionIndex: 0,
      assetUrl,
      commandItemId: "command",
      detailKind: "result",
      detailLabel: "Screenshot",
      detailText: null,
      durationMs: 12,
      entryKey: "browse-entry",
      recordedAt: 100,
      session: "research",
      state: "completed",
      threadId: "thread",
      turnId: "turn",
    });

    const reloadState = await bridge.detachForReload();
    assert.equal(reloadState.transcriptSteers?.size, 1);
    bridge = createBridge(reloadState);
    await bridge.handleUpstreamMessage({
      method: "turn/completed",
      params: {
        threadId: "thread",
        turn: {
          ...liveTurn,
          completedAt: 3,
          durationMs: 2_000,
          items: [],
          status: "interrupted",
        },
      },
    });
    await bridge.forwardRequest({
      id: "read",
      method: "thread/read",
      params: { includeTurns: false, threadId: "thread" },
      workbenchThreadHydration: { mode: "latest" },
    }, client, "read");
    const readRequest = upstreamRequests.slice().reverse().find((request) => request.method === "thread/read")!;
    await bridge.handleUpstreamMessage({
      id: readRequest.id ?? null,
      result: { thread: { ...bridgeThread(), turns: [], updatedAt: 5 } },
    });
    await bridge.waitForIdle();
    const observations = sqliteBatches.flat();
    assert.equal(observations.some((observation) => observation.kind === "canonicalWindow"), false);
    assert.ok(observations.some((observation) => observation.kind === "thread"));
    assert.ok(observations.some((observation) => observation.kind === "turn" && observation.state === "inProgress"));
    assert.ok(observations.some((observation) => observation.kind === "turn" && observation.state === "interrupted"));
    assert.ok(observations.some((observation) => (
      observation.kind === "item" && observation.item.id === "message" && observation.lifecycle === "streaming"
    )));
    assert.ok(observations.some((observation) => (
      observation.kind === "item" && observation.item.id === "message" && observation.lifecycle === "completed"
    )));
    assert.ok(observations.some((observation) => (
      observation.kind === "item" && observation.item.type === "dynamicToolCall"
    )));
    assert.ok(observations.some((observation) => (
      observation.kind === "questionnaire" && observation.entry.requestKey === "questionnaire"
    )));
    assert.equal(observations.filter((observation) => (
      observation.kind === "steer" && observation.entry.status === "pending"
    )).length, 2);
    assert.ok(observations.some((observation) => (
      observation.kind === "steer" && observation.entry.clientUserMessageId === "failed" && observation.entry.status === "failed"
    )));
    assert.ok(observations.some((observation) => (
      observation.kind === "steer"
      && observation.entry.clientUserMessageId === "interrupted"
      && observation.entry.status === "interrupted"
    )));
    assert.ok(observations.some((observation) => (
      observation.kind === "browse"
      && observation.entry.entryKey === "browse-entry"
      && observation.asset?.digest === assetDigest
    )));
    assert.equal(sqliteBatches.some((batch) => (
      batch.length === 1 && batch[0]?.kind === "thread"
    )), true);
    assert.deepEqual(sqliteFailures, []);
    const snapshot = repository.read({ threadId: "thread", turnLimit: 1 });
    assert.ok(snapshot);
    const native = fixtureIdentities.threads.knownNativeBinding("codex", fixtureIdentityValues.NativeThreadId.thread);
    const publicThreadId = fixtureIdentities.threads.workbenchIdForNative(native);
    const publicTurnId = fixtureIdentities.threads.workbenchTurnIdForNative({
      ...native, nativeTurnId: fixtureIdentityValues.NativeTurnId.turn,
    });
    const question = publications.find(([event]) => event.method === "questionnaire/requested");
    assert.ok(question);
    const pendingInput = question[1].lifecycle;
    assert.equal(pendingInput?.event.kind, "pendingInput");
    if (pendingInput?.event.kind !== "pendingInput") throw new Error("Missing pending questionnaire observation");
    assert.equal(pendingInput.threadId, publicThreadId);
    assert.equal(pendingInput.event.turnId, publicTurnId);
    assert.ok(pendingInput.event.questionnaire);
    assert.equal(pendingInput.event.questionnaire.turnId, publicTurnId);
    assert.equal(question[1].projectId, fixtureIdentityValues.ProjectId.project);
    assert.deepEqual(publications.find(([event]) => event.method === "questionnaire/resolved")?.[1].lifecycle, {
      threadId: publicThreadId, event: { kind: "inputResolved", requestKey: "questionnaire" },
    });
    assert.deepEqual(publications.find(([event]) => event.method === "turn/completed")?.[1].lifecycle, {
      threadId: publicThreadId, event: { kind: "turnCompleted", turnId: publicTurnId, status: "interrupted" },
    });
    for (const [event, , original] of publications.filter(([event]) => (
      event.method === "questionnaire/requested" || event.method === "questionnaire/resolved"
      || event.method === "browse/result/recorded" || event.method === "turn/completed"
    ))) {
      assert.equal((event.params as { threadId: string }).threadId, publicThreadId);
      assert.equal((original.params as { threadId: string }).threadId, "thread");
    }
    assert.ok(publications.some(([event]) => event.method === "browse/result/recorded"));
    assert.ok(snapshot.rows.threadItems.some(({ source_id }) => source_id === "message"));
    assert.ok(snapshot.rows.threadItems.some(({ source_id }) => source_id === "dynamic-call"));
    assert.ok(snapshot.rows.threadItems.some(({ source_id }) => source_id === "command"));
    assert.equal(snapshot.rows.threadItemInteractions.length, 1);
    assert.equal(snapshot.rows.threadBrowseEntries.length, 1);
    assert.deepEqual(snapshot.rows.transcriptAssets.map(({ digest }) => digest), [assetDigest]);
    assert.deepEqual(Buffer.from((await assetPorts(database).readTranscriptAsset({
      threadId: encodedThreadId, assetName: `${assetDigest}.png`,
    }))!.bytes), assetBytes);
    const messageItemId = snapshot.rows.threadItems.find(({ source_id }) => source_id === "message")?.id;
    assert.ok(messageItemId);
    assert.deepEqual(
      snapshot.rows.threadItemTimelines.find(({ item_id }) => item_id === messageItemId),
      {
        completed_at: 2_000,
        first_seen_at: 1_000,
        item_id: messageItemId,
        last_seen_at: 2_000,
        started_at: 1_000,
      },
    );
  } finally {
    await bridge.disposeImmediately();
    database.close();
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("ordered claim-hook denials synthesize live failures and thread reads across bridge reload", async () => {
  const sql = await recordingFixture();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-bridge-file-change-test-"));
  const anchorlessItemId = "exec-11111111-1111-4111-8111-111111111111";
  const anchoredItemId = "exec-22222222-2222-4222-8222-222222222222";
  const ordinaryItemId = "exec-33333333-3333-4333-8333-333333333333";
  const precedingItem: ThreadItem = { id: "before", memoryCitation: null, delivery: null, questions: null, phase: "commentary", text: "before", type: "agentMessage" };
  const followingItem: ThreadItem = { id: "after", memoryCitation: null, delivery: null, questions: null, phase: "commentary", text: "after", type: "agentMessage" };
  const futureProviderItem: Extract<ThreadItem, { type: "fileChange" }> = {
    changes: [{ diff: "@@ -1 +1 @@\n-old\n+new", kind: { move_path: null, type: "update" }, path: "src/a.ts" }],
    id: anchorlessItemId,
    status: "failed",
    type: "fileChange",
  };
  const notifications: Array<{ method?: string; params?: { item?: ThreadItem } }> = [];
  let providerItems: ThreadItem[] = [];
  let bridge!: InstanceType<typeof CodexStdioBridge>;
  const appServer = {
    send(message: JsonRpcRequest) {
      queueMicrotask(() => {
        void bridge.handleUpstreamMessage({ id: message.id ?? null, result: { thread: bridgeThread(providerItems) } });
      });
    },
  } as unknown as CodexAppServer;
  const createBridge = (initialState?: import("./CodexStdioBridge").CodexStdioBridgeReloadState) => new CodexStdioBridge({
    ...sql.ports,
    appServer,
    bridgeUrl: "ws://127.0.0.1:1",
    handleWorkbenchRequest: rejectWorkbenchRequest,
    initialState,
    onNotification(notification) { notifications.push(notification as { params?: { item?: ThreadItem } }); },
    resolveProjectFromCwd: sql.ports.resolveProjectFromCwd,
    sendToClient() {},
    storageRoot: root,
  });

  try {
    bridge = createBridge();
    await bridge.handleUpstreamMessage({ method: "thread/started", params: { thread: bridgeThread() } });
    await bridge.waitForIdle();
    const nativeIds = (items: { id: string }[]) => items.map(item =>
      sql.project().snapshot.rows.threadItems.find(row => row.public_id === item.id)?.source_id);
    const systemMessage = createWorkbenchFileChangeFailureSystemMessage([{
      additions: 1,
      deletions: 1,
      kind: { move_path: null, type: "update" },
      path: "C:\\repo\\src\\a.ts",
    }]);
    assert(systemMessage);
    const unclaimedHookNotification = (itemId: string) => ({
      method: "hook/completed",
      params: {
        run: {
          entries: [
            { kind: "warning", text: systemMessage },
            { kind: "feedback", text: "apply_patch denied. No active Git arc claim covers C:\\repo\\src\\a.ts. Claim every path before editing." },
          ],
          eventName: "preToolUse",
          id: `pre-tool-use:0:C:\\<session-flags>\\config.toml:${itemId}`,
          status: "blocked",
        },
        threadId: "thread",
        turnId: "turn",
      },
    });
    await bridge.handleUpstreamMessage(unclaimedHookNotification(anchorlessItemId));
    await bridge.handleUpstreamMessage(unclaimedHookNotification(anchorlessItemId));
    await bridge.handleUpstreamMessage({
      method: "hook/completed",
      params: {
        run: {
          entries: [
            { kind: "warning", text: systemMessage },
            { kind: "feedback", text: "another hook blocked this patch" },
          ],
          eventName: "preToolUse",
          id: `pre-tool-use:1:C:\\user\\config.toml:${ordinaryItemId}`,
          status: "blocked",
        },
        threadId: "thread",
        turnId: "turn",
      },
    });

    let fileChangeNotifications = notifications.filter((notification) => notification.method === "item/completed" && notification.params?.item?.type === "fileChange");
    assert.equal(fileChangeNotifications.length, 1);
    const native = sql.ports.identities.threads.knownNativeBinding("codex", fixtureIdentityValues.NativeThreadId.thread);
    const publicThreadId = sql.ports.identities.threads.workbenchIdForNative(native);
    const publicTurnId = sql.ports.identities.threads.workbenchTurnIdForNative({ ...native, nativeTurnId: fixtureIdentityValues.NativeTurnId.turn });
    const publicItemId = sql.ports.identities.items.itemIdForSource(publicThreadId, {
      turnId: publicTurnId, sourceId: anchorlessItemId, kind: "stable",
    });
    assert.deepEqual(fileChangeNotifications[0]?.params?.item, {
      changes: [{
        diff: "",
        kind: { move_path: null, type: "update" },
        path: "C:\\repo\\src\\a.ts",
        workbenchAdditions: 1,
        workbenchDeletions: 1,
      }],
      id: publicItemId,
      status: "failed",
      type: "fileChange",
      workbenchFailureKind: "unclaimed",
    });

    const read = await bridge.handleBridgeRequest({ id: 1, method: "thread/context/read", params: { threadId: "thread" } });
    const readItems = ((read?.result as { thread?: ReturnType<typeof bridgeThread> })?.thread?.turns[0]?.items ?? []) as WorkbenchFileChangeItem[];
    assert.equal(readItems.length, 1);
    assert.equal(readItems[0]?.workbenchFailureKind, "unclaimed", "initial SQL read retains claim denial");

    await bridge.handleUpstreamMessage({ method: "item/completed", params: { item: precedingItem, threadId: "thread", turnId: "turn" } });
    providerItems = [precedingItem];
    const reloadState = await bridge.detachForReload();
    assert.equal(
      [...(reloadState.fileChanges?.items.values() ?? [])].some(({ item }) => item.workbenchFailureKind === "unclaimed"),
      false,
      "SQLite owns synthetic claim denials across reload",
    );
    bridge = createBridge(reloadState);
    const reloadedRead = await bridge.handleBridgeRequest({ id: 2, method: "thread/context/read", params: { threadId: "thread" } });
    const reloadedItems = ((reloadedRead?.result as { thread?: ReturnType<typeof bridgeThread> })?.thread?.turns[0]?.items ?? []) as WorkbenchFileChangeItem[];
    assert.deepEqual(nativeIds(reloadedItems), [anchorlessItemId, precedingItem.id]);
    assert.equal(reloadedItems[0]?.workbenchFailureKind, "unclaimed", "reload retains claim denial");

    await bridge.handleUpstreamMessage(unclaimedHookNotification(anchoredItemId));
    await bridge.handleUpstreamMessage({ method: "item/completed", params: { item: followingItem, threadId: "thread", turnId: "turn" } });
    await bridge.handleUpstreamMessage(unclaimedHookNotification(anchoredItemId));
    providerItems = [precedingItem, followingItem];
    const futureRead = await bridge.handleBridgeRequest({ id: 3, method: "thread/context/read", params: { threadId: "thread" } });
    const futureItems = ((futureRead?.result as { thread?: ReturnType<typeof bridgeThread> })?.thread?.turns[0]?.items ?? []) as WorkbenchFileChangeItem[];
    assert.deepEqual(nativeIds(futureItems), [anchorlessItemId, precedingItem.id, anchoredItemId, followingItem.id]);
    fileChangeNotifications = notifications.filter((notification) => notification.method === "item/completed" && notification.params?.item?.type === "fileChange");
    assert.equal(fileChangeNotifications.length, 2);

    providerItems = [precedingItem, followingItem, futureProviderItem];
    await bridge.handleUpstreamMessage({ method: "item/completed", params: { item: futureProviderItem, threadId: "thread", turnId: "turn" } });
    await bridge.waitForIdle();
    const afterLateCompletion = sql.project().snapshot;
    const lateCompletionRoot = afterLateCompletion.rows.threadItems.find(row => row.source_id === anchorlessItemId);
    assert.ok(lateCompletionRoot);
    assert.equal(
      afterLateCompletion.rows.threadItemFileChanges.find(row => row.item_id === lateCompletionRoot.id)?.workbench_failure_kind,
      "unclaimed",
      "atomic provider completion retains the SQLite-owned denial",
    );
    const providerRead = await bridge.handleBridgeRequest({ id: 4, method: "thread/context/read", params: { threadId: "thread" } });
    const providerReadItems = ((providerRead?.result as { thread?: ReturnType<typeof bridgeThread> })?.thread?.turns[0]?.items ?? []) as WorkbenchFileChangeItem[];
    assert.deepEqual(nativeIds(providerReadItems), [anchorlessItemId, precedingItem.id, anchoredItemId, followingItem.id]);
    assert.equal(providerReadItems[0]?.workbenchFailureKind, "unclaimed", "late provider completion retains claim denial");
    assert.equal(providerReadItems[0]?.changes[0]?.diff, futureProviderItem.changes[0]?.diff);
    assert.equal(providerReadItems[0]?.changes[0]?.workbenchAnalysis, undefined, "blocked patches never acquire current-file success findings");

    await bridge.handleUpstreamMessage({
      method: "turn/completed",
      params: {
        threadId: "thread",
        turn: {
          ...bridgeThread(providerItems).turns[0],
          completedAt: 2,
          durationMs: 1,
          status: "completed",
        },
      },
    });
    const completedState = await bridge.detachForReload();
    assert.equal(completedState.fileChanges?.turnCursors.size, 0);
  } finally {
    await bridge.disposeImmediately();
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("external socket send failure clears pending response and records exact steer failure", async () => {
  const sql = await recordingFixture("C:/repo", true);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-bridge-test-"));
  const client: BridgeClient = {
    OPEN: 1,
    close() {},
    on() {},
    once() {},
    readyState: 1,
    send() {},
  };
  const appServer = {
    send() {
      throw new Error("upstream socket failed Bearer secret-token at C:\\Users\\private\\thread.json");
    },
  } as unknown as CodexAppServer;
  const bridge = new CodexStdioBridge({
    ...sql.ports,
    appServer,
    bridgeUrl: "ws://127.0.0.1:1",
    handleWorkbenchRequest: rejectWorkbenchRequest,
    onNotification() {},
    resolveProjectFromCwd: sql.ports.resolveProjectFromCwd,
    sendToClient() {},
    storageRoot: root,
  });
  try {
    await bridge.handleUpstreamMessage({ method: "thread/started", params: { thread: bridgeThread() } });
    await bridge.waitForIdle();
    await assert.rejects(bridge.forwardRequest({
      id: 7,
      method: "turn/steer",
      params: {
        clientUserMessageId: "native",
        expectedTurnId: "turn",
        input: [{ text: "one", text_elements: [], type: "text" }],
        threadId: "thread",
      },
    }, client, 7), /upstream socket failed/u);
    const state = await bridge.detachForReload();
    assert.equal(state.pendingResponses.size, 0);
    const persisted = await sql.ports.sqliteReader.history("thread");
    assert.deepEqual(persisted.steerEntries?.map((entry) => [entry.clientUserMessageId, entry.status]), [["native", "failed"]]);
    assert.doesNotMatch(persisted.steerEntries?.[0]?.error ?? "", /secret-token|Users\\private/u);
  } finally {
    await bridge.disposeImmediately();
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("successful external send remaps the response id and detaches with settled reload state", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-bridge-success-test-"));
  const client: BridgeClient = {
    OPEN: 1, close() {}, on() {}, once() {}, readyState: 1, send() {},
  };
  let upstreamRequest: { id: number; method: string } | null = null;
  const appServer = {
    send(message: unknown) {
      upstreamRequest = message as { id: number; method: string };
    },
  } as unknown as CodexAppServer;
  const clientMessages: unknown[] = [];
  const acceptedSteers: string[] = [];
  const bridge = new CodexStdioBridge({
    appServer,
    bridgeUrl: "ws://127.0.0.1:1",
    handleWorkbenchRequest: rejectWorkbenchRequest,
    onAcceptedTurnSteer(threadId) { acceptedSteers.push(threadId); },
    onNotification() {},
    resolveProjectFromCwd: async () => null,
    sendToClient(_client, message) {
      assert.deepEqual(acceptedSteers, ["thread"], "accepted steer handling must finish before its response is published");
      clientMessages.push(message);
    },
    storageRoot: root,
  });
  try {
    await bridge.forwardRequest({
      id: 41,
      method: "turn/steer",
      params: {
        clientUserMessageId: "native", expectedTurnId: "turn",
        input: [{ text: "one", text_elements: [], type: "text" }], threadId: "thread",
      },
    }, client, 41);
    assert.equal(upstreamRequest?.method, "turn/steer");
    await bridge.handleUpstreamMessage({ id: upstreamRequest!.id, result: { turnId: "turn" } });
    assert.deepEqual(clientMessages, [{ id: 41, result: { turnId: "turn" } }]);
    assert.deepEqual(acceptedSteers, ["thread"]);
    const state = await bridge.detachForReload();
    assert.equal(state.pendingResponses.size, 0);
    assert.ok(state.requestIdAllocator.next > upstreamRequest!.id);
  } finally {
    await bridge.disposeImmediately();
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("direct thread resume is rejected without forwarding or transcript hydration", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-bridge-metadata-resume-test-"));
  const client: BridgeClient = {
    OPEN: 1, close() {}, on() {}, once() {}, readyState: 1, send() {},
  };
  const upstreamRequests: JsonRpcRequest[] = [];
  const appServer = {
    send(message: JsonRpcRequest) { upstreamRequests.push(message); },
  } as unknown as CodexAppServer;
  const clientMessages: unknown[] = [];
  const bridge = new CodexStdioBridge({
    appServer,
    bridgeUrl: "ws://127.0.0.1:1",
    handleWorkbenchRequest: rejectWorkbenchRequest,
    onNotification() {},
    resolveProjectFromCwd: async () => null,
    sendToClient(_client, message) { clientMessages.push(message); },
    storageRoot: root,
  });
  try {
    await bridge.forwardRequest({
      id: 51,
      method: "thread/resume",
      params: { excludeTurns: true, threadId: "thread" },
      workbenchThreadHydration: { mode: "latest" },
    }, client, 51);
    assert.deepEqual(upstreamRequests, []);
    const response = clientMessages[0] as { error?: { code?: number; message?: string } };
    assert.equal(response.error?.code, -32600);
    assert.match(response.error?.message ?? "", /turn-start lifecycle/u);
  } finally {
    await bridge.disposeImmediately();
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("rejected and empty external steer responses do not interrupt MCP waits", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-bridge-rejected-steer-test-"));
  const client: BridgeClient = {
    OPEN: 1, close() {}, on() {}, once() {}, readyState: 1, send() {},
  };
  let upstreamRequest: JsonRpcRequest | null = null;
  const appServer = {
    send(message: JsonRpcRequest) { upstreamRequest = message; },
  } as unknown as CodexAppServer;
  const acceptedSteers: string[] = [];
  const bridge = new CodexStdioBridge({
    appServer,
    bridgeUrl: "ws://127.0.0.1:1",
    handleWorkbenchRequest: rejectWorkbenchRequest,
    onAcceptedTurnSteer(threadId) { acceptedSteers.push(threadId); },
    onNotification() {},
    resolveProjectFromCwd: async () => null,
    sendToClient() {},
    storageRoot: root,
  });
  const steer = (id: number) => bridge.forwardRequest({
    id,
    method: "turn/steer",
    params: {
      expectedTurnId: "turn",
      input: [{ text: "one", text_elements: [], type: "text" }],
      threadId: "thread",
    },
  }, client, id);
  try {
    await steer(42);
    await bridge.handleUpstreamMessage({ id: upstreamRequest!.id, result: { turnId: "" } });
    await steer(43);
    await bridge.handleUpstreamMessage({ id: upstreamRequest!.id, error: { code: -32000, message: "rejected" } });
    assert.deepEqual(acceptedSteers, []);
  } finally {
    await bridge.dispose();
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("accepted internal steers do not interrupt MCP waits", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-bridge-internal-steer-test-"));
  let bridge!: InstanceType<typeof CodexStdioBridge>;
  const appServer = {
    send(message: JsonRpcRequest) {
      queueMicrotask(() => { void bridge.handleUpstreamMessage({ id: message.id ?? null, result: { turnId: "turn" } }); });
    },
  } as unknown as CodexAppServer;
  const acceptedSteers: string[] = [];
  bridge = new CodexStdioBridge({
    appServer,
    bridgeUrl: "ws://127.0.0.1:1",
    handleWorkbenchRequest: rejectWorkbenchRequest,
    onAcceptedTurnSteer(threadId) { acceptedSteers.push(threadId); },
    onNotification() {},
    resolveProjectFromCwd: async () => null,
    sendToClient() {},
    storageRoot: root,
  });
  try {
    assert.equal(await bridge.steerTurnForBrowse("thread", "turn", [{ text: "one", text_elements: [], type: "text" }]), "turn");
    assert.deepEqual(acceptedSteers, []);
  } finally {
    await bridge.dispose();
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("fresh first turn prepares its stored profile across reload and failed admission without resume", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-bridge-fresh-start-"));
  const events: string[] = [];
  const upstreamRequests: JsonRpcRequest[] = [];
  let turnStartAttempts = 0;
  let bridge!: InstanceType<typeof CodexStdioBridge>;
  const appServer = {
    send(message: JsonRpcRequest) {
      upstreamRequests.push(message);
      queueMicrotask(() => {
        if (message.method === "thread/start" || message.method === "thread/read") {
          void bridge.handleUpstreamMessage({
            id: message.id ?? null,
            result: {
              thread: { ...bridgeThread(), id: "fresh", status: { type: "idle" }, turns: [] },
            },
          });
          return;
        }
        if (message.method === "turn/start") {
          turnStartAttempts += 1;
          void bridge.handleUpstreamMessage(turnStartAttempts === 1
            ? { error: { code: -32000, message: "first admission failed" }, id: message.id ?? null }
            : {
              id: message.id ?? null,
              result: { turn: { ...bridgeThread().turns[0]!, id: "fresh-turn" } },
            });
          return;
        }
        void bridge.handleUpstreamMessage({
          error: { code: -32000, message: `unexpected ${message.method}` },
          id: message.id ?? null,
        });
      });
    },
  } as unknown as CodexAppServer;
  const createBridge = (
    initialState?: import("./CodexStdioBridge").CodexStdioBridgeReloadState,
  ) => new CodexStdioBridge({
    appServer,
    bridgeUrl: "ws://127.0.0.1:1",
    handleWorkbenchRequest: rejectWorkbenchRequest,
    initialState,
    instructions: new WorkbenchCodexInstructionAdapter("ws://127.0.0.1:1", root),
    onNotification() {},
    prepareThreadConfiguration: async (thread, requests) => {
      assert.equal(thread.id, "fresh");
      events.push("prepare:profile");
      return {
        ...requests,
        startRequest: { ...requests.startRequest, params: { ...requests.startRequest.params as object, model: "saved-model", effort: "low" } },
      };
    },
    prepareTurnStart: async () => { events.push("prepare:mcp"); },
    resolveProjectFromCwd: async () => null,
    sendToClient() {},
    storageRoot: root,
  });
  bridge = createBridge();
  const firstTurn = {
    id: 2,
    method: "turn/start",
    params: {
      input: [{ text: "hello", text_elements: [], type: "text" }],
      model: "stale-model",
      effort: "high",
      threadId: "fresh",
    },
  };
  try {
    const started = await bridge.handleServerRequest({
      id: 1,
      method: "thread/start",
      params: { cwd: root },
    });
    assert.equal((started.result as { thread?: { id?: string } } | undefined)?.thread?.id, "fresh");

    const state = await bridge.detachForReload();
    bridge = createBridge(state);
    const failed = await bridge.handleServerRequest(firstTurn);
    assert.equal(failed.error?.message, "first admission failed");
    const admitted = await bridge.handleServerRequest({ ...firstTurn, id: 3 });
    assert.equal((admitted.result as { turn?: { id?: string } } | undefined)?.turn?.id, "fresh-turn");
    for (const request of upstreamRequests.filter(({ method }) => method === "turn/start")) {
      assert.equal((request.params as { model: string }).model, "saved-model");
      assert.equal((request.params as { effort: string }).effort, "low");
    }
    assert.deepEqual(upstreamRequests.map(({ method }) => method), [
      "thread/start",
      "thread/read",
      "turn/start",
      "thread/read",
      "turn/start",
    ]);
    assert.deepEqual(events, ["prepare:profile", "prepare:mcp", "prepare:profile", "prepare:mcp"]);
  } finally {
    await bridge.waitForIdle();
    await bridge.disposeImmediately();
    await fs.rm(root, { force: true, recursive: true });
  }
});

for (const route of ["server", "forward"] as const) {
for (const status of ["notLoaded", "idle", "active", "resumeFailure"] as const) {
  test(`compaction prepares only a cold thread without admitting a turn: ${route} ${status}`, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-compact-"));
    const requests: JsonRpcRequest[] = [];
    const configured: string[][] = [];
    const responses: JsonRpcResponse[] = [];
    let bridge!: InstanceType<typeof CodexStdioBridge>;
    const appServer = {
      send(message: JsonRpcRequest) {
        requests.push(message);
        queueMicrotask(() => {
          const result = message.method === "thread/read"
            ? { thread: { ...bridgeThread(), status: { type: status === "resumeFailure" ? "notLoaded" : status }, turns: [] } }
            : message.method === "thread/resume"
              ? { thread: { ...bridgeThread(), status: { type: "idle" }, turns: [] } }
              : {};
          void bridge.handleUpstreamMessage(status === "resumeFailure" && message.method === "thread/resume"
            ? { id: message.id ?? null, error: { code: -32000, message: "resume failed" } }
            : { id: message.id ?? null, result });
        });
      },
    } as unknown as CodexAppServer;
    bridge = new CodexStdioBridge({
      appServer, bridgeUrl: "ws://127.0.0.1:1", storageRoot: root,
      handleWorkbenchRequest: rejectWorkbenchRequest,
      instructions: {
        augment: async request => request,
        createThreadResume: params => ({ method: "thread/resume", params }),
      },
      prepareThreadConfiguration: async (_thread, pending) => {
        configured.push(Object.values(pending).map(request => request.method!));
        return { ...pending, resumeRequest: {
          ...pending.resumeRequest,
          params: { ...pending.resumeRequest.params as object, baseInstructions: "managed prefix", model: "saved-model" },
        } };
      },
      onNotification() {}, sendToClient(_client, response) { responses.push(response as JsonRpcResponse); }, resolveProjectFromCwd: async () => null,
    });
    try {
      const request = { id: 71, method: "thread/compact/start", params: { threadId: "thread" } };
      const response = route === "server" ? await bridge.handleServerRequest(request)
        : (await bridge.forwardRequest(request, {} as BridgeClient, 71), responses[0]!);
      const methods = requests.map(request => request.method);
      assert.deepEqual(methods, status === "notLoaded"
        ? ["thread/read", "thread/resume", "thread/compact/start"]
        : status === "idle" ? ["thread/read", "thread/compact/start"]
          : status === "active" ? ["thread/read"] : ["thread/read", "thread/resume"]);
      assert.equal(Boolean(response.error), status === "active" || status === "resumeFailure");
      if (status === "notLoaded" || status === "resumeFailure") {
        assert.deepEqual(configured, [["thread/resume"]]);
        const resume = requests.find(request => request.method === "thread/resume")!;
        assert.deepEqual(resume.params, { threadId: "thread", excludeTurns: true, baseInstructions: "managed prefix", model: "saved-model" });
      } else assert.deepEqual(configured, []);
      assert.ok(requests.every(request => (request.params as { threadId: string }).threadId === "thread"));
      assert.equal((requests[0]!.params as { includeTurns: boolean }).includeTurns, false);
    } finally {
      await bridge.disposeImmediately();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
}
}

test("retired compaction preparation cannot resume or compact through a replacement generation", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-compact-cancel-"));
  let markPrepared!: () => void;
  const prepared = new Promise<void>(resolve => { markPrepared = resolve; });
  let finishPreparation!: () => void;
  const preparation = new Promise<void>(resolve => { finishPreparation = resolve; });
  const requests: JsonRpcRequest[] = [];
  let bridge!: InstanceType<typeof CodexStdioBridge>;
  bridge = new CodexStdioBridge({
    appServer: { send(request: JsonRpcRequest) {
      requests.push(request);
      queueMicrotask(() => { void bridge.handleUpstreamMessage({
        id: request.id ?? null, result: { thread: { ...bridgeThread(), status: { type: "notLoaded" }, turns: [] } },
      }); });
    } } as unknown as CodexAppServer,
    bridgeUrl: "ws://127.0.0.1:1", storageRoot: root,
    handleWorkbenchRequest: rejectWorkbenchRequest,
    instructions: { augment: async request => request, createThreadResume: params => ({ method: "thread/resume", params }) },
    prepareThreadConfiguration: async (_thread, requests) => {
      markPrepared();
      await preparation;
      return requests;
    },
    onNotification() {}, sendToClient() {}, resolveProjectFromCwd: async () => null,
  });
  try {
    const compact = bridge.handleServerRequest({ id: 1, method: "thread/compact/start", params: { threadId: "thread" } });
    const cancelled = assert.rejects(compact);
    await prepared;
    bridge.expireForReload();
    finishPreparation();
    await cancelled;
    assert.deepEqual(requests.map(request => request.method), ["thread/read"]);
  } finally {
    finishPreparation();
    await bridge.disposeImmediately();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("managed unloaded turn start resolves when MCP preparation requests a provider reload", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-bridge-managed-start-"));
  const events: string[] = [];
  const upstreamRequests: JsonRpcRequest[] = [];
  const unloadedThread = { ...bridgeThread(), status: { type: "notLoaded" as const }, turns: [] };
  const resumedThread = { ...bridgeThread(), status: { type: "idle" as const }, turns: [] };
  const startedTurn = { ...bridgeThread().turns[0]!, id: "managed-turn" };
  let resumed = false;
  let bridge!: InstanceType<typeof CodexStdioBridge>;
  const appServer = {
    send(message: JsonRpcRequest) {
      events.push(`send:${message.method}`);
      upstreamRequests.push(message);
      const result = message.method === "thread/read"
        ? { thread: resumed ? resumedThread : unloadedThread }
        : message.method === "thread/unsubscribe"
          ? { status: "notLoaded" }
          : message.method === "thread/resume"
            ? (() => {
              resumed = true;
              return {
                initialTurnsPage: { backwardsCursor: null, data: [], nextCursor: null },
                thread: resumedThread,
              };
            })()
            : message.method === "config/mcpServer/reload"
              ? {}
              : message.method === "turn/start"
                ? { turn: startedTurn }
                : null;
      queueMicrotask(() => {
        void (async () => {
          await bridge.handleUpstreamMessage({
            method: "workbench/test/upstream-progress",
            params: { requestMethod: message.method },
          });
          await bridge.handleUpstreamMessage(result
            ? { id: message.id ?? null, result }
            : { error: { code: -32000, message: `unexpected ${message.method}` }, id: message.id ?? null });
        })();
      });
    },
  } as unknown as CodexAppServer;
  bridge = new CodexStdioBridge({
    appServer,
    bridgeUrl: "ws://127.0.0.1:1",
    handleWorkbenchRequest: rejectWorkbenchRequest,
    instructions: new WorkbenchCodexInstructionAdapter("ws://127.0.0.1:1", root),
    onNotification() { events.push("receive:notification"); },
    withThreadAdmission: async (thread, requests, admit) => {
      assert.equal(thread.id, "thread");
      events.push("prepare:profile");
      const adapter = new WorkbenchCodexInstructionAdapter("ws://127.0.0.1:1", root);
      const configuration = {
        cwd: root, projectId: fixtureIdentityValues.ProjectId.project, roots: [], subagentName: null, threadId: thread.id,
        settings: {
          harness: "codex" as const, agentPath: "library:agents/lily.md", agentSource: "library" as const,
          model: "saved-model", reasoningEffort: null, serviceTier: null,
        },
      };
      const outcome = await admit({
        ...requests,
        resumeRequest: adapter.withThreadConfiguration(requests.resumeRequest, configuration),
        startRequest: adapter.withThreadConfiguration(requests.startRequest, configuration),
      });
      assert.equal(outcome.accepted, true);
      events.push("commit:profile");
      return outcome.result;
    },
    prepareTurnStart: async (_request, requestProvider) => {
      events.push("prepare:mcp");
      const threadRead = await requestProvider({
        id: "mcp-thread-read",
        method: "thread/read",
        params: { includeTurns: false, threadId: "thread" },
      });
      if (threadRead.error) throw new Error(threadRead.error.message);
      const response = await requestProvider({
        id: "mcp-reload",
        method: "config/mcpServer/reload",
        params: null,
      });
      if (response.error) throw new Error(response.error.message);
    },
    resolveProjectFromCwd: async () => null,
    sendToClient() {},
    storageRoot: root,
  });
  const promptContext = {
    agentPath: null,
    cwd: root,
    harness: "codex",
    threadId: "thread",
    workflowIds: ["default"],
  };
  try {
    const response = await bridge.handleBridgeRequest({
      id: 71,
      method: "workbench/codex/message/admit",
      params: {
        resumeRequest: {
          method: "thread/resume",
          params: {
            excludeTurns: true,
            initialTurnsPage: { itemsView: "notLoaded", limit: 1, sortDirection: "desc" },
            threadId: "thread",
          },
          workbenchPromptContext: promptContext,
        },
        startRequest: {
          method: "turn/start",
          params: {
            clientUserMessageId: "message-id",
            input: [{ text: "hello", text_elements: [], type: "text" }],
            threadId: "thread",
          },
          workbenchPromptContext: promptContext,
        },
        steerRequest: { method: "turn/steer", params: {}, workbenchPromptContext: promptContext },
        threadId: "thread",
      },
    });
    assert.deepEqual(upstreamRequests.map(({ method }) => method), [
      "thread/read",
      "thread/unsubscribe",
      "thread/resume",
      "thread/read",
      "config/mcpServer/reload",
      "turn/start",
    ]);
    assert.deepEqual(events, [
      "send:thread/read",
      "receive:notification",
      "prepare:profile",
      "send:thread/unsubscribe",
      "receive:notification",
      "send:thread/resume",
      "receive:notification",
      "prepare:mcp",
      "send:thread/read",
      "receive:notification",
      "send:config/mcpServer/reload",
      "receive:notification",
      "send:turn/start",
      "receive:notification",
      "commit:profile",
    ]);
    assert.deepEqual(upstreamRequests[0]?.params, {
      includeTurns: false,
      threadId: "thread",
    });
    const resumeParams = upstreamRequests[2]?.params as {
      baseInstructions?: string | null;
      developerInstructions?: string | null;
    };
    assert.match(`${resumeParams.baseInstructions ?? ""}\n${resumeParams.developerInstructions ?? ""}`, /LILY PREFIX SENTINEL/u);
    const startParams = upstreamRequests[5]?.params as Record<string, unknown>;
    assert.equal(startParams.model, "saved-model");
    assert.equal(startParams.effort, null);
    assert.equal(startParams.serviceTier, null);
    assert.equal("baseInstructions" in startParams, false);
    assert.equal("developerInstructions" in startParams, false);
    assert.deepEqual(response?.result, { kind: "started", turn: startedTurn });
  } finally {
    await bridge.waitForIdle();
    await bridge.disposeImmediately();
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("explicit refresh rebuilds the current instruction prefix and prepares MCP before replacement admission", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-explicit-refresh-"));
  const agentPath = path.join(testWorkbenchLibraryRoot, "agents", "refresh.md");
  await fs.writeFile(agentPath, "---\nname: refresh test\n---\nOLD REFRESH PREFIX", "utf8");
  const instructions = new WorkbenchCodexInstructionAdapter("ws://127.0.0.1:1", root);
  const resumeRequest: JsonRpcRequest = {
    method: "thread/resume", params: { threadId: "thread", cwd: root },
    workbenchPromptContext: { agentPath: "library:agents/refresh.md", agentSource: "library", cwd: root, harness: "codex", threadId: "thread", workflowIds: [] },
  };
  const oldRequest = await instructions.augment(resumeRequest, "thread/resume");
  assert.match(JSON.stringify(oldRequest.params), /OLD REFRESH PREFIX/);
  await fs.writeFile(agentPath, "---\nname: refresh test\n---\nNEW REFRESH PREFIX", "utf8");
  const requests: JsonRpcRequest[] = [];
  const order: string[] = [];
  const thread = { ...bridgeThread(), status: { type: "idle" }, turns: [{ id: "original", items: [], status: "interrupted", error: null }] };
  let bridge!: InstanceType<typeof CodexStdioBridge>;
  const appServer = {
    send(request: JsonRpcRequest) {
      requests.push(request);
      order.push(request.method);
      const result = request.method === "thread/read" ? { thread }
        : request.method === "thread/resume" ? { thread, initialTurnsPage: { backwardsCursor: null, data: [], nextCursor: null } }
          : request.method === "turn/start" ? { turn: { id: "replacement", items: [], status: "inProgress", error: null } }
            : { status: "unsubscribed" };
      queueMicrotask(() => { void bridge.handleUpstreamMessage({ id: request.id, result }); });
    },
  } as unknown as CodexAppServer;
  bridge = new CodexStdioBridge({
    appServer, bridgeUrl: "ws://127.0.0.1:1", handleWorkbenchRequest: rejectWorkbenchRequest,
    instructions, onNotification() {}, sendToClient() {}, resolveProjectFromCwd: async () => null, storageRoot: root,
    withThreadAdmission: async (_thread, pending, admit) => (await admit(pending)).result,
    prepareTurnStart: async () => { order.push("prepare:mcp"); },
  });
  const failures: unknown[] = [];
  const controller = new CodexRecoveryController({
    coordinator: new WorkbenchTurnRecoveryController(() => undefined),
    log: () => undefined,
    reportFailure: async (_candidate, error) => { failures.push(error); },
    runTask: async (_label, task) => task(),
    recover: async candidate => recoverCodexTurn(candidate, {
      request: async request => request.method === "thread/read"
        ? { id: request.id, result: { thread } }
        : await bridge.handleBridgeRequest(request),
    }),
  });
  try {
    controller.observeRequest("codex", resumeRequest);
    controller.observeRequest("codex", { id: "start", method: "turn/start", params: { cwd: root, threadId: "thread", input: [] } });
    controller.observeNotification("codex", { method: "turn/started", params: { threadId: "thread", turn: { id: "original" } } });
    await controller.requestResume("codex", "thread");
    await controller.waitForIdle();
    assert.deepEqual(failures, []);
    const resume = requests.find(request => request.method === "thread/resume");
    assert.ok(resume);
    assert.match(JSON.stringify(resume.params), /NEW REFRESH PREFIX/);
    assert.doesNotMatch(JSON.stringify(resume.params), /OLD REFRESH PREFIX/);
    assert.ok(order.indexOf("thread/resume") < order.indexOf("prepare:mcp"));
    assert.ok(order.indexOf("prepare:mcp") < order.indexOf("turn/start"));
    assert.equal(requests.filter(request => request.method === "turn/start").length, 1);
  } finally {
    await bridge.waitForIdle();
    await bridge.disposeImmediately();
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(agentPath, { force: true });
  }
});

test("profile preparation failure prevents native effects for ordinary, detached and native existing-thread starts", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-profile-failure-"));
  const sent: JsonRpcRequest[] = [];
  let bridge!: InstanceType<typeof CodexStdioBridge>;
  const appServer = {
    send(message: JsonRpcRequest) {
      sent.push(message);
      queueMicrotask(() => {
        void bridge.handleUpstreamMessage({
          id: message.id ?? null,
          result: { thread: { ...bridgeThread(), status: { type: "notLoaded" }, turns: [] } },
        });
      });
    },
  } as unknown as CodexAppServer;
  bridge = new CodexStdioBridge({
    appServer, bridgeUrl: "ws://127.0.0.1:1", handleWorkbenchRequest: rejectWorkbenchRequest,
    instructions: new WorkbenchCodexInstructionAdapter("ws://127.0.0.1:1", root),
    onNotification() {}, sendToClient() {}, resolveProjectFromCwd: async () => null, storageRoot: root,
    prepareThreadConfiguration: async () => { throw new Error("Profile persistence failed"); },
  });
  context.after(async () => { await bridge.disposeImmediately(); await fs.rm(root, { force: true, recursive: true }); });
  const startRequest = { method: "turn/start", params: { threadId: "thread", input: [] } };
  for (const steer of [true, false]) {
    await assert.rejects(bridge.handleBridgeRequest({
      id: 1, method: "workbench/codex/message/admit",
      params: {
        threadId: "thread", startRequest,
        resumeRequest: { method: "thread/resume", params: { threadId: "thread" } },
        ...(steer ? { steerRequest: { method: "turn/steer", params: {} } } : {}),
      },
    }), /Profile persistence failed/u);
  }
  await assert.rejects(bridge.handleServerRequest(startRequest), /Profile persistence failed/u);
  assert.deepEqual(sent.map((request) => request.method), ["thread/read", "thread/read", "thread/read"]);
});

test("managed admission steers a provider-confirmed active turn without changing its prefix", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-bridge-managed-steer-"));
  const upstreamRequests: JsonRpcRequest[] = [];
  const acceptedSteers: string[] = [];
  let prepared = false;
  let bridge!: InstanceType<typeof CodexStdioBridge>;
  const activeTurn = { ...bridgeThread().turns[0]!, items: [], itemsView: "notLoaded" as const };
  const activeThread = { ...bridgeThread(), turns: [] };
  const appServer = {
    send(message: JsonRpcRequest) {
      upstreamRequests.push(message);
      const result = message.method === "thread/read"
        ? { thread: activeThread }
        : message.method === "thread/turns/list"
          ? { data: [activeTurn], nextCursor: null }
        : message.method === "turn/steer"
          ? { turnId: "turn" }
          : message.method === "turn/start"
            ? { turn: activeTurn }
          : null;
      queueMicrotask(() => {
        void bridge.handleUpstreamMessage(result
          ? { id: message.id ?? null, result }
          : { error: { code: -32000, message: `unexpected ${message.method}` }, id: message.id ?? null });
      });
    },
  } as unknown as CodexAppServer;
  bridge = new CodexStdioBridge({
    appServer,
    bridgeUrl: "ws://127.0.0.1:1",
    handleWorkbenchRequest: rejectWorkbenchRequest,
    onAcceptedTurnSteer: (threadId) => { acceptedSteers.push(threadId); },
    onNotification() {},
    instructions: {
      augment: async (message) => message,
      createThreadResume: (params) => ({ method: "thread/resume", params }),
    },
    prepareThreadConfiguration: async () => { throw new Error("Active steers must not prepare a new profile."); },
    prepareTurnStart: async () => { prepared = true; },
    resolveProjectFromCwd: async () => null,
    sendToClient() {},
    storageRoot: root,
  });
  try {
    const response = await bridge.handleBridgeRequest({
      id: 72,
      method: "workbench/codex/message/admit",
      params: {
        resumeRequest: { method: "thread/resume", params: { threadId: "thread" } },
        startRequest: {
          method: "turn/start",
          params: {
            clientUserMessageId: "message-id",
            input: [{ text: "steer me", text_elements: [], type: "text" }],
            threadId: "thread",
          },
        },
        steerRequest: { method: "turn/steer", params: {} },
        threadId: "thread",
      },
    });
    assert.deepEqual(upstreamRequests.map(({ method }) => method), [
      "thread/read",
      "thread/turns/list",
      "turn/steer",
    ]);
    assert.deepEqual(upstreamRequests[0]?.params, {
      includeTurns: false,
      threadId: "thread",
    });
    assert.deepEqual(upstreamRequests[1]?.params, {
      itemsView: "notLoaded",
      limit: 1,
      sortDirection: "desc",
      threadId: "thread",
    });
    assert.deepEqual(upstreamRequests[2]?.params, {
      clientUserMessageId: "message-id",
      expectedTurnId: "turn",
      input: [{ text: "steer me", text_elements: [], type: "text" }],
      threadId: "thread",
    });
    assert.equal(prepared, false);
    assert.deepEqual(acceptedSteers, ["thread"]);
    assert.deepEqual(response?.result, { kind: "steered", turnId: "turn" });

    const startOnlyOffset = upstreamRequests.length;
    const startOnly = await bridge.handleBridgeRequest({
      id: 721,
      method: "workbench/codex/message/admit",
      params: {
        resumeRequest: { method: "thread/resume", params: { threadId: "thread" } },
        startRequest: {
          method: "turn/start",
          params: {
            clientUserMessageId: "new-turn-message",
            input: [{ text: "new turn only", text_elements: [], type: "text" }],
            threadId: "thread",
          },
        },
        threadId: "thread",
      },
    });
    assert.match(startOnly.error?.message ?? "", /cannot start a new turn while the provider reports an active turn/u);
    assert.deepEqual(
      upstreamRequests.slice(startOnlyOffset).map(({ method }) => method),
      ["thread/read", "thread/turns/list"],
    );
    const toolOutput = { name: "agent_message", namespace: "workbench", output: "agent information" };
    const outputOffset = upstreamRequests.length;
    const outputResponse = await bridge.handleServerRequest({
      id: 722, method: "turn/start", params: { input: [], threadId: "thread", toolOutput },
    });
    assert.equal(outputResponse.error, undefined);
    assert.deepEqual(upstreamRequests.slice(outputOffset).map(({ method }) => method), ["thread/read", "turn/start"]);
    assert.deepEqual((upstreamRequests.at(-1)?.params as { toolOutput?: object }).toolOutput, toolOutput);
    assert.equal(prepared, false);
    assert.deepEqual(acceptedSteers, ["thread"], "agent information must not interrupt user-steer waits");
  } finally {
    await bridge.waitForIdle();
    await bridge.disposeImmediately();
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("managed continuation starts the unchanged input when its active turn ends before steer", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-bridge-managed-steer-race-"));
  const upstreamRequests: JsonRpcRequest[] = [];
  const activeTurn = { ...bridgeThread().turns[0]!, items: [], itemsView: "notLoaded" as const };
  const activeThread = { ...bridgeThread(), turns: [] };
  const idleThread = { ...bridgeThread(), status: { type: "idle" as const }, turns: [] };
  const startedTurn = { ...activeTurn, id: "continued-turn" };
  let readCount = 0;
  let steerError = "transport failed";
  let bridge!: InstanceType<typeof CodexStdioBridge>;
  const appServer = {
    send(message: JsonRpcRequest) {
      upstreamRequests.push(message);
      const result = message.method === "thread/read"
        ? { thread: readCount++ === 0 ? activeThread : idleThread }
        : message.method === "thread/turns/list"
          ? { data: [activeTurn], nextCursor: null }
          : message.method === "thread/unsubscribe"
            ? { status: "unsubscribed" }
            : message.method === "thread/resume"
              ? { initialTurnsPage: { backwardsCursor: null, data: [], nextCursor: null }, thread: idleThread }
              : message.method === "turn/start"
                ? { turn: startedTurn }
                : null;
      queueMicrotask(() => {
        void bridge.handleUpstreamMessage(message.method === "turn/steer"
          ? { id: message.id ?? null, error: { code: -32000, message: steerError } }
          : result
            ? { id: message.id ?? null, result }
            : { id: message.id ?? null, error: { code: -32000, message: `unexpected ${message.method}` } });
      });
    },
  } as unknown as CodexAppServer;
  bridge = new CodexStdioBridge({
    appServer,
    bridgeUrl: "ws://127.0.0.1:1",
    handleWorkbenchRequest: rejectWorkbenchRequest,
    onNotification() {},
    prepareTurnStart: async () => undefined,
    resolveProjectFromCwd: async () => null,
    sendToClient() {},
    storageRoot: root,
  });
  const input = [
    { text: "questionnaire response", text_elements: [], type: "text" as const },
    { image_url: "data:image/png;base64,aGVsbG8=", type: "input_image" as const },
  ];
  try {
    const ambiguousFailure = await bridge.handleBridgeRequest({
      id: 722,
      method: "workbench/codex/message/admit",
      params: {
        resumeRequest: { method: "thread/resume", params: { threadId: "thread" } },
        startRequest: {
          method: "turn/start",
          params: { clientUserMessageId: "questionnaire-response", input, threadId: "thread" },
        },
        steerRequest: { method: "turn/steer", params: {} },
        threadId: "thread",
      },
    });
    assert.equal(ambiguousFailure.error?.message, "transport failed");
    assert.deepEqual(upstreamRequests.map(({ method }) => method), [
      "thread/read",
      "thread/turns/list",
      "turn/steer",
    ]);

    upstreamRequests.length = 0;
    readCount = 0;
    steerError = "no active turn to steer";
    const response = await bridge.handleBridgeRequest({
      id: 723,
      method: "workbench/codex/message/admit",
      params: {
        resumeRequest: { method: "thread/resume", params: { threadId: "thread" } },
        startRequest: {
          method: "turn/start",
          params: { clientUserMessageId: "questionnaire-response", input, threadId: "thread" },
        },
        steerRequest: { method: "turn/steer", params: {} },
        threadId: "thread",
      },
    });

    assert.deepEqual(response.result, { kind: "started", turn: startedTurn });
    assert.deepEqual(upstreamRequests.map(({ method }) => method), [
      "thread/read",
      "thread/turns/list",
      "turn/steer",
      "thread/read",
      "thread/unsubscribe",
      "thread/resume",
      "turn/start",
    ]);
    assert.deepEqual(upstreamRequests.at(-1)?.params, {
      clientUserMessageId: "questionnaire-response",
      input,
      threadId: "thread",
    });
  } finally {
    await bridge.waitForIdle();
    await bridge.disposeImmediately();
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("managed admission rejects active metadata without a newest in-progress turn", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-bridge-active-turn-missing-"));
  const upstreamRequests: JsonRpcRequest[] = [];
  let bridge!: InstanceType<typeof CodexStdioBridge>;
  const appServer = {
    send(message: JsonRpcRequest) {
      upstreamRequests.push(message);
      const result = message.method === "thread/read"
        ? { thread: { ...bridgeThread(), turns: [] } }
        : message.method === "thread/turns/list"
          ? {
              data: [{
                ...bridgeThread().turns[0]!,
                items: [],
                itemsView: "notLoaded",
                status: "completed",
              }],
              nextCursor: null,
            }
          : null;
      queueMicrotask(() => {
        void bridge.handleUpstreamMessage(result
          ? { id: message.id ?? null, result }
          : { error: { code: -32000, message: `unexpected ${message.method}` }, id: message.id ?? null });
      });
    },
  } as unknown as CodexAppServer;
  bridge = new CodexStdioBridge({
    appServer,
    bridgeUrl: "ws://127.0.0.1:1",
    handleWorkbenchRequest: rejectWorkbenchRequest,
    onNotification() {},
    prepareTurnStart: async () => undefined,
    resolveProjectFromCwd: async () => null,
    sendToClient() {},
    storageRoot: root,
  });
  try {
    await assert.rejects(bridge.handleBridgeRequest({
      id: 73,
      method: "workbench/codex/message/admit",
      params: {
        resumeRequest: { method: "thread/resume", params: { threadId: "thread" } },
        startRequest: {
          method: "turn/start",
          params: {
            clientUserMessageId: "message-id",
            input: [{ text: "do not misroute me", text_elements: [], type: "text" }],
            threadId: "thread",
          },
        },
        steerRequest: { method: "turn/steer", params: {} },
        threadId: "thread",
      },
    }), /no current in-progress turn/u);
    assert.deepEqual(upstreamRequests.map(({ method }) => method), [
      "thread/read",
      "thread/turns/list",
    ]);
  } finally {
    await bridge.waitForIdle();
    await bridge.disposeImmediately();
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("managed admission attempts a prepared turn start from provider system errors", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-bridge-system-error-start-"));
  const upstreamRequests: JsonRpcRequest[] = [];
  let prepared = false;
  let bridge!: InstanceType<typeof CodexStdioBridge>;
  const failedTurn = {
    ...bridgeThread().turns[0]!,
    completedAt: 2,
    error: {
      additionalDetails: null,
      codexErrorInfo: null,
      message: "provider failed",
    },
    id: "failed-turn",
    status: "failed" as const,
  };
  const failedThread = {
    ...bridgeThread(),
    status: { type: "systemError" as const },
    turns: [failedTurn],
  };
  const startedTurn = {
    ...bridgeThread().turns[0]!,
    id: "recovery-turn",
  };
  const appServer = {
    send(message: JsonRpcRequest) {
      upstreamRequests.push(message);
      const result = message.method === "thread/read"
        ? { thread: failedThread }
        : message.method === "thread/unsubscribe"
          ? { status: "unsubscribed" }
          : message.method === "thread/resume"
            ? {
              initialTurnsPage: {
                backwardsCursor: null,
                data: [failedTurn],
                nextCursor: null,
              },
              thread: failedThread,
            }
            : message.method === "turn/start"
              ? { turn: startedTurn }
              : null;
      queueMicrotask(() => {
        void bridge.handleUpstreamMessage(result
          ? { id: message.id ?? null, result }
          : { error: { code: -32000, message: `unexpected ${message.method}` }, id: message.id ?? null });
      });
    },
  } as unknown as CodexAppServer;
  bridge = new CodexStdioBridge({
    appServer,
    bridgeUrl: "ws://127.0.0.1:1",
    handleWorkbenchRequest: rejectWorkbenchRequest,
    onNotification() {},
    prepareTurnStart: async () => { prepared = true; },
    resolveProjectFromCwd: async () => null,
    sendToClient() {},
    storageRoot: root,
  });
  try {
    const response = await bridge.handleBridgeRequest({
      id: 73,
      method: "workbench/codex/message/admit",
      params: {
        resumeRequest: { method: "thread/resume", params: { threadId: "thread" } },
        startRequest: {
          method: "turn/start",
          params: {
            clientUserMessageId: "message-id",
            input: [{ text: "try recovery", text_elements: [], type: "text" }],
            threadId: "thread",
          },
        },
        steerRequest: { method: "turn/steer", params: {} },
        threadId: "thread",
      },
    });
    assert.deepEqual(response?.result, { kind: "started", turn: startedTurn });
    assert.deepEqual(upstreamRequests.map(({ method }) => method), [
      "thread/read",
      "thread/unsubscribe",
      "thread/resume",
      "turn/start",
    ]);
    assert.equal(prepared, true);
  } finally {
    await bridge.waitForIdle();
    await bridge.disposeImmediately();
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("managed inactive admissions serialize complete resume and start lifecycles", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-bridge-serialized-starts-"));
  const upstreamRequests: JsonRpcRequest[] = [];
  let heldRead: JsonRpcRequest | null = null;
  let bridge!: InstanceType<typeof CodexStdioBridge>;
  const appServer = {
    send(message: JsonRpcRequest) {
      upstreamRequests.push(message);
      if (message.method === "thread/read" && heldRead === null) {
        heldRead = message;
        return;
      }
      const params = message.params as { threadId?: string } | undefined;
      const threadId = params?.threadId ?? "thread";
      const idleThread = { ...bridgeThread(), id: threadId, status: { type: "idle" as const }, turns: [] };
      const result = message.method === "thread/read"
        ? { thread: idleThread }
        : message.method === "thread/unsubscribe"
          ? { status: "unsubscribed" }
          : message.method === "thread/resume"
            ? { initialTurnsPage: { backwardsCursor: null, data: [], nextCursor: null }, thread: idleThread }
            : message.method === "turn/start"
              ? { turn: { ...bridgeThread().turns[0]!, id: `${threadId}-turn` } }
              : null;
      queueMicrotask(() => {
        void bridge.handleUpstreamMessage(result
          ? { id: message.id ?? null, result }
          : { error: { code: -32000, message: `unexpected ${message.method}` }, id: message.id ?? null });
      });
    },
  } as unknown as CodexAppServer;
  bridge = new CodexStdioBridge({
    appServer,
    bridgeUrl: "ws://127.0.0.1:1",
    handleWorkbenchRequest: rejectWorkbenchRequest,
    onNotification() {},
    prepareTurnStart: async () => undefined,
    resolveProjectFromCwd: async () => null,
    sendToClient() {},
    storageRoot: root,
  });
  const admit = (threadId: string) => bridge.handleBridgeRequest({
    id: threadId,
    method: "workbench/codex/message/admit",
    params: {
      resumeRequest: { method: "thread/resume", params: { threadId } },
      startRequest: {
        method: "turn/start",
        params: {
          clientUserMessageId: `${threadId}-message`,
          input: [{ text: threadId, text_elements: [], type: "text" }],
          threadId,
        },
      },
      steerRequest: { method: "turn/steer", params: {} },
      threadId,
    },
  });
  try {
    const first = admit("one");
    const second = admit("two");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(upstreamRequests.map(({ method }) => method), ["thread/read"]);
    assert.deepEqual(upstreamRequests[0]?.params, {
      includeTurns: false,
      threadId: "one",
    });

    const firstRead = heldRead!;
    heldRead = firstRead;
    await bridge.handleUpstreamMessage({
      id: firstRead.id ?? null,
      result: { thread: { ...bridgeThread(), id: "one", status: { type: "idle" }, turns: [] } },
    });
    await Promise.all([first, second]);
    assert.deepEqual(upstreamRequests.map((request) => [
      request.method,
      (request.params as { threadId?: string } | undefined)?.threadId,
    ]), [
      ["thread/read", "one"],
      ["thread/unsubscribe", "one"],
      ["thread/resume", "one"],
      ["turn/start", "one"],
      ["thread/read", "two"],
      ["thread/unsubscribe", "two"],
      ["thread/resume", "two"],
      ["turn/start", "two"],
    ]);
  } finally {
    await bridge.waitForIdle();
    await bridge.disposeImmediately();
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("context reads bypass the operation queue and negotiate scoped entries without forwarding the capability", async () => {
  const sql = await recordingFixture();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-bridge-context-test-"));
  const upstreamRequests: JsonRpcRequest[] = [];
  let bridge!: InstanceType<typeof CodexStdioBridge>;
  const appServer = {
    send(message: JsonRpcRequest) {
      upstreamRequests.push(message);
      queueMicrotask(() => {
        void bridge.handleUpstreamMessage({ id: message.id ?? null, result: message.method === "thread/read"
          ? { thread: { ...bridgeThread(), turns: [] } }
          : { data: bridgeThread().turns.map(turn => ({ ...turn, items: [], itemsView: "notLoaded" })), nextCursor: null } });
      });
    },
  } as unknown as CodexAppServer;
  bridge = new CodexStdioBridge({
    ...sql.ports,
    appServer,
    bridgeUrl: "ws://127.0.0.1:1",
    handleWorkbenchRequest: rejectWorkbenchRequest,
    onNotification() {},
    resolveProjectFromCwd: sql.ports.resolveProjectFromCwd,
    sendToClient() {},
    storageRoot: root,
  });
  const queueGate = deferred<{ data: [] }>();
  const queueOwner = bridge as unknown as {
    listQuestionnaireHistory(params: unknown): Promise<{ data: [] }>;
  };
  queueOwner.listQuestionnaireHistory = async () => await queueGate.promise;

  try {
    await bridge.handleUpstreamMessage({ method: "thread/started", params: { thread: bridgeThread() } });
    await bridge.waitForIdle();
    const queuedRead = bridge.handleBridgeRequest({
      id: 10,
      method: "questionnaire/history/list",
      params: { threadId: "thread" },
    });
    await new Promise<void>(resolve => { setImmediate(resolve); });

    const scopedRead = bridge.handleBridgeRequest({
      id: 11,
      method: "thread/context/read",
      params: { includeTurns: true, threadId: "thread" },
      workbenchThreadContextEntries: { mode: "hydratedTurns" },
      workbenchThreadHydration: { mode: "latest" },
    });
    await new Promise<void>(resolve => { setImmediate(resolve); });
    assert.ok(upstreamRequests.length > 0);
    assert.ok(upstreamRequests.every(request => request.method === "thread/read" || request.method === "thread/turns/list"));
    assert.equal(upstreamRequests[0]?.method, "thread/read");
    assert.equal("workbenchThreadContextEntries" in (upstreamRequests[0] ?? {}), false);

    queueGate.resolve({ data: [] });
    await queuedRead;
    const scopedResponse = await scopedRead;
    assert.equal(scopedResponse?.error, undefined);
    assert.deepEqual((scopedResponse?.result as { entryScope?: unknown })?.entryScope, {
      mode: "turns",
      turnIds: sql.project().projection.turns.map(turn => turn.id),
    });

    const legacyResponse = await bridge.handleBridgeRequest({
      id: 12,
      method: "thread/context/read",
      params: { includeTurns: true, threadId: "thread" },
      workbenchThreadHydration: { mode: "latest" },
    });
    assert.equal("entryScope" in ((legacyResponse?.result as object | undefined) ?? {}), false);
  } finally {
    queueGate.resolve({ data: [] });
    await bridge.disposeImmediately();
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("exact transcript windows await ordered provider recording and Thread Recall reuses materialisation", async () => {
  const sql = await recordingFixture();
  const fixtureIdentities = sql.ports.identities;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-bridge-known-window-"));
  const pageRecordingStarted = deferred<void>();
  const releasePageRecording = deferred<void>();
  const sqliteBatches: object[][] = [];
  const upstreamRequests: JsonRpcRequest[] = [];
  let bridge!: InstanceType<typeof CodexStdioBridge>;
  const appServer = {
    send(message: JsonRpcRequest) {
      upstreamRequests.push(message);
      queueMicrotask(() => {
        if (message.method === "thread/turns/list") {
          const latest = { ...bridgeThread().turns[0]!, startedAt: 2 };
          const earlier = { ...latest, id: "earlier", startedAt: 1, completedAt: 1, status: "completed" as const };
          const params = message.params as { itemsView?: string; cursor?: string; limit?: number };
          void bridge.handleUpstreamMessage({
            id: message.id ?? null,
            result: {
              data: params.itemsView === "full"
                ? [params.cursor ? earlier : latest]
                : (params.cursor ? [earlier] : [latest, earlier]).slice(0, params.limit ?? 100)
                  .map(turn => ({ ...turn, items: [], itemsView: "notLoaded" })),
              nextCursor: !params.cursor && (params.itemsView === "full" || params.limit === 1) ? "older" : null,
            },
          });
          return;
        }
        if (message.method !== "thread/read") {
          void bridge.handleUpstreamMessage({
            error: { code: -32000, message: `unexpected ${message.method}` },
            id: message.id ?? null,
          });
          return;
        }
        void bridge.handleUpstreamMessage({
          id: message.id ?? null,
          result: { thread: { ...bridgeThread(), turns: [] } },
        });
      });
    },
  } as unknown as CodexAppServer;
  bridge = new CodexStdioBridge({
    ...sql.ports,
    appServer,
    bridgeUrl: "ws://127.0.0.1:1",
    handleWorkbenchRequest: rejectWorkbenchRequest,
    instructions: new WorkbenchCodexInstructionAdapter("ws://127.0.0.1:1", root),
    onNotification() {},
    recordSqliteTranscript: async (observations) => {
      sqliteBatches.push([...observations]);
      const page = observations.find(({ kind }) => kind === "providerTurnScope");
      if (page?.kind === "providerTurnScope" && page.completeTurnIds.length > 0) {
        pageRecordingStarted.resolve();
        await releasePageRecording.promise;
      }
      await sql.ports.recordSqliteTranscript(observations);
    },
    resolveProjectFromCwd: async () => ({
      cwd: "C:/repo",
      project: { id: fixtureIdentityValues.ProjectId.project, kind: "git", root: "C:/repo", rootPath: "C:/repo", roots: [] },
      root: { id: "root", name: "repo", root: "C:/repo", rootPath: "C:/repo" },
    }),
    sendToClient() {},
    storageRoot: root,
  });
  try {
    let responseSettled = false;
    const responseTask = bridge.handleBridgeRequest({
      id: 20,
      method: "workbench/thread/page/read",
      params: { cursor: null, threadId: "thread" },
    }).then(response => { responseSettled = true; return response; });
    const duplicateResponseTask = bridge.handleBridgeRequest({
      id: 21,
      method: "workbench/thread/page/read",
      params: { cursor: null, threadId: "thread" },
    });
    await Promise.race([
      pageRecordingStarted.promise,
      responseTask.then(response => assert.fail(`page returned before SQL recording: ${response?.error?.message ?? "no error"}`)),
    ]);
    assert.equal(responseSettled, false);
    releasePageRecording.resolve();
    const [response, duplicateResponse] = await Promise.all([responseTask, duplicateResponseTask]);
    assert.deepEqual((await sql.ports.sqliteReader.catalog("thread"))?.turns.map(turn => turn.native_turn_id), ["earlier", "turn"]);
    assert.equal(response?.error, undefined, "first page settles");
    assert.deepEqual(duplicateResponse?.result, response?.result);
    assert.deepEqual(upstreamRequests.map((request) => request.method), [
      "thread/read",
      "thread/turns/list",
      "thread/turns/list",
      "thread/turns/list",
    ]);
    assert.deepEqual(upstreamRequests[1]?.params, {
      itemsView: "notLoaded",
      limit: 1,
      sortDirection: "desc",
      threadId: "thread",
    });
    const sameWindowResponse = await bridge.handleBridgeRequest({
      id: 120,
      method: "thread/context/read",
      params: { includeTurns: false, threadId: "thread" },
      workbenchThreadContextEntries: { mode: "hydratedTurns" },
      workbenchThreadHydration: { mode: "latest" },
    });
    assert.equal(sameWindowResponse?.error, undefined, "same window reuses SQL");
    assert.deepEqual(
      ((sameWindowResponse?.result as { thread: Thread }).thread.turns).map((turn) => turn.id),
      [fixtureIdentities.threads.workbenchTurnIdForNative({
        harness: "codex", nativeLocation: "C:/repo", nativeThreadId: fixtureIdentityValues.NativeThreadId.thread,
        nativeTurnId: fixtureIdentityValues.NativeTurnId.turn,
      })],
    );
    const upstreamRequestCountBeforeRecall = upstreamRequests.length;
    let transcriptMaterialisationSettled = false;
    const transcriptMaterialisationTask = bridge.handleBridgeRequest({
      id: 121,
      method: "workbench/transcript/materialize",
      params: { threadId: "thread", turnIds: ["earlier", "turn"] },
    }).then((result) => {
      transcriptMaterialisationSettled = true;
      return result;
    });
    const transcriptMaterialisation = await transcriptMaterialisationTask;
    assert.equal(transcriptMaterialisationSettled, true);
    assert.equal(transcriptMaterialisation?.error, undefined);
    assert.deepEqual(transcriptMaterialisation?.result, {
      materializedTurnIds: ["earlier", "turn"],
      threadId: "thread",
    });
    const recallMaterialisation = await bridge.handleBridgeRequest({
      id: 122,
      method: "workbench/thread-recall/materialize",
      params: { threadId: "thread", turnId: "earlier" },
    });
    assert.deepEqual(recallMaterialisation?.result, {
      materializedTurnIds: ["earlier"],
      threadId: "thread",
    });
    assert.deepEqual(
      ((response?.result as { thread: Thread }).thread.turns).map((turn) => turn.id),
      [fixtureIdentities.threads.workbenchTurnIdForNative({
        harness: "codex", nativeLocation: "C:/repo", nativeThreadId: fixtureIdentityValues.NativeThreadId.thread,
        nativeTurnId: fixtureIdentityValues.NativeTurnId.turn,
      })],
    );
    await bridge.waitForIdle();
    assert.ok(upstreamRequests.length > upstreamRequestCountBeforeRecall);

    sqliteBatches.length = 0;
    const fullResponse = await bridge.handleBridgeRequest({
      id: 22,
      method: "thread/context/read",
      params: { includeTurns: true, threadId: "thread" },
      workbenchThreadContextEntries: { mode: "hydratedTurns" },
      workbenchThreadHydration: { mode: "legacyFull" },
    });
    assert.equal(fullResponse?.error, undefined, "complete context reuses materialised pages");
    assert.deepEqual(
      ((fullResponse?.result as { thread: Thread }).thread.turns).map((turn) =>
        fixtureIdentities.threads.knownTurn(fixtureIdentitySchemas.TurnReferenceSchema.parse(turn.id)).native.nativeTurnId),
      ["earlier", "turn"],
    );
    await bridge.waitForIdle();
    assert.equal(sqliteBatches.flat().some((observation) => (
      (observation as { kind?: string }).kind === "canonicalWindow"
    )), false);
    const bootstrapResponse = await bridge.handleBridgeRequest({
      id: 23,
      method: "workbench/thread-recall/materialize",
      params: { threadId: "thread", turnId: null },
    });
    assert.deepEqual(bootstrapResponse?.result, {
      materializedTurnIds: [],
      threadId: "thread",
    });
    const missingTurnResponse = await bridge.handleBridgeRequest({
      id: 24,
      method: "workbench/thread-recall/materialize",
      params: { threadId: "thread", turnId: "missing" },
    });
    assert.deepEqual(missingTurnResponse?.result, { materializedTurnIds: [], threadId: "thread" });
  } finally {
    releasePageRecording.resolve();
    await bridge.dispose();
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("durable transcript and recall materialisation propagate SQLite failure and can retry after recovery", async (context) => {
  const diagnostics = captureTestOutput(context, process.stderr, text =>
    text.startsWith("[codex-transcript] capture failed provider-turn-window:") && text.includes("cause=SQL page recording failure"));
  context.after(() => assert.equal(diagnostics.length, 1));
  const sql = await recordingFixture();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-materialisation-failure-"));
  const failure = new Error("SQL page recording failure");
  let failing = true;
  let imports = 0;
  let bridge!: InstanceType<typeof CodexStdioBridge>;
  bridge = new CodexStdioBridge({
    ...sql.ports,
    appServer: { send(request: JsonRpcRequest) {
      const result = request.method === "thread/read"
        ? { thread: { ...bridgeThread(), turns: [] } }
        : { data: bridgeThread().turns.map(turn => (request.params as { itemsView?: string }).itemsView === "full"
          ? turn : { ...turn, items: [], itemsView: "notLoaded" }), nextCursor: null };
      queueMicrotask(() => void bridge.handleUpstreamMessage({ id: request.id, result }));
    } } as unknown as CodexAppServer,
    bridgeUrl: "ws://127.0.0.1:1",
    handleWorkbenchRequest: rejectWorkbenchRequest,
    instructions: new WorkbenchCodexInstructionAdapter("ws://127.0.0.1:1", root),
    onNotification() {},
    recordSqliteTranscript: async (observations) => {
      if (observations.some(observation => observation.kind === "providerTurnScope" && observation.completeTurnIds.length > 0)) {
        if (failing) throw failure;
        imports++;
      }
      await sql.ports.recordSqliteTranscript(observations);
    },
    resolveProjectFromCwd: async () => ({
      cwd: "C:/repo",
      project: { id: fixtureIdentityValues.ProjectId.project, kind: "git", root: "C:/repo", rootPath: "C:/repo", roots: [] },
      root: { id: "root", name: "repo", root: "C:/repo", rootPath: "C:/repo" },
    }),
    sendToClient() {},
    storageRoot: root,
  });
  try {
    const metadata = { ...bridgeThread(), turns: [] } as Thread;
    const turn = bridgeThread().turns[0]!;
    const requests = [
      { id: 1, method: "workbench/transcript/materialize", params: { threadId: metadata.id, turnIds: [turn.id] } },
      { id: 2, method: "workbench/thread-recall/materialize", params: { threadId: metadata.id, turnId: turn.id } },
    ];
    for (const request of requests) {
      const response = await bridge.handleBridgeRequest(request);
      assert.equal(response?.error?.message, "SQLite transcript recording failed.");
      assert.equal(response?.result, undefined);
    }
    failing = false;
    for (const request of requests) {
      const response = await bridge.handleBridgeRequest(request);
      assert.equal(response?.error, undefined);
      assert.deepEqual(response?.result, { materializedTurnIds: [turn.id], threadId: metadata.id });
    }
    assert.equal(imports, 1, "Recovered materialisation must be reused");
  } finally {
    await bridge.dispose();
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("transcript materialisation waits for an admitted live turn to settle", async () => {
  const fixtureIdentities = await recordingIdentities();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-bridge-live-materialisation-"));
  const liveTurnRecordingStarted = deferred<void>();
  const releaseLiveTurnRecording = deferred<void>();
  const materializedTurnIds = new Set<string>();
  let materializationReads = 0;
  let materialisationSettled = false;
  const bridge = new CodexStdioBridge({
    identities: fixtureIdentities,
    appServer: { send() {} } as unknown as CodexAppServer,
    bridgeUrl: "ws://127.0.0.1:1",
    handleWorkbenchRequest: rejectWorkbenchRequest,
    instructions: new WorkbenchCodexInstructionAdapter("ws://127.0.0.1:1", root),
    onNotification() {},
    readSqliteTranscriptMaterializedTurnIds: async (_threadId, turnIds) => {
      materializationReads += 1;
      return turnIds.filter((turnId) => materializedTurnIds.has(turnId));
    },
    recordSqliteTranscript: async (observations) => {
      if (!observations.some((observation) => (
        observation.kind === "turn" && observation.nativeTurnId === "turn"
      ))) return;
      liveTurnRecordingStarted.resolve();
      await releaseLiveTurnRecording.promise;
      materializedTurnIds.add("turn");
    },
    resolveProjectFromCwd: async () => ({
      cwd: "C:/repo",
      project: { id: fixtureIdentityValues.ProjectId.project, kind: "git", root: "C:/repo", rootPath: "C:/repo", roots: [] },
      root: { id: "root", name: "repo", root: "C:/repo", rootPath: "C:/repo" },
    }),
    sendToClient() {},
    storageRoot: root,
  });
  try {
    await bridge.handleUpstreamMessage({
      method: "thread/started",
      params: { thread: { ...bridgeThread(), turns: [] } },
    });
    await bridge.waitForIdle();
    await bridge.handleUpstreamMessage({
      method: "turn/started",
      params: { threadId: "thread", turn: bridgeThread().turns[0] },
    });
    await liveTurnRecordingStarted.promise;
    const materialisation = bridge.handleBridgeRequest({
      id: 25,
      method: "workbench/transcript/materialize",
      params: { threadId: "thread", turnIds: ["turn"] },
    }).then((response) => {
      materialisationSettled = true;
      return response;
    });
    await new Promise<void>((resolve) => { setImmediate(resolve); });

    assert.equal(materialisationSettled, false);
    assert.equal(materializationReads, 0);

    releaseLiveTurnRecording.resolve();
    assert.deepEqual((await materialisation)?.result, {
      materializedTurnIds: ["turn"],
      threadId: "thread",
    });
    assert.equal(materializationReads, 1);
  } finally {
    releaseLiveTurnRecording.resolve();
    await bridge.dispose();
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("turn start responses admit the live turn before materialisation reads SQL", async () => {
  const fixtureIdentities = await recordingIdentities();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-bridge-turn-start-materialisation-"));
  const directTurnRecordingStarted = deferred<void>();
  const releaseDirectTurnRecording = deferred<void>();
  const materializedTurnIds = new Set<string>();
  let materializationReads = 0;
  let materialisationSettled = false;
  let turnStartSettled = false;
  const recordedObservations: WorkbenchTranscriptObservation[] = [];
  let bridge!: InstanceType<typeof CodexStdioBridge>;
  const appServer = {
    send(message: JsonRpcRequest) {
      const result = message.method === "thread/start" || message.method === "thread/read"
        ? { thread: { ...bridgeThread(), status: { type: "idle" as const }, turns: [] } }
        : message.method === "turn/start"
          ? { turn: bridgeThread().turns[0] }
          : null;
      queueMicrotask(() => {
        void bridge.handleUpstreamMessage(result
          ? { id: message.id ?? null, result }
          : { error: { code: -32000, message: `unexpected ${message.method}` }, id: message.id ?? null });
      });
    },
  } as unknown as CodexAppServer;
  bridge = new CodexStdioBridge({
    identities: fixtureIdentities,
    appServer,
    bridgeUrl: "ws://127.0.0.1:1",
    handleWorkbenchRequest: rejectWorkbenchRequest,
    instructions: new WorkbenchCodexInstructionAdapter("ws://127.0.0.1:1", root),
    onNotification() {},
    readSqliteTranscriptMaterializedTurnIds: async (_threadId, turnIds) => {
      materializationReads += 1;
      return turnIds.filter((turnId) => materializedTurnIds.has(turnId));
    },
    recordSqliteTranscript: async (observations) => {
      recordedObservations.push(...observations);
      if (!observations.some((observation) => (
        observation.kind === "turn" && observation.nativeTurnId === "turn"
      ))) return;
      directTurnRecordingStarted.resolve();
      await releaseDirectTurnRecording.promise;
      materializedTurnIds.add("turn");
    },
    resolveProjectFromCwd: async () => ({
      cwd: "C:/repo",
      project: { id: fixtureIdentityValues.ProjectId.project, kind: "git", root: "C:/repo", rootPath: "C:/repo", roots: [] },
      root: { id: "root", name: "repo", root: "C:/repo", rootPath: "C:/repo" },
    }),
    sendToClient() {},
    storageRoot: root,
  });
  try {
    const threadStart = await bridge.handleServerRequest({
      id: 1,
      method: "thread/start",
      params: { cwd: "C:/repo" },
    });
    assert.equal((threadStart.result as { thread?: { id?: string } } | undefined)?.thread?.id, "thread");
    const turnStart = bridge.handleServerRequest({
      id: 2,
      method: "turn/start",
      params: {
        input: [{ text: "hello", text_elements: [], type: "text" }],
        threadId: "thread",
      },
    }).then((response) => {
      turnStartSettled = true;
      return response;
    });
    await directTurnRecordingStarted.promise;
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    assert.equal(turnStartSettled, true);

    const materialisation = bridge.handleBridgeRequest({
      id: 3,
      method: "workbench/transcript/materialize",
      params: { threadId: "thread", turnIds: ["turn"] },
    }).then((response) => {
      materialisationSettled = true;
      return response;
    });
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    assert.equal(materialisationSettled, false);
    assert.equal(materializationReads, 0);

    releaseDirectTurnRecording.resolve();
    assert.equal(((await turnStart).result as { turn?: { id?: string } } | undefined)?.turn?.id, "turn");
    assert.deepEqual((await materialisation)?.result, {
      materializedTurnIds: ["turn"],
      threadId: "thread",
    });
    assert.equal(materializationReads, 1);
    const contextObservation = recordedObservations.find((observation) => observation.kind === "turnUsageContext");
    assert.equal(contextObservation?.kind, "turnUsageContext");
    if (contextObservation?.kind === "turnUsageContext") {
      assert.equal(contextObservation.model, null);
      assert.equal(contextObservation.serviceTier, null);
      assert.equal(contextObservation.threadId, fixtureIdentities.threads.workbenchIdForNative({
        harness: "codex", nativeLocation: "C:/repo", nativeThreadId: fixtureIdentityValues.NativeThreadId.thread,
      }));
      assert.equal(fixtureIdentities.threads.knownTurn(contextObservation.turnId).native.nativeTurnId, "turn");
      assert.equal(typeof contextObservation.observedAt, "number");
    }
    await bridge.handleUpstreamMessage({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thread",
        tokenUsage: {
          modelContextWindow: null,
          last: {
            cacheWriteInputTokens: 5,
            cachedInputTokens: 20,
            inputTokens: 100,
            outputTokens: 40,
            reasoningOutputTokens: 10,
            totalTokens: 140,
          },
          total: {
            cacheWriteInputTokens: 5,
            cachedInputTokens: 20,
            inputTokens: 100,
            outputTokens: 40,
            reasoningOutputTokens: 10,
            totalTokens: 140,
          },
        },
        turnId: "turn",
      },
    });
    await bridge.waitForIdle();
    const tokenObservation = recordedObservations.find((observation) => observation.kind === "turnTokenUsage");
    assert.deepEqual(tokenObservation && { ...tokenObservation, observedAt: 0 }, {
      cumulative: {
        cacheWriteInputTokens: 5,
        cachedInputTokens: 20,
        inputTokens: 100,
        outputTokens: 40,
        reasoningOutputTokens: 10,
        totalTokens: 140,
      },
      kind: "turnTokenUsage",
      observedAt: 0,
      threadId: fixtureIdentities.threads.workbenchIdForNative({
        harness: "codex", nativeLocation: "C:/repo", nativeThreadId: fixtureIdentityValues.NativeThreadId.thread,
      }),
      turnId: fixtureIdentities.threads.workbenchTurnIdForNative({
        harness: "codex", nativeLocation: "C:/repo", nativeThreadId: fixtureIdentityValues.NativeThreadId.thread,
        nativeTurnId: fixtureIdentityValues.NativeTurnId.turn,
      }),
      usageDataVersion: 2,
    });
  } finally {
    releaseDirectTurnRecording.resolve();
    await bridge.dispose();
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("bounded context reads bootstrap unseen threads through one full turn page", async () => {
  const sql = await recordingFixture();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-bridge-unseen-window-"));
  const upstreamRequests: JsonRpcRequest[] = [];
  let bridge!: InstanceType<typeof CodexStdioBridge>;
  const appServer = {
    send(message: JsonRpcRequest) {
      upstreamRequests.push(message);
      queueMicrotask(() => {
        const result = message.method === "thread/read"
          ? { thread: { ...bridgeThread(), turns: [] } }
          : message.method === "thread/turns/list"
            ? {
              data: bridgeThread().turns.map((turn) => (
                (message.params as { itemsView?: string } | undefined)?.itemsView === "notLoaded"
                  ? { ...turn, items: [], itemsView: "notLoaded" }
                  : turn
              )),
              nextCursor: null,
            }
            : null;
        void bridge.handleUpstreamMessage(result
          ? { id: message.id ?? null, result }
          : {
            error: { code: -32000, message: `unexpected ${message.method}` },
            id: message.id ?? null,
          });
      });
    },
  } as unknown as CodexAppServer;
  bridge = new CodexStdioBridge({
    ...sql.ports,
    appServer,
    bridgeUrl: "ws://127.0.0.1:1",
    handleWorkbenchRequest: rejectWorkbenchRequest,
    instructions: new WorkbenchCodexInstructionAdapter("ws://127.0.0.1:1", root),
    onNotification() {},
    resolveProjectFromCwd: sql.ports.resolveProjectFromCwd,
    sendToClient() {},
    storageRoot: root,
  });
  try {
    const response = await bridge.handleBridgeRequest({
      id: 21,
      method: "thread/context/read",
      params: { includeTurns: false, threadId: "thread" },
      workbenchThreadContextEntries: { mode: "hydratedTurns" },
      workbenchThreadHydration: { mode: "latest" },
    });
    assert.deepEqual(upstreamRequests.map((request) => request.method), [
      "thread/read",
      "thread/turns/list",
      "thread/turns/list",
    ]);
    assert.deepEqual(upstreamRequests[1]?.params, {
      itemsView: "notLoaded",
      limit: 1,
      sortDirection: "desc",
      threadId: "thread",
    });
    assert.deepEqual(upstreamRequests[2]?.params, {
      itemsView: "full",
      limit: 1,
      sortDirection: "desc",
      threadId: "thread",
    });
    assert.deepEqual(
      ((response?.result as { thread: Thread }).thread.turns).map((turn) => turn.id),
      sql.project().projection.turns.map(turn => turn.id),
    );
  } finally {
    await bridge.waitForIdle();
    await bridge.disposeImmediately();
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("observational internal thread lists skip transcripts without forwarding the marker", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-bridge-observational-test-"));
  const upstreamRequests: JsonRpcRequest[] = [];
  let bridge!: InstanceType<typeof CodexStdioBridge>;
  const appServer = {
    send(message: JsonRpcRequest) {
      upstreamRequests.push(message);
      queueMicrotask(() => { void bridge.handleUpstreamMessage({ id: message.id ?? null, result: { data: [], nextCursor: null } }); });
    },
  } as unknown as CodexAppServer;
  bridge = new CodexStdioBridge({
    appServer,
    bridgeUrl: "ws://127.0.0.1:1",
    handleWorkbenchRequest: rejectWorkbenchRequest,
    onNotification() {},
    resolveProjectFromCwd: async () => null,
    sendToClient() {},
    storageRoot: root,
  });
  try {
    await bridge.handleServerRequest({
      id: 1,
      method: "thread/list",
      params: { cwd: "C:/repo" },
      workbenchRequestSource: "autoRefresh",
    });
    await bridge.waitForIdle();
    assert.equal("workbenchRequestSource" in (upstreamRequests[0] ?? {}), false);
    await assert.rejects(
      fs.access(path.join(root, ".workbench", "transcripts", "codex", "threads")),
      (error: NodeJS.ErrnoException) => error.code === "ENOENT",
    );
  } finally {
    await bridge.disposeImmediately();
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("caller cancellation clears a pending internal app-server response", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-bridge-internal-cancel-test-"));
  const requestSent = deferred<void>();
  const bridge = new CodexStdioBridge({
    appServer: {
      send() { requestSent.resolve(); },
    } as unknown as CodexAppServer,
    bridgeUrl: "ws://127.0.0.1:4500/codex",
    handleWorkbenchRequest: rejectWorkbenchRequest,
    onNotification() {},
    resolveProjectFromCwd: async () => null,
    sendToClient() {},
    storageRoot: root,
  });
  const abortController = new AbortController();
  try {
    const response = bridge.handleServerRequest({
      id: 101,
      method: "thread/read",
      params: { includeTurns: false, threadId: "thread" },
    }, { signal: abortController.signal });
    await requestSent.promise;
    abortController.abort(new Error("turn ended"));
    await assert.rejects(response, /turn ended/u);
    const state = await bridge.detachForReload();
    assert.equal(state.pendingResponses.size, 0);
  } finally {
    await bridge.disposeImmediately();
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("fatal bridge stop rejects a pending internal app-server response", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-bridge-internal-fatal-test-"));
  const requestSent = deferred<void>();
  const bridge = new CodexStdioBridge({
    appServer: {
      send() { requestSent.resolve(); },
    } as unknown as CodexAppServer,
    bridgeUrl: "ws://127.0.0.1:4500/codex",
    handleWorkbenchRequest: rejectWorkbenchRequest,
    onNotification() {},
    resolveProjectFromCwd: async () => null,
    sendToClient() {},
    storageRoot: root,
  });
  try {
    const response = bridge.handleServerRequest({
      id: 101,
      method: "thread/read",
      params: { includeTurns: false, threadId: "thread" },
    });
    await requestSent.promise;
    bridge.beginStopping("Codex app-server exited.");
    await assert.rejects(response, /Codex app-server exited/u);
    const state = await bridge.detachForReload();
    assert.equal(state.pendingResponses.size, 0);
  } finally {
    await bridge.disposeImmediately();
    await fs.rm(root, { force: true, recursive: true });
  }
});

