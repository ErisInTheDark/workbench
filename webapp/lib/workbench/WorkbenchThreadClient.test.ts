/*
 * Exports:
 * - No production exports; Node tests cover thread reads, lifecycle fencing, canonical placement, and steer settlement. Keywords: workbench, thread, lifecycle, read, steer, integration, test.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { Thread } from "../codex/generated/app-server/v2/Thread.ts";
import type { ThreadPayload, WorkbenchSteerHistoryEntry } from "../types.ts";
import WorkbenchThreadClient from "./WorkbenchThreadClient.ts";

type Listener = (event: { data?: string }) => void;
type SocketRequest = { id: number; method: string; params?: Record<string, unknown>; workbenchHarness?: string };

function wireThread(
  id: string,
  turnId = `${id}-turn`,
  turnStatus: Thread["turns"][number]["status"] = "inProgress",
): Thread {
  return {
    agentNickname: null, agentRole: null, cliVersion: "test", createdAt: 1, cwd: "C:/repo", ephemeral: false,
    forkedFromId: null, gitInfo: null, id, modelProvider: "openai", name: null, parentThreadId: null, path: null,
    preview: "", recencyAt: null, sessionId: `${id}-session`, source: "appServer",
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
    const message = JSON.parse(payload) as { id?: number; method: string; params?: Record<string, unknown>; workbenchHarness?: string };
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
    reasoningEffort: null, serviceTier: null, source: harness, status: turnStatus === "inProgress" ? "active" : "idle", tokenUsage: null, turnHistory: [], unreadBadge: null,
    turns: [{ completedAt: turnStatus === "inProgress" ? null : 2, durationMs: turnStatus === "inProgress" ? null : 1, error: null, id: `${id === "thread" ? "" : `${id}-`}turn`, items: [], itemsView: "full", startedAt: 1, status: turnStatus }], updatedAt: 1,
  };
}

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
    assert.ok(socket?.requests.some((request) => (
      request.method === "turn/steer" && request.params?.threadId === "background"
    )));
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

test("idle Codex uses the full route with native identity while Copilot and OpenCode preserve provider acknowledgements", async () => withClient(async (client, socket) => {
  const idle = activeThread("codex", "idle", "completed");
  client.selectThreadPayload(idle);
  const result = await client.sendThreadMessage(idle, [{ text: "codex", text_elements: [], type: "text" }]);
  assert.equal(result?.id, "idle");
  const codexSteer = socket.requests.find((request) => request.method === "turn/steer" && request.params?.threadId === "idle");
  assert.equal(typeof codexSteer?.params?.clientUserMessageId, "string");
  assert.ok(socket.requests.some((request) => request.method === "thread/read" && request.params?.threadId === "idle"));

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
  await assert.rejects(sameKey, /changed before the steer could be admitted/u);

  const aba = client.sendThreadMessage(source, [{ text: "aba", text_elements: [], type: "text" }]);
  client.selectThreadPayload(activeThread("codex", "b"));
  client.selectThreadPayload(source);
  await assert.rejects(aba, /changed before the steer could be admitted/u);

  const clear = client.sendThreadMessage(source, [{ text: "clear", text_elements: [], type: "text" }]);
  client.clearThreadSelection();
  client.selectThreadPayload(source);
  await assert.rejects(clear, /changed before the steer could be admitted/u);

  const profile = client.sendThreadMessage(source, [{ text: "profile", text_elements: [], type: "text" }]);
  client.setCurrentThreadComposerSettings("thread", {
    agentPath: "agent://changed", agentSource: null, harness: "codex", model: "changed-model", reasoningEffort: null, serviceTier: "fast",
  });
  assert.equal(await profile, null);
  assert.equal(socket.requests.filter((request) => request.method === "turn/steer").length, 1);
  assert.equal(socket.requests.some((request) => request.method === "thread/resume"), false);
}));

test("status drift during fast admission prevents obsolete steer dispatch", async () => withClient(async (client, socket) => {
  const source = activeThread();
  client.selectThreadPayload(source);
  const send = client.sendThreadMessage(source, [{ text: "blocked", text_elements: [], type: "text" }]);
  socket.notify("thread/status/changed", {
    status: { activeFlags: ["waitingOnUserInput"], type: "active" },
    threadId: "thread",
  });
  await assert.rejects(send, /changed before the steer could be admitted/u);
  assert.equal(socket.requests.some((request) => request.method === "turn/steer"), false);
}));

test("selection drift during preserved general preparation sends no obsolete steer", async () => withClient(async (client, socket) => {
  const idle = activeThread("codex", "idle", "completed");
  client.selectThreadPayload(idle);
  let readRequest: SocketRequest | null = null;
  FakeWebSocket.intercept = (_target, request) => {
    if (request.method === "thread/read" && request.params?.threadId === "idle") {
      readRequest = request;
      return true;
    }
    return false;
  };
  const send = client.sendThreadMessage(idle, [{ text: "stale", text_elements: [], type: "text" }]);
  await waitForRequest(socket, "thread/read");
  client.selectThreadPayload(activeThread("codex", "other"));
  socket.respond(readRequest!.id, { thread: wireThread("idle") });
  await assert.rejects(send, /thread changed before the message could be sent/u);
  assert.equal(socket.requests.some((request) => request.method === "turn/steer" && request.params?.threadId === "idle"), false);
  assert.equal(client.getSnapshot().currentThread?.id, "other");
}));

test("same-selection notification drift rejects before dispatch instead of clearing an unsent message", async () => withClient(async (client, socket) => {
  const idle = activeThread("codex", "idle", "completed");
  client.selectThreadPayload(idle);
  let readRequest: SocketRequest | null = null;
  FakeWebSocket.intercept = (_target, request) => {
    if (request.method === "thread/read" && request.params?.threadId === "idle") {
      readRequest = request;
      return true;
    }
    return false;
  };

  const send = client.sendThreadMessage(idle, [{ text: "keep me", text_elements: [], type: "text" }]);
  await waitForRequest(socket, "thread/read");
  socket.notify("thread/status/changed", {
    status: { type: "idle" },
    threadId: "idle",
  });
  socket.respond(readRequest!.id, { thread: wireThread("idle", "idle-turn", "completed") });

  await assert.rejects(send, /thread changed before the message could be sent/u);
  assert.equal(socket.requests.some((request) => request.method === "turn/steer" || request.method === "turn/start"), false);
  assert.equal(client.getSnapshot().currentThread?.id, "idle");
}));

test("idle status with a stale in-progress turn uses authoritative preparation and starts a new turn", async () => withClient(async (client, socket) => {
  const stale = { ...activeThread(), status: "idle" };
  const completed = wireThread("thread", "turn", "completed");
  client.selectThreadPayload(stale);
  FakeWebSocket.intercept = (target, request) => {
    if (request.method === "thread/read") {
      queueMicrotask(() => target.respond(request.id, { thread: completed }));
      return true;
    }
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
  assert.equal(result?.turns.at(-1)?.id, "new-turn");
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
    client.sendThreadMessage(codex, [{ text: "codex", text_elements: [], type: "text" }]),
    /empty turn id/u,
  );
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

test("status and token owners survive canonical updates, authoritative nulls, and compact clears", async () => withClient(async (client, socket) => {
  const usage = (totalTokens: number) => ({
    last: { cachedInputTokens: 0, inputTokens: totalTokens, outputTokens: 0, reasoningOutputTokens: 0, totalTokens },
    modelContextWindow: 100,
    total: { cachedInputTokens: 0, inputTokens: totalTokens, outputTokens: 0, reasoningOutputTokens: 0, totalTokens },
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

test("project or selection changes during draft list refresh prevent stale general dispatch", async () => withClient(async (client, socket) => {
  const draft = { ...activeThread("copilot", "draft", "completed"), isDraft: true, source: "draft" };
  client.selectThreadPayload(draft);
  const deferredLists: SocketRequest[] = [];
  FakeWebSocket.intercept = (target, request) => {
    if (request.method === "thread/start") {
      queueMicrotask(() => target.respond(request.id, { thread: wireThread("materialized") }));
      return true;
    }
    if (request.method === "thread/list") {
      deferredLists.push(request);
      return true;
    }
    return false;
  };
  const send = client.sendThreadMessage(draft, [{ text: "draft", text_elements: [], type: "text" }]);
  await waitForRequest(socket, "thread/list");
  client.setProjectContext({ projectId: "other", root: "other", rootPath: "C:/other" });
  for (const request of deferredLists) {
    socket.respond(request.id, { data: [] });
  }
  await assert.rejects(send, /thread changed before the message could be sent/u);
  assert.equal(socket.requests.some((request) => request.method === "thread/read" && request.params?.threadId === "materialized"), false);
  assert.equal(socket.requests.some((request) => request.method === "turn/steer" && request.params?.threadId === "materialized"), false);
}));

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

test("questionnaire, pause, resume, and stop controls keep native steer identity off control payloads", async () => withClient(async (client, socket) => {
  const source = activeThread();
  client.selectThreadPayload(source);
  socket.notify("questionnaire/requested", {
    hidden: true, itemId: "question", requestKey: "pause-key", threadId: "thread", turnId: "turn", controlKind: "pause",
    request: { id: "pause", questions: [], submitLabel: "resume", summary: "paused", title: "paused" },
  });
  await client.resumeThread(source);
  const response = socket.requests.find((request) => request.method === "questionnaire/respond");
  assert.ok(response);

  await client.pauseThread(source);
  const pauseSteer = socket.requests.filter((request) => request.method === "turn/steer").at(-1);
  assert.equal(pauseSteer?.params?.clientUserMessageId, undefined);

  await client.stopThread(source);
  assert.ok(socket.requests.some((request) => request.method === "turn/interrupt"));

  socket.notify("questionnaire/requested", {
    hidden: false, itemId: "question-2", requestKey: "question-key", threadId: "thread", turnId: "turn",
    request: { id: "question", questions: [], submitLabel: "send", summary: "question", title: "question" },
  });
  await client.submitPendingUserInputRequest("thread", { answers: {} }, {
    supplementalInput: [{ text: "extra", text_elements: [], type: "text" }],
  });
  const supplemental = socket.requests.filter((request) => request.method === "turn/steer").at(-1);
  assert.equal(supplemental?.params?.clientUserMessageId, undefined);
}));
