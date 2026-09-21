/*
 * No production exports. Tests local control cancellation and connection ownership.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import WorkbenchServiceClient from "./WorkbenchServiceClient.ts";
import type { WorkbenchServiceSnapshot } from "../http/workbench-service.ts";

class Socket extends EventTarget {
  readyState = 1;
  sent: { id: string; method: string; requestId?: string }[] = [];
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() { this.readyState = 3; this.dispatchEvent(new Event("close")); }
  message(value: object) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) })); }
}

const snapshot: WorkbenchServiceSnapshot = {
  identity: { protocol: 1, daemonId: randomUUID(), hostname: "local", state: "sleeping", wakeEnabled: false },
  failure: null, daemonOrigin: null, network: null, discovery: { refreshing: false, peers: [] },
};

async function fixture() {
  const socket = new Socket();
  let create!: () => void;
  const created = new Promise<void>(resolve => { create = resolve; });
  const client = new WorkbenchServiceClient({
    endpointPath: "unused",
    read: async () => ({ version: 1, instanceId: randomUUID(), pid: 1, origin: "http://127.0.0.1:1234", token: "a".repeat(64) }),
    verify: async () => {},
    createSocket: () => { create(); return socket; },
    observe: () => () => {},
    warn: () => {},
  });
  const ready = client.start();
  await created;
  socket.message({ kind: "snapshot", snapshot });
  await ready;
  return { client, socket };
}

test("cancelling one request does not cancel another or replay either", async context => {
  const { client, socket } = await fixture();
  context.after(() => client.close());
  const cancel = new AbortController();
  const first = client.request({ method: "service/daemon/wake", retry: false }, cancel.signal);
  const second = client.request({ method: "service/daemon/wake", retry: false });
  const secondId = socket.sent[1]!.id;
  cancel.abort();
  await assert.rejects(first, { name: "AbortError" });
  socket.message({ kind: "ok", id: secondId });
  await second;
  assert.equal(socket.sent.filter(item => item.method === "service/daemon/wake").length, 2);
  assert.equal(socket.sent.filter(item => item.method === "service/request/cancel").length, 1);
});

test("connection loss rejects pending mutations rather than replaying them", async context => {
  const { client, socket } = await fixture();
  context.after(() => client.close());
  const pending = client.request({ method: "service/wake/enable", enabled: true });
  socket.close();
  await assert.rejects(pending, /closed|lost/i);
  assert.equal(socket.sent.length, 1);
});
