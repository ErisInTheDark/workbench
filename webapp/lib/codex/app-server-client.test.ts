/*
 * Exports:
 * - No production exports; Node tests cover WebSocket send failure cleanup, response settlement, and cumulative event-stream receipts. Keywords: codex, websocket, stream, acknowledgement, request, test.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { CodexAppServerClient } from "./app-server-client.ts";
import { WORKBENCH_EVENT_STREAM_SEQUENCE_FIELD } from "../workbench/websocket-stream.ts";

type Listener = (event: { data?: string }) => void;

class FakeClock {
  nowMs = 0;
  private nextTimerId = 1;
  private readonly timers = new Map<number, { callback: () => void; dueAt: number }>();

  readonly clearTimeout = (timer: ReturnType<typeof setTimeout>) => {
    this.timers.delete(timer as unknown as number);
  };

  readonly setTimeout = (callback: () => void, delayMs: number) => {
    const id = this.nextTimerId++;
    this.timers.set(id, { callback, dueAt: this.nowMs + Math.max(0, delayMs) });
    return id as unknown as ReturnType<typeof setTimeout>;
  };

  advance(durationMs: number) {
    const target = this.nowMs + durationMs;
    while (true) {
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.dueAt <= target)
        .sort((left, right) => left[1].dueAt - right[1].dueAt || left[0] - right[0])[0];
      if (!next) break;
      this.timers.delete(next[0]);
      this.nowMs = next[1].dueAt;
      next[1].callback();
    }
    this.nowMs = target;
  }
}

class FakeWebSocket {
  static readonly OPEN = 1;
  readonly OPEN = 1;
  readyState = FakeWebSocket.OPEN;
  throwNext = false;
  closeCalls = 0;
  readonly sent: Array<Record<string, unknown>> = [];
  private readonly listeners = new Map<string, Listener[]>();

  constructor(_url: string, autoOpen = true) {
    if (autoOpen) queueMicrotask(() => this.emit("open", {}));
  }

  addEventListener(type: string, listener: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  close() {
    this.closeCalls += 1;
    this.readyState = 3;
    this.emit("close", {});
  }

  send(payload: string) {
    if (this.throwNext) {
      this.throwNext = false;
      throw new Error("socket send failed");
    }
    const request = JSON.parse(payload) as { id?: number; method?: string };
    this.sent.push(request as Record<string, unknown>);
    if (request.method === "initialize") {
      queueMicrotask(() => this.respond(request.id ?? 0, { userAgent: "test" }));
    }
  }

  respond(id: number, result: unknown) {
    this.emit("message", { data: JSON.stringify({ id, result }) });
  }

  notify(message: Record<string, unknown>) {
    this.emit("message", { data: JSON.stringify(message) });
  }

  protected emit(type: string, event: { data?: string }) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

test("a socket that errors before opening is closed before replacement", async () => {
  const originalWebSocket = globalThis.WebSocket;
  const sockets: FakeWebSocket[] = [];
  globalThis.WebSocket = class extends FakeWebSocket {
    constructor(url: string) {
      const shouldFail = sockets.length === 0;
      super(url, !shouldFail);
      sockets.push(this);
      if (shouldFail) queueMicrotask(() => this.emit("error", {}));
    }
  } as unknown as typeof WebSocket;
  try {
    const client = new CodexAppServerClient();
    await assert.rejects(client.connectSocket("ws://test"), /Failed to connect/u);
    assert.equal(sockets[0]?.closeCalls, 1);
    await client.connectSocket("ws://test");
    assert.equal(sockets.length, 2);
    client.close();
  } finally {
    globalThis.WebSocket = originalWebSocket;
  }
});

test("sendRequest removes a pending handler when socket send throws", async () => {
  const originalWebSocket = globalThis.WebSocket;
  let socket: FakeWebSocket | null = null;
  globalThis.WebSocket = class extends FakeWebSocket {
    constructor(url: string) {
      super(url);
      socket = this;
    }
  } as unknown as typeof WebSocket;
  try {
    const client = new CodexAppServerClient();
    await client.connect("ws://test");
    assert.ok(socket);
    socket.throwNext = true;
    await assert.rejects(client.sendRequest({ method: "turn/steer", params: {} }), /socket send failed/u);
    assert.doesNotThrow(() => client.close());
    assert.equal(socket.closeCalls, 1);
  } finally {
    globalThis.WebSocket = originalWebSocket;
  }
});

test("a normal request resolves once by response id", async () => {
  const originalWebSocket = globalThis.WebSocket;
  let socket: FakeWebSocket | null = null;
  globalThis.WebSocket = class extends FakeWebSocket {
    constructor(url: string) {
      super(url);
      socket = this;
    }
  } as unknown as typeof WebSocket;
  try {
    const client = new CodexAppServerClient();
    await client.connect("ws://test");
    const response = client.sendRequest<{ ok: true }>({ id: 42, method: "test" });
    socket?.respond(42, { ok: true });
    assert.deepEqual(await response, { id: 42, result: { ok: true } });
    client.close();
  } finally {
    globalThis.WebSocket = originalWebSocket;
  }
});

test("default receipt timers preserve the browser global receiver", async () => {
  const originalClearTimeout = globalThis.clearTimeout;
  const originalSetTimeout = globalThis.setTimeout;
  const originalWebSocket = globalThis.WebSocket;
  const timer = 123 as unknown as ReturnType<typeof setTimeout>;
  let clearedTimer: ReturnType<typeof setTimeout> | null = null;
  let scheduledCallback: (() => void) | null = null;
  let socket: FakeWebSocket | null = null;
  globalThis.clearTimeout = function (this: unknown, candidate?: ReturnType<typeof setTimeout>) {
    if (this !== globalThis) throw new TypeError("Illegal invocation");
    clearedTimer = candidate ?? null;
  } as typeof clearTimeout;
  globalThis.setTimeout = function (this: unknown, callback: () => void) {
    if (this !== globalThis) throw new TypeError("Illegal invocation");
    scheduledCallback = callback;
    return timer;
  } as typeof setTimeout;
  globalThis.WebSocket = class extends FakeWebSocket {
    constructor(url: string) {
      super(url);
      socket = this;
    }
  } as unknown as typeof WebSocket;
  try {
    const client = new CodexAppServerClient();
    await client.connect("ws://test");
    assert.ok(socket);
    socket.notify({
      [WORKBENCH_EVENT_STREAM_SEQUENCE_FIELD]: 1,
      method: "item/agentMessage/delta",
      params: { delta: "first", itemId: "item", threadId: "thread", turnId: "turn" },
      workbenchHarness: "codex",
    });
    assert.ok(scheduledCallback);
    client.close();
    assert.equal(clearedTimer, timer);
  } finally {
    globalThis.clearTimeout = originalClearTimeout;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.WebSocket = originalWebSocket;
  }
});

test("batches cumulative receipts after notification listeners consume events", async () => {
  const originalWebSocket = globalThis.WebSocket;
  const clock = new FakeClock();
  let socket: FakeWebSocket | null = null;
  globalThis.WebSocket = class extends FakeWebSocket {
    constructor(url: string) {
      super(url);
      socket = this;
    }
  } as unknown as typeof WebSocket;
  try {
    const client = new CodexAppServerClient({
      clearEventStreamAckTimeout: clock.clearTimeout,
      setEventStreamAckTimeout: clock.setTimeout,
    });
    await client.connect("ws://test");
    assert.ok(socket);
    socket.sent.length = 0;
    const consumed: string[] = [];
    client.onNotification((notification) => { consumed.push(notification.method); });

    socket.notify({
      [WORKBENCH_EVENT_STREAM_SEQUENCE_FIELD]: 1,
      method: "item/agentMessage/delta",
      params: { delta: "first", itemId: "item", threadId: "thread", turnId: "turn" },
      workbenchHarness: "codex",
    });
    socket.notify({
      [WORKBENCH_EVENT_STREAM_SEQUENCE_FIELD]: 2,
      method: "item/agentMessage/delta",
      params: { delta: "second", itemId: "item", threadId: "thread", turnId: "turn" },
      workbenchHarness: "codex",
    });
    assert.deepEqual(consumed, ["item/agentMessage/delta", "item/agentMessage/delta"]);
    clock.advance(49);
    assert.deepEqual(socket.sent, []);
    clock.advance(1);
    assert.deepEqual(socket.sent, [{ method: "workbench/event-stream/ack", params: { sequence: 2 } }]);
    client.close();
  } finally {
    globalThis.WebSocket = originalWebSocket;
  }
});

test("does not acknowledge failed dispatch or cancelled receipt work", async () => {
  const originalWebSocket = globalThis.WebSocket;
  const clock = new FakeClock();
  let socket: FakeWebSocket | null = null;
  globalThis.WebSocket = class extends FakeWebSocket {
    constructor(url: string) {
      super(url);
      socket = this;
    }
  } as unknown as typeof WebSocket;
  try {
    const client = new CodexAppServerClient({
      clearEventStreamAckTimeout: clock.clearTimeout,
      setEventStreamAckTimeout: clock.setTimeout,
    });
    await client.connect("ws://test");
    assert.ok(socket);
    socket.sent.length = 0;
    client.onNotification((notification) => {
      if (notification.method === "item/agentMessage/delta" && notification.params.delta === "fail") throw new Error("render dispatch failed");
    });

    assert.throws(() => socket?.notify({
      [WORKBENCH_EVENT_STREAM_SEQUENCE_FIELD]: 1,
      method: "item/agentMessage/delta",
      params: { delta: "fail", itemId: "item", threadId: "thread", turnId: "turn" },
      workbenchHarness: "codex",
    }), /render dispatch failed/u);
    clock.advance(100);
    assert.deepEqual(socket.sent, []);

    socket.notify({
      [WORKBENCH_EVENT_STREAM_SEQUENCE_FIELD]: 2,
      method: "item/agentMessage/delta",
      params: { delta: "ok", itemId: "item", threadId: "thread", turnId: "turn" },
      workbenchHarness: "codex",
    });
    clock.advance(100);
    assert.deepEqual(socket.sent, []);
    client.close();
    clock.advance(100);
    assert.deepEqual(socket.sent, []);
  } finally {
    globalThis.WebSocket = originalWebSocket;
  }
});
