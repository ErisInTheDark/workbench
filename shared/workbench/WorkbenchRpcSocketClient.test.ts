/* No production exports. Protect shared socket notification and pending-request lifetimes. */
import assert from "node:assert/strict";
import test from "node:test";
import WorkbenchRpcSocketClient from "./WorkbenchRpcSocketClient.ts";

test("one connection delivers notifications and rejects its pending RPC when disposed", async () => {
  class Socket extends EventTarget {
    readyState = WebSocket.CONNECTING;
    sent: object[] = [];
    open() { this.readyState = WebSocket.OPEN; this.dispatchEvent(new Event("open")); }
    send(payload: string) { this.sent.push(JSON.parse(payload) as object); }
    close() { this.readyState = WebSocket.CLOSED; this.dispatchEvent(new Event("close")); }
    notify(value: object) {
      this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) }));
    }
  }
  let createdSocket!: (socket: Socket) => void;
  const created = new Promise<Socket>(resolve => { createdSocket = resolve; });
  const client = new WorkbenchRpcSocketClient(async () => "ws://example.test", "app",
    () => {
      const socket = new Socket();
      createdSocket(socket);
      return socket as unknown as WebSocket;
    });
  const notifications: unknown[] = [];
  client.onMessage(value => notifications.push(value));
  const opening = client.connect();
  const socket = await created;
  socket.open();
  await opening;
  socket.notify({ kind: "ready" });
  const pending = client.sendRequest({ method: "workbench/example" });
  assert.equal(socket.sent.length, 1);
  client.dispose();
  await assert.rejects(pending, /disposed/u);
  assert.deepEqual(notifications, [{ kind: "ready" }]);
  assert.equal(socket.readyState, WebSocket.CLOSED);
});
