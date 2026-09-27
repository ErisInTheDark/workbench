/*
 * No production exports. Protect early RPC selection, response validation and uncertain-write failure.
 */
import assert from "node:assert/strict";
import test from "node:test";
import WorkbenchAppRpcClient from "./WorkbenchAppRpcClient";

test("old app processes select HTTP without opening an RPC socket", async () => {
  let sockets = 0;
  const client = new WorkbenchAppRpcClient({
    fetcher: async () => new Response(null, { status: 200 }),
    socket: () => { sockets++; throw new Error("Unexpected socket."); },
  });
  try {
    await client.start();
    assert.equal(client.available, false);
    assert.equal(sockets, 0);
  } finally { client.dispose(); }
});

test("a failed capability probe is not mistaken for an old app process", async () => {
  const client = new WorkbenchAppRpcClient({
    fetcher: async () => new Response(null, { status: 503 }),
  });
  try {
    await assert.rejects(client.start(), /capability could not be read/u);
  } finally { client.dispose(); }
});

test("an initial import warning survives the gap before its network owner subscribes", async () => {
  class Socket extends EventTarget {
    readyState: number = WebSocket.CONNECTING;
    constructor() {
      super();
      queueMicrotask(() => {
        this.readyState = WebSocket.OPEN;
        this.dispatchEvent(new Event("open"));
      });
    }
    send() {}
    close() { this.readyState = WebSocket.CLOSED; this.dispatchEvent(new Event("close")); }
    publish(value: object) {
      this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) }));
    }
  }
  let socket!: Socket;
  const client = new WorkbenchAppRpcClient({
    fetcher: async () => new Response(null, { status: 200,
      headers: { "X-Workbench-App-Rpc": "1" } }),
    socket: () => {
      socket = new Socket();
      return socket as unknown as WebSocket;
    },
  });
  try {
    await client.start();
    socket.publish({ kind: "presentation-import",
      status: { phase: "partial", scanned: 2, imported: 1, failed: 1 } });
    const observed: number[] = [];
    client.onEvent(event => {
      if (event.kind === "presentation-import") observed.push(event.status.failed);
    });
    assert.deepEqual(observed, [1]);
  } finally { client.dispose(); }
});

test("a pending app write fails on socket loss instead of replaying after reconnect", async () => {
  class Socket extends EventTarget {
    readyState: number = WebSocket.CONNECTING;
    sent: object[] = [];
    sentRequest = Promise.withResolvers<void>();
    constructor() {
      super();
      queueMicrotask(() => {
        this.readyState = WebSocket.OPEN;
        this.dispatchEvent(new Event("open"));
      });
    }
    send(value: string) {
      this.sent.push(JSON.parse(value) as object);
      this.sentRequest.resolve();
    }
    publish(value: object) {
      this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) }));
    }
    close() {
      this.readyState = WebSocket.CLOSED;
      this.dispatchEvent(new Event("close"));
    }
  }
  const sockets: Socket[] = [];
  const secondSocket = Promise.withResolvers<Socket>();
  const client = new WorkbenchAppRpcClient({
    fetcher: async () => new Response(null, { status: 200,
      headers: { "X-Workbench-App-Rpc": "1" } }),
    socket: () => {
      const socket = new Socket();
      sockets.push(socket);
      if (sockets.length === 2) secondSocket.resolve(socket);
      return socket as unknown as WebSocket;
    },
  });
  try {
    await client.start();
    assert.equal(client.available, true);
    const pending = client.requestRaw({
      method: "app/state/mutate",
      params: { browserStateId: null, mutation: { action: "put",
        record: { kind: "globalPreference", preference: { key: "theme", value: "winter" } } } },
    });
    assert.equal(sockets[0]?.sent.length, 1);
    assert.equal((sockets[0]?.sent[0] as { method: string }).method, "app/state/mutate");
    sockets[0]?.close();
    await assert.rejects(pending, /connection closed/u);
    assert.equal(sockets[0]?.sent.length, 1);
    const next = client.requestRaw({ method: "app/network/read", params: {} });
    const replacement = await secondSocket.promise;
    await replacement.sentRequest.promise;
    assert.deepEqual(replacement.sent.map(item => (item as { method: string }).method), ["app/network/read"]);
    replacement.publish({ id: 2, result: {} });
    await next;
  } finally { client.dispose(); }
});
