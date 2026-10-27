/* No production exports. Protect that callers' aborted requests reach the peer as cancellations, and that a cancellation aborts exactly the running request it names. */
import assert from "node:assert/strict";
import test from "node:test";
import WorkbenchRpcSocketClient from "./WorkbenchRpcSocketClient.ts";
import { sendCancellableRequest, WORKBENCH_RPC_CANCEL_METHOD, WorkbenchRpcInflight } from "./rpc-cancellation.ts";

function gate() {
  let open!: () => void;
  const opened = new Promise<void>(resolve => { open = resolve; });
  return { open, opened };
}

class Socket extends EventTarget {
  readyState = WebSocket.CONNECTING;
  sent: object[] = [];
  open() { this.readyState = WebSocket.OPEN; this.dispatchEvent(new Event("open")); }
  send(payload: string) { this.sent.push(JSON.parse(payload) as object); }
  close() { this.readyState = WebSocket.CLOSED; this.dispatchEvent(new Event("close")); }
}

test("aborting a dispatched request asks the peer to cancel it; an undispatched one sends nothing", async () => {
  let created!: (socket: Socket) => void;
  const socketCreated = new Promise<Socket>(resolve => { created = resolve; });
  const transport = new WorkbenchRpcSocketClient(async () => "ws://example.test", "app",
    () => { const socket = new Socket(); created(socket); return socket as unknown as WebSocket; });
  const opening = transport.connect();
  const socket = await socketCreated;
  socket.open();
  await opening;

  const early = new AbortController();
  early.abort();
  await assert.rejects(sendCancellableRequest(transport, { id: 1, method: "workbench/example" }, { signal: early.signal }));
  assert.equal(socket.sent.length, 0);

  const cancellation = new AbortController();
  const pending = sendCancellableRequest(transport, { id: 2, method: "workbench/example" }, { signal: cancellation.signal });
  cancellation.abort();
  await assert.rejects(pending, /cancelled/u);
  assert.deepEqual(socket.sent, [{ id: 2, method: "workbench/example" }, { method: WORKBENCH_RPC_CANCEL_METHOD, params: { id: 2 } }]);
  transport.dispose();
});

test("cancellation aborts the named running request only, and finished ids are forgotten", async () => {
  const inflight = new WorkbenchRpcInflight();
  const signals: AbortSignal[] = [];
  const hold = gate();
  const running = (id: number | null) => inflight.run(id, async signal => { signals.push(signal); await hold.opened; });
  const first = running(1);
  const second = running(2);
  const anonymous = running(null);
  const cancel = (id: number) => inflight.cancel({ method: WORKBENCH_RPC_CANCEL_METHOD, params: { id } });

  cancel(1);
  assert.deepEqual(signals.map(signal => signal.aborted), [true, false, false]);

  hold.open();
  await Promise.all([first, second, anonymous]);
  const reused = gate();
  const next = inflight.run(2, async signal => { signals.push(signal); await reused.opened; });
  cancel(1);
  assert.equal(signals[3]!.aborted, false, "a finished id no longer cancels anything");
  cancel(2);
  assert.equal(signals[3]!.aborted, true, "a reused id cancels its current request");
  reused.open();
  await next;
});
