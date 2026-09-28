/* No production exports. Protect independent source progress, shared demand and stale-generation fencing. */
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { DaemonIdSchema, ThreadReferenceSchema } from "workbench-shared/workbench/identity";
import WorkbenchDaemonSource, { type WorkbenchDaemonTranscriptEvent } from "./WorkbenchDaemonSource";

class Socket extends EventTarget {
  readyState: number = WebSocket.CONNECTING;
  sent: Array<{ id: number; method: string; params: { subscriptionId?: string; generation?: number } }> = [];
  private readonly listeners = new Set<() => void>();
  open() { this.readyState = WebSocket.OPEN; this.dispatchEvent(new Event("open")); }
  send(payload: string) { this.sent.push(JSON.parse(payload)); for (const listener of [...this.listeners]) listener(); }
  close() { this.readyState = WebSocket.CLOSED; this.dispatchEvent(new Event("close")); }
  notify(value: object) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) })); }
  request(method: string, after = 0) {
    return new Promise<typeof this.sent[number]>(resolve => {
      const changed = () => {
        const request = this.sent.slice(after).find(item => item.method === method);
        if (!request) return;
        this.listeners.delete(changed); resolve(request);
      };
      this.listeners.add(changed); changed();
    });
  }
}

function fixture() {
  const created = Promise.withResolvers<Socket>();
  const warnings: string[] = [];
  const descriptor = {
    daemonId: DaemonIdSchema.parse(randomUUID()), hostname: "source", state: "ready" as const,
    endpoint: "ws://127.0.0.1:12345", access: true, failure: null,
  };
  const source = new WorkbenchDaemonSource(descriptor, {
    warn: message => warnings.push(message),
    createSocket: () => {
      const socket = new Socket();
      created.resolve(socket);
      return socket as unknown as WebSocket;
    },
  });
  return { source, descriptor, created: created.promise, warnings };
}

test("one stalled source cannot hold another source's shared observation", async context => {
  const a = fixture();
  const b = fixture();
  context.after(() => { a.source.dispose(); b.source.dispose(); });
  const query = { kind: "threadIdentity" as const, threadId: ThreadReferenceSchema.parse(randomUUID()) };
  const first = a.source.observe(query, () => {});
  const second = a.source.observe(query, () => {});
  const blocked = b.source.observe(query, () => {});
  const socket = await a.created;
  const opening = a.source.socket.connect();
  socket.open();
  await opening;
  const requests = socket.sent.filter(request => request.method === "workspace/observe");
  assert.equal(requests.length, 1);
  const request = requests[0]!;
  socket.notify({ id: request.id, result: {
    kind: "threadIdentity", subscriptionId: request.params.subscriptionId,
    generation: request.params.generation, revision: 1, phase: "current", failure: null, identity: null,
  } });
  // Notification publication is synchronous, independent of the unresolved RPC on B.
  socket.notify({ method: "workspace/updated", params: {
    kind: "threadIdentity", subscriptionId: request.params.subscriptionId,
    generation: request.params.generation, revision: 2, phase: "current", failure: null, identity: null,
  } });
  assert.equal(first.getSnapshot().phase, "current");
  assert.equal(second.getSnapshot().phase, "current");
  assert.equal(blocked.getSnapshot().phase, "pending");
  first.release();
  assert.equal(a.source.available, true);
  assert.equal(socket.sent.filter(request => request.method === "workspace/release").length, 0);
  second.release();
  assert.equal(a.source.hasDemand, false);
  assert.equal(socket.readyState, WebSocket.CLOSED);
  assert.deepEqual(a.warnings, []);
});

test("revocation removes usable facts and prevents late replies from restoring access", async context => {
  const fixtureValue = fixture();
  const source = fixtureValue.source;
  context.after(() => source.dispose());
  const observation = source.observe({ kind: "threadIdentity", threadId: ThreadReferenceSchema.parse(randomUUID()) }, () => {});
  const socket = await fixtureValue.created;
  const opening = source.socket.connect();
  socket.open();
  await opening;
  const request = socket.sent.find(request => request.method === "workspace/observe")!;
  const update = {
    kind: "threadIdentity", subscriptionId: request.params.subscriptionId,
    generation: request.params.generation, revision: 1, phase: "current", failure: null, identity: null,
  };
  socket.notify({ method: "workspace/updated", params: update });
  assert.equal(observation.getSnapshot().phase, "current");
  source.update({ ...fixtureValue.descriptor, access: false, endpoint: null });
  socket.notify({ method: "workspace/updated", params: { ...update, revision: 2 } });
  assert.equal(observation.getSnapshot().phase, "unavailable");
  assert.equal(observation.getSnapshot().value, null);
  await assert.rejects(source.request("models/list", { provider: "codex" }));
  assert.equal(socket.sent.filter(request => request.method === "models/list").length, 0);
});

test("matching transcript views share an upstream subscription and late joiners receive a fresh baseline", async context => {
  const f = fixture();
  context.after(() => f.source.dispose());
  const query = { threadId: randomUUID(), turnLimit: 1, toolPatchPreviews: true };
  const left: WorkbenchDaemonTranscriptEvent[] = [];
  const right: WorkbenchDaemonTranscriptEvent[] = [];
  const first = f.source.observeTranscript(query, event => left.push(event));
  const second = f.source.observeTranscript(query, event => right.push(event));
  const socket = await f.created;
  const opening = f.source.socket.connect(); socket.open(); await opening;
  const request = await socket.request("workbench/transcript/subscribe");
  assert.equal(socket.sent.filter(item => item.method === "workbench/transcript/subscribe").length, 1);
  const baseline = () => socket.notify({ method: "workbench/transcript/streamed",
    params: { subscriptionId: request.params.subscriptionId, update: { kind: "absent" } } });
  baseline();
  socket.notify({ id: request.id, result: { subscribed: true } });
  assert.equal(left.filter(event => event.kind === "transcriptStream").length, 1);
  assert.equal(right.filter(event => event.kind === "transcriptStream").length, 1);
  first.release();
  const offset = socket.sent.length;
  const late: WorkbenchDaemonTranscriptEvent[] = [];
  const third = f.source.observeTranscript(query, event => late.push(event));
  const refreshed = await socket.request("workbench/transcript/subscribe", offset);
  assert.equal(refreshed.params.subscriptionId, request.params.subscriptionId);
  baseline();
  socket.notify({ id: refreshed.id, result: { subscribed: true } });
  assert.equal(left.filter(event => event.kind === "transcriptStream").length, 1);
  assert.equal(right.filter(event => event.kind === "transcriptStream").length, 2);
  assert.equal(late.filter(event => event.kind === "transcriptStream").length, 1);
  second.release();
  assert.equal(socket.sent.some(item => item.method === "workbench/transcript/unsubscribe"), false);
  third.release();
  const released = await socket.request("workbench/transcript/unsubscribe");
  assert.equal(released.params.subscriptionId, request.params.subscriptionId);
  socket.notify({ id: released.id, result: { unsubscribed: true } });
  assert.deepEqual(f.warnings, []);
});

test("a transcript acknowledgement without a baseline becomes a scoped failure, not a resubscribe loop", async context => {
  const f = fixture();
  context.after(() => f.source.dispose());
  const failed = Promise.withResolvers<void>();
  const events: WorkbenchDaemonTranscriptEvent[] = [];
  const lease = f.source.observeTranscript({ threadId: randomUUID(), turnLimit: 1 }, event => {
    events.push(event);
    if (event.kind === "transcriptState" && event.data.phase === "failed") failed.resolve();
  });
  const socket = await f.created;
  const opening = f.source.socket.connect(); socket.open(); await opening;
  const request = await socket.request("workbench/transcript/subscribe");
  socket.notify({ id: request.id, result: { subscribed: true } });
  await failed.promise;
  assert.equal(f.source.available, true);
  assert.equal(socket.sent.filter(item => item.method === "workbench/transcript/subscribe").length, 1);
  assert.equal(f.warnings.length, 1);
  assert.ok(events.some(event => event.kind === "transcriptState" && event.data.failure));
  lease.release();
});

test("revocation fences transcript delivery without reviving it through late baseline frames", async context => {
  const f = fixture();
  context.after(() => f.source.dispose());
  const events: WorkbenchDaemonTranscriptEvent[] = [];
  f.source.observeTranscript({ threadId: randomUUID(), turnLimit: 1 }, event => events.push(event));
  const socket = await f.created;
  const opening = f.source.socket.connect(); socket.open(); await opening;
  const request = await socket.request("workbench/transcript/subscribe");
  const frame = { method: "workbench/transcript/streamed",
    params: { subscriptionId: request.params.subscriptionId, update: { kind: "absent" } } };
  socket.notify(frame);
  socket.notify({ id: request.id, result: { subscribed: true } });
  f.source.update({ ...f.descriptor, access: false, endpoint: null });
  socket.notify(frame);
  assert.equal(events.filter(event => event.kind === "transcriptStream").length, 1);
  assert.ok(events.at(-1)?.kind === "transcriptState");
  const state = events.at(-1);
  assert.equal(state?.kind === "transcriptState" ? state.data.phase : null, "unavailable");
});
