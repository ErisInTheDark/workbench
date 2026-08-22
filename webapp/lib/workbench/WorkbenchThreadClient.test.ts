/*
 * Exports:
 * - No production exports; Node tests cover thread reads, lifecycle fencing, canonical placement, and message admission settlement. Keywords: workbench, thread, lifecycle, read, message, integration, test.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { Thread } from "../codex/generated/app-server/v2/Thread.ts";
import type { ThreadPayload, WorkbenchBrowseResultEntry, WorkbenchSteerHistoryEntry, WorkbenchThreadTurnHistoryEntry } from "../types.ts";
import WorkbenchThreadClient, { type WorkbenchAcceptedIntent } from "./WorkbenchThreadClient.ts";
import { ThreadMessageNotSentError } from "./thread/thread-message-submission.ts";

type Listener = (event: { data?: string }) => void;
type SocketRequest = {
  id: number;
  method: string;
  params?: Record<string, unknown>;
  workbenchHarness?: string;
  workbenchThreadContextEntries?: { mode: string };
  workbenchThreadHydration?: Record<string, unknown>;
};

function wireThread(
  id: string,
  turnId = `${id}-turn`,
  turnStatus: Thread["turns"][number]["status"] = "inProgress",
): Thread {
  return {
    agentNickname: null, agentRole: null, canAcceptDirectInput: null, cliVersion: "test", createdAt: 1, cwd: "C:/repo", ephemeral: false,
    extra: null, forkedFromId: null, gitInfo: null, historyMode: "legacy", id, modelProvider: "openai", name: null, parentThreadId: null, path: null,
    preview: "", recencyAt: null, section: null, sectionEnteredAt: null, sessionId: `${id}-session`, source: "appServer",
    status: turnStatus === "inProgress" ? { activeFlags: [], type: "active" } : { type: "idle" },
    threadSource: null, turns: [{
      completedAt: turnStatus === "inProgress" ? null : 2,
      durationMs: turnStatus === "inProgress" ? null : 1,
      error: null,
      id: turnId,
      items: [],
      itemsView: "full",
      startedAt: 1,
      status: turnStatus,
    }],
    updatedAt: 1,
  };
}

class FakeWebSocket {
  static readonly OPEN = 1;
  static intercept: ((socket: FakeWebSocket, request: SocketRequest) => boolean) | null = null;
  readonly OPEN = 1;
  readyState = 1;
  readonly requests: SocketRequest[] = [];
  private readonly listeners = new Map<string, Listener[]>();

  constructor(_url: string) {
    queueMicrotask(() => this.emit("open", {}));
  }

  addEventListener(type: string, listener: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  close() {
    this.readyState = 3;
    this.emit("close", {});
  }

  send(payload: string) {
    const message = JSON.parse(payload) as Omit<SocketRequest, "id"> & { id?: number };
    if (message.id === undefined) {
      return;
    }
    const request = { ...message, id: message.id };
    this.requests.push(request);
    if (FakeWebSocket.intercept?.(this, request)) {
      return;
    }
    if (request.method === "initialize") {
      queueMicrotask(() => this.respond(request.id, {}));
    } else if (request.method === "account/rateLimits/read") {
      queueMicrotask(() => this.fail(request.id, "rate limits unavailable in test"));
    } else if (request.method === "thread/read") {
      const threadId = String(request.params?.threadId ?? "thread");
      queueMicrotask(() => this.respond(request.id, { thread: wireThread(threadId) }));
    } else if (request.method === "thread/context/read") {
      const threadId = String(request.params?.threadId ?? "thread");
      queueMicrotask(() => this.respond(request.id, { browseResultEntries: [], questionnaireEntries: [], steerEntries: [], thread: wireThread(threadId) }));
    } else if (request.method === "thread/resume") {
      const threadId = String(request.params?.threadId ?? "thread");
      queueMicrotask(() => this.respond(request.id, { model: "model", reasoningEffort: null, serviceTier: null, thread: wireThread(threadId) }));
    } else if (request.method === "thread/list") {
      queueMicrotask(() => this.respond(request.id, { data: [] }));
    } else if (request.method === "questionnaire/list") {
      queueMicrotask(() => this.respond(request.id, { data: [] }));
    } else if (request.method === "questionnaire/respond") {
      queueMicrotask(() => this.respond(request.id, { ok: true }));
    } else if (request.method === "turn/interrupt" || request.method === "thread/compact/start" || request.method === "thread/goal/clear") {
      queueMicrotask(() => this.respond(request.id, {}));
    } else if (request.method === "browse/result/list" || request.method === "questionnaire/history/list" || request.method === "steer/history/list") {
      queueMicrotask(() => this.respond(request.id, { data: [] }));
    } else if (request.method === "turn/steer") {
      const turnId = String(request.params?.expectedTurnId ?? "turn");
      queueMicrotask(() => this.respond(request.id, request.workbenchHarness === "copilot"
        ? { ok: true }
        : request.workbenchHarness === "opencode"
          ? { turn: wireThread(String(request.params?.threadId ?? "thread"), turnId).turns[0] }
          : { turnId }));
    } else if (request.method === "turn/start") {
      const threadId = String(request.params?.threadId ?? "thread");
      queueMicrotask(() => this.respond(request.id, { turn: wireThread(threadId, `${threadId}-started`).turns[0] }));
    } else if (request.method === "workbench/thread-state/intent/accept" || request.method === "workbench/thread-state/questionnaire/resolve") {
      queueMicrotask(() => this.respond(request.id, { accepted: true, revision: 1 }));
    } else {
      queueMicrotask(() => this.fail(request.id, `unexpected ${request.method}`));
    }
  }

  notify(method: string, params: unknown, workbenchHarness = "codex") {
    this.emit("message", { data: JSON.stringify({ method, params, workbenchHarness }) });
  }

  fail(id: number, message: string) {
    this.emit("message", { data: JSON.stringify({ error: { code: -32000, message }, id }) });
  }

  respond(id: number, result: unknown) {
    this.emit("message", { data: JSON.stringify({ id, result }) });
  }

  private emit(type: string, event: { data?: string }) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

async function waitForRequest(socket: FakeWebSocket, method: string, offset = 0) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const requests = socket.requests.filter((request) => request.method === method);
    if (requests[offset]) {
      return requests[offset];
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Timed out waiting for ${method} request ${offset}.`);
}

async function waitForCondition(predicate: () => boolean, message: string) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(message);
}

async function withClient(
  run: (client: ReturnType<typeof WorkbenchThreadClient>, socket: FakeWebSocket) => Promise<void>,
  clientOptions: Parameters<typeof WorkbenchThreadClient>[0] = {},
) {
  const originalWindow = globalThis.window;
  const originalWebSocket = globalThis.WebSocket;
  let socket: FakeWebSocket | null = null;
  FakeWebSocket.intercept = null;
  globalThis.window = {
    clearTimeout: globalThis.clearTimeout,
    setTimeout: globalThis.setTimeout,
  } as unknown as Window & typeof globalThis;
  globalThis.WebSocket = class extends FakeWebSocket {
    constructor(url: string) {
      super(url);
      socket = this;
    }
  } as unknown as typeof WebSocket;
  const client = WorkbenchThreadClient(clientOptions);
  try {
    client.setProjectContext({ projectId: "project", root: "repo", rootPath: "C:/repo" });
    await client.refreshRateLimits();
    assert.ok(socket);
    await run(client, socket);
  } finally {
    FakeWebSocket.intercept = null;
    client.dispose();
    globalThis.WebSocket = originalWebSocket;
    globalThis.window = originalWindow;
  }
}

function activeThread(
  harness: ThreadPayload["harness"] = "codex",
  id = "thread",
  turnStatus: ThreadPayload["turns"][number]["status"] = "inProgress",
): ThreadPayload {
  return {
    agentNickname: null, agentPath: null, agentRole: null, browseResultEntries: [], createdAt: 1, cwd: "C:/repo",
    forkedFromId: null, harness, id, isDraft: false, model: "model", name: null, path: null, preview: "",
    reasoningEffort: null, serviceTier: null, source: harness, status: turnStatus === "inProgress" ? "active" : "idle", tokenUsage: null, turnHistory: [],
    turns: [{ completedAt: turnStatus === "inProgress" ? null : 2, durationMs: turnStatus === "inProgress" ? null : 1, error: null, id: `${id === "thread" ? "" : `${id}-`}turn`, items: [], itemsView: "full", startedAt: 1, status: turnStatus }], updatedAt: 1,
  };
}

function historyEntry(turnId: string, loadState: WorkbenchThreadTurnHistoryEntry["loadState"]): WorkbenchThreadTurnHistoryEntry {
  return {
    completedAt: turnId === "turn" ? null : 2,
    durationMs: turnId === "turn" ? null : 1,
    itemCount: 0,
    itemIds: [],
    loadState,
    startedAt: 1,
    status: turnId === "turn" ? "inProgress" : "completed",
    turnId,
  };
}

function wireThreadWithHistory(turnIds: string[], history: WorkbenchThreadTurnHistoryEntry[]) {
  const base = wireThread("thread");
  return {
    ...base,
    turns: turnIds.map((turnId) => ({
      ...base.turns[0]!,
      completedAt: turnId === "turn" ? null : 2,
      durationMs: turnId === "turn" ? null : 1,
      id: turnId,
      startedAt: turnId === "turn" ? 2 : 1,
      status: turnId === "turn" ? "inProgress" as const : "completed" as const,
    })),
    workbenchTurnHistory: history,
  };
}

function browseEntry(entryKey: string, turnId: string): WorkbenchBrowseResultEntry {
  return {
    action: "snapshot",
    actionIndex: 0,
    assetUrl: null,
    commandItemId: null,
    detailKind: "result",
    detailLabel: null,
    detailText: entryKey,
    durationMs: 1,
    entryKey,
    recordedAt: turnId === "older" ? 1 : 2,
    session: "research",
    state: "completed",
    threadId: "thread",
    turnId,
  };
}

test("accepted thread titles update only the matching canonical source name", async () => withClient(async (client) => {
  const original = activeThread("codex", "original");
  const progressed = { ...original, preview: "newer preview", updatedAt: 2 };
  const selected = activeThread("opencode", "selected");
  client.selectThreadPayload(progressed);
  client.selectThreadPayload(selected);

  assert.equal(client.applyAcceptedThreadTitle(original.id, original.harness, "Renamed original"), true);

  const snapshot = client.getSnapshot();
  const originalKey = snapshot.threadDocuments.keysByThreadId[original.id];
  const renamedOriginal = originalKey ? snapshot.threadDocuments.documentsByKey[originalKey] : null;
  assert.equal(renamedOriginal?.name, "Renamed original");
  assert.equal(renamedOriginal?.preview, "newer preview");
  assert.equal(renamedOriginal?.updatedAt, 2);
  assert.equal(snapshot.currentThread?.id, selected.id);
  assert.equal(snapshot.currentThread?.name, selected.name);
  assert.equal(client.applyAcceptedThreadTitle(selected.id, "codex", "Wrong harness"), false);
  assert.equal(client.getSnapshot().currentThread?.name, selected.name);
}));

test("selected active Codex steers settle at admission and canonical notification owns placement", async () => {
  const originalWindow = globalThis.window;
  const originalWebSocket = globalThis.WebSocket;
  let socket: FakeWebSocket | null = null;
  globalThis.window = {
    clearTimeout: globalThis.clearTimeout,
    setTimeout: globalThis.setTimeout,
  } as unknown as Window & typeof globalThis;
  globalThis.WebSocket = class extends FakeWebSocket {
    constructor(url: string) {
      super(url);
      socket = this;
    }
  } as unknown as typeof WebSocket;
  const client = WorkbenchThreadClient();
  try {
    const source = activeThread();
    client.setProjectContext({ projectId: "project", root: "repo", rootPath: "C:/repo" });
    client.selectThreadPayload(source);
    const firstAdmission = client.sendThreadMessage(source, [{ text: "same", text_elements: [], type: "text" }]);
    const secondAdmission = client.sendThreadMessage(source, [{ text: "same", text_elements: [], type: "text" }]);
    const [first, second] = await Promise.all([firstAdmission, secondAdmission]);
    assert.equal(first, null);
    assert.equal(second, null);
    const methods = socket?.requests.map((request) => request.method) ?? [];
    assert.equal(methods.filter((method) => method === "turn/steer").length, 2);
    assert.equal(methods.some((method) => method === "thread/read" || method === "thread/resume" || method === "steer/history/list" || method === "thread/list"), false);
    assert.equal(client.getSnapshot().currentThread?.turns[0]?.items.filter((item) => item.type === "userMessage").length, 2);

    const steerRequests = socket?.requests.filter((request) => request.method === "turn/steer") ?? [];
    const firstHandle = steerRequests[0]?.params?.clientUserMessageId;
    assert.equal(typeof firstHandle, "string");
    socket?.notify("item/started", {
      item: { clientId: firstHandle, content: [{ text: "same", text_elements: [], type: "text" }], id: "canonical-first", type: "userMessage" },
      threadId: "thread",
      turnId: "turn",
    });
    const userItems = client.getSnapshot().currentThread?.turns[0]?.items.filter((item) => item.type === "userMessage") ?? [];
    assert.equal(userItems.length, 2);
    assert.equal(userItems[0]?.id, "canonical-first");
    assert.ok(userItems[1]?.id.startsWith("optimistic-user-message:steer:pending:"));

    socket?.notify("item/completed", {
      item: { clientId: firstHandle, content: [{ text: "same", text_elements: [], type: "text" }], id: "canonical-first", type: "userMessage" },
      threadId: "thread",
      turnId: "turn",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(client.getSnapshot().currentThread?.turns[0]?.items.filter((item) => item.type === "userMessage").length, 2);
    assert.ok((socket?.requests ?? []).some((request) => request.method === "steer/history/list"));

    const secondHandle = steerRequests[1]?.params?.clientUserMessageId;
    assert.equal(typeof secondHandle, "string");
    socket?.notify("item/started", {
      item: { clientId: secondHandle, content: [{ text: "same", text_elements: [], type: "text" }], id: "canonical-second", type: "userMessage" },
      threadId: "thread",
      turnId: "turn-created-by-item",
    });
    const createdTurn = client.getSnapshot().currentThread?.turns.find((turn) => turn.id === "turn-created-by-item");
    assert.deepEqual(createdTurn?.items.map((item) => item.id), ["canonical-second"]);

    const background = { ...activeThread(), id: "background", turns: [{ ...activeThread().turns[0]!, id: "background-turn" }] };
    const backgroundResult = await client.sendThreadMessage(
      background,
      [{ text: "background steer", text_elements: [], type: "text" }],
      { selectThread: false },
    );
    assert.equal(backgroundResult?.id, "background");
    const backgroundRequests = socket?.requests.filter((request) => request.params?.threadId === "background") ?? [];
    const backgroundSteerIndex = backgroundRequests.findIndex((request) => request.method === "turn/steer");
    const backgroundPreparationIndex = backgroundRequests.findIndex((request) => request.method === "thread/read" || request.method === "thread/resume");
    assert.ok(backgroundSteerIndex >= 0);
    assert.ok(backgroundPreparationIndex === -1 || backgroundSteerIndex < backgroundPreparationIndex);
    assert.equal(backgroundRequests[backgroundSteerIndex]?.params?.expectedTurnId, "background-turn");
  } finally {
    client.dispose();
    globalThis.WebSocket = originalWebSocket;
    globalThis.window = originalWindow;
  }
});

test("differing acknowledgement runs the preserved tail once and tail failure stays admitted", async () => withClient(async (client, socket) => {
  const source = activeThread();
  client.selectThreadPayload(source);
  FakeWebSocket.intercept = (target, request) => {
    if (request.method === "turn/steer") {
      queueMicrotask(() => target.respond(request.id, { turnId: "different-turn" }));
      return true;
    }
    return false;
  };
  assert.equal((await client.sendThreadMessage(source, [{ text: "one", text_elements: [], type: "text" }]))?.id, "thread");
  assert.equal(socket.requests.filter((request) => request.method === "turn/steer").length, 1);
  assert.equal(socket.requests.filter((request) => request.method === "thread/resume").length, 1);
  assert.equal(socket.requests.filter((request) => request.method === "steer/history/list").length, 1);

  const second = activeThread("codex", "second");
  client.selectThreadPayload(second);
  FakeWebSocket.intercept = (target, request) => {
    if (request.method === "turn/steer") {
      queueMicrotask(() => target.respond(request.id, { turnId: "different-second-turn" }));
      return true;
    }
    if (request.method === "thread/resume") {
      queueMicrotask(() => target.fail(request.id, "reconciliation failed"));
      return true;
    }
    return false;
  };
  assert.equal(await client.sendThreadMessage(second, [{ text: "two", text_elements: [], type: "text" }]), null);
}));

test("idle selected Codex resumes once and starts with native identity while providers preserve their routes", async () => withClient(async (client, socket) => {
  const idle = activeThread("codex", "idle", "completed");
  client.selectThreadPayload(idle);
  FakeWebSocket.intercept = (target, request) => {
    if (request.method === "thread/resume" && request.params?.threadId === "idle") {
      queueMicrotask(() => target.respond(request.id, { model: "model", reasoningEffort: null, serviceTier: null, thread: wireThread("idle", "idle-turn", "completed") }));
      return true;
    }
    return false;
  };
  const result = await client.sendThreadMessage(idle, [{ text: "codex", text_elements: [], type: "text" }]);
  assert.equal(result, null);
  const codexStart = socket.requests.find((request) => request.method === "turn/start" && request.params?.threadId === "idle");
  assert.equal(typeof codexStart?.params?.clientUserMessageId, "string");
  const codexResume = socket.requests.find((request) => request.method === "thread/resume" && request.params?.threadId === "idle");
  assert.equal(codexResume?.workbenchThreadHydration?.mode, "latest");
  assert.equal(socket.requests.filter((request) => request.method === "thread/resume" && request.params?.threadId === "idle").length, 1);
  assert.equal(socket.requests.some((request) => request.method === "thread/read" && request.params?.threadId === "idle"), false);
  assert.equal(socket.requests.some((request) => request.method === "turn/steer" && request.params?.threadId === "idle"), false);
  assert.deepEqual(socket.requests.find((request) => request.method === "workbench/thread-state/intent/accept" && (request.params?.identity as { threadId?: string } | undefined)?.threadId === "idle")?.params, {
    identity: { harness: "codex", threadId: "idle" },
    projectId: "project",
    title: "New thread",
    turnId: "idle-started",
  });

  FakeWebSocket.intercept = null;

  for (const harness of ["copilot", "opencode"] as const) {
    const provider = activeThread(harness, `${harness}-thread`);
    client.selectThreadPayload(provider);
    const providerResult = await client.sendThreadMessage(provider, [{ text: harness, text_elements: [], type: "text" }]);
    assert.equal(providerResult?.harness, harness);
    const providerSteer = socket.requests.find((request) => request.method === "turn/steer" && request.params?.threadId === provider.id);
    assert.equal(providerSteer?.params?.clientUserMessageId, undefined);
    assert.equal(providerSteer?.workbenchHarness, harness);
  }
}));

test("an accepted background child turn publishes Working before the send returns", async () => withClient(async (client, socket) => {
  client.selectThreadPayload(activeThread("codex", "parent"));
  const child = activeThread("codex", "child", "completed");
  FakeWebSocket.intercept = (target, request) => {
    if (request.method === "thread/resume" && request.params?.threadId === "child") {
      queueMicrotask(() => target.respond(request.id, {
        model: "model",
        reasoningEffort: null,
        serviceTier: null,
        thread: wireThread("child", "child-turn", "completed"),
      }));
      return true;
    }
    return false;
  };
  const result = await client.sendThreadMessage(
    child,
    [{ text: "continue", text_elements: [], type: "text" }],
    { selectThread: false },
  );
  assert.equal(result?.id, "child");
  const startIndex = socket.requests.findIndex((request) => request.method === "turn/start" && request.params?.threadId === "child");
  const acceptedIndex = socket.requests.findIndex((request) => request.method === "workbench/thread-state/intent/accept" && (request.params?.identity as { threadId?: string } | undefined)?.threadId === "child");
  assert.ok(startIndex >= 0);
  assert.ok(acceptedIndex > startIndex);
  assert.deepEqual(socket.requests[acceptedIndex]?.params, {
    identity: { harness: "codex", threadId: "child" },
    projectId: "project",
    title: "continue",
    turnId: "child-started",
  });
}));

test("Copilot and OpenCode user notifications keep their provider-owned turn history path", async () => withClient(async (client, socket) => {
  for (const harness of ["copilot", "opencode"] as const) {
    const provider = activeThread(harness, `${harness}-notification`);
    client.selectThreadPayload(provider);
    socket.notify("item/started", {
      item: { clientId: null, content: [{ text: harness, text_elements: [], type: "text" }], id: `${harness}-item`, type: "userMessage" },
      threadId: provider.id,
      turnId: provider.turns[0]!.id,
    }, harness);
    const current = client.getSnapshot().currentThread;
    assert.equal(current?.turnHistory.length, 1);
    assert.deepEqual(current?.turns[0]?.items.map((item) => item.id), [`${harness}-item`]);
  }
}));

test("project reset and a newer canonical notification fence stale reads before source installation", async () => withClient(async (client, socket) => {
  const source = activeThread();
  client.selectThreadPayload(source);
  let deferred: SocketRequest | null = null;
  FakeWebSocket.intercept = (_target, request) => {
    if (request.method === "thread/context/read") {
      deferred = request;
      return true;
    }
    return false;
  };
  const staleRead = client.readThread("thread", "codex");
  await waitForRequest(socket, "thread/context/read");
  client.setProjectContext({ projectId: "other", root: "other", rootPath: "C:/other" });
  socket.respond(deferred!.id, { browseResultEntries: [], questionnaireEntries: [], steerEntries: [], thread: wireThread("thread") });
  assert.equal(await staleRead, null);
  assert.equal(client.getSnapshot().currentThread, null);

  client.setProjectContext({ projectId: "project", root: "repo", rootPath: "C:/repo" });
  client.selectThreadPayload(source);
  deferred = null;
  const racedRead = client.readThread("thread", "codex");
  await waitForRequest(socket, "thread/context/read", 1);
  socket.notify("item/started", {
    item: { clientId: null, content: [{ text: "new", text_elements: [], type: "text" }], id: "new-item", type: "userMessage" },
    threadId: "thread", turnId: "turn",
  });
  socket.respond(deferred!.id, { browseResultEntries: [], questionnaireEntries: [], steerEntries: [], thread: wireThread("thread") });
  assert.equal(await racedRead, null);
  assert.deepEqual(client.getSnapshot().currentThread?.turns[0]?.items.map((item) => item.id), ["new-item"]);
}));

test("previous Codex pages preserve live state and merge only their scoped sidecars", async () => withClient(async (client, socket) => {
  const olderTimeline = [{ completedAt: 2, firstSeenAt: 1, itemId: "older-item", lastSeenAt: 2, startedAt: 1 }];
  const currentTimeline = [{ completedAt: 4, firstSeenAt: 2, itemId: "current-item", lastSeenAt: 4, startedAt: 2 }];
  const replacementOlderTimeline = [{ completedAt: 3, firstSeenAt: 1, itemId: "older-item", lastSeenAt: 3, startedAt: 1 }];
  const history = [
    { ...historyEntry("older", "unloaded"), itemTimeline: olderTimeline },
    { ...historyEntry("turn", "loaded"), itemTimeline: currentTimeline },
  ];
  client.selectThreadPayload({ ...activeThread(), turnHistory: history });
  const deferredContextReads: SocketRequest[] = [];
  FakeWebSocket.intercept = (_target, request) => {
    if (request.method === "thread/context/read") {
      deferredContextReads.push(request);
      return true;
    }
    return false;
  };

  const latestRead = client.readThread("thread", "codex", { hydration: { mode: "latest" } });
  const latestRequest = await waitForRequest(socket, "thread/context/read");
  assert.equal(latestRequest.workbenchThreadContextEntries?.mode, "hydratedTurns");
  socket.respond(latestRequest.id, {
    browseResultEntries: [browseEntry("browse:turn", "turn")],
    questionnaireEntries: [],
    steerEntries: [],
    thread: wireThreadWithHistory(["turn"], history),
  });
  assert.ok(await latestRead);

  const previousRead = client.readThread("thread", "codex", {
    hydration: { beforeTurnId: "turn", mode: "previous" },
  });
  const previousRequest = await waitForRequest(socket, "thread/context/read", 1);
  assert.equal(previousRequest.workbenchThreadContextEntries?.mode, "hydratedTurns");
  socket.notify("item/started", {
    item: { clientId: null, content: [{ text: "live", text_elements: [], type: "text" }], id: "live-item", type: "userMessage" },
    threadId: "thread",
    turnId: "turn",
  });
  socket.respond(previousRequest.id, {
    browseResultEntries: [browseEntry("browse:older", "older")],
    entryScope: { mode: "turns", turnIds: ["older"] },
    questionnaireEntries: [],
    steerEntries: [],
    thread: wireThreadWithHistory(["older"], [
      { ...historyEntry("older", "loaded"), itemTimeline: replacementOlderTimeline },
      historyEntry("turn", "unloaded"),
    ]),
  });

  const result = await previousRead;
  assert.ok(result);
  assert.deepEqual(result.turns.map((turn) => turn.id), ["older", "turn"]);
  assert.deepEqual(result.turns.find((turn) => turn.id === "turn")?.items.map((item) => item.id), ["live-item"]);
  assert.deepEqual(result.turnHistory.find((entry) => entry.turnId === "turn")?.itemTimeline, currentTimeline);
  assert.deepEqual(result.turnHistory.find((entry) => entry.turnId === "older")?.itemTimeline, replacementOlderTimeline);
  assert.deepEqual(result.browseResultEntries?.map((entry) => entry.entryKey), ["browse:older", "browse:turn"]);
  assert.equal(result.status, "active");
  assert.equal(socket.requests.filter((request) => request.method === "thread/resume").length, 2);
  assert.equal(deferredContextReads.length, 2);
}));

test("previous Codex pages reject a body that is not the exact predecessor", async () => withClient(async (client, socket) => {
  const history = [historyEntry("older", "unloaded"), historyEntry("turn", "loaded")];
  client.selectThreadPayload({ ...activeThread(), turnHistory: history });
  let contextRequest: SocketRequest | null = null;
  FakeWebSocket.intercept = (_target, request) => {
    if (request.method === "thread/context/read") {
      contextRequest = request;
      return true;
    }
    return false;
  };

  const previousRead = client.readThread("thread", "codex", {
    hydration: { beforeTurnId: "turn", mode: "previous" },
  });
  await waitForRequest(socket, "thread/context/read");
  socket.respond(contextRequest!.id, {
    browseResultEntries: [],
    entryScope: { mode: "turns", turnIds: ["wrong"] },
    questionnaireEntries: [],
    steerEntries: [],
    thread: wireThreadWithHistory(["wrong"], history),
  });

  assert.equal(await previousRead, null);
  assert.deepEqual(client.getSnapshot().currentThread?.turns.map((turn) => turn.id), ["turn"]);
}));

test("previous Codex pages reject an empty body when history names a predecessor", async () => withClient(async (client, socket) => {
  const history = [historyEntry("older", "unloaded"), historyEntry("turn", "loaded")];
  client.selectThreadPayload({ ...activeThread(), turnHistory: history });
  let contextRequest: SocketRequest | null = null;
  FakeWebSocket.intercept = (_target, request) => {
    if (request.method === "thread/context/read") {
      contextRequest = request;
      return true;
    }
    return false;
  };

  const previousRead = client.readThread("thread", "codex", {
    hydration: { beforeTurnId: "turn", mode: "previous" },
  });
  await waitForRequest(socket, "thread/context/read");
  socket.respond(contextRequest!.id, {
    browseResultEntries: [],
    entryScope: { mode: "turns", turnIds: [] },
    questionnaireEntries: [],
    steerEntries: [],
    thread: wireThreadWithHistory([], history),
  });

  assert.equal(await previousRead, null);
  assert.deepEqual(client.getSnapshot().currentThread?.turns.map((turn) => turn.id), ["turn"]);
}));

test("candidate reads keep superseded ownership fences silent", async () => {
  const statusMessages: string[] = [];
  await withClient(async (client) => {
    FakeWebSocket.intercept = (socket, request) => {
      if (request.method !== "thread/context/read") {
        return false;
      }

      client.selectThreadPayload({
        ...activeThread("codex", "superseded"),
        updatedAt: 2,
      });
      queueMicrotask(() => socket.respond(request.id, {
        browseResultEntries: [],
        questionnaireEntries: [],
        steerEntries: [],
        thread: wireThread("superseded"),
      }));
      return true;
    };

    assert.equal(await client.readThread("superseded"), null);
    assert.equal(client.getSnapshot().threadsError, "");
    assert.deepEqual(statusMessages, []);
  }, { onStatusMessage: (message) => statusMessages.push(message) });
});

test("candidate reads still surface genuine provider failures", async () => {
  const statusMessages: string[] = [];
  await withClient(async (client) => {
    FakeWebSocket.intercept = (socket, request) => {
      if (request.method !== "thread/context/read" && request.method !== "thread/read") {
        return false;
      }

      queueMicrotask(() => socket.fail(request.id, `${request.workbenchHarness ?? "codex"} missing`));
      return true;
    };

    assert.equal(await client.readThread("missing"), null);
    const expectedMessage = "Unable to open codex thread missing: codex missing";
    assert.equal(client.getSnapshot().threadsError, expectedMessage);
    assert.deepEqual(statusMessages, [expectedMessage]);
  }, { onStatusMessage: (message) => statusMessages.push(message) });
});

test("open-thread selection binding prevents a late open from replacing newer selection", async () => withClient(async (client, socket) => {
  client.selectThreadPayload(activeThread("codex", "b"));
  let openRequest: SocketRequest | null = null;
  FakeWebSocket.intercept = (_target, request) => {
    if (request.method === "thread/context/read" && request.params?.threadId === "a") {
      openRequest = request;
      return true;
    }
    return false;
  };
  const opening = client.openThread("a", { harness: "codex", source: "open" });
  await waitForRequest(socket, "thread/context/read");
  client.selectThreadPayload(activeThread("codex", "c"));
  socket.respond(openRequest!.id, { browseResultEntries: [], questionnaireEntries: [], steerEntries: [], thread: wireThread("a") });
  await opening;
  assert.equal(client.getSnapshot().currentThread?.id, "c");
}));

test("same-key, A-B-A, and clear-reselect commands invalidate fast preparation while profile changes do not", async () => withClient(async (client, socket) => {
  const source = activeThread();
  client.selectThreadPayload(source);
  const sameKey = client.sendThreadMessage(source, [{ text: "same-key", text_elements: [], type: "text" }]);
  client.selectThreadPayload({ ...source, updatedAt: 2 });
  await assert.rejects(sameKey, ThreadMessageNotSentError);

  const aba = client.sendThreadMessage(source, [{ text: "aba", text_elements: [], type: "text" }]);
  client.selectThreadPayload(activeThread("codex", "b"));
  client.selectThreadPayload(source);
  await assert.rejects(aba, ThreadMessageNotSentError);

  const clear = client.sendThreadMessage(source, [{ text: "clear", text_elements: [], type: "text" }]);
  client.clearThreadSelection();
  client.selectThreadPayload(source);
  await assert.rejects(clear, ThreadMessageNotSentError);

  const profile = client.sendThreadMessage(source, [{ text: "profile", text_elements: [], type: "text" }]);
  client.setCurrentThreadComposerSettings("thread", {
    agentPath: "agent://changed", agentSource: null, harness: "codex", model: "changed-model", reasoningEffort: null, serviceTier: "fast",
  });
  assert.equal(await profile, null);
  assert.equal(socket.requests.filter((request) => request.method === "turn/steer").length, 1);
  assert.equal(socket.requests.some((request) => request.method === "thread/resume"), false);
}));

test("visible questionnaire keeps back-to-back selected steers admissible", async () => withClient(async (client, socket) => {
  const source = activeThread();
  client.selectThreadPayload(source);
  socket.notify("questionnaire/requested", {
    hidden: false,
    itemId: "question",
    request: { id: "question", questions: [], submitLabel: "send", summary: "question", title: "question" },
    requestKey: "question-key",
    threadId: "thread",
    turnId: "turn",
  });

  const results = await Promise.all(["one", "two", "three"].map((text) => (
    client.sendThreadMessage(source, [{ text, text_elements: [], type: "text" }])
  )));

  assert.deepEqual(results, [null, null, null]);
  const steerRequests = socket.requests.filter((request) => request.method === "turn/steer");
  assert.equal(steerRequests.length, 3);
  assert.deepEqual(steerRequests.map((request) => request.params?.expectedTurnId), ["turn", "turn", "turn"]);
  const handles = steerRequests.map((request) => String(request.params?.clientUserMessageId ?? ""));
  assert.equal(handles.every(Boolean), true);
  assert.equal(new Set(handles).size, 3);
  assert.equal(socket.requests.some((request) => request.method === "thread/read" || request.method === "thread/resume"), false);

  const snapshot = client.getSnapshot();
  assert.equal(snapshot.pendingUserInputRequestsByThreadId["thread"]?.requestKey, "question-key");
  assert.match(snapshot.currentThread?.status ?? "", /waitingOnUserInput/u);
  assert.equal(snapshot.currentThread?.turns[0]?.items.filter((item) => item.type === "userMessage").length, 3);
}));

test("selection drift during selected resume sends no obsolete message", async () => withClient(async (client, socket) => {
  const idle = activeThread("codex", "idle", "completed");
  client.selectThreadPayload(idle);
  let resumeRequest: SocketRequest | null = null;
  FakeWebSocket.intercept = (_target, request) => {
    if (request.method === "thread/resume" && request.params?.threadId === "idle") {
      resumeRequest = request;
      return true;
    }
    return false;
  };
  const send = client.sendThreadMessage(idle, [{ text: "stale", text_elements: [], type: "text" }]);
  await waitForRequest(socket, "thread/resume");
  client.selectThreadPayload(activeThread("codex", "other"));
  socket.respond(resumeRequest!.id, { model: "model", reasoningEffort: null, serviceTier: null, thread: wireThread("idle", "idle-turn", "completed") });
  await assert.rejects(send, ThreadMessageNotSentError);
  assert.equal(socket.requests.some((request) => (request.method === "turn/steer" || request.method === "turn/start") && request.params?.threadId === "idle"), false);
  assert.equal(client.getSnapshot().currentThread?.id, "other");
}));

test("same-selection completion drift during resume starts once instead of rejecting", async () => withClient(async (client, socket) => {
  const idle = activeThread("codex", "idle", "completed");
  client.selectThreadPayload(idle);
  let resumeRequest: SocketRequest | null = null;
  FakeWebSocket.intercept = (_target, request) => {
    if (request.method === "thread/resume" && request.params?.threadId === "idle") {
      resumeRequest = request;
      return true;
    }
    return false;
  };

  const send = client.sendThreadMessage(idle, [{ text: "keep me", text_elements: [], type: "text" }]);
  await waitForRequest(socket, "thread/resume");
  socket.notify("thread/status/changed", {
    status: { type: "idle" },
    threadId: "idle",
  });
  socket.respond(resumeRequest!.id, { model: "model", reasoningEffort: null, serviceTier: null, thread: wireThread("idle", "idle-turn", "completed") });

  assert.equal(await send, null);
  assert.equal(socket.requests.filter((request) => request.method === "turn/start" && request.params?.threadId === "idle").length, 1);
  assert.equal(client.getSnapshot().currentThread?.id, "idle");
}));

test("idle status with a stale in-progress turn uses authoritative preparation and starts a new turn", async () => withClient(async (client, socket) => {
  const stale = { ...activeThread(), status: "idle" };
  const completed = wireThread("thread", "turn", "completed");
  client.selectThreadPayload(stale);
  FakeWebSocket.intercept = (target, request) => {
    if (request.method === "thread/resume") {
      queueMicrotask(() => target.respond(request.id, { model: "model", reasoningEffort: null, serviceTier: null, thread: completed }));
      return true;
    }
    if (request.method === "turn/start") {
      queueMicrotask(() => target.respond(request.id, { turn: wireThread("thread", "new-turn").turns[0] }));
      return true;
    }
    return false;
  };

  const result = await client.sendThreadMessage(stale, [{ text: "new turn", text_elements: [], type: "text" }]);
  assert.equal(socket.requests.filter((request) => request.method === "turn/steer").length, 0);
  assert.equal(socket.requests.filter((request) => request.method === "turn/start").length, 1);
  assert.equal(result, null);
  assert.equal(client.getSnapshot().currentThread?.turns.at(-1)?.id, "new-turn");
  assert.equal(socket.requests.some((request) => request.method === "thread/read"), false);
}));

test("selected resume preserves already-loaded earlier turns before starting", async () => withClient(async (client, socket) => {
  const base = activeThread("codex", "thread", "completed");
  const olderTurn = { ...base.turns[0]!, completedAt: 2, durationMs: 1, id: "older", startedAt: 1, status: "completed" as const };
  const currentTurn = { ...base.turns[0]!, id: "current" };
  const source = {
    ...base,
    status: "idle",
    turnHistory: [historyEntry("older", "loaded"), { ...historyEntry("older", "loaded"), turnId: "current" }],
    turns: [olderTurn, currentTurn],
  };
  client.selectThreadPayload(source);
  FakeWebSocket.intercept = (target, request) => {
    if (request.method === "thread/resume") {
      queueMicrotask(() => target.respond(request.id, {
        model: "model",
        reasoningEffort: null,
        serviceTier: null,
        thread: wireThread("thread", "current", "completed"),
      }));
      return true;
    }
    return false;
  };

  assert.equal(await client.sendThreadMessage(source, [{ text: "next", text_elements: [], type: "text" }]), null);
  assert.deepEqual(client.getSnapshot().currentThread?.turns.map((turn) => turn.id), ["older", "current", "thread-started"]);
}));

test("new active turn notification during resume wins and receives one steer", async () => withClient(async (client, socket) => {
  const idle = activeThread("codex", "idle", "completed");
  client.selectThreadPayload(idle);
  let resumeRequest: SocketRequest | null = null;
  FakeWebSocket.intercept = (_target, request) => {
    if (request.method === "thread/resume" && !resumeRequest) {
      resumeRequest = request;
      return true;
    }
    return false;
  };

  const send = client.sendThreadMessage(idle, [{ text: "join active", text_elements: [], type: "text" }]);
  await waitForRequest(socket, "thread/resume");
  socket.notify("turn/started", {
    threadId: "idle",
    turn: wireThread("idle", "notification-turn").turns[0],
  });
  socket.respond(resumeRequest!.id, {
    model: "model",
    reasoningEffort: null,
    serviceTier: null,
    thread: wireThread("idle", "idle-turn", "completed"),
  });

  assert.equal(await send, null);
  assert.equal(socket.requests.filter((request) => request.method === "turn/steer" && request.params?.expectedTurnId === "notification-turn").length, 1);
  assert.equal(socket.requests.some((request) => request.method === "turn/start" && request.params?.threadId === "idle"), false);
}));

test("compaction during selected resume cancels before message dispatch", async () => withClient(async (client, socket) => {
  const idle = activeThread("codex", "idle", "completed");
  client.selectThreadPayload(idle);
  let resumeRequest: SocketRequest | null = null;
  FakeWebSocket.intercept = (target, request) => {
    if (request.method === "thread/resume" && !resumeRequest) {
      resumeRequest = request;
      return true;
    }
    if (request.method === "thread/compact/start") {
      queueMicrotask(() => target.respond(request.id, {}));
      return true;
    }
    return false;
  };

  const send = client.sendThreadMessage(idle, [{ text: "after compact", text_elements: [], type: "text" }]);
  await waitForRequest(socket, "thread/resume");
  await client.compactThread(idle);
  socket.respond(resumeRequest!.id, {
    model: "model", reasoningEffort: null, serviceTier: null,
    thread: wireThread("idle", "idle-turn", "completed"),
  });

  await assert.rejects(send, ThreadMessageNotSentError);
  assert.equal(socket.requests.some((request) => request.method === "turn/start" || request.method === "turn/steer"), false);
}));

test("canonical initial notification before start acknowledgement is preserved once", async () => withClient(async (client, socket) => {
  const idle = activeThread("codex", "idle", "completed");
  client.selectThreadPayload(idle);
  let startRequest: SocketRequest | null = null;
  FakeWebSocket.intercept = (target, request) => {
    if (request.method === "thread/resume") {
      queueMicrotask(() => target.respond(request.id, {
        model: "model",
        reasoningEffort: null,
        serviceTier: null,
        thread: wireThread("idle", "idle-turn", "completed"),
      }));
      return true;
    }
    if (request.method === "turn/start") {
      startRequest = request;
      return true;
    }
    return false;
  };

  const send = client.sendThreadMessage(idle, [{ text: "initial", text_elements: [], type: "text" }]);
  await waitForRequest(socket, "turn/start");
  const clientId = String(startRequest!.params?.clientUserMessageId ?? "");
  const startedTurn = wireThread("idle", "new-turn").turns[0]!;
  socket.notify("turn/started", { threadId: "idle", turn: startedTurn });
  socket.notify("item/started", {
    item: { clientId, content: [{ text: "initial", text_elements: [], type: "text" }], id: "canonical-initial", type: "userMessage" },
    threadId: "idle",
    turnId: "new-turn",
  });
  socket.respond(startRequest!.id, { turn: startedTurn });

  assert.equal(await send, null);
  const initialItems = client.getSnapshot().currentThread?.turns.find((turn) => turn.id === "new-turn")?.items.filter((item) => item.type === "userMessage") ?? [];
  assert.deepEqual(initialItems.map((item) => item.id), ["canonical-initial"]);
}));

test("preserved general active steer rejects interruption before acknowledgement", async () => withClient(async (client, socket) => {
  const baseSource = activeThread();
  const source = {
    ...baseSource,
    turns: [{ ...baseSource.turns[0]!, id: "thread-turn" }],
  };
  client.selectThreadPayload(source);
  let pendingSteer: SocketRequest | null = null;
  FakeWebSocket.intercept = (_target, request) => {
    if (request.method === "turn/steer") {
      pendingSteer = request;
      return true;
    }
    return false;
  };
  const send = client.sendThreadMessage(
    source,
    [{ text: "interrupted", text_elements: [], type: "text" }],
    { selectThread: false },
  );
  await waitForRequest(socket, "turn/steer");
  socket.notify("turn/completed", {
    threadId: "thread",
    turn: {
      ...wireThread("thread", "thread-turn").turns[0]!,
      completedAt: 2,
      durationMs: 1,
      status: "interrupted",
    },
  });
  socket.respond(pendingSteer!.id, { turnId: "thread-turn" });
  await assert.rejects(send, /turn stopped before this steer was delivered/u);
  assert.match(client.getSnapshot().currentThread?.turns[0]?.items.at(-1)?.id ?? "", /:interrupted:/u);
}));

test("malformed general acknowledgements render exact failed evidence before rejection", async () => withClient(async (client, socket) => {
  FakeWebSocket.intercept = (target, request) => {
    if (request.method !== "turn/steer") {
      return false;
    }
    queueMicrotask(() => target.respond(request.id, request.workbenchHarness === "copilot" ? { ok: false } : { turnId: " " }));
    return true;
  };

  const copilot = activeThread("copilot", "copilot-failure");
  client.selectThreadPayload(copilot);
  await assert.rejects(
    client.sendThreadMessage(copilot, [{ text: "copilot", text_elements: [], type: "text" }]),
    /did not acknowledge/u,
  );
  assert.match(client.getSnapshot().currentThread?.turns.at(-1)?.items.at(-1)?.id ?? "", /:failed:/u);

  const codex = { ...activeThread("codex", "codex-failure"), status: "active:waitingOnUserInput" };
  client.selectThreadPayload(codex);
  await assert.rejects(
    client.sendThreadMessage(codex, [{ text: "codex", text_elements: [], type: "text" }], { selectThread: false }),
    /empty turn id/u,
  );
  client.selectThreadPayload(codex);
  assert.match(client.getSnapshot().currentThread?.turns.at(-1)?.items.at(-1)?.id ?? "", /:failed:/u);
}));

test("raw canonical notifications preserve waiting status and stable preferences", async () => withClient(async (client, socket) => {
  const source = { ...activeThread(), agentPath: "agent://selected", model: "selected-model", serviceTier: "fast" };
  client.selectThreadPayload(source);
  socket.notify("questionnaire/requested", {
    hidden: false, itemId: "question", requestKey: "question", threadId: "thread", turnId: "turn",
    request: { id: "question", questions: [], submitLabel: "send", summary: "question", title: "question" },
  });
  socket.notify("item/started", {
    item: { clientId: null, content: [{ text: "new", text_elements: [], type: "text" }], id: "canonical", type: "userMessage" },
    threadId: "thread", turnId: "turn",
  });
  const current = client.getSnapshot().currentThread;
  assert.equal(current?.model, "selected-model");
  assert.equal(current?.serviceTier, "fast");
  assert.equal(current?.agentPath, "agent://selected");
  assert.ok(current?.status.includes("waitingOnUserInput"));
  assert.deepEqual(current?.turns[0]?.items.map((item) => item.id), ["canonical"]);
}));

test("live compaction notifications preserve distinct markers and complete one owned timeline entry", async () => withClient(async (client, socket) => {
  const source = activeThread();
  source.turns[0] = {
    ...source.turns[0]!,
    items: [
      { id: "compaction-one", type: "contextCompaction" },
      { id: "between", memoryCitation: null, phase: "commentary", text: "between", type: "agentMessage" },
    ],
  };
  client.selectThreadPayload(source);

  socket.notify("item/started", {
    item: { id: "compaction-two", type: "contextCompaction" },
    startedAtMs: 100,
    threadId: "thread",
    turnId: "turn",
  });
  let current = client.getSnapshot().currentThread;
  assert.deepEqual(current?.turns[0]?.items.map((item) => item.id), ["compaction-one", "between", "compaction-two"]);
  assert.deepEqual(current?.turnHistory[0]?.itemTimeline, [{
    completedAt: null,
    firstSeenAt: 100,
    itemId: "compaction-two",
    lastSeenAt: 100,
    startedAt: 100,
  }]);

  socket.notify("item/completed", {
    completedAtMs: 200,
    item: { id: "compaction-two", type: "contextCompaction" },
    threadId: "thread",
    turnId: "turn",
  });
  current = client.getSnapshot().currentThread;
  assert.deepEqual(current?.turns[0]?.items.map((item) => item.id), ["compaction-one", "between", "compaction-two"]);
  assert.deepEqual(current?.turnHistory[0]?.itemTimeline, [{
    completedAt: 200,
    firstSeenAt: 100,
    itemId: "compaction-two",
    lastSeenAt: 200,
    startedAt: 100,
  }]);

  socket.notify("item/completed", {
    completedAtMs: 250,
    item: { id: "item-99", type: "contextCompaction" },
    threadId: "thread",
    turnId: "turn",
  });
  current = client.getSnapshot().currentThread;
  assert.deepEqual(current?.turns[0]?.items.map((item) => item.id), ["compaction-one", "between", "compaction-two"]);
  assert.deepEqual(current?.turnHistory[0]?.itemTimeline, [{
    aliases: ["item-99"],
    completedAt: 250,
    firstSeenAt: 100,
    itemId: "compaction-two",
    lastSeenAt: 250,
    startedAt: 100,
  }]);
}));

test("status and token owners survive canonical updates, authoritative nulls, and compact clears", async () => withClient(async (client, socket) => {
  const usage = (totalTokens: number) => ({
    last: { cacheWriteInputTokens: 0, cachedInputTokens: 0, inputTokens: totalTokens, outputTokens: 0, reasoningOutputTokens: 0, totalTokens },
    modelContextWindow: 100,
    total: { cacheWriteInputTokens: 0, cachedInputTokens: 0, inputTokens: totalTokens, outputTokens: 0, reasoningOutputTokens: 0, totalTokens },
  });
  const selected = {
    ...activeThread(),
    agentPath: "agent://selected",
    model: "selected-model",
    reasoningEffort: "high",
    serviceTier: "fast",
    tokenUsage: usage(10),
  };
  client.selectThreadPayload(selected);
  client.selectThreadPayload({
    ...selected,
    agentPath: null,
    model: null,
    reasoningEffort: null,
    serviceTier: null,
    tokenUsage: null,
  });
  assert.equal(client.getSnapshot().currentThread?.agentPath, "agent://selected");
  assert.equal(client.getSnapshot().currentThread?.model, "selected-model");
  assert.equal(client.getSnapshot().currentThread?.reasoningEffort, "high");
  assert.equal(client.getSnapshot().currentThread?.serviceTier, "fast");
  assert.equal(client.getSnapshot().currentThread?.tokenUsage?.total.totalTokens, 10);

  socket.notify("thread/status/changed", { status: { type: "idle" }, threadId: "thread" });
  assert.equal(client.getSnapshot().currentThread?.status, "idle");

  socket.notify("thread/tokenUsage/updated", { threadId: "thread", tokenUsage: usage(20), turnId: "turn" });
  assert.equal(client.getSnapshot().currentThread?.tokenUsage?.total.totalTokens, 20);

  await client.compactThread(client.getSnapshot().currentThread!);
  assert.equal(client.getSnapshot().currentThread?.tokenUsage, null);
}));

test("known non-selected and unknown canonical notifications do not retarget or materialize public documents", async () => withClient(async (client, socket) => {
  const background = activeThread("codex", "background");
  const selected = activeThread("codex", "selected");
  client.selectThreadPayload(background);
  client.selectThreadPayload(selected);
  socket.notify("item/started", {
    item: { clientId: null, content: [{ text: "background", text_elements: [], type: "text" }], id: "background-item", type: "userMessage" },
    threadId: "background", turnId: "background-turn",
  });
  socket.notify("item/started", {
    item: { clientId: null, content: [{ text: "unknown", text_elements: [], type: "text" }], id: "unknown-item", type: "userMessage" },
    threadId: "unknown", turnId: "unknown-turn",
  });
  assert.equal(client.getSnapshot().currentThread?.id, "selected");
  assert.equal(client.getSnapshot().threadDocuments.documentsByKey["codex:unknown"], undefined);
  assert.deepEqual(client.getSnapshot().threadDocuments.documentsByKey["codex:background"]?.turns[0]?.items, []);
}));

test("project reset during history and control awaits cannot resurrect thread state or start follow-up reads", async () => withClient(async (client, socket) => {
  const source = activeThread();
  client.selectThreadPayload(source);
  let historyRequest: SocketRequest | null = null;
  FakeWebSocket.intercept = (_target, request) => {
    if (request.method === "steer/history/list") {
      historyRequest = request;
      return true;
    }
    return false;
  };
  socket.notify("item/completed", {
    item: { clientId: null, content: [{ text: "event", text_elements: [], type: "text" }], id: "event", type: "userMessage" },
    threadId: "thread", turnId: "turn",
  });
  await waitForRequest(socket, "steer/history/list");
  client.setProjectContext({ projectId: "other", root: "other", rootPath: "C:/other" });
  socket.respond(historyRequest!.id, { data: [] });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(client.getSnapshot().currentThread, null);

  client.setProjectContext({ projectId: "project", root: "repo", rootPath: "C:/repo" });
  client.selectThreadPayload(source);
  let interruptRequest: SocketRequest | null = null;
  FakeWebSocket.intercept = (_target, request) => {
    if (request.method === "turn/interrupt") {
      interruptRequest = request;
      return true;
    }
    return false;
  };
  const stop = client.stopThread(source);
  await waitForRequest(socket, "turn/interrupt");
  const readsBeforeReset = socket.requests.filter((request) => request.method === "thread/context/read").length;
  client.setProjectContext({ projectId: "final", root: "final", rootPath: "C:/final" });
  socket.respond(interruptRequest!.id, {});
  assert.equal((await stop)?.id, "thread");
  assert.equal(socket.requests.filter((request) => request.method === "thread/context/read").length, readsBeforeReset);
  assert.equal(client.getSnapshot().currentThread, null);
}));

test("project reset during admitted reconciliation history cannot reinstall the old thread", async () => withClient(async (client, socket) => {
  const source = activeThread();
  client.selectThreadPayload(source);
  let historyRequest: SocketRequest | null = null;
  FakeWebSocket.intercept = (target, request) => {
    if (request.method === "turn/steer") {
      queueMicrotask(() => target.respond(request.id, { turnId: "acknowledged-turn" }));
      return true;
    }
    if (request.method === "steer/history/list") {
      historyRequest = request;
      return true;
    }
    return false;
  };
  const send = client.sendThreadMessage(source, [{ text: "queued", text_elements: [], type: "text" }]);
  await waitForRequest(socket, "steer/history/list");
  client.setProjectContext({ projectId: "other", root: "other", rootPath: "C:/other" });
  socket.respond(historyRequest!.id, { data: [] });
  assert.equal(await send, null);
  assert.equal(client.getSnapshot().currentThread, null);
  assert.equal(client.getSnapshot().threadDocuments.documentsByKey["codex:thread"], undefined);
}));

test("project reset suppresses stale reconciliation failure warnings", async () => {
  const statusMessages: string[] = [];
  await withClient(async (client, socket) => {
    const source = activeThread();
    client.selectThreadPayload(source);
    let resumeRequest: SocketRequest | null = null;
    FakeWebSocket.intercept = (target, request) => {
      if (request.method === "turn/steer") {
        queueMicrotask(() => target.respond(request.id, { turnId: "acknowledged-turn" }));
        return true;
      }
      if (request.method === "thread/resume") {
        resumeRequest = request;
        return true;
      }
      return false;
    };
    const send = client.sendThreadMessage(source, [{ text: "queued", text_elements: [], type: "text" }]);
    await waitForRequest(socket, "thread/resume");
    client.setProjectContext({ projectId: "other", root: "other", rootPath: "C:/other" });
    socket.fail(resumeRequest!.id, "old reconciliation failed");
    assert.equal(await send, null);
    assert.equal(statusMessages.some((message) => message.includes("immediate thread reconciliation failed")), false);
  }, { onStatusMessage: (message) => statusMessages.push(message) });
});

test("project reset fences a late rate-limit success from the previous project", async () => withClient(async (client, socket) => {
  const pendingRequests: SocketRequest[] = [];
  FakeWebSocket.intercept = (_target, request) => {
    if (request.method === "account/rateLimits/read") {
      pendingRequests.push(request);
      return true;
    }
    return false;
  };
  const staleRefresh = client.refreshRateLimits();
  await waitForRequest(socket, "account/rateLimits/read", 1);
  client.setProjectContext({ projectId: "other", root: "other", rootPath: "C:/other" });
  client.selectThreadPayload(activeThread());
  const currentRefresh = client.refreshRateLimits();
  await waitForRequest(socket, "account/rateLimits/read", 2);
  socket.fail(pendingRequests[1]!.id, "new project rate limits unavailable");
  await currentRefresh;

  const staleSnapshot = {
    credits: null, individualLimit: null, limitId: "codex", limitName: "stale", planType: null,
    primary: null, rateLimitReachedType: null, secondary: null,
  };
  socket.respond(pendingRequests[0]!.id, {
    rateLimitResetCredits: null,
    rateLimits: staleSnapshot,
    rateLimitsByLimitId: { codex: staleSnapshot },
  });
  await staleRefresh;
  assert.equal(client.getSnapshot().rateLimits, null);
}));

test("project changes during draft materialization prevent stale general dispatch without list polling", async () => withClient(async (client, socket) => {
  const draft = { ...activeThread("copilot", "draft", "completed"), isDraft: true, source: "draft" };
  client.selectThreadPayload(draft);
  let startRequest: SocketRequest | null = null;
  FakeWebSocket.intercept = (_target, request) => {
    if (request.method === "thread/start") {
      startRequest = request;
      return true;
    }
    return false;
  };
  const send = client.sendThreadMessage(draft, [{ text: "draft", text_elements: [], type: "text" }]);
  await waitForRequest(socket, "thread/start");
  client.setProjectContext({ projectId: "other", root: "other", rootPath: "C:/other" });
  socket.respond(startRequest!.id, { thread: wireThread("materialized") });
  await assert.rejects(send, ThreadMessageNotSentError);
  assert.equal(socket.requests.some((request) => request.method === "thread/list"), false);
  assert.equal(socket.requests.some((request) => request.method === "thread/read" && request.params?.threadId === "materialized"), false);
  assert.equal(socket.requests.some((request) => request.method === "turn/steer" && request.params?.threadId === "materialized"), false);
}));

test("project changes after draft turn dispatch prevent acceptance and materialization", async () => {
  const acceptedIntents: WorkbenchAcceptedIntent[] = [];
  await withClient(async (client, socket) => {
    const draft = { ...activeThread("codex", "draft:00000000-0000-4000-8000-000000000002", "completed"), isDraft: true, source: "draft" };
    const materialized: string[] = [];
    let startRequest: SocketRequest | null = null;
    client.selectThreadPayload(draft);
    FakeWebSocket.intercept = (target, request) => {
      if (request.method === "thread/start") {
        queueMicrotask(() => target.respond(request.id, { thread: wireThread("materialized-after-dispatch", "old", "completed") }));
        return true;
      }
      if (request.method === "turn/start") {
        startRequest = request;
        return true;
      }
      return false;
    };

    const send = client.sendThreadMessage(draft, [{ text: "draft", text_elements: [], type: "text" }], {
      onThreadMaterialized: (thread) => materialized.push(thread.id),
    });
    await waitForRequest(socket, "turn/start");
    client.setProjectContext({ projectId: "other", root: "other", rootPath: "C:/other" });
    socket.respond(startRequest!.id, { turn: wireThread("materialized-after-dispatch", "new-turn").turns[0] });

    assert.equal(await send, null);
    assert.deepEqual(acceptedIntents, []);
    assert.deepEqual(materialized, []);
  }, {
    publishAcceptedIntent: async (event) => { acceptedIntents.push(event); },
  });
});

test("draft projection precedes admission and materialization is skipped on start failure", async () => {
  const acceptedIntents: WorkbenchAcceptedIntent[] = [];
  let markAcceptedIntentObserved!: () => void;
  const acceptedIntentObserved = new Promise<void>((resolve) => { markAcceptedIntentObserved = resolve; });
  let releaseAcceptedIntent: (() => void) | null = null;
  const acceptedIntentPending = new Promise<void>((resolve) => { releaseAcceptedIntent = resolve; });
  await withClient(async (client, socket) => {
  const draft = { ...activeThread("codex", "draft:00000000-0000-4000-8000-000000000001", "completed"), isDraft: true, source: "draft" };
  client.selectThreadPayload(draft);
  const created: string[] = [];
  const materialized: string[] = [];
  let startRequest: SocketRequest | null = null;
  FakeWebSocket.intercept = (target, request) => {
    if (request.method === "thread/start") {
      queueMicrotask(() => target.respond(request.id, { thread: wireThread("materialized", "old", "completed") }));
      return true;
    }
    if (request.method === "turn/start") {
      startRequest = request;
      return true;
    }
    return false;
  };

  const send = client.sendThreadMessage(draft, [{ text: "draft", text_elements: [], type: "text" }], {
    onThreadCreated: (thread) => created.push(thread.id),
    onThreadMaterialized: (thread) => materialized.push(thread.id),
  });
  await waitForRequest(socket, "turn/start");
  assert.deepEqual(created, ["materialized"]);
  assert.deepEqual(materialized, []);
  assert.equal(client.getSnapshot().currentThread?.id, "materialized");
  assert.equal(client.getSnapshot().currentThread?.preview, "draft");
  assert.equal(client.getSnapshot().currentThread?.turns.length, 1);
  assert.match(client.getSnapshot().currentThread?.turns[0]?.id ?? "", /^workbench:connecting:/u);
  const startedNotificationThread = wireThread("materialized", "old", "completed");
  startedNotificationThread.name = "New thread";
  socket.notify("thread/started", { thread: startedNotificationThread });
  assert.equal(client.getSnapshot().currentThread?.preview, "draft");
  const failedPendingItemId = client.getSnapshot().currentThread?.turns.at(-1)?.items[0]?.id ?? "";
  assert.match(failedPendingItemId, /^optimistic-user-message:initial:pending:/u);
  socket.fail(startRequest!.id, "start failed");
  await assert.rejects(send, /start failed/u);
  assert.deepEqual(materialized, []);

  client.selectThreadPayload(draft);
  let admittedStartRequest: SocketRequest | null = null;
  FakeWebSocket.intercept = (target, request) => {
    if (request.method === "thread/start") {
      queueMicrotask(() => target.respond(request.id, { thread: wireThread("materialized", "old", "completed") }));
      return true;
    }
    if (request.method === "turn/start") {
      admittedStartRequest = request;
      return true;
    }
    return false;
  };
  const admittedInput = [
    { text: "draft", text_elements: [], type: "text" as const },
    { type: "image" as const, url: "data:image/png;base64,AAAA" },
  ];
  const admittedSend = client.sendThreadMessage(draft, admittedInput, {
    onThreadCreated: (thread) => created.push(thread.id),
    onThreadMaterialized: (thread) => materialized.push(thread.id),
  });
  await waitForRequest(socket, "turn/start", 1);
  assert.equal(client.getSnapshot().currentThread?.turns.length, 1);
  assert.match(client.getSnapshot().currentThread?.turns[0]?.id ?? "", /^workbench:connecting:/u);
  const admittedPendingItemId = client.getSnapshot().currentThread?.turns.at(-1)?.items[0]?.id ?? "";
  assert.match(admittedPendingItemId, /^optimistic-user-message:initial:pending:/u);
  const clientUserMessageId = String(admittedStartRequest?.params?.clientUserMessageId ?? "");
  assert.match(clientUserMessageId, /^[0-9a-f-]{36}$/u);
  const admittedTurn = wireThread("materialized", "new-turn").turns[0]!;
  socket.notify("turn/started", { threadId: "materialized", turn: admittedTurn });
  socket.notify("item/started", {
    item: { clientId: clientUserMessageId, content: admittedInput, id: "canonical-draft", type: "userMessage" },
    threadId: "materialized",
    turnId: "new-turn",
  });
  socket.respond(admittedStartRequest!.id, { turn: admittedTurn });
  await acceptedIntentObserved;
  assert.deepEqual(acceptedIntents, [{
    draftId: "00000000-0000-4000-8000-000000000001",
    harness: "codex",
    projectId: "project",
    threadId: "materialized",
    title: "draft",
    turnId: "new-turn",
  }]);
  assert.deepEqual(materialized, ["materialized"]);
  releaseAcceptedIntent?.();
  const admitted = await admittedSend;
  assert.ok(admitted);
  assert.equal(admitted.preview, "draft");
  assert.equal(client.getSnapshot().currentThread?.preview, "draft");
  assert.deepEqual(created, ["materialized", "materialized"]);
  assert.deepEqual(materialized, ["materialized"]);
  assert.deepEqual(admitted.turns.map((turn) => turn.id), ["new-turn"]);
  assert.deepEqual(admitted.turns.at(-1)?.items.filter((item) => item.type === "userMessage").map((item) => item.id), ["canonical-draft"]);
  }, {
    publishAcceptedIntent: async (event) => {
      acceptedIntents.push(event);
      markAcceptedIntentObserved();
      await acceptedIntentPending;
    },
  });
});

test("steer-history reads are latest-wins, retain the last success, and warn once per failure streak", async () => {
  const statusMessages: string[] = [];
  await withClient(async (client, socket) => {
    const source = activeThread();
    client.selectThreadPayload(source);
    await client.sendThreadMessage(source, [{ text: "queued", text_elements: [], type: "text" }]);
    const handle = String(socket.requests.find((request) => request.method === "turn/steer")?.params?.clientUserMessageId ?? "");
    const history: WorkbenchSteerHistoryEntry = {
      attemptedAt: 1, canonicalItemId: null, clientUserMessageId: handle, dispatchSequence: 0,
      entryKey: `turn-steer-client:${handle}`, error: null, input: [{ text: "queued", text_elements: [], type: "text" }],
      requestId: "1", resolvedAt: null, status: "pending", threadId: "thread", turnId: "turn",
    };
    const historyRequests: SocketRequest[] = [];
    FakeWebSocket.intercept = (_target, request) => {
      if (request.method === "steer/history/list") {
        historyRequests.push(request);
        return true;
      }
      return false;
    };
    const trigger = (id: string) => socket.notify("item/completed", {
      item: { clientId: null, content: [{ text: id, text_elements: [], type: "text" }], id, type: "userMessage" },
      threadId: "thread", turnId: "turn",
    });

    trigger("event-1");
    trigger("event-2");
    await waitForRequest(socket, "steer/history/list", 1);
    socket.respond(historyRequests[1]!.id, { data: [history] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    socket.fail(historyRequests[0]!.id, "stale failure");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(client.getSnapshot().currentThread?.turns[0]?.items.some((item) => item.id.startsWith("workbench:steer-history:pending:")));
    assert.equal(statusMessages.length, 0);

    trigger("event-3");
    await waitForRequest(socket, "steer/history/list", 2);
    socket.fail(historyRequests[2]!.id, "latest failure");
    await new Promise((resolve) => setTimeout(resolve, 0));
    trigger("event-4");
    await waitForRequest(socket, "steer/history/list", 3);
    socket.fail(historyRequests[3]!.id, "same streak");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(statusMessages.length, 1);

    trigger("event-5");
    await waitForRequest(socket, "steer/history/list", 4);
    socket.respond(historyRequests[4]!.id, { data: [history] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    trigger("event-6");
    await waitForRequest(socket, "steer/history/list", 5);
    socket.fail(historyRequests[5]!.id, "new streak");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(statusMessages.length, 2);
  }, { onStatusMessage: (message) => statusMessages.push(message) });
});

test("questionnaire and Browse history reads are latest-wins within one project", async () => withClient(async (client, socket) => {
  const source = activeThread();
  client.selectThreadPayload(source);
  const questionnaireRequests: SocketRequest[] = [];
  const browseRequests: SocketRequest[] = [];
  FakeWebSocket.intercept = (_target, request) => {
    if (request.method === "questionnaire/history/list") {
      questionnaireRequests.push(request);
      return true;
    }
    if (request.method === "browse/result/list") {
      browseRequests.push(request);
      return true;
    }
    return false;
  };

  socket.notify("questionnaire/resolved", { requestKey: "one", threadId: "thread" });
  socket.notify("questionnaire/resolved", { requestKey: "two", threadId: "thread" });
  await waitForRequest(socket, "questionnaire/history/list", 1);
  socket.respond(questionnaireRequests[1]!.id, { data: [] });
  socket.respond(questionnaireRequests[0]!.id, { data: [{
    insertAfterItemId: null, insertAfterItemIndex: null, itemId: null,
    request: { id: "old", questions: [], submitLabel: "send", summary: "old", title: "old" },
    requestKey: "old", resolvedAt: 1, response: { answers: {} }, threadId: "thread", turnId: "turn",
  }] });

  socket.notify("browse/result/recorded", { threadId: "thread" });
  socket.notify("browse/result/recorded", { threadId: "thread" });
  await waitForRequest(socket, "browse/result/list", 1);
  socket.respond(browseRequests[1]!.id, { data: [] });
  socket.respond(browseRequests[0]!.id, { data: [{
    action: "snapshot", actionIndex: 0, assetUrl: null, commandItemId: null, durationMs: 1,
    entryKey: "old", recordedAt: 1, session: "old", state: "completed", threadId: "thread", turnId: "turn",
  }] });
  await new Promise((resolve) => setTimeout(resolve, 0));

  const current = client.getSnapshot().currentThread;
  assert.equal(current?.turns.flatMap((turn) => turn.items).some((item) => item.id.startsWith("workbench:questionnaire-history:")), false);
  assert.deepEqual(current?.browseResultEntries, []);
}));

test("draft harness migration selects the new exact document and deletes the old key", async () => withClient(async (client) => {
  const draft = { ...activeThread("codex", "draft", "completed"), isDraft: true, source: "draft" };
  client.selectThreadPayload(draft);
  client.setDraftThreadHarness("opencode");
  const documents = client.getSnapshot().threadDocuments;
  assert.equal(documents.selectedThreadKey, "opencode:draft");
  assert.equal(documents.documentsByKey["codex:draft"], undefined);
  assert.equal(documents.documentsByKey["opencode:draft"]?.harness, "opencode");
  assert.equal(documents.keysByThreadId.draft, "opencode:draft");
}));

test("selection drift after dispatch keeps exact failed evidence without selecting the old thread", async () => withClient(async (client, socket) => {
  const source = activeThread("codex", "a");
  const other = activeThread("codex", "b");
  client.selectThreadPayload(source);
  let pending: SocketRequest | null = null;
  FakeWebSocket.intercept = (_target, request) => {
    if (request.method === "turn/steer" && request.params?.threadId === "a") {
      pending = request;
      return true;
    }
    return false;
  };
  const admission = client.sendThreadMessage(source, [{ text: "one", text_elements: [], type: "text" }]);
  await waitForRequest(socket, "turn/steer");
  client.selectThreadPayload(other);
  socket.fail(pending!.id, "transport failed");
  await assert.rejects(admission, /transport failed/u);
  assert.equal(client.getSnapshot().currentThread?.id, "b");
  client.selectThreadPayload(source);
  assert.match(client.getSnapshot().currentThread?.turns[0]?.items[0]?.id ?? "", /:failed:/u);

  const admittedSource = activeThread("codex", "c");
  const selectedOther = activeThread("codex", "d");
  client.selectThreadPayload(admittedSource);
  pending = null;
  FakeWebSocket.intercept = (_target, request) => {
    if (request.method === "turn/steer" && request.params?.threadId === "c") {
      pending = request;
      return true;
    }
    return false;
  };
  const admitted = client.sendThreadMessage(admittedSource, [{ text: "two", text_elements: [], type: "text" }]);
  await waitForRequest(socket, "turn/steer", 1);
  client.selectThreadPayload(selectedOther);
  socket.respond(pending!.id, { turnId: "different-c-turn" });
  assert.equal((await admitted)?.id, "c");
  assert.equal(client.getSnapshot().currentThread?.id, "d");
  assert.equal(client.getSnapshot().threadDocuments.selectedThreadKey, "codex:d");
}));

test("questionnaire supplemental input and stop keep native steer identity off control payloads", async () => withClient(async (client, socket) => {
  const source = activeThread();
  client.selectThreadPayload(source);
  await client.stopThread(source);
  assert.ok(socket.requests.some((request) => request.method === "turn/interrupt"));

  socket.notify("questionnaire/requested", {
    itemId: "question-2", requestKey: "question-key", threadId: "thread", turnId: "turn",
    request: { id: "question", questions: [], submitLabel: "send", summary: "question", title: "question" },
  });
  await client.submitPendingUserInputRequest("thread", { answers: {} }, {
    supplementalInput: [{ text: "extra", text_elements: [], type: "text" }],
  });
  const supplemental = socket.requests.filter((request) => request.method === "turn/steer").at(-1);
  assert.equal(supplemental?.params?.clientUserMessageId, undefined);
}));

test("interrupted proper questionnaires detach while approvals are discarded", async () => withClient(async (client, socket) => {
  const source = activeThread();
  client.selectThreadPayload(source);
  const question = {
    id: "question",
    questions: [{ allowOther: false, header: "Route", id: "route", isSecret: false, options: [{ description: "Continue", label: "Approve" }], question: "Continue?" }],
    submitLabel: "Send",
    summary: "Choose",
    title: "Questionnaire",
  };
  socket.notify("questionnaire/requested", { itemId: "item", request: question, requestKey: "question", threadId: "thread", turnId: "turn" });
  socket.notify("turn/completed", { threadId: "thread", turn: { ...source.turns[0], completedAt: 2, status: "interrupted" } });
  assert.equal(client.getSnapshot().pendingUserInputRequestsByThreadId.thread?.responseMode, "newTurn");

  socket.notify("questionnaire/resolved", { requestKey: "question", threadId: "thread", turnId: "turn" });
  socket.notify("questionnaire/requested", {
    itemId: "approval-item",
    request: { ...question, approval: {}, id: "approval" },
    requestKey: "approval",
    threadId: "thread",
    turnId: "turn",
  });
  socket.notify("turn/completed", { threadId: "thread", turn: { ...source.turns[0], completedAt: 2, status: "interrupted" } });
  assert.equal(client.getSnapshot().pendingUserInputRequestsByThreadId.thread, undefined);
}));

test("durable detached questionnaire responses start hidden turns and resolve only after admission", async () => withClient(async (client, socket) => {
  const source = activeThread("codex", "thread", "interrupted");
  const questionnairePrompt = { id: "prompt", memoryCitation: null, phase: "commentary" as const, text: "Choose a route.", type: "agentMessage" as const };
  source.turns[0]!.items = [questionnairePrompt];
  client.selectThreadPayload(source);
  const request = {
    id: "question",
    questions: [{ allowOther: false, header: "Route", id: "route", isSecret: false, options: [{ description: "Continue", label: "Approve" }], question: "Continue?" }],
    submitLabel: "Send",
    summary: "Choose",
    title: "Questionnaire",
  };
  client.installSidebarSnapshot({
    entries: [{
      activityAt: 2,
      entryKind: "thread",
      identity: { harness: "codex", threadId: "thread" },
      lifecycle: { kind: "stopped", reason: "providerInterrupted", settled: false, turnId: "turn" },
      metadata: { archived: false, pinned: false, snoozed: false },
      pendingQuestionnaire: { itemId: "item", request, requestKey: "question", turnId: "turn" },
      title: "Thread",
    }],
    error: null,
    freshness: "fresh",
    projectId: "project",
    revision: 1,
  });
  await waitForCondition(() => client.getSnapshot().pendingUserInputRequestsByThreadId.thread?.responseMode === "newTurn", "Durable questionnaire did not reconcile as detached.");

  const admitted = wireThread("thread", "thread-started");
  admitted.turns = [wireThread("thread", "turn", "interrupted").turns[0]!, admitted.turns[0]!];
  admitted.turns[0]!.items = [questionnairePrompt];
  let turnStarted = false;
  FakeWebSocket.intercept = (target, candidate) => {
    if (candidate.method === "turn/start") {
      turnStarted = true;
      queueMicrotask(() => target.respond(candidate.id, { turn: admitted.turns[1] }));
      return true;
    }
    if (turnStarted && candidate.method === "thread/resume") {
      queueMicrotask(() => target.respond(candidate.id, { model: "model", reasoningEffort: null, serviceTier: null, thread: admitted }));
      return true;
    }
    if (turnStarted && candidate.method === "thread/context/read") {
      queueMicrotask(() => target.respond(candidate.id, { browseResultEntries: [], questionnaireEntries: [], steerEntries: [], thread: admitted }));
      return true;
    }
    return false;
  };

  await client.submitPendingUserInputRequest("thread", { answers: { route: { answers: ["Approve"] } } }, {
    insertAfterItemId: "prompt",
    insertAfterItemIndex: 0,
    turnId: "turn",
  });
  const start = socket.requests.find((candidate) => candidate.method === "turn/start");
  const input = start?.params?.input as Array<{ text?: string; type?: string }> | undefined;
  assert.match(input?.[0]?.text ?? "", /^<workbench:questionnaire-response>/u);
  assert.equal(socket.requests.some((candidate) => candidate.method === "questionnaire/respond"), false);
  assert.equal(socket.requests.some((candidate) => candidate.method === "workbench/thread-state/questionnaire/resolve"), true);
  assert.equal(client.getSnapshot().pendingUserInputRequestsByThreadId.thread, undefined);
  const originalTurn = client.getSnapshot().currentThread?.turns.find((turn) => turn.id === "turn");
  assert.equal(originalTurn?.items.some((item) => item.id.startsWith("workbench:questionnaire-history:")), true);
}));

test("failed detached questionnaire admission leaves the durable request retryable", async () => withClient(async (client, socket) => {
  const source = activeThread("codex", "thread", "interrupted");
  client.selectThreadPayload(source);
  const request = {
    id: "question",
    questions: [{ allowOther: false, header: "Route", id: "route", isSecret: false, options: [{ description: "Continue", label: "Approve" }], question: "Continue?" }],
    submitLabel: "Send",
    summary: "Choose",
    title: "Questionnaire",
  };
  client.installSidebarSnapshot({
    entries: [{ activityAt: 2, entryKind: "thread", identity: { harness: "codex", threadId: "thread" }, lifecycle: { kind: "stopped", reason: "providerInterrupted", settled: false, turnId: "turn" }, metadata: { archived: false, pinned: false, snoozed: false }, pendingQuestionnaire: { itemId: "item", request, requestKey: "question", turnId: "turn" }, title: "Thread" }],
    error: null, freshness: "fresh", projectId: "project", revision: 1,
  });
  await waitForCondition(() => client.getSnapshot().pendingUserInputRequestsByThreadId.thread?.responseMode === "newTurn", "Durable questionnaire did not reconcile as detached.");
  FakeWebSocket.intercept = (target, candidate) => {
    if (candidate.method !== "turn/start") return false;
    queueMicrotask(() => target.fail(candidate.id, "admission failed"));
    return true;
  };
  await assert.rejects(client.submitPendingUserInputRequest("thread", { answers: { route: { answers: ["Approve"] } } }), /admission failed/u);
  assert.equal(client.getSnapshot().pendingUserInputRequestsByThreadId.thread?.requestKey, "question");
  assert.equal(socket.requests.some((candidate) => candidate.method === "workbench/thread-state/questionnaire/resolve"), false);
}));

test("rejected durable questionnaire resolution does not clear the detached request", async () => withClient(async (client, socket) => {
  const source = activeThread("codex", "thread", "interrupted");
  client.selectThreadPayload(source);
  const request = {
    id: "question",
    questions: [{ allowOther: false, header: "Route", id: "route", isSecret: false, options: [{ description: "Continue", label: "Approve" }], question: "Continue?" }],
    submitLabel: "Send",
    summary: "Choose",
    title: "Questionnaire",
  };
  client.installSidebarSnapshot({
    entries: [{ activityAt: 2, entryKind: "thread", identity: { harness: "codex", threadId: "thread" }, lifecycle: { kind: "stopped", reason: "providerInterrupted", settled: false, turnId: "turn" }, metadata: { archived: false, pinned: false, snoozed: false }, pendingQuestionnaire: { itemId: "item", request, requestKey: "question", turnId: "turn" }, title: "Thread" }],
    error: null, freshness: "fresh", projectId: "project", revision: 1,
  });
  await waitForCondition(() => client.getSnapshot().pendingUserInputRequestsByThreadId.thread?.responseMode === "newTurn", "Durable questionnaire did not reconcile as detached.");
  FakeWebSocket.intercept = (target, candidate) => {
    if (candidate.method !== "workbench/thread-state/questionnaire/resolve") return false;
    queueMicrotask(() => target.respond(candidate.id, { accepted: false, revision: 2 }));
    return true;
  };
  await assert.rejects(
    client.submitPendingUserInputRequest("thread", { answers: { route: { answers: ["Approve"] } } }),
    /durable history could not be resolved/u,
  );
  assert.equal(client.getSnapshot().pendingUserInputRequestsByThreadId.thread?.requestKey, "question");
}));
