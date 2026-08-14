/*
 * Exports:
 * - No production exports; Node tests cover WebSocket send failure cleanup and normal response settlement. Keywords: codex, websocket, request, test.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { CodexAppServerClient } from "./app-server-client.ts";

type Listener = (event: { data?: string }) => void;

class FakeWebSocket {
  static readonly OPEN = 1;
  readonly OPEN = 1;
  readyState = FakeWebSocket.OPEN;
  throwNext = false;
  closeCalls = 0;
  private readonly listeners = new Map<string, Listener[]>();

  constructor(_url: string) {
    queueMicrotask(() => this.emit("open", {}));
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
    if (request.method === "initialize") {
      queueMicrotask(() => this.respond(request.id ?? 0, { userAgent: "test" }));
    }
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
