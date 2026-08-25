/*
 * Exports:
 * - No production exports; Node tests cover bridge pending cleanup, file-change failure ordering, turn-start preflight, context reads, managed MCP config, and scoped-entry negotiation. Keywords: codex, bridge, transcript, MCP, test.
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import type CodexAppServer from "./CodexAppServer";
import type { ThreadItem } from "../lib/codex/generated/app-server/v2/ThreadItem";
import {
  createWorkbenchFileChangeFailureSystemMessage,
  type WorkbenchFileChangeItem,
} from "../lib/workbench/thread/workbench-file-change";
import type { BridgeClient, JsonRpcRequest } from "./bridge-types";

const originalWorkbenchLibraryRoot = process.env.WORKBENCH_LIBRARY_ROOT;
let testWorkbenchLibraryRoot = "";
let CodexStdioBridge: typeof import("./CodexStdioBridge.js").default;

before(async () => {
  testWorkbenchLibraryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-bridge-library-test-"));
  process.env.WORKBENCH_LIBRARY_ROOT = testWorkbenchLibraryRoot;
  const bridgeModule = await import("./CodexStdioBridge.js");
  CodexStdioBridge = bridgeModule.default as unknown as typeof CodexStdioBridge;
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
    cliVersion: "test",
    createdAt: 1,
    cwd: "C:/repo",
    ephemeral: false,
    forkedFromId: null,
    gitInfo: null,
    id: "thread",
    modelProvider: "openai",
    name: null,
    parentThreadId: null,
    path: null,
    preview: "",
    recencyAt: null,
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
    const state = await bridge.detachForReload();
    assert.equal(state.pendingResponses.size, 0);
    assert.ok(state.requestIdAllocator.next > upstreamRequest!.id);
  } finally {
    await bridge.disposeImmediately();
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("turn-start preflight completes before upstream delivery and blocks delivery on failure", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-bridge-turn-preflight-"));
  const client: BridgeClient = {
    OPEN: 1, close() {}, on() {}, once() {}, readyState: 1, send() {},
  };
  const gate = deferred<void>();
  const events: string[] = [];
  const upstreamRequests: JsonRpcRequest[] = [];
  let rejectPreflight = false;
  const appServer = {
    send(message: JsonRpcRequest) {
      events.push(`send:${message.method}`);
      upstreamRequests.push(message);
    },
  } as unknown as CodexAppServer;
  const bridge = new CodexStdioBridge({
    appServer,
    bridgeUrl: "ws://127.0.0.1:1",
    handleWorkbenchRequest: rejectWorkbenchRequest,
    onNotification() {},
    prepareTurnStart: async () => {
      events.push("prepare:start");
      if (rejectPreflight) throw new Error("MCP refresh failed");
      await gate.promise;
      events.push("prepare:complete");
    },
    resolveProjectFromCwd: async () => null,
    sendToClient() {},
    storageRoot: root,
  });
  const request = (id: number): JsonRpcRequest => ({
    id,
    method: "turn/start",
    params: { input: [{ text: "continue", text_elements: [], type: "text" }], threadId: "thread" },
  });
  try {
    const admitted = bridge.forwardRequest(request(1), client, 1);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(events, ["prepare:start"]);
    assert.deepEqual(upstreamRequests, []);

    gate.resolve();
    await admitted;
    assert.deepEqual(events, ["prepare:start", "prepare:complete", "send:turn/start"]);
    assert.equal(upstreamRequests.length, 1);

    rejectPreflight = true;
    await assert.rejects(bridge.forwardRequest(request(2), client, 2), /MCP refresh failed/u);
    assert.equal(upstreamRequests.length, 1);
  } finally {
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
    const instrumentation = bridge as unknown as {
      transcriptAutoRefreshSkippedCount: number;
      transcriptLabelCounts: Map<string, number>;
    };
    assert.equal(instrumentation.transcriptAutoRefreshSkippedCount, 2);
    assert.equal(instrumentation.transcriptLabelCounts.get("client-request") ?? 0, 0);
    assert.equal(instrumentation.transcriptLabelCounts.get("upstream-response:thread/list") ?? 0, 0);
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

test("managed thread starts, resumes, and forks receive runtime policy and wb MCP config without replacing caller config", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-bridge-mcp-config-test-"));
  const bridge = new CodexStdioBridge({
    appServer: { send() {} } as unknown as CodexAppServer,
    bridgeUrl: "ws://0.0.0.0:4500",
    handleWorkbenchRequest: rejectWorkbenchRequest,
    onNotification() {},
    resolveProjectFromCwd: async () => null,
    sendToClient() {},
    storageRoot: root,
  });
  const owner = bridge as unknown as {
    withWorkbenchPromptInstructions(message: JsonRpcRequest, method: string): Promise<JsonRpcRequest>;
  };
  const clientScopes = new Set<string>();
  try {
    for (const method of ["thread/start", "thread/resume", "thread/fork"]) {
      const capable = method === "thread/start";
      const result = await owner.withWorkbenchPromptInstructions({
        method,
        params: {
          config: {
            bypass_hook_trust: false,
            existing_setting: "preserved",
            mcp_servers: { docs: { url: "https://example.com/mcp" } },
          },
          threadId: "thread",
        },
        workbenchPromptContext: { ...(capable ? { cwd: root } : {}), instructionScope: "threadUtilities", threadId: "thread" },
      }, method);
      const config = (result.params as { config: Record<string, unknown> }).config;
      assert.equal(config.existing_setting, "preserved");
      assert.equal(config.bypass_hook_trust, true);
      assert.deepEqual((config.mcp_servers as Record<string, unknown>).docs, { url: "https://example.com/mcp" });
      const wb = (config.mcp_servers as { wb: Record<string, unknown> }).wb;
      const mcpUrl = new URL(String(wb.url));
      const clientScope = mcpUrl.searchParams.get("client") ?? "";
      assert.equal(mcpUrl.origin, "http://127.0.0.1:4500");
      assert.equal(mcpUrl.pathname, "/orchestrator/mcp");
      assert.match(clientScope, /^[0-9a-f-]{36}$/u);
      assert.equal(mcpUrl.searchParams.get("capabilities"), null);
      clientScopes.add(clientScope);
      const { url: _url, ...wbWithoutUrl } = wb;
      assert.deepEqual(wbWithoutUrl, {
        default_tools_approval_mode: "approve",
        required: true,
        tool_timeout_sec: 1800,
      });
    }
    assert.equal(clientScopes.size, 3);

    const unmarked = await owner.withWorkbenchPromptInstructions({
      method: "thread/start",
      params: { config: { bypass_hook_trust: false, existing_setting: "preserved" } },
    }, "thread/start");
    assert.deepEqual(unmarked.params, { config: { bypass_hook_trust: false, existing_setting: "preserved" } });
  } finally {
    await bridge.disposeImmediately();
    await fs.rm(root, { force: true, recursive: true });
  }
});
