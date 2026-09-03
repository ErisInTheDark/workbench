/*
 * Exports:
 * - No production exports; Node tests cover app-server generation handoff, durable versus live-only transcript routing, active transcript baselines, reload-safe page recovery, bridge pending cleanup, approval classification, file-change failure ordering, turn-start preflight, context reads, managed MCP config, and scoped-entry negotiation. Keywords: codex, bridge, reload, transcript, live, durable, recovery, approval, MCP, test.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import Database from "better-sqlite3";

import type CodexAppServer from "./CodexAppServer";
import type CodexTranscriptStore from "./CodexTranscriptStore";
import type { Thread } from "workbench-shared/codex/generated/app-server/v2/Thread";
import type { ThreadItem } from "workbench-shared/codex/generated/app-server/v2/ThreadItem";
import type { WorkbenchBrowseResultEntry } from "workbench-shared/types";
import {
  createWorkbenchFileChangeFailureSystemMessage,
  type WorkbenchFileChangeItem,
} from "workbench-shared/workbench/thread/workbench-file-change";
import type { WorkbenchThreadPageResponse } from "workbench-shared/workbench/thread/workbench-thread-page";
import type { BridgeClient, JsonRpcRequest } from "./bridge-types";
import { installWorkbenchDatabaseSchema } from "./database/workbench-database-schema";
import WorkbenchTranscriptRepository from "./database/transcript/WorkbenchTranscriptRepository";
import type { WorkbenchTranscriptObservation } from "./database/transcript/workbench-transcript-types";

const originalWorkbenchLibraryRoot = process.env.WORKBENCH_LIBRARY_ROOT;
let testWorkbenchLibraryRoot = "";
let CodexStdioBridge: typeof import("./CodexStdioBridge.js").default;
let WorkbenchCodexInstructionAdapter: (typeof import("./WorkbenchCodexInstructionAdapter.js"))["default"];

before(async () => {
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

test("generic failed-patch retries are declined without hiding real file-change approvals", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-bridge-file-approval-"));
  const upstreamMessages: unknown[] = [];
  const notifications: unknown[] = [];
  const pendingUserInputRequests = new Map();
  const bridge = new CodexStdioBridge({
    appServer: { send(message: unknown) { upstreamMessages.push(message); } } as unknown as CodexAppServer,
    bridgeUrl: "ws://127.0.0.1:1",
    handleWorkbenchRequest: rejectWorkbenchRequest,
    initialState: {
      initializeResult: {},
      pendingResponses: new Map(),
      pendingUserInputRequests,
      requestIdAllocator: { next: 1 },
      upstreamInitialized: true,
    },
    onNotification(notification) { notifications.push(notification); },
    resolveProjectFromCwd: async () => null,
    sendToClient() {},
    storageRoot: root,
  });
  try {
    await bridge.handleUpstreamMessage({
      id: 10,
      method: "item/fileChange/requestApproval",
      params: {
        grantRoot: null,
        itemId: "failed-patch",
        reason: "command failed; retry without sandbox?",
        startedAtMs: 1,
        threadId: "thread",
        turnId: "turn",
      },
    });
    assert.deepEqual(upstreamMessages, [{ id: 10, result: { decision: "decline" } }]);
    assert.equal(pendingUserInputRequests.size, 0);
    assert.deepEqual(notifications, []);

    await bridge.handleUpstreamMessage({
      id: 11,
      method: "item/fileChange/requestApproval",
      params: {
        grantRoot: "C:/outside",
        itemId: "real-permission-request",
        reason: "write outside the workspace",
        startedAtMs: 2,
        threadId: "thread",
        turnId: "turn",
      },
    });
    assert.equal(upstreamMessages.length, 1);
    assert.equal(pendingUserInputRequests.size, 1);
    assert.equal(
      (notifications[0] as { method?: string } | undefined)?.method,
      "questionnaire/requested",
    );
  } finally {
    await bridge.dispose();
    await fs.rm(root, { force: true, recursive: true });
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

test("background thread pages repair inactive provider turns directly into both transcript recorders", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-bridge-thread-recovery-"));
  const contextResolutionStarted = deferred<void>();
  const releaseContextResolution = deferred<void>();
  const laterProviderFactRecorded = deferred<void>();
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
    appServer,
    bridgeUrl: "ws://127.0.0.1:1",
    handleWorkbenchRequest: rejectWorkbenchRequest,
    onNotification() {},
    recordSqliteTranscript: async (observations) => {
      sqliteBatches.push([...observations]);
      if (observations.length === 1 && observations[0]?.kind === "item") {
        laterProviderFactRecorded.resolve();
      }
    },
    resolveProjectFromCwd: async () => {
      contextResolutionStarted.resolve();
      await releaseContextResolution.promise;
      return {
        cwd: "C:/repo",
        project: { id: "project", kind: "git", root: "C:/repo", rootPath: "C:/repo", roots: [] },
        root: { id: "root", name: "repo", root: "C:/repo", rootPath: "C:/repo" },
      };
    },
    sendToClient() {},
    storageRoot: root,
  });
  const owner = bridge as unknown as { ensureTranscriptStore(): CodexTranscriptStore };
  try {
    await owner.ensureTranscriptStore().recordHydratedThreadSnapshot({
      id: "stale",
      result: { thread: { ...bridgeThread([userItem]), turns: [staleTurn] } },
    });
    const responsePromise = bridge.handleBridgeRequest({
      id: 1,
      method: "workbench/thread/page/read",
      params: {
        cursor: null,
        readScope: "subagentBackground",
        threadId: "thread",
      },
    });
    await contextResolutionStarted.promise;
    const response = await responsePromise;
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
    releaseContextResolution.resolve();
    await laterProviderFactRecorded.promise;

    const recovered = (response?.result as WorkbenchThreadPageResponse).thread.turns[0]!;
    assert.equal(recovered.status, "interrupted");
    assert.deepEqual(recovered.items.map(({ id }) => id), ["user", "assistant"]);
    assert.deepEqual(upstreamRequests.map(({ method }) => method), [
      "thread/read",
      "thread/turns/list",
    ]);
    assert.deepEqual(sqliteBatches.map((batch) => batch.map(({ kind }) => kind)), [
      ["providerTurnScope"],
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
    await bridge.waitForIdle();
    await bridge.disposeImmediately();
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("provider catalog identities and the materialized page record as one dual-recorder fact", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-bridge-provider-window-"));
  const sqliteBatches: WorkbenchTranscriptObservation[][] = [];
  const pageItem: ThreadItem = {
    id: "assistant",
    memoryCitation: null,
    phase: "commentary",
    text: "latest",
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
    appServer: { send() {} } as unknown as CodexAppServer,
    bridgeUrl: "ws://127.0.0.1:1",
    handleWorkbenchRequest: rejectWorkbenchRequest,
    onNotification() {},
    recordSqliteTranscript: async (observations) => {
      sqliteBatches.push([...observations]);
    },
    resolveProjectFromCwd: async () => ({
      cwd: "C:/repo",
      project: { id: "project", kind: "git", root: "C:/repo", rootPath: "C:/repo", roots: [] },
      root: { id: "root", name: "repo", root: "C:/repo", rootPath: "C:/repo" },
    }),
    sendToClient() {},
    storageRoot: root,
  });
  const owner = bridge as unknown as {
    createThreadWindowStore(store: CodexTranscriptStore): {
      recordProviderWindow(recording: {
        catalog: {
          boundary: { cursor: string | null; turnId: string };
          turns: Thread["turns"];
        };
        page: { previousCursor: string | null; turn: Thread["turns"][number] };
        thread: Thread;
      }): void;
    };
    ensureTranscriptStore(): CodexTranscriptStore;
  };
  try {
    owner.createThreadWindowStore(owner.ensureTranscriptStore()).recordProviderWindow({
      catalog: {
        boundary: { cursor: "before-latest", turnId: latest.id },
        turns: [older, latest],
      },
      page: { previousCursor: "before-latest", turn: latest },
      thread: metadata,
    });
    await bridge.waitForIdle();

    assert.deepEqual(sqliteBatches.map((batch) => batch.map(({ kind }) => kind)), [["providerTurnScope"]]);
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
      ["turn"],
    );
    const stored = await owner.ensureTranscriptStore().readStoredThreadWindow("thread", ["turn"]) as (
      Thread & { workbenchTurnHistory: Array<{ turnId: string }> }
    );
    assert.deepEqual(stored.workbenchTurnHistory.map(({ turnId }) => turnId), ["older", "turn"]);
    assert.deepEqual(stored.turns[0]?.items.map(({ id }) => id), ["assistant"]);
  } finally {
    await bridge.disposeImmediately();
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("non-empty terminal provider turns record as complete replacement scopes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-bridge-provider-turn-scope-"));
  const batches: WorkbenchTranscriptObservation[][] = [];
  const item: ThreadItem = {
    id: "answer",
    memoryCitation: null,
    phase: "final_answer",
    text: "done",
    type: "agentMessage",
  };
  const bridge = new CodexStdioBridge({
    appServer: { send() {} } as unknown as CodexAppServer,
    bridgeUrl: "ws://127.0.0.1:1",
    handleWorkbenchRequest: rejectWorkbenchRequest,
    onNotification() {},
    recordSqliteTranscript: async (observations) => {
      batches.push([...observations]);
    },
    resolveProjectFromCwd: async () => ({
      cwd: "C:/repo",
      project: { id: "project", kind: "git", root: "C:/repo", rootPath: "C:/repo", roots: [] },
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
      ["turn"],
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

test("live provider observations and active baselines stay ordered across a bridge reload", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-bridge-sqlite-transcript-"));
  const batches: object[][] = [];
  let activeRecords = 0;
  let bridge!: InstanceType<typeof CodexStdioBridge>;
  const createBridge = (
    initialState?: import("./CodexStdioBridge").CodexStdioBridgeReloadState,
  ) => new CodexStdioBridge({
    appServer: {
      send(message: JsonRpcRequest) {
        if (message.method !== "thread/read") return;
        queueMicrotask(() => {
          void bridge.handleUpstreamMessage({
            id: message.id ?? null,
            result: { thread: bridgeThread() },
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
      project: { id: "project", kind: "git", root: "C:/repo", rootPath: "C:/repo", roots: [] },
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
  };
  try {
    bridge = createBridge();
    await bridge.handleUpstreamMessage({ method: "thread/started", params: { thread: bridgeThread([]) } });
    await bridge.handleUpstreamMessage({
      method: "turn/started",
      params: { threadId: "thread", turn: bridgeThread([]).turns[0] },
    });
    assert.deepEqual(bridge.activeSqliteTranscriptThreadIds, ["thread"]);
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
    assert.deepEqual(bridge.activeSqliteTranscriptThreadIds, ["thread"]);
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

test("JSON records first and blocked SQLite recording holds bridge detach", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-bridge-blocked-shadow-"));
  const sqliteStarted = deferred<void>();
  const releaseSqlite = deferred<void>();
  const bridge = new CodexStdioBridge({
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
      project: { id: "project", kind: "git", root: "C:/repo", rootPath: "C:/repo", roots: [] },
      root: { id: "root", name: "repo", root: "C:/repo", rootPath: "C:/repo" },
    }),
    sendToClient() {},
    storageRoot: root,
  });
  try {
    await bridge.handleUpstreamMessage({ method: "thread/started", params: { thread: bridgeThread([]) } });
    await sqliteStarted.promise;
    const TranscriptStore = (await import("./CodexTranscriptStore.js")).default as unknown as typeof CodexTranscriptStore;
    const inspection = new TranscriptStore(root);
    const stored = await inspection.readStoredThreadWindow("thread", ["turn"]);
    assert.equal(stored?.id, "thread");
    await inspection.dispose();

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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-bridge-live-only-transcript-"));
  const notifications: string[] = [];
  const sqliteBatches: WorkbenchTranscriptObservation[][] = [];
  const bridge = new CodexStdioBridge({
    appServer: { send() {} } as unknown as CodexAppServer,
    bridgeUrl: "ws://127.0.0.1:1",
    handleWorkbenchRequest: rejectWorkbenchRequest,
    onNotification(notification) {
      notifications.push(notification.method ?? "");
    },
    recordSqliteTranscript: async (observations) => {
      sqliteBatches.push([...observations]);
    },
    resolveProjectFromCwd: async () => ({
      cwd: "C:/repo",
      project: { id: "project", kind: "git", root: "C:/repo", rootPath: "C:/repo", roots: [] },
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
    type: "agentMessage",
  };
  const owner = bridge as unknown as { ensureTranscriptStore(): CodexTranscriptStore };

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
    await bridge.waitForIdle();

    assert.equal(notifications.filter((method) => method === "item/agentMessage/delta").length, 200);
    assert.equal(notifications.includes("turn/diff/updated"), true);
    assert.equal(notifications.includes("turn/plan/updated"), true);
    assert.equal(sqliteBatches.length, durableBatchCount);
    const liveOnlyWindow = await owner.ensureTranscriptStore().readStoredThreadWindow("thread", ["turn"]);
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
    const settledWindow = await owner.ensureTranscriptStore().readStoredThreadWindow("thread", ["turn"]);
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
          result: { thread: bridgeThread() },
        });
      });
    },
  } as unknown as CodexAppServer;
  bridge = new CodexStdioBridge({
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
      project: { id: "project", kind: "git", root: "C:/repo", rootPath: "C:/repo", roots: [] },
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
    assert.equal(upstreamMessages.length, 2);
    assert.equal(upstreamMessages[0]?.method, "thread/read");
    assert.deepEqual(upstreamMessages[0]?.params, { includeTurns: true, threadId: "thread" });
    assert.deepEqual(contexts, [
      { recoveryBoundary: true, source: "provider" },
    ]);
  } finally {
    releaseSqlite.resolve();
    await bridge.disposeImmediately();
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("SQLite transcript failure does not block steer or questionnaire side effects", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-bridge-transcript-failed-"));
  const upstreamMessages: unknown[] = [];
  const client: BridgeClient = {
    OPEN: 1, close() {}, on() {}, once() {}, readyState: 1, send() {},
  };
  const bridge = new CodexStdioBridge({
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
    assert.deepEqual(response?.result, { ok: true });
    assert.equal((upstreamMessages[1] as { id?: string } | undefined)?.id, "questionnaire");
  } finally {
    await bridge.disposeImmediately();
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("repeated provider misses report one SQLite capture failure", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-bridge-transcript-report-"));
  const records: Array<{ event?: string }> = [];
  const bridge = new CodexStdioBridge({
    appServer: { send() {} } as unknown as CodexAppServer,
    bridgeUrl: "ws://127.0.0.1:1",
    handleWorkbenchRequest: rejectWorkbenchRequest,
    onNotification() {},
    recordSqliteTranscript: async () => { throw new Error("SQLite transcript failed"); },
    resolveProjectFromCwd: async () => null,
    sendToClient() {},
    storageRoot: root,
    transcriptShadowLog: {
      flush: async () => undefined,
      write: (record) => { records.push(record); },
    },
  });
  const item = {
    id: "message",
    memoryCitation: null,
    phase: "commentary" as const,
    text: "hello",
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
    assert.equal(records.filter(({ event }) => event === "capture-failed").length, 1);
  } finally {
    await bridge.disposeImmediately();
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("Browse settlement verifies Workbench transcript assets before forwarding their SQLite observation", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-bridge-browse-asset-"));
  const observations: object[] = [];
  const notifications: object[] = [];
  const bytes = Buffer.from("verified browse image");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const encodedThreadId = Buffer.from("thread", "utf8").toString("base64url");
  const assetUrl = `/api/transcript-assets/codex/${encodedThreadId}/${digest}.png`;
  const assetDirectory = path.join(
    root,
    ".workbench",
    "transcripts",
    "codex",
    "threads",
    encodedThreadId,
    "assets",
  );
  await fs.mkdir(assetDirectory, { recursive: true });
  await fs.writeFile(path.join(assetDirectory, `${digest}.png`), bytes);

  const bridge = new CodexStdioBridge({
    appServer: { send() {} } as unknown as CodexAppServer,
    bridgeUrl: "ws://127.0.0.1:1",
    handleWorkbenchRequest: rejectWorkbenchRequest,
    onNotification(notification) { notifications.push(notification); },
    recordSqliteTranscript: async (batch) => {
      observations.push(...batch);
    },
    resolveProjectFromCwd: async () => ({
      cwd: "C:/repo",
      project: { id: "project", kind: "git", root: "C:/repo", rootPath: "C:/repo", roots: [] },
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
      entry,
      asset: {
        byteLength: bytes.byteLength,
        digest,
        mimeType: "image/png",
        storageKey: assetUrl,
      },
    }]);
    assert.deepEqual(notifications, [{
      method: "browse/result/recorded",
      params: { threadId: "thread", turnId: "turn" },
    }]);

    await fs.writeFile(path.join(assetDirectory, `${digest}.png`), "tampered");
    await assert.rejects(
      bridge.recordBrowseResultForBrowse({ ...entry, entryKey: "tampered" }),
      /contents do not match/u,
    );
    assert.equal(observations.length, 1);
    assert.equal(notifications.length, 1);
  } finally {
    await bridge.disposeImmediately();
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("SQLite transcript failure does not block Browse settlement", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-bridge-browse-sqlite-failure-"));
  const notifications: object[] = [];
  const bridge = new CodexStdioBridge({
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
      params: { threadId: "thread", turnId: "turn" },
    }]);
  } finally {
    await bridge.disposeImmediately();
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("live transcript recording survives throwing compatibility readers across reload", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-bridge-live-transcript-"));
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  installWorkbenchDatabaseSchema(database);
  const repository = new WorkbenchTranscriptRepository(database);
  const sqliteBatches: WorkbenchTranscriptObservation[][] = [];
  const sqliteFailures: Error[] = [];
  const upstreamRequests: JsonRpcRequest[] = [];
  let compatibilityReads = 0;
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
    appServer,
    bridgeUrl: "ws://127.0.0.1:1",
    handleWorkbenchRequest: rejectWorkbenchRequest,
    initialState,
    onNotification() {},
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
      project: { id: "project", kind: "git", root: "C:/repo", rootPath: "C:/repo", roots: [] },
      root: { id: "root", name: "repo", root: "C:/repo", rootPath: "C:/repo" },
    }),
    sendToClient() {},
    storageRoot: root,
  });
  const guardSqliteCompatibilityReader = () => {
    const owner = bridge as unknown as { ensureTranscriptStore(): CodexTranscriptStore };
    const store = owner.ensureTranscriptStore() as CodexTranscriptStore & {
      readThreadContextEntries: () => Promise<never>;
    };
    const fail = async (): Promise<never> => {
      compatibilityReads += 1;
      throw new Error("legacy compatibility reader crossed the live boundary");
    };
    store.readThreadContextEntries = fail;
  };
  const item: ThreadItem = {
    id: "message",
    memoryCitation: null,
    phase: "commentary",
    text: "live",
    type: "agentMessage",
  };
  const liveTurn = bridgeThread().turns[0]!;
  const assetBytes = Buffer.from("live browse image");
  const assetDigest = createHash("sha256").update(assetBytes).digest("hex");
  const encodedThreadId = Buffer.from("thread", "utf8").toString("base64url");
  const assetUrl = `/api/transcript-assets/codex/${encodedThreadId}/${assetDigest}.png`;
  const assetDirectory = path.join(
    root,
    ".workbench",
    "transcripts",
    "codex",
    "threads",
    encodedThreadId,
    "assets",
  );
  await fs.mkdir(assetDirectory, { recursive: true });
  await fs.writeFile(path.join(assetDirectory, `${assetDigest}.png`), assetBytes);

  try {
    bridge = createBridge();
    guardSqliteCompatibilityReader();
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
    guardSqliteCompatibilityReader();
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
    const compatibilityOwner = bridge as unknown as {
      ensureTranscriptStore(): CodexTranscriptStore;
      importSqliteCompatibilityWindow(thread: Thread, transcriptStore: CodexTranscriptStore): Promise<void>;
    };
    await compatibilityOwner.importSqliteCompatibilityWindow(
      bridgeThread(),
      compatibilityOwner.ensureTranscriptStore(),
    );

    const observations = sqliteBatches.flat();
    assert.equal(compatibilityReads, 0);
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
    assert.ok(snapshot.rows.threadItems.some(({ source_id }) => source_id === "message"));
    assert.ok(snapshot.rows.threadItems.some(({ source_id }) => source_id === "dynamic-call"));
    assert.ok(snapshot.rows.threadItems.some(({ source_id }) => source_id === "command"));
    assert.equal(snapshot.rows.threadItemInteractions.length, 1);
    assert.equal(snapshot.rows.threadBrowseEntries.length, 1);
    assert.deepEqual(snapshot.rows.transcriptAssets.map(({ digest }) => digest), [assetDigest]);
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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-bridge-file-change-test-"));
  const anchorlessItemId = "exec-11111111-1111-4111-8111-111111111111";
  const anchoredItemId = "exec-22222222-2222-4222-8222-222222222222";
  const ordinaryItemId = "exec-33333333-3333-4333-8333-333333333333";
  const precedingItem: ThreadItem = { id: "before", memoryCitation: null, phase: "commentary", text: "before", type: "agentMessage" };
  const followingItem: ThreadItem = { id: "after", memoryCitation: null, phase: "commentary", text: "after", type: "agentMessage" };
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
    appServer,
    bridgeUrl: "ws://127.0.0.1:1",
    handleWorkbenchRequest: rejectWorkbenchRequest,
    initialState,
    onNotification(notification) { notifications.push(notification as { params?: { item?: ThreadItem } }); },
    resolveProjectFromCwd: async () => null,
    sendToClient() {},
    storageRoot: root,
  });

  try {
    bridge = createBridge();
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
    assert.deepEqual(fileChangeNotifications[0]?.params?.item, {
      changes: [{
        diff: "",
        kind: { move_path: null, type: "update" },
        path: "C:\\repo\\src\\a.ts",
        workbenchAdditions: 1,
        workbenchDeletions: 1,
      }],
      id: anchorlessItemId,
      status: "failed",
      type: "fileChange",
      workbenchFailureKind: "unclaimed",
    });

    const read = await bridge.handleBridgeRequest({ id: 1, method: "thread/context/read", params: { threadId: "thread" } });
    const readItems = ((read?.result as { thread?: ReturnType<typeof bridgeThread> })?.thread?.turns[0]?.items ?? []) as WorkbenchFileChangeItem[];
    assert.equal(readItems.length, 1);
    assert.equal(readItems[0]?.workbenchFailureKind, "unclaimed");

    await bridge.handleUpstreamMessage({ method: "item/completed", params: { item: precedingItem, threadId: "thread", turnId: "turn" } });
    providerItems = [precedingItem];
    const reloadState = await bridge.detachForReload();
    bridge = createBridge(reloadState);
    const reloadedRead = await bridge.handleBridgeRequest({ id: 2, method: "thread/context/read", params: { threadId: "thread" } });
    const reloadedItems = ((reloadedRead?.result as { thread?: ReturnType<typeof bridgeThread> })?.thread?.turns[0]?.items ?? []) as WorkbenchFileChangeItem[];
    assert.deepEqual(reloadedItems.map((item) => item.id), [anchorlessItemId, precedingItem.id]);
    assert.equal(reloadedItems[0]?.workbenchFailureKind, "unclaimed");

    await bridge.handleUpstreamMessage(unclaimedHookNotification(anchoredItemId));
    await bridge.handleUpstreamMessage({ method: "item/completed", params: { item: followingItem, threadId: "thread", turnId: "turn" } });
    await bridge.handleUpstreamMessage(unclaimedHookNotification(anchoredItemId));
    providerItems = [precedingItem, followingItem];
    const futureRead = await bridge.handleBridgeRequest({ id: 3, method: "thread/context/read", params: { threadId: "thread" } });
    const futureItems = ((futureRead?.result as { thread?: ReturnType<typeof bridgeThread> })?.thread?.turns[0]?.items ?? []) as WorkbenchFileChangeItem[];
    assert.deepEqual(futureItems.map((item) => item.id), [anchorlessItemId, precedingItem.id, anchoredItemId, followingItem.id]);
    fileChangeNotifications = notifications.filter((notification) => notification.method === "item/completed" && notification.params?.item?.type === "fileChange");
    assert.equal(fileChangeNotifications.length, 2);

    providerItems = [precedingItem, followingItem, futureProviderItem];
    const providerRead = await bridge.handleBridgeRequest({ id: 4, method: "thread/context/read", params: { threadId: "thread" } });
    const providerReadItems = ((providerRead?.result as { thread?: ReturnType<typeof bridgeThread> })?.thread?.turns[0]?.items ?? []) as WorkbenchFileChangeItem[];
    assert.deepEqual(providerReadItems.map((item) => item.id), [precedingItem.id, anchoredItemId, followingItem.id, anchorlessItemId]);
    assert.equal(providerReadItems.at(-1)?.workbenchFailureKind, "unclaimed");
    assert.equal(providerReadItems.at(-1)?.changes[0]?.diff, futureProviderItem.changes[0]?.diff);

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
    assert.equal(completedState.fileChangeTurnCursors?.size, 0);
  } finally {
    await bridge.disposeImmediately();
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("external socket send failure clears pending response and records exact steer failure", async () => {
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
    appServer,
    bridgeUrl: "ws://127.0.0.1:1",
    handleWorkbenchRequest: rejectWorkbenchRequest,
    onNotification() {},
    resolveProjectFromCwd: async () => null,
    sendToClient() {},
    storageRoot: root,
  });
  try {
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
    const transcriptPath = path.join(root, ".workbench", "transcripts", "codex", "threads");
    const threadDirectories = await fs.readdir(transcriptPath);
    assert.equal(threadDirectories.length, 1);
    const persisted = JSON.parse(await fs.readFile(path.join(transcriptPath, threadDirectories[0]!, "thread.json"), "utf8")) as {
      steerEntries?: Array<{ clientUserMessageId?: string | null; error: string | null; status: string }>;
    };
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
    sendToClient(_client, message) { clientMessages.push(message); },
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
  const TranscriptStore = (await import("./CodexTranscriptStore.js")).default as unknown as typeof CodexTranscriptStore;
  const transcriptStore = new TranscriptStore(root);
  await transcriptStore.recordHydratedThreadSnapshot({
    id: 1,
    result: {
      thread: bridgeThread([{
        id: "stored-item",
        memoryCitation: null,
        phase: "commentary",
        text: "stored",
        type: "agentMessage",
      }]),
    },
  });
  await transcriptStore.dispose();

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

test("fresh first turn survives bridge reload and failed admission without resume", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-bridge-fresh-start-"));
  const events: string[] = [];
  const upstreamRequests: JsonRpcRequest[] = [];
  let turnStartAttempts = 0;
  let bridge!: InstanceType<typeof CodexStdioBridge>;
  const appServer = {
    send(message: JsonRpcRequest) {
      upstreamRequests.push(message);
      queueMicrotask(() => {
        if (message.method === "thread/start") {
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
    onNotification() {},
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
    assert.deepEqual(upstreamRequests.map(({ method }) => method), [
      "thread/start",
      "turn/start",
      "turn/start",
    ]);
    assert.deepEqual(events, ["prepare:mcp", "prepare:mcp"]);
  } finally {
    await bridge.waitForIdle();
    await bridge.disposeImmediately();
    await fs.rm(root, { force: true, recursive: true });
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
    agentPath: "library:agents/lily.md",
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
    assert.equal("baseInstructions" in startParams, false);
    assert.equal("developerInstructions" in startParams, false);
    assert.deepEqual(response?.result, { kind: "started", turn: startedTurn });
  } finally {
    await bridge.waitForIdle();
    await bridge.disposeImmediately();
    await fs.rm(root, { force: true, recursive: true });
  }
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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-bridge-context-test-"));
  const upstreamRequests: JsonRpcRequest[] = [];
  let bridge!: InstanceType<typeof CodexStdioBridge>;
  const appServer = {
    send(message: JsonRpcRequest) {
      upstreamRequests.push(message);
      queueMicrotask(() => {
        void bridge.handleUpstreamMessage({ id: message.id ?? null, result: { thread: bridgeThread() } });
      });
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
  const queueGate = deferred<{ data: [] }>();
  const queueOwner = bridge as unknown as {
    listQuestionnaireHistory(params: unknown): Promise<{ data: [] }>;
  };
  queueOwner.listQuestionnaireHistory = async () => await queueGate.promise;

  try {
    const queuedRead = bridge.handleBridgeRequest({
      id: 10,
      method: "questionnaire/history/list",
      params: { threadId: "thread" },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const scopedRead = bridge.handleBridgeRequest({
      id: 11,
      method: "thread/context/read",
      params: { includeTurns: true, threadId: "thread" },
      workbenchThreadContextEntries: { mode: "hydratedTurns" },
      workbenchThreadHydration: { mode: "latest" },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(upstreamRequests.length, 1);
    assert.equal(upstreamRequests[0]?.method, "thread/read");
    assert.equal("workbenchThreadContextEntries" in (upstreamRequests[0] ?? {}), false);

    queueGate.resolve({ data: [] });
    await queuedRead;
    const scopedResponse = await scopedRead;
    assert.deepEqual((scopedResponse?.result as { entryScope?: unknown })?.entryScope, {
      mode: "turns",
      turnIds: ["turn"],
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

test("exact transcript windows await ordered import and Thread Recall reuses their materialisation owner", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-bridge-known-window-"));
  const compatibilityImportStarted = deferred<void>();
  const releaseCompatibilityImport = deferred<void>();
  const materializedTurnIds = new Set<string>();
  const sqliteBatches: object[][] = [];
  const upstreamRequests: JsonRpcRequest[] = [];
  let materializationReads = 0;
  let bridge!: InstanceType<typeof CodexStdioBridge>;
  const appServer = {
    send(message: JsonRpcRequest) {
      upstreamRequests.push(message);
      queueMicrotask(() => {
        if (message.method === "thread/turns/list") {
          const latest = bridgeThread().turns[0]!;
          void bridge.handleUpstreamMessage({
            id: message.id ?? null,
            result: {
              data: [{ ...latest, items: [], itemsView: "notLoaded" }],
              nextCursor: null,
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
      sqliteBatches.push([...observations]);
      const compatibilityWindow = observations.find(({ kind }) => kind === "canonicalWindow");
      if (compatibilityWindow?.kind === "canonicalWindow") {
        compatibilityImportStarted.resolve();
        await releaseCompatibilityImport.promise;
        for (const turnId of compatibilityWindow.materializedTurnIds) materializedTurnIds.add(turnId);
      }
    },
    resolveProjectFromCwd: async () => ({
      cwd: "C:/repo",
      project: { id: "project", kind: "git", root: "C:/repo", rootPath: "C:/repo", roots: [] },
      root: { id: "root", name: "repo", root: "C:/repo", rootPath: "C:/repo" },
    }),
    sendToClient() {},
    storageRoot: root,
  });
  const owner = bridge as unknown as { ensureTranscriptStore(): CodexTranscriptStore };
  try {
    const metadata = { ...bridgeThread(), turns: [] } as Thread;
    const latest = bridgeThread().turns[0]!;
    const earlier = {
      ...latest,
      completedAt: 1,
      id: "earlier",
      startedAt: 0,
      status: "completed" as const,
    };
    await owner.ensureTranscriptStore().recordProviderTurnCatalog(metadata, [earlier, latest], {
      cursor: null,
      turnId: latest.id,
    });
    await owner.ensureTranscriptStore().recordProviderTurnPage(metadata, earlier, null);
    await owner.ensureTranscriptStore().recordProviderTurnPage(metadata, latest, null);

    const responseTask = bridge.handleBridgeRequest({
      id: 20,
      method: "workbench/thread/page/read",
      params: { cursor: null, threadId: "thread" },
    });
    const duplicateResponseTask = bridge.handleBridgeRequest({
      id: 21,
      method: "workbench/thread/page/read",
      params: { cursor: null, threadId: "thread" },
    });
    await compatibilityImportStarted.promise;
    const [response, duplicateResponse] = await Promise.all([responseTask, duplicateResponseTask]);
    assert.deepEqual(duplicateResponse?.result, response?.result);
    assert.deepEqual(upstreamRequests.map((request) => request.method), [
      "thread/read",
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
    assert.deepEqual(
      ((sameWindowResponse?.result as { thread: Thread }).thread.turns).map((turn) => turn.id),
      ["turn"],
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
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    assert.equal(transcriptMaterialisationSettled, false);
    releaseCompatibilityImport.resolve();
    const transcriptMaterialisation = await transcriptMaterialisationTask;
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
      ["turn"],
    );
    await bridge.waitForIdle();
    assert.equal(materializationReads, 4);
    const compatibilityWindows = sqliteBatches.flat().filter((observation) => (
      (observation as { kind?: string }).kind === "canonicalWindow"
    )) as Array<{ materializedTurnIds?: string[] }>;
    assert.deepEqual(
      compatibilityWindows.map(({ materializedTurnIds }) => materializedTurnIds),
      [["turn"], ["earlier"]],
    );
    assert.equal(upstreamRequests.length, upstreamRequestCountBeforeRecall);

    sqliteBatches.length = 0;
    const fullResponse = await bridge.handleBridgeRequest({
      id: 22,
      method: "thread/context/read",
      params: { includeTurns: true, threadId: "thread" },
      workbenchThreadContextEntries: { mode: "hydratedTurns" },
      workbenchThreadHydration: { mode: "legacyFull" },
    });
    assert.deepEqual(
      ((fullResponse?.result as { thread: Thread }).thread.turns).map((turn) => turn.id),
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
      materializedTurnIds: ["turn"],
      threadId: "thread",
    });
    const missingTurnResponse = await bridge.handleBridgeRequest({
      id: 24,
      method: "workbench/thread-recall/materialize",
      params: { threadId: "thread", turnId: "missing" },
    });
    assert.match(missingTurnResponse?.error?.message ?? "", /no stored compatibility turn missing/u);

    const store = owner.ensureTranscriptStore() as CodexTranscriptStore & {
      readThreadContextEntries(): Promise<never>;
    };
    store.readThreadContextEntries = async () => {
      throw new Error("materialized turns must not reach the compatibility reader");
    };
    sqliteBatches.length = 0;
    const compatibilityOwner = bridge as unknown as {
      importSqliteCompatibilityWindow(thread: Thread, transcriptStore: CodexTranscriptStore): Promise<void>;
    };
    await compatibilityOwner.importSqliteCompatibilityWindow(
      (fullResponse?.result as { thread: Thread }).thread,
      store,
    );
    await bridge.waitForIdle();
    assert.equal(sqliteBatches.flat().some((observation) => (
      (observation as { kind?: string }).kind === "canonicalWindow"
    )), false);
  } finally {
    await bridge.dispose();
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("bounded context reads bootstrap unseen threads through one full turn page", async () => {
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
    appServer,
    bridgeUrl: "ws://127.0.0.1:1",
    handleWorkbenchRequest: rejectWorkbenchRequest,
    instructions: new WorkbenchCodexInstructionAdapter("ws://127.0.0.1:1", root),
    onNotification() {},
    resolveProjectFromCwd: async () => null,
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
      ["turn"],
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

