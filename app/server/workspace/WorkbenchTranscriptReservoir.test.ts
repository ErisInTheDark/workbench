/*
 * No production exports. Protect bounded transcript caching, invalidation fencing, shared refill, fairness, and disposal.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  emptyTranscriptSnapshotRows,
  type WorkbenchTranscriptPrefetchResult,
  type WorkbenchTranscriptSnapshot,
} from "workbench-shared/workbench/database/transcript/workbench-transcript-contract";
import WorkbenchTranscriptReservoir from "./WorkbenchTranscriptReservoir";

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Value>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, reject, resolve };
}

function snapshot(threadId: string, itemId?: string, text = ""): WorkbenchTranscriptSnapshot {
  const rows = emptyTranscriptSnapshotRows();
  if (itemId) {
    rows.threadItems.push({
      created_at: 1,
      id: 1,
      item_position: 0,
      public_id: itemId,
      thread_id: threadId,
      turn_id: `${threadId}-turn`,
      type: "assistantMessage",
      updated_at: 1,
    });
    rows.threadItemAssistantMessages.push({
      item_id: 1,
      item_type: "assistantMessage",
      phase: "commentary",
      state: "completed",
      text,
    });
  }
  return {
    hasPreviousTurns: false,
    loadedTurnIds: itemId ? [`${threadId}-turn`] : [],
    rows,
    thread: {
      activity_at: 1,
      archived: 0,
      created_at: 1,
      id: threadId,
      identity_origin: "workbench",
      next_turn_index: 1,
      pinned: 0,
      project_id: "project",
      project_root: "C:/project",
      snoozed: 0,
      title: threadId,
      transcript_content_version: 1,
      updated_at: 1,
    },
    turns: itemId ? [{
      created_at: 1,
      duration_ms: null,
      ended_at: null,
      harness_id: "codex",
      id: `${threadId}-turn`,
      identity_origin: "workbench",
      native_location: "C:/project",
      native_thread_id: threadId,
      native_turn_id: `${threadId}-turn`,
      started_at: 1,
      state: "completed",
      thread_id: threadId,
      turn_index: 0,
    }] : [],
  };
}

function result(threadId: string, itemId: string, text: string, hasMore = false): WorkbenchTranscriptPrefetchResult {
  const itemSnapshot = snapshot(threadId, itemId, text);
  const envelopeValue = {
    cursor: { itemId, itemPosition: 0, turnIndex: 0 },
    itemId,
    snapshot: itemSnapshot,
  };
  const envelope = { ...envelopeValue, retainedBytes: JSON.stringify(envelopeValue).length * 2 };
  return {
    catalog: snapshot(threadId),
    envelopes: [envelope],
    hasMore,
    retainedBytes: envelope.retainedBytes,
  };
}

function turnResult(itemId: string, turnIndex: number, hasMore: boolean): WorkbenchTranscriptPrefetchResult {
  const base = result("thread", itemId, itemId, hasMore);
  const envelope = base.envelopes[0]!;
  const turnId = `turn-${turnIndex}`;
  const rows = {
    ...envelope.snapshot.rows,
    threadItems: envelope.snapshot.rows.threadItems.map(item => ({ ...item, turn_id: turnId })),
  };
  const turns = envelope.snapshot.turns.map(turn => ({ ...turn, id: turnId, native_turn_id: turnId, turn_index: turnIndex }));
  return {
    ...base,
    envelopes: [{
      ...envelope,
      cursor: { ...envelope.cursor, turnIndex },
      snapshot: { ...envelope.snapshot, loadedTurnIds: [turnId], rows, turns },
    }],
  };
}

test("invalidation reopens exhausted history without losing each viewer's cursor or another thread's cache", async context => {
  const reservoir = new WorkbenchTranscriptReservoir();
  context.after(() => reservoir.dispose());
  const requests: Array<{ threadId: string; before?: { itemId: string } }> = [];
  reservoir.registerSource({
    daemonId: "daemon", generation: 1,
    prefetch: async request => {
      requests.push(request);
      const older = turnResult("older", 0, false);
      return { ...older, envelopes: [...older.envelopes, ...turnResult("newest", 1, false).envelopes] };
    },
  });
  reservoir.seed({ daemonId: "daemon", generation: 1, threadId: "thread", result: turnResult("newest", 1, false) });
  reservoir.seed({ daemonId: "daemon", generation: 1, threadId: "other", result: result("other", "other-item", "") });
  const first = reservoir.open({ consumerId: "first", daemonId: "daemon", generation: 1, threadId: "thread" });
  const second = reservoir.open({ consumerId: "second", daemonId: "daemon", generation: 1, threadId: "thread" });
  const other = reservoir.open({ consumerId: "other", daemonId: "daemon", generation: 1, threadId: "other" });
  await first.demand(1);
  await second.demand(1);
  reservoir.invalidate({ daemonId: "daemon", generation: 1, threadId: "thread" });
  const pages = await Promise.all([first.demand(1), second.demand(1)]);
  assert.deepEqual(pages.map(page => page.envelopes.map(envelope => envelope.itemId)), [["older"], ["older"]]);
  assert.equal(requests.length, 1);
  assert.deepEqual((await other.demand(1)).envelopes.map(envelope => envelope.itemId), ["other-item"]);
  assert.equal(requests.length, 1);
  assert.deepEqual((await first.demand(1)).envelopes, []);
});

for (const staleOutcome of ["success", "failure"] as const) {
  test(`invalidation fences an in-flight ${staleOutcome} before satisfying demand`, async context => {
    const reservoir = new WorkbenchTranscriptReservoir();
    context.after(() => reservoir.dispose());
    const stale = deferred<WorkbenchTranscriptPrefetchResult>();
    let calls = 0;
    reservoir.registerSource({
      daemonId: "daemon", generation: 1,
      prefetch: () => ++calls === 1 ? stale.promise : Promise.resolve(turnResult("recovered", 0, false)),
    });
    const lease = reservoir.open({ consumerId: "browser", daemonId: "daemon", generation: 1, threadId: "thread" });
    const page = lease.demand(1);
    reservoir.invalidate({ daemonId: "daemon", generation: 1, threadId: "thread" });
    if (staleOutcome === "success") stale.resolve({ catalog: snapshot("thread"), envelopes: [], hasMore: false, retainedBytes: 0 });
    else stale.reject(new Error("obsolete failure"));
    assert.deepEqual((await page).envelopes.map(envelope => envelope.itemId), ["recovered"]);
    assert.equal(calls, 2);
    assert.equal(reservoir.getDiagnostics().pendingDemands, 0);
  });
}

test("a fresh baseline seed fences an older refill without starting an unnecessary replacement", async context => {
  const reservoir = new WorkbenchTranscriptReservoir();
  context.after(() => reservoir.dispose());
  const stale = deferred<WorkbenchTranscriptPrefetchResult>();
  let calls = 0;
  reservoir.registerSource({ daemonId: "daemon", generation: 1, prefetch: () => { calls++; return stale.promise; } });
  const lease = reservoir.open({ consumerId: "browser", daemonId: "daemon", generation: 1, threadId: "thread" });
  const pending = lease.demand(1);
  reservoir.seed({ daemonId: "daemon", generation: 1, threadId: "thread", result: turnResult("fresh", 1, false) });
  assert.deepEqual((await pending).envelopes.map(envelope => envelope.itemId), ["fresh"]);
  stale.resolve(turnResult("obsolete", 0, false));
  await stale.promise;
  const next = reservoir.open({ consumerId: "next", daemonId: "daemon", generation: 1, threadId: "thread" });
  assert.deepEqual((await next.demand(2)).envelopes.map(envelope => envelope.itemId), ["fresh"]);
  assert.equal(calls, 1);
});

for (const stop of ["release", "dispose"] as const) {
  test(`invalidated demand cannot restart after ${stop}`, async context => {
    const reservoir = new WorkbenchTranscriptReservoir();
    context.after(() => reservoir.dispose());
    const stale = deferred<WorkbenchTranscriptPrefetchResult>();
    let calls = 0;
    reservoir.registerSource({
      daemonId: "daemon", generation: 1, prefetch: () => { calls++; return stale.promise; },
    });
    const lease = reservoir.open({ consumerId: "browser", daemonId: "daemon", generation: 1, threadId: "thread" });
    const pending = assert.rejects(lease.demand(1), /released/);
    reservoir.invalidate({ daemonId: "daemon", generation: 1, threadId: "thread" });
    if (stop === "release") lease.release();
    else reservoir.dispose();
    stale.resolve(turnResult("obsolete", 0, false));
    await pending;
    assert.equal(calls, 1);
    assert.equal(reservoir.getDiagnostics().pendingDemands, 0);
    assert.equal(reservoir.getDiagnostics().refillIntents, 0);
    assert.equal(reservoir.getDiagnostics().residentBytes, 0);
  });
}

test("a live seed that does not reach the cached range replaces it, so pages never skip a gap", async () => {
  const fills = [turnResult("old", 1, true), turnResult("between", 4, false)];
  const requests: unknown[] = [];
  const reservoir = new WorkbenchTranscriptReservoir({ maxBytes: 64 * 1024 });
  reservoir.registerSource({
    daemonId: "daemon",
    generation: 1,
    prefetch: async request => {
      requests.push(request.before ?? null);
      return fills.shift()!;
    },
  });
  const earlier = reservoir.open({ consumerId: "earlier", daemonId: "daemon", generation: 1, threadId: "thread" });
  assert.deepEqual((await earlier.demand(1)).envelopes.map(envelope => envelope.itemId), ["old"]);
  earlier.release();

  reservoir.seed({ daemonId: "daemon", generation: 1, replaceTurnIds: ["turn-5"], result: turnResult("live", 5, true), threadId: "thread" });
  const lease = reservoir.open({ consumerId: "browser", daemonId: "daemon", generation: 1, threadId: "thread" });
  const page = await lease.demand(2);
  assert.deepEqual(page.envelopes.map(envelope => envelope.itemId), ["between", "live"]);
  assert.deepEqual(requests[1], { itemId: "live", itemPosition: 0, turnIndex: 5 }, "refill continues below the live window");
  reservoir.dispose();
});

test("a live seed overlapping the cached range keeps the older cache", async () => {
  const fills = [turnResult("first", 0, true), turnResult("second", 1, true)];
  let prefetches = 0;
  const reservoir = new WorkbenchTranscriptReservoir({ maxBytes: 64 * 1024 });
  reservoir.registerSource({
    daemonId: "daemon",
    generation: 1,
    prefetch: async () => {
      prefetches += 1;
      return fills.pop()!;
    },
  });
  const earlier = reservoir.open({ consumerId: "earlier", daemonId: "daemon", generation: 1, threadId: "thread" });
  await earlier.demand(1);
  await earlier.demand(1);
  earlier.release();

  reservoir.seed({ daemonId: "daemon", generation: 1, replaceTurnIds: ["turn-1"], result: turnResult("second-live", 1, true), threadId: "thread" });
  const lease = reservoir.open({ consumerId: "browser", daemonId: "daemon", generation: 1, threadId: "thread" });
  assert.deepEqual((await lease.demand(2)).envelopes.map(envelope => envelope.itemId), ["first", "second-live"]);
  assert.equal(prefetches, 2);
  reservoir.dispose();
});

test("repeated demand coalesces one refill and source replacement aborts every retained owner", async () => {
  const fill = deferred<WorkbenchTranscriptPrefetchResult>();
  let calls = 0;
  let aborted = false;
  const reservoir = new WorkbenchTranscriptReservoir({ maxBytes: 64 * 1024 });
  reservoir.registerSource({
    daemonId: "daemon",
    generation: 1,
    prefetch: (_request, signal) => {
      calls += 1;
      signal.addEventListener("abort", () => { aborted = true; }, { once: true });
      return fill.promise;
    },
  });
  const lease = reservoir.open({ consumerId: "browser", daemonId: "daemon", generation: 1, threadId: "thread" });
  const first = lease.demand(1);
  const duplicate = lease.demand(1);
  assert.equal(first, duplicate);
  assert.equal(calls, 1);
  assert.equal(reservoir.getDiagnostics().pendingDemands, 1);

  reservoir.registerSource({
    daemonId: "daemon",
    generation: 2,
    prefetch: async () => result("thread", "replacement", "fresh"),
  });
  await assert.rejects(first, /generation changed/u);
  assert.equal(aborted, true);
  assert.deepEqual(reservoir.getDiagnostics(), {
    blocks: 0,
    inFlightSources: 0,
    leases: 0,
    pendingDemands: 0,
    refillIntents: 0,
    residentBytes: 0,
    reachableBytes: 0,
    sources: 1,
    threads: 0,
  });
  reservoir.dispose();
});

test("one daemon refill advances fairly between active threads without building a job queue", async () => {
  const fills = new Map<string, ReturnType<typeof deferred<WorkbenchTranscriptPrefetchResult>>>();
  const order: string[] = [];
  const reservoir = new WorkbenchTranscriptReservoir({ maxBytes: 64 * 1024 });
  reservoir.registerSource({
    daemonId: "daemon",
    generation: 1,
    prefetch: request => {
      order.push(request.threadId);
      const fill = deferred<WorkbenchTranscriptPrefetchResult>();
      fills.set(request.threadId, fill);
      return fill.promise;
    },
  });
  const busy = reservoir.open({ consumerId: "busy", daemonId: "daemon", generation: 1, threadId: "busy" });
  const waiting = reservoir.open({ consumerId: "waiting", daemonId: "daemon", generation: 1, threadId: "waiting" });
  const busyDemand = busy.demand(1);
  const waitingDemand = waiting.demand(1);
  busy.demand(10);
  assert.deepEqual(order, ["busy"]);
  assert.equal(reservoir.getDiagnostics().refillIntents, 2);

  fills.get("busy")!.resolve(result("busy", "busy-item", "busy"));
  await busyDemand;
  await new Promise<void>(resolve => queueMicrotask(resolve));
  assert.deepEqual(order, ["busy", "waiting"]);
  fills.get("waiting")!.resolve(result("waiting", "waiting-item", "waiting"));
  assert.equal((await waitingDemand).envelopes[0]?.itemId, "waiting-item");
  assert.equal(reservoir.getDiagnostics().inFlightSources, 0);
  busy.release();
  waiting.release();
  reservoir.dispose();
});

test("oversize demanded blocks replace one another and failed refills retain no promises or intents", async () => {
  let item = 0;
  let fail = false;
  const reservoir = new WorkbenchTranscriptReservoir({ maxBytes: 1_000 });
  reservoir.registerSource({
    daemonId: "daemon",
    generation: 1,
    prefetch: async request => {
      if (fail) throw new Error("refill failed");
      item += 1;
      return result(request.threadId, `item-${item}`, "x".repeat(4_000));
    },
  });
  const first = reservoir.open({ consumerId: "one", daemonId: "daemon", generation: 1, threadId: "one" });
  await first.demand(1);
  const firstState = reservoir.getDiagnostics();
  assert.equal(firstState.blocks, 1);
  assert.ok(firstState.residentBytes > 1_000);
  assert.equal(firstState.residentBytes, firstState.reachableBytes);

  const second = reservoir.open({ consumerId: "two", daemonId: "daemon", generation: 1, threadId: "two" });
  await second.demand(1);
  const replaced = reservoir.getDiagnostics();
  assert.equal(replaced.blocks, 1);
  assert.equal(replaced.threads, 1);
  assert.equal(replaced.residentBytes, replaced.reachableBytes);

  fail = true;
  const failed = reservoir.open({ consumerId: "failed", daemonId: "daemon", generation: 1, threadId: "failed" });
  await assert.rejects(failed.demand(1), /refill failed/u);
  const cleaned = reservoir.getDiagnostics();
  assert.equal(cleaned.inFlightSources, 0);
  assert.equal(cleaned.pendingDemands, 0);
  assert.equal(cleaned.refillIntents, 0);
  first.release();
  second.release();
  failed.release();
  reservoir.dispose();
});

test("subscription churn leaves no lease, demand, intent, thread, block, or byte state", () => {
  const reservoir = new WorkbenchTranscriptReservoir({ maxBytes: 64 * 1024 });
  reservoir.registerSource({
    daemonId: "daemon",
    generation: 1,
    prefetch: async () => result("thread", "unused", "unused"),
  });
  for (let index = 0; index < 5_000; index += 1) {
    reservoir.open({
      consumerId: `browser-${index}`,
      daemonId: "daemon",
      generation: 1,
      threadId: `thread-${index}`,
    }).release();
  }
  assert.deepEqual(reservoir.getDiagnostics(), {
    blocks: 0,
    inFlightSources: 0,
    leases: 0,
    pendingDemands: 0,
    refillIntents: 0,
    residentBytes: 0,
    reachableBytes: 0,
    sources: 1,
    threads: 0,
  });
  reservoir.dispose();
});
