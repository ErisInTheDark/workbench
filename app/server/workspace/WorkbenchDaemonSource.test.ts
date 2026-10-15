/* No production exports. Protect independent source progress, shared demand and stale-generation fencing. */
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { DaemonIdSchema, ProjectIdSchema, ThreadReferenceSchema, WorkbenchThreadIdSchema } from "workbench-shared/workbench/identity";
import { daemonObservationShape, type DaemonWorkspaceObservation } from "workbench-shared/workbench/workspace/workspace-observation";
import { diffObservationValue } from "workbench-shared/workbench/workspace/observation-patch";
import {
  emptyTranscriptSnapshotRows,
  type WorkbenchTranscriptSnapshot,
} from "workbench-shared/workbench/database/transcript/workbench-transcript-contract";
import WorkbenchDaemonSource, { type WorkbenchDaemonTranscriptEvent } from "./WorkbenchDaemonSource";
import WorkbenchTranscriptReservoir from "./WorkbenchTranscriptReservoir";
import WorkbenchDeliveredTranscriptWindow from "./WorkbenchDeliveredTranscriptWindow";
import { splitWorkbenchTranscriptSnapshot } from "workbench-shared/workbench/transcript/workbench-transcript-envelope";
import {
  applyTranscriptLayoutPatch, applyTranscriptStructure, type TranscriptLayout,
} from "workbench-shared/workbench/transcript/thread-transcript-stream";
import type { WorkbenchTranscriptProjection } from "workbench-shared/workbench/transcript/workbench-transcript-projection";

class Socket extends EventTarget {
  readyState: number = WebSocket.CONNECTING;
  sent: Array<{ id: number; method: string; params: {
    subscriptionId?: string; generation?: number; query?: object;
  } }> = [];
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

function fixture(transcriptReservoir?: WorkbenchTranscriptReservoir) {
  const created = Promise.withResolvers<Socket>();
  const warnings: string[] = [];
  const descriptor = {
    daemonId: DaemonIdSchema.parse(randomUUID()), hostname: "source", state: "ready" as const,
    endpoint: "ws://127.0.0.1:12345", access: true, failure: null,
  };
  const source = new WorkbenchDaemonSource(descriptor, {
    warn: message => warnings.push(message),
    ...(transcriptReservoir ? { transcriptReservoir } : {}),
    createSocket: () => {
      const socket = new Socket();
      created.resolve(socket);
      return socket as unknown as WebSocket;
    },
  });
  return { source, descriptor, created: created.promise, warnings };
}

test("socket generations register one validated reservoir prefetch edge and remove it on close", async context => {
  const reservoir = new WorkbenchTranscriptReservoir();
  const f = fixture(reservoir);
  context.after(() => { f.source.dispose(); reservoir.dispose(); });
  const release = f.source.retain();
  const socket = await f.created;
  const opening = f.source.socket.connect();
  socket.open();
  await opening;
  const generation = f.source.socket.getSnapshot().generation;
  const lease = reservoir.open({
    consumerId: "browser",
    daemonId: f.source.id,
    generation,
    threadId: "thread",
  });
  const demand = lease.demand(1);
  const request = await socket.request("workbench/transcript/prefetch");
  socket.notify({ id: request.id, result: {
    catalog: null,
    envelopes: [],
    hasMore: false,
    retainedBytes: 0,
  } });
  assert.deepEqual(await demand, {
    catalog: null,
    envelopes: [],
    hasMore: false,
    retainedBytes: 0,
  });
  socket.close();
  assert.equal(reservoir.getDiagnostics().sources, 0);
  lease.release();
  release();
});

test("a streamed live baseline refreshes the reservoir's newest end", async context => {
  const reservoir = new WorkbenchTranscriptReservoir();
  const f = fixture(reservoir);
  context.after(() => { f.source.dispose(); reservoir.dispose(); });
  const threadId = randomUUID();
  const transcript = f.source.observeTranscript({ threadId, turnLimit: 4, protocolVersion: 5, initialItemCredit: 1 }, () => {});
  const socket = await f.created;
  const opening = f.source.socket.connect(); socket.open(); await opening;
  const request = await socket.request("workbench/transcript/subscribe");
  const rows = emptyTranscriptSnapshotRows();
  rows.threadItems.push({
    created_at: 1, id: 1, item_position: 0, public_id: "live-item", thread_id: threadId, turn_id: "turn", type: "assistantMessage", updated_at: 1,
  });
  rows.itemIdentities.push({ id: "live-item", thread_id: threadId });
  rows.threadItemAssistantMessages.push({ item_id: 1, item_type: "assistantMessage", phase: "commentary", state: "completed", text: "newest" });
  const snapshot: WorkbenchTranscriptSnapshot = {
    hasPreviousTurns: true,
    loadedTurnIds: ["turn"],
    rows,
    thread: {
      activity_at: 1, archived: 0, created_at: 1, id: threadId, identity_origin: "workbench", next_turn_index: 1,
      pinned: 0, project_id: "project", project_root: "C:/project", snoozed: 0, title: "thread",
      transcript_content_version: 1, updated_at: 1,
    },
    turns: [{
      created_at: 1, duration_ms: null, ended_at: null, harness_id: "codex", id: "turn", identity_origin: "workbench",
      native_location: "C:/project", native_thread_id: threadId, native_turn_id: "turn", started_at: 1,
      state: "inProgress", thread_id: threadId, turn_index: 3,
    }],
  };
  socket.notify({ method: "workbench/transcript/streamed", params: {
    subscriptionId: request.params.subscriptionId,
    update: { kind: "structure", reset: true, snapshot, removedItemIds: [], layout: {}, hasPreviousTurns: true },
  } });
  socket.notify({ id: request.id, result: { subscribed: true } });
  assert.equal(reservoir.getDiagnostics().blocks, 1, "the live window is cached before any browser demands it");

  const lease = reservoir.open({ consumerId: "browser", daemonId: f.source.id, generation: f.source.socket.getSnapshot().generation, threadId });
  const page = await lease.demand(1);
  assert.deepEqual(page.envelopes.map(envelope => envelope.itemId), ["live-item"]);
  assert.equal(socket.sent.some(item => item.method === "workbench/transcript/prefetch"), false);
  lease.release();
  transcript.release();
});

test("recovery after an empty baseline reaches browser paging through the source and reservoir", async context => {
  const reservoir = new WorkbenchTranscriptReservoir();
  const f = fixture(reservoir);
  context.after(() => { f.source.dispose(); reservoir.dispose(); });
  const threadId = randomUUID();
  const window = new WorkbenchDeliveredTranscriptWindow();
  const browser: { layout: TranscriptLayout | null; projection: WorkbenchTranscriptProjection | null } = {
    layout: null, projection: null,
  };
  const apply = (update: ReturnType<WorkbenchDeliveredTranscriptWindow["receive"]>) => {
    if (!update) return;
    browser.layout = applyTranscriptLayoutPatch(update.reset ? null : browser.layout, update.layout);
    browser.projection = applyTranscriptStructure(update.reset ? null : browser.projection, update, browser.layout);
  };
  f.source.observeTranscript({ threadId, turnLimit: 4, protocolVersion: 5, initialItemCredit: 1 }, event => {
    if (event.kind === "transcriptStream" && event.data.update.kind === "structure") {
      apply(window.receive(event.data.update.snapshot, event.data.update.removedItemIds));
    }
  });
  const socket = await f.created;
  const opening = f.source.socket.connect(); socket.open(); await opening;
  const request = await socket.request("workbench/transcript/subscribe");
  const empty: WorkbenchTranscriptSnapshot = {
    thread: {
      activity_at: 1, archived: 0, created_at: 1, id: threadId, identity_origin: "workbench", next_turn_index: 0,
      pinned: 0, project_id: "project", project_root: "C:/project", snoozed: 0, title: "thread",
      transcript_content_version: 0, updated_at: 1,
    },
    turns: [], loadedTurnIds: [], hasPreviousTurns: false, rows: emptyTranscriptSnapshotRows(),
  };
  const notify = (snapshot: WorkbenchTranscriptSnapshot, reset: boolean) => socket.notify({
    method: "workbench/transcript/streamed",
    params: { subscriptionId: request.params.subscriptionId,
      update: { kind: "structure", reset, snapshot, removedItemIds: [], layout: {}, hasPreviousTurns: false } },
  });
  notify(empty, true);
  socket.notify({ id: request.id, result: { subscribed: true } });
  const lease = reservoir.open({ consumerId: "browser", daemonId: f.source.id,
    generation: f.source.socket.getSnapshot().generation, threadId });
  apply(window.deliver(await lease.demand(1)));
  const recovered = (index: number): WorkbenchTranscriptSnapshot => {
    const turnId = `turn-${index}`;
    const itemId = `item-${index}`;
    const rows = emptyTranscriptSnapshotRows();
    rows.itemIdentities.push({ id: itemId, thread_id: threadId });
    rows.threadItems.push({ id: index + 1, public_id: itemId, turn_id: turnId, thread_id: threadId,
      item_position: 0, type: "assistantMessage", created_at: 1, updated_at: 1 });
    rows.threadItemAssistantMessages.push({ item_id: index + 1, item_type: "assistantMessage",
      state: "completed", phase: "commentary", text: `recovered ${index}` });
    return { ...empty, rows, loadedTurnIds: [turnId], turns: [{
      id: turnId, thread_id: threadId, turn_index: index, harness_id: "codex", native_location: "C:/project",
      native_thread_id: threadId, native_turn_id: turnId, identity_origin: "workbench", created_at: 1,
      started_at: 1, ended_at: 2, duration_ms: 1, state: "completed",
    }] };
  };
  const newest = recovered(1);
  const older = recovered(0);
  notify(newest, false);
  assert.equal(browser.projection?.hasPreviousTurns, false);
  notify(older, false);
  assert.deepEqual(browser.projection?.turns.map(turn => turn.id), ["turn-1"]);
  assert.equal(browser.projection?.hasPreviousTurns, true, "recovery must reopen browser scrolling");

  const sent = socket.sent.length;
  const pending = lease.demand(2);
  assert.ok(socket.sent.slice(sent).some(value => value.method === "workbench/transcript/prefetch"),
    "the empty baseline must not permanently exhaust the reservoir");
  const prefetch = await socket.request("workbench/transcript/prefetch", sent);
  const catalog = { ...empty, turns: [...older.turns, ...newest.turns] };
  const envelopes = [older, newest].flatMap(value => splitWorkbenchTranscriptSnapshot(value).envelopes);
  socket.notify({ id: prefetch.id, result: { catalog, envelopes, hasMore: false, retainedBytes: 0 } });
  apply(window.deliver(await pending));
  assert.deepEqual(browser.projection?.turns.map(turn => turn.id), ["turn-0", "turn-1"]);
  assert.deepEqual(browser.projection?.display.orderedItems.map(item => item.itemId), ["item-0", "item-1"]);
  assert.equal(browser.projection?.hasPreviousTurns, false);
  socket.notify({ method: "workbench/transcript/streamed", params: {
    subscriptionId: request.params.subscriptionId,
    update: { kind: "structure", reset: false, snapshot: empty, removedItemIds: ["item-1"], layout: {}, hasPreviousTurns: false },
  } });
  const next = reservoir.open({ consumerId: "next", daemonId: f.source.id,
    generation: f.source.socket.getSnapshot().generation, threadId });
  const beforeRemovalRead = socket.sent.length;
  const afterRemoval = next.demand(2);
  assert.ok(socket.sent.slice(beforeRemovalRead).some(value => value.method === "workbench/transcript/prefetch"),
    "a removal must invalidate previously cached items too");
  const removalRead = await socket.request("workbench/transcript/prefetch", beforeRemovalRead);
  socket.notify({ id: removalRead.id, result: {
    catalog, envelopes: splitWorkbenchTranscriptSnapshot(older).envelopes, hasMore: false, retainedBytes: 0,
  } });
  assert.deepEqual((await afterRemoval).envelopes.map(envelope => envelope.itemId), ["item-0"]);
  assert.deepEqual(f.warnings, []);
});

test("passive reload and update status leaves sleeping daemons cold while explicit work retains them", async context => {
  const f = fixture();
  context.after(() => f.source.dispose());
  f.source.update({ ...f.descriptor, state: "sleeping" });
  const runtime = f.source.observe({ kind: "runtime" }, () => {});
  const update = f.source.observe({ kind: "update" }, () => {});
  assert.equal(f.source.socket.getSnapshot().phase, "suspended");
  const releaseWork = f.source.retain();
  const socket = await f.created;
  const opening = f.source.socket.connect();
  socket.open();
  await opening;
  assert.equal(f.source.available, true);
  releaseWork();
  assert.equal(socket.readyState, WebSocket.CLOSED);
  assert.equal(f.source.socket.getSnapshot().phase, "suspended");
  runtime.release();
  update.release();
});

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
  assert.ok(observation.getSnapshot().failure);
  const late = source.observe({ kind: "runtime" }, () => {});
  assert.equal(late.getSnapshot().phase, "unavailable");
  assert.ok(late.getSnapshot().failure);
  await assert.rejects(source.request("models/list", { provider: "codex" }));
  assert.equal(socket.sent.filter(request => request.method === "models/list").length, 0);
});

test("connection loss changes observation and transcript freshness without scoped failures", async context => {
  const f = fixture();
  context.after(() => f.source.dispose());
  const query = { kind: "threadIdentity" as const, threadId: ThreadReferenceSchema.parse(randomUUID()) };
  const retained = f.source.observe(query, () => {});
  const pending = f.source.observe({ kind: "runtime" }, () => {});
  const events: WorkbenchDaemonTranscriptEvent[] = [];
  const pendingEvents: WorkbenchDaemonTranscriptEvent[] = [];
  f.source.observeTranscript({ threadId: randomUUID(), turnLimit: 1 }, event => events.push(event));
  f.source.observeTranscript({ threadId: randomUUID(), turnLimit: 1 }, event => pendingEvents.push(event));
  const socket = await f.created;
  const opening = f.source.socket.connect(); socket.open(); await opening;
  const request = await socket.request("workspace/observe");
  socket.notify({ method: "workspace/updated", params: {
    kind: "threadIdentity", subscriptionId: request.params.subscriptionId,
    generation: request.params.generation, revision: 1, phase: "current", failure: null, identity: null,
  } });
  const transcript = await socket.request("workbench/transcript/subscribe");
  socket.notify({ method: "workbench/transcript/streamed",
    params: { subscriptionId: transcript.params.subscriptionId, update: { kind: "absent" } } });
  socket.notify({ id: transcript.id, result: { subscribed: true } });
  const value = retained.getSnapshot().value;
  assert.ok(value);
  socket.close();
  assert.deepEqual(retained.getSnapshot(), { phase: "stale", failure: null, value });
  assert.deepEqual(pending.getSnapshot(), { phase: "pending", failure: null, value: null });
  const state = events.at(-1);
  const pendingState = pendingEvents.at(-1);
  assert.ok(state?.kind === "transcriptState");
  assert.ok(pendingState?.kind === "transcriptState");
  assert.equal(state.data.phase, "stale");
  assert.equal(state.data.failure, null);
  assert.equal(pendingState.data.phase, "pending");
  assert.equal(pendingState.data.failure, null);
  assert.ok(f.source.getSnapshot().failure);

  f.source.update({ ...f.descriptor, state: "failed", failure: "Daemon startup failed." });
  assert.equal(retained.getSnapshot().failure, "Daemon startup failed.");
  assert.equal(pending.getSnapshot().failure, "Daemon startup failed.");
  const failedState = events.at(-1);
  const failedPendingState = pendingEvents.at(-1);
  assert.ok(failedState?.kind === "transcriptState");
  assert.ok(failedPendingState?.kind === "transcriptState");
  assert.equal(failedState.data.failure, "Daemon startup failed.");
  assert.equal(failedPendingState.data.failure, "Daemon startup failed.");
});

test("daemon deltas apply onto the exact first value, may arrive before it, and a gap re-observes", async context => {
  const f = fixture();
  context.after(() => f.source.dispose());
  const projectId = ProjectIdSchema.parse("project");
  const changes = new Set<() => void>();
  const handle = f.source.observe({ kind: "projectThreads", projectIds: [projectId] }, () => {
    for (const changed of [...changes]) changed();
  });
  const until = (expected: string) => new Promise<void>(resolve => {
    const changed = () => { if (title() === expected) { changes.delete(changed); resolve(); } };
    changes.add(changed); changed();
  });
  const socket = await f.created;
  const opening = f.source.socket.connect(); socket.open(); await opening;
  const request = await socket.request("workspace/observe");
  const row = (title: string) => ({
    entryKind: "thread" as const, title, activityAt: 1, waitingOnThreads: [],
    identity: { harness: "codex" as const, threadId: WorkbenchThreadIdSchema.parse("00000001-0000-4000-8000-000000000000") },
    metadata: { archived: false as const, pinned: false, snoozed: false },
    lifecycle: { kind: "needsAttention" as const, reason: "noActiveTurn" as const, settled: false as const },
  });
  const value = (revision: number, title: string): DaemonWorkspaceObservation => ({
    kind: "projectThreads", subscriptionId: request.params.subscriptionId!, generation: request.params.generation!, revision,
    phase: "current", failure: null, projects: [{ projectId, phase: "current", failure: null, sidebar: {
      projectId, revision, entries: [row(title)], freshness: "fresh", error: null, displayOrder: {}, archivedCount: 0,
    } }],
  });
  const delta = (from: DaemonWorkspaceObservation, to: DaemonWorkspaceObservation) => ({
    subscriptionId: to.subscriptionId, generation: to.generation, kind: to.kind, baseRevision: from.revision, revision: to.revision,
    delta: diffObservationValue(from, { ...to, revision: from.revision }, daemonObservationShape(to.kind))!,
  });
  const title = () => {
    const snapshot = handle.getSnapshot().value;
    return snapshot?.kind === "projectThreads" ? snapshot.projects[0]?.sidebar?.entries[0]?.title : undefined;
  };
  // The daemon publishes while the observe response is still in flight.
  socket.notify({ method: "workspace/delta", params: delta(value(1, "first"), value(2, "renamed")) });
  socket.notify({ id: request.id, result: value(1, "first") });
  await until("renamed");
  socket.notify({ method: "workspace/delta", params: delta(value(2, "renamed"), value(3, "again")) });
  assert.equal(title(), "again");
  const offset = socket.sent.length;
  socket.notify({ method: "workspace/delta", params: delta(value(7, "lost"), value(8, "gap")) });
  const reobserved = await socket.request("workspace/observe", offset);
  assert.equal(reobserved.params.subscriptionId, request.params.subscriptionId);
  assert.equal(title(), "again", "A diverged copy keeps its last good facts until the fresh value lands");
  assert.match(f.warnings.join("\n"), /projectThreads observation resync/u);
});

test("a summary batch retargets in place, sharers asking for its current ids keep it, and a daemon without retargeting gets a fresh subscription", async context => {
  const f = fixture();
  context.after(() => f.source.dispose());
  const [first, second] = ["00000001", "00000002"].map(prefix => ThreadReferenceSchema.parse(`${prefix}-0000-4000-8000-000000000000`));
  const handle = f.source.observe({ kind: "threadSummaries", threadIds: [first] }, () => {});
  const socket = await f.created;
  const opening = f.source.socket.connect(); socket.open(); await opening;
  const opened = await socket.request("workspace/observe");
  socket.notify({ id: opened.id, result: {
    kind: "threadSummaries", subscriptionId: opened.params.subscriptionId,
    generation: opened.params.generation, revision: 1, phase: "current", failure: null, summaries: {},
  } });
  const sharedOffset = socket.sent.length;
  const twin = f.source.observe({ kind: "threadSummaries", threadIds: [first] }, () => {});
  assert.doesNotThrow(() => twin.retarget({ kind: "threadSummaries", threadIds: [first] }));
  assert.throws(() => twin.retarget({ kind: "threadSummaries", threadIds: [first, second] }), /sole observer/u);
  twin.release();
  assert.equal(socket.sent.length, sharedOffset, "sharing and same-id retargets send nothing upstream");
  const offset = socket.sent.length;
  handle.retarget({ kind: "threadSummaries", threadIds: [first, second] });
  const retarget = await socket.request("workspace/retarget", offset);
  assert.equal(retarget.params.subscriptionId, opened.params.subscriptionId);

  const fallbackOffset = socket.sent.length;
  socket.notify({ id: retarget.id, error: { code: -32601, message: "Method not found" } });
  const reopened = await socket.request("workspace/observe", fallbackOffset);
  assert.notEqual(reopened.params.subscriptionId, opened.params.subscriptionId);
  assert.deepEqual(reopened.params.query, { kind: "threadSummaries", threadIds: [first, second] });
  assert.ok(socket.sent.slice(fallbackOffset).some(message => message.method === "workspace/release"
    && message.params.subscriptionId === opened.params.subscriptionId), "the old subscription is released");
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
  assert.ok(state?.kind === "transcriptState" && state.data.failure);
});
