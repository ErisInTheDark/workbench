/*
 * No production exports. Tests protect SQL publication, local inputs and subscription lifecycles.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { ThreadPayload } from "workbench-shared/types";
import { WorkbenchThreadIdSchema } from "workbench-shared/workbench/identity";
import { withWorkbenchTurnAdmission } from "workbench-shared/workbench/thread/thread-admission";
import { getWorkbenchInputState } from "workbench-shared/workbench/thread/thread-input-item";
import { applySteerHistoryToThread, isWorkbenchPendingSteerUserMessage } from "workbench-shared/workbench/thread/thread-steer-history";
import ThreadOptimisticInputStore from "../thread/ThreadOptimisticInputStore";
import {
  transcriptSnapshotTables,
  type WorkbenchTranscriptSnapshot,
  type WorkbenchTranscriptSnapshotRows,
  type WorkbenchTranscriptSubscribeParams,
} from "workbench-shared/workbench/database/transcript/workbench-transcript-contract";
import ThreadTranscriptProjectionController from "./ThreadTranscriptProjectionController";
import type { ThreadTranscriptProjectionState } from "./ThreadTranscriptProjectionController";
import { projectWorkbenchTranscript } from "workbench-shared/workbench/transcript/workbench-transcript-projection";
import {
  createTranscriptLayout, createTranscriptLayoutPatch, type TranscriptPatchUpdate, type TranscriptStreamUpdate,
} from "workbench-shared/workbench/transcript/thread-transcript-stream";

function flush() {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

function thread(id: string, turnIds = ["turn"]): Extract<ThreadPayload, { isDraft: false }> {
  return {
    agentNickname: null,
    agentPath: null,
    agentRole: null,
    browseResultEntries: [],
    createdAt: 1,
    cwd: "C:/project",
    harness: "codex",
    id: WorkbenchThreadIdSchema.parse(id),
    isDraft: false,
    model: null,
    name: "Thread",
    path: null,
    preview: "Thread",
    reasoningEffort: null,
    serviceTier: null,
    source: "app-server",
    status: "completed",
    tokenUsage: null,
    turnHistory: turnIds.map((turnId) => ({
      completedAt: 2,
      durationMs: 1_000,
      itemCount: 1,
      itemIds: [`plan:${turnId}`],
      itemTimeline: [],
      loadState: "loaded" as const,
      startedAt: 1,
      status: "completed",
      turnId,
    })),
    turns: turnIds.map((turnId) => ({
      completedAt: 2,
      durationMs: 1_000,
      error: null,
      id: turnId,
      items: [{ id: `plan:${turnId}`, text: "planned", type: "plan" as const }],
      itemsView: "full" as const,
      startedAt: 1,
      status: "completed" as const,
    })),
    updatedAt: 2,
  };
}

function emptyRows(): WorkbenchTranscriptSnapshotRows {
  return Object.fromEntries(
    Object.keys(transcriptSnapshotTables).map((name) => [name, []]),
  ) as unknown as WorkbenchTranscriptSnapshotRows;
}

function emptySnapshot(threadId: string): WorkbenchTranscriptSnapshot {
  return {
    hasPreviousTurns: false,
    loadedTurnIds: [],
    rows: emptyRows(),
    thread: {
      activity_at: 2_000,
      archived: 0,
      created_at: 1_000,
      id: threadId,
      identity_origin: "legacy",
      next_turn_index: 0,
      pinned: 0,
      project_id: "project",
      project_root: "C:/project",
      snoozed: 0,
      title: "Thread",
      transcript_content_version: 1,
      updated_at: 2_000,
    },
    turns: [],
  };
}

function streamBaseline(threadId: string): TranscriptStreamUpdate {
  const snapshot = emptySnapshot(threadId);
  snapshot.turns = [{
    id: "turn", identity_origin: "legacy", thread_id: threadId, turn_index: 0, harness_id: "codex",
    native_location: "C:/project", native_thread_id: threadId, native_turn_id: "turn", state: "inProgress",
    created_at: 1, started_at: 1, ended_at: null, duration_ms: null,
  }];
  snapshot.loadedTurnIds = ["turn"];
  snapshot.rows.threadItems = [{
    id: 1, public_id: null, source_id: "plan:turn", thread_id: threadId, turn_id: "turn",
    item_position: 0, type: "plan", created_at: 1, updated_at: 1,
  }];
  snapshot.rows.threadItemPlans = [{ item_id: 1, item_type: "plan", text: "stored" }];
  const projected = projectWorkbenchTranscript(snapshot);
  assert.ok(projected.success);
  return {
    kind: "structure", reset: true, snapshot, removedItemIds: [], hasPreviousTurns: false,
    layout: createTranscriptLayoutPatch(null, createTranscriptLayout(projected.data)),
  };
}

function patchBaseline(
  status: "inProgress" | "completed" | "failed" = "inProgress",
  previous?: WorkbenchTranscriptSnapshot,
) {
  const update = streamBaseline("thread");
  assert.ok(update.kind === "structure");
  update.snapshot.rows.threadItems.push({
    ...update.snapshot.rows.threadItems[0]!, id: 2, source_id: "patch", item_position: 1, type: "fileChange",
  });
  update.snapshot.rows.threadItemFileChanges.push({
    item_id: 2, item_type: "fileChange", state: status, error_text: null,
    workbench_failure_kind: null, workbench_policy: null, recovery_state: null, recovery_detail: null,
  });
  const projection = projectWorkbenchTranscript(update.snapshot);
  assert.ok(projection.success);
  const previousProjection = previous ? projectWorkbenchTranscript(previous) : null;
  if (previousProjection) assert.ok(previousProjection.success);
  update.reset = !previous;
  update.layout = createTranscriptLayoutPatch(
    previousProjection ? createTranscriptLayout(previousProjection.data) : null,
    createTranscriptLayout(projection.data),
  );
  return update;
}

async function patchViewer() {
  const states: ThreadTranscriptProjectionState[] = [];
  const errors: Error[] = [];
  let receive!: (update: TranscriptStreamUpdate) => void;
  const controller = new ThreadTranscriptProjectionController({
    available: true, turnLimit: 4,
    onStateChange: state => states.push(state), onError: error => errors.push(error),
    transcripts: {
      unsubscribe: async () => {},
      subscribe: async (_params, _snapshot, stream) => { receive = stream!; },
    },
  });
  controller.select({ thread: thread("thread") });
  await flush();
  return {
    controller, states, errors,
    receive: (update: TranscriptStreamUpdate) => receive(update),
    projection: () => {
      const state = states.at(-1)!;
      assert.ok(state.status === "ready");
      return state.projection;
    },
    patch: (diff: string, itemId = "patch"): TranscriptPatchUpdate => ({
      kind: "patch", threadId: "thread", turnId: "turn", itemId,
      changes: [{ path: "file.ts", kind: { type: "add" }, diff }],
    }),
  };
}

test("patch previews appear before admission, grow immutably and become one canonical item", async () => {
  const view = await patchViewer();
  const fileItems = () => view.projection().turns[0]!.items.filter(item => item.type === "fileChange");
  try {
    const baseline = streamBaseline("thread");
    assert.ok(baseline.kind === "structure");
    view.receive(baseline);
    view.receive(view.patch("+first"));
    assert.deepEqual(fileItems().map(item => item.changes[0]?.diff), ["+first"]);
    assert.deepEqual(view.errors, []);
    const first = view.projection();
    const grown = view.patch("+first\n+second");
    grown.changes.push({ path: "second.ts", kind: { type: "add" }, diff: "+another file" });
    view.receive(grown);
    assert.deepEqual(fileItems()[0]!.changes, grown.changes);
    const previous = first.turns[0]!.items.find(item => item.type === "fileChange");
    assert.ok(previous?.type === "fileChange");
    assert.deepEqual(previous.changes.map(change => change.diff), ["+first"], "Previously published snapshots must not change under subscribers");
    assert.equal(view.projection().display.orderedItems.some(item => item.itemId === "patch"), false);
    assert.equal(view.projection().display.segments.flatMap(segment => segment.items).filter(item => item.id === "patch").length, 1);

    const unrelated = streamBaseline("thread");
    assert.ok(unrelated.kind === "structure");
    unrelated.reset = false;
    unrelated.layout = {};
    unrelated.snapshot.rows = emptyRows();
    view.receive(unrelated);
    assert.deepEqual(fileItems()[0]!.changes, grown.changes, "Historical structure does not withdraw the current preview");

    const source = thread("thread");
    source.turns[0] = { ...source.turns[0]!, status: "inProgress" };
    const inputs = ThreadOptimisticInputStore({ now: () => 42 });
    const steer = inputs.enqueueSteer(source, "turn", [{ type: "text", text: "keep this input", text_elements: [] }]);
    view.controller.select({ thread: inputs.apply(source, []) });
    assert.deepEqual(fileItems()[0]!.changes, grown.changes);
    const admitted = patchBaseline("inProgress", baseline.snapshot);
    view.receive(admitted);
    view.receive(grown);
    assert.equal(fileItems().length, 1);
    assert.equal(view.projection().display.orderedItems.filter(item => item.itemId === "patch").length, 1);
    assert.equal(view.projection().display.segments.flatMap(segment => segment.items).filter(item => item.id === "patch").length, 1);
    view.receive(patchBaseline("completed", admitted.snapshot));
    assert.equal(fileItems().length, 1);
    assert.equal(fileItems()[0]!.status, "completed");
    assert.deepEqual(fileItems()[0]!.changes, []);
    const retainedSteer = view.projection().turns[0]!.items.find(item => item.id === steer.handle);
    assert.ok(retainedSteer?.type === "userMessage");
    assert.equal(getWorkbenchInputState(retainedSteer)?.status, "pending");
    assert.equal(view.projection().display.segments.flatMap(segment => segment.items).filter(item => item.id === steer.handle).length, 1);
    assert.deepEqual(view.errors, []);
  } finally { await view.controller.dispose(); }
});

test("server withdrawal removes only the transient tail and preserves canonical changes and local input", async () => {
  const view = await patchViewer();
  try {
    view.receive(patchBaseline());
    view.receive(view.patch("+canonical"));
    const source = thread("thread");
    source.turns[0] = { ...source.turns[0]!, status: "inProgress" };
    const inputs = ThreadOptimisticInputStore({ now: () => 42 });
    const steer = inputs.enqueueSteer(source, "turn", [{ type: "text", text: "keep input", text_elements: [] }]);
    view.controller.select({ thread: inputs.apply(source, []) });
    const draft = view.patch("+draft", "preview");
    view.receive(draft);
    view.receive({ ...draft, changes: [] });
    assert.equal(view.projection().turns[0]!.items.some(item => item.id === "preview"), false);
    assert.equal(view.projection().display.segments.flatMap(segment => segment.items).some(item => item.id === "preview"), false);
    view.receive({ ...view.patch(""), changes: [] });
    const canonical = view.projection().turns[0]!.items.find(item => item.id === "patch");
    assert.ok(canonical?.type === "fileChange");
    assert.equal(canonical.changes[0]?.diff, "+canonical");
    assert.ok(view.projection().turns[0]!.items.some(item => item.id === steer.handle));
    assert.deepEqual(view.errors, []);
  } finally { await view.controller.dispose(); }
});

test("replacing the transient tail cannot accumulate orphaned previews", async () => {
  const view = await patchViewer();
  try {
    view.receive(streamBaseline("thread"));
    view.receive(view.patch("+first", "first"));
    view.receive(view.patch("+second", "second"));
    assert.deepEqual(view.projection().turns[0]!.items.filter(item => item.type === "fileChange").map(item => item.id), ["second"]);
    view.receive({ ...view.patch("", "first"), changes: [] });
    assert.deepEqual(view.projection().turns[0]!.items.filter(item => item.type === "fileChange").map(item => item.id), ["second"]);
    assert.deepEqual(view.errors, []);
  } finally { await view.controller.dispose(); }
});

test("patches to admitted items notify with fresh snapshots and preserve final failures", async () => {
  const view = await patchViewer();
  try {
    view.receive(patchBaseline());
    const before = view.projection();
    view.receive(view.patch("+first"));
    assert.notDeepEqual(view.projection(), before, "The thread owner's equality guard must see the patch");
    const item = before.turns[0]!.items.find(item => item.type === "fileChange");
    assert.ok(item?.type === "fileChange");
    assert.deepEqual(item.changes, []);
    const first = view.projection();
    view.receive(view.patch("+first\n+second"));
    assert.notDeepEqual(view.projection(), first);
    view.receive(patchBaseline("failed"));
    const failed = view.projection().turns[0]!.items.find(item => item.type === "fileChange");
    assert.ok(failed?.type === "fileChange");
    assert.equal(failed.status, "failed");
    assert.deepEqual(failed.changes, []);
    assert.deepEqual(view.errors, []);
  } finally { await view.controller.dispose(); }
});

for (const boundary of ["completed", "interrupted", "failed", "removed", "reset", "selection", "disconnect", "dispose"] as const) {
test(`unadmitted previews are cleared on ${boundary}`, async () => {
  const view = await patchViewer();
  try {
    view.receive(streamBaseline("thread"));
    view.receive(view.patch("+preview"));
    assert.ok(view.projection().turns[0]!.items.some(item => item.id === "patch"));
    if (boundary === "selection") {
      view.controller.select({ thread: thread("other") });
      await flush();
      view.receive(streamBaseline("other"));
    } else if (boundary === "disconnect") {
      view.controller.setAvailable(false);
      view.controller.setAvailable(true);
      await flush();
      view.receive(streamBaseline("thread"));
    } else if (boundary === "dispose") {
      await view.controller.dispose();
      view.receive(view.patch("+late"));
      assert.equal(view.states.at(-1)?.status, "idle");
      return;
    } else {
      const update = streamBaseline("thread");
      assert.ok(update.kind === "structure");
      if (boundary !== "reset") {
        update.reset = false;
        update.layout = {};
        update.snapshot.rows = emptyRows();
        if (boundary === "removed") update.removedItemIds = ["patch"];
        else update.snapshot.turns[0] = { ...update.snapshot.turns[0]!, state: boundary };
      }
      view.receive(update);
    }
    assert.equal(view.projection().turns.flatMap(turn => turn.items).some(item => item.id === "patch"), false);
    assert.equal(view.projection().display.segments.flatMap(segment => segment.items).some(item => item.id === "patch"), false);
    assert.deepEqual(view.errors, []);
  } finally { await view.controller.dispose(); }
});
}

for (const correlation of ["item", "client"] as const) {
  test(`incremental SQL retains local steers until canonical ${correlation} delivery`, async () => {
    const states: ThreadTranscriptProjectionState[] = [];
    const errors: Error[] = [];
    let receive!: (update: TranscriptStreamUpdate) => void;
    let subscriptions = 0;
    const controller = new ThreadTranscriptProjectionController({
      available: true, turnLimit: 4,
      onStateChange: state => states.push(state), onError: error => errors.push(error),
      transcripts: {
        unsubscribe: async () => {},
        subscribe: async (_params, _snapshot, stream) => { subscriptions++; receive = stream!; },
      },
    });
    const source = thread("thread");
    source.turns[0] = { ...source.turns[0]!, status: "inProgress" };
    const inputs = ThreadOptimisticInputStore({ now: () => 42 });
    const select = () => controller.select({ thread: inputs.apply(source, []) });
    const projection = () => {
      const state = states.at(-1)!;
      assert.ok(state.status === "ready");
      return state.projection;
    };
    const inputStates = () => projection().turns[0]!.items.map(item => item.type === "userMessage" ? getWorkbenchInputState(item) : null);
    try {
      select();
      await flush();
      receive(streamBaseline("thread"));
      const canonicalSegment = projection().display.segments[0]!.id;
      const first = inputs.enqueueSteer(source, "turn", [{ type: "text", text: "same", text_elements: [] }]);
      const second = inputs.enqueueSteer(source, "turn", [{ type: "text", text: "same", text_elements: [] }]);
      select();
      assert.deepEqual(projection().turns[0]!.items.map(item => item.id), ["plan:turn", first.handle, second.handle]);
      assert.ok(projection().turns[0]!.items.slice(1).every(item => item.type === "userMessage" && isWorkbenchPendingSteerUserMessage(item)));
      assert.deepEqual(projection().display.segments.flatMap(segment => segment.items.map(item => item.id)),
        ["plan:turn", first.handle, second.handle]);
      assert.equal(projection().display.segments[0]!.id, canonicalSegment);
      assert.equal(projection().turns[0]!.itemTimeline.find(entry => entry.itemId === first.handle)?.firstSeenAt, 42);
      const pendingHistory = [{
        threadId: source.id, turnId: "turn", entryKey: first.handle, itemId: first.handle,
        clientUserMessageId: first.handle, canonicalItemId: null, input: first.input,
        status: "pending" as const, attemptedAt: 42, resolvedAt: null, error: null, requestId: null,
      }];
      controller.select({
        thread: inputs.apply(applySteerHistoryToThread(source, pendingHistory), pendingHistory),
      });
      assert.deepEqual(projection().turns[0]!.items.map(item => item.id), ["plan:turn", first.handle, second.handle]);
      assert.ok(projection().turns[0]!.items.slice(1).every(item => item.type === "userMessage" && isWorkbenchPendingSteerUserMessage(item)));
      assert.ok(inputs.movePending(first.handle, "turn"));
      select();
      assert.equal(inputStates()[1]?.status, "pending", "Admission is not delivery");
      const publications = states.length;
      receive({ kind: "text", threadId: "thread", turnId: "turn", itemId: "plan:turn",
        field: "planText", index: null, text: " delta", append: true });
      select();
      assert.equal(states.length, publications, "Provider text must not republish local input");
      receive(streamBaseline("thread"));
      assert.deepEqual(projection().turns[0]!.items.map(item => item.id), ["plan:turn", first.handle, second.handle]);
      const unsent = correlation === "item" ? "failed" : "interrupted";
      inputs.transition(second.handle, unsent);
      select();
      assert.equal(inputStates()[2]?.status, unsent);

      const delivered = streamBaseline("thread");
      assert.ok(delivered.kind === "structure");
      const deliveredId = correlation === "item" ? first.handle : "delivered";
      delivered.snapshot.rows.threadItems.push({
        ...delivered.snapshot.rows.threadItems[0]!, id: 2, source_id: deliveredId, item_position: 1, type: "userMessage",
      });
      delivered.snapshot.rows.threadItemUserMessages.push({
        item_id: 2, item_type: "userMessage", input_kind: "steer", delivery_state: "delivered",
        client_id: correlation === "client" ? first.handle : null, error_text: null,
      });
      delivered.snapshot.rows.threadUserMessageParts.push({
        item_id: 2, part_index: 0, part_type: "text", text: "same", url: null, path: null, name: null, image_detail: null,
      });
      const canonical = projectWorkbenchTranscript(delivered.snapshot);
      assert.ok(canonical.success);
      delivered.layout = createTranscriptLayoutPatch(null, createTranscriptLayout(canonical.data));
      receive(delivered);
      assert.deepEqual(projection().turns[0]!.items.map(item => item.id), ["plan:turn", deliveredId, second.handle]);
      assert.equal(inputStates()[1]?.status, "sent");
      assert.deepEqual(projection().display.orderedItems.map(item => item.itemId), ["plan:turn", deliveredId]);
      assert.equal(subscriptions, 1, "Local input changes must not resubscribe");

      const retained = applySteerHistoryToThread(source, [{
        threadId: source.id, turnId: "turn", entryKey: second.handle, itemId: second.handle,
        clientUserMessageId: second.handle, canonicalItemId: null, input: second.input,
        status: unsent, attemptedAt: 42, resolvedAt: 43, error: null, requestId: null,
      }]);
      controller.select({ thread: retained });
      assert.equal(inputStates().at(-1)?.status, unsent);
      controller.select({ thread: source });
      assert.deepEqual(projection().turns[0]!.items.map(item => item.id), ["plan:turn", deliveredId], "Removing local state must remove its presentation");
      controller.select({ thread: thread("other") });
      await flush();
      receive(streamBaseline("other"));
      assert.deepEqual(projection().turns[0]!.items.map(item => item.id), ["plan:turn"]);
      assert.deepEqual(errors, []);
    } finally { await controller.dispose(); }
  });
}

test("incremental SQL never reconciles provider-live state and text does not republish the tree", async () => {
  const states: ThreadTranscriptProjectionState[] = [];
  const text: string[] = [];
  const errors: Error[] = [];
  let receive!: (update: TranscriptStreamUpdate) => void;
  let subscriptions = 0;
  const controller = new ThreadTranscriptProjectionController({
    available: true, turnLimit: 4,
    onStateChange: state => states.push(state),
    onText: (_update, value) => text.push(value),
    onError: error => errors.push(error),
    transcripts: {
      unsubscribe: async () => {},
      subscribe: async (_params, _snapshot, stream) => { subscriptions++; receive = stream!; },
    },
  });
  try {
    controller.select({ thread: thread("thread") });
    await flush();
    receive(streamBaseline("thread"));
    const count = states.length;
    receive({ kind: "text", threadId: "thread", turnId: "turn", itemId: "plan:turn",
      field: "planText", index: null, append: true, text: " delta" });
    controller.select({ thread: thread("thread") });
    assert.deepEqual(text, ["stored delta"]);
    assert.equal(states.length, count);
    assert.deepEqual(errors, []);
    controller.select({ thread: thread("thread", ["turn", "next"]) });
    await flush();
    assert.equal(subscriptions, 1, "new live turns arrive on the existing stream");
    const obsolete = receive;
    controller.select({ thread: thread("other") });
    await flush();
    receive(streamBaseline("other"));
    obsolete({ kind: "text", threadId: "thread", turnId: "turn", itemId: "plan:turn",
      field: "planText", index: null, append: true, text: " stale" });
    assert.deepEqual(text, ["stored delta"]);
  } finally {
    await controller.dispose();
  }
});

test("an initial same-thread snapshot remains usable while its replacement window loads", async () => {
  const states: ThreadTranscriptProjectionState[] = [];
  const pending: Array<{ publish: (snapshot: WorkbenchTranscriptSnapshot | null) => void; finish: () => void }> = [];
  const controller = new ThreadTranscriptProjectionController({
    available: true, turnLimit: 4,
    onStateChange: state => { states.push(state); },
    transcripts: {
      unsubscribe: async () => {},
      subscribe: async (_params, publish) => new Promise<void>(finish => { pending.push({ publish, finish }); }),
    },
  });
  try {
    controller.select({ thread: thread("one", ["first"]) });
    await flush();
    controller.select({ thread: thread("one", ["first", "second"]) });
    pending[0]!.publish(emptySnapshot("one"));
    const interim = states.at(-1)!;
    assert.equal(interim.status, "loading");
    assert.ok("projection" in interim && interim.projection);
    controller.select({ thread: thread("one", ["first", "second"]) });
    assert.equal(states.at(-1)!.status, "loading");
    pending[0]!.finish();
    await flush();
    const newer: WorkbenchTranscriptSnapshot = { ...emptySnapshot("one"), thread: { ...emptySnapshot("one").thread, title: "Newer" } };
    pending[1]!.publish(newer);
    assert.equal(states.at(-1)!.status, "ready");
    const accepted = states.at(-1);
    pending[0]!.publish(emptySnapshot("one"));
    assert.equal(states.at(-1), accepted);
    controller.select({ thread: thread("two") });
    pending[1]!.publish(newer);
    const switched = states.at(-1)!;
    assert.ok("projection" in switched && switched.projection === null);
    controller.setAvailable(false);
    pending[1]!.publish(emptySnapshot("two"));
    assert.equal(states.at(-1)!.status, "unavailable");
  } finally {
    for (const request of pending) request.finish();
    await controller.dispose();
  }
});

test("independent thread projections use distinct subscriptions and dispose only their own stream", async () => {
  const subscriptions: WorkbenchTranscriptSubscribeParams[] = [];
  const released: string[] = [];
  let accepted!: () => void;
  const opened = new Promise<void>(resolve => { accepted = resolve; });
  let closed!: () => void;
  const closing = new Promise<void>(resolve => { closed = resolve; });
  const transcripts = {
    subscribe: async (params: WorkbenchTranscriptSubscribeParams) => {
      subscriptions.push(params);
      if (subscriptions.length === 2) accepted();
    },
    unsubscribe: async ({ subscriptionId }: { subscriptionId: string }) => { released.push(subscriptionId); closed(); },
  };
  const first = new ThreadTranscriptProjectionController({ available: true, transcripts, turnLimit: 4 });
  const second = new ThreadTranscriptProjectionController({ available: true, transcripts, turnLimit: 4 });
  first.select({ thread: thread("first") });
  second.select({ thread: thread("second") });
  await opened;
  assert.notEqual(subscriptions[0]?.subscriptionId, subscriptions[1]?.subscriptionId);
  first.dispose();
  await closing;
  assert.deepEqual(released, [subscriptions[0]?.subscriptionId]);
  second.dispose();
});

test("disposal releases the active stream even when a replacement is already queued", async () => {
  const subscriptions: string[] = [];
  const releases: string[] = [];
  let accepted!: () => void;
  const ready = new Promise<void>(resolve => { accepted = resolve; });
  const controller = new ThreadTranscriptProjectionController({
    available: true, turnLimit: 4,
    transcripts: {
      subscribe: async ({ subscriptionId }) => { subscriptions.push(subscriptionId); accepted(); },
      unsubscribe: async ({ subscriptionId }) => { releases.push(subscriptionId); },
    },
  });
  controller.select({ thread: thread("first") });
  await ready;
  controller.select({ thread: thread("second") });
  await controller.dispose();
  assert.equal(subscriptions.length, 1);
  assert.deepEqual(releases, subscriptions);
});

test("selection changes serialize unsubscribe before the replacement subscription", async () => {
  const events: string[] = [];
  const subscriptions: string[] = [];
  const controller = new ThreadTranscriptProjectionController({
    available: true,
    transcripts: {
      subscribe: async (params) => { subscriptions.push(params.subscriptionId); events.push(`subscribe:${params.threadId}`); },
      unsubscribe: async (params) => { events.push(`unsubscribe:${params.subscriptionId}`); },
    },
    turnLimit: 4,
  });

  controller.select({ thread: thread("one") });
  await flush();
  controller.select({ thread: thread("two") });
  await flush();
  await flush();

  assert.equal(events[0], "subscribe:one");
  assert.equal(events[1], `unsubscribe:${subscriptions[0]}`);
  assert.equal(events[2], "subscribe:two");
  controller.dispose();
});

test("a failed subscription reports immediately without poisoning replacement work", async () => {
  const errors: Error[] = [];
  const failure = new Error("subscription failed");
  const events: string[] = [];
  const states: string[] = [];
  let subscriptions = 0;
  let firstSubscriptionId = "";
  const controller = new ThreadTranscriptProjectionController({
    available: true,
    onError: (error) => { errors.push(error); },
    onStateChange: (state) => { states.push(state.status); },
    transcripts: {
      subscribe: async (params) => {
        subscriptions += 1;
        if (subscriptions === 1) firstSubscriptionId = params.subscriptionId;
        events.push(`subscribe:${params.threadId}`);
        if (subscriptions === 1) throw failure;
      },
      unsubscribe: async (params) => { events.push(`unsubscribe:${params.subscriptionId}`); },
    },
    turnLimit: 4,
  });

  controller.select({ thread: thread("one") });
  await flush();
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.cause, failure);
  assert.equal(states.at(-1), "failed");

  controller.select({ thread: thread("two") });
  await flush();
  await flush();
  assert.deepEqual(events, [
    "subscribe:one",
    `unsubscribe:${firstSubscriptionId}`,
    "subscribe:two",
  ]);
  controller.dispose();
});

test("disposal owns an in-flight subscription failure without reporting it", async () => {
  const errors: Error[] = [];
  let rejectSubscription: ((error: Error) => void) | null = null;
  const controller = new ThreadTranscriptProjectionController({
    available: true,
    onError: (error) => { errors.push(error); },
    transcripts: {
      subscribe: async () => await new Promise<void>((_resolve, reject) => {
        rejectSubscription = reject;
      }),
      unsubscribe: async () => undefined,
    },
    turnLimit: 4,
  });

  controller.select({ thread: thread("one") });
  await flush();
  assert.ok(rejectSubscription);
  controller.dispose();
  (rejectSubscription as (error: Error) => void)(new Error("socket closed during disposal"));
  await flush();

  assert.deepEqual(errors, []);
});

test("reconciled projections publish and real invalidations clear the browser read model", async () => {
  const listeners = new Map<string, (snapshot: WorkbenchTranscriptSnapshot | null) => void>();
  const publications: Array<{ status: string; threadId: string | null }> = [];
  const controller = new ThreadTranscriptProjectionController({
    available: true,
    onError: () => undefined,
    onStateChange: (state) => {
      publications.push({
        status: state.status,
        threadId: "threadId" in state ? state.threadId : null,
      });
    },
    transcripts: {
      subscribe: async (params, listener) => { listeners.set(params.subscriptionId, listener); },
      unsubscribe: async (params) => { listeners.delete(params.subscriptionId); },
    },
    turnLimit: 4,
  });

  controller.select({ thread: thread("one") });
  await flush();
  [...listeners.values()][0]?.(emptySnapshot("one"));
  await flush();
  assert.deepEqual(publications.at(-1), { status: "ready", threadId: "one" });

  [...listeners.values()][0]?.(null);
  assert.deepEqual(publications.at(-1), { status: "absent", threadId: "one" });

  controller.select({ thread: thread("two") });
  assert.deepEqual(publications.at(-1), { status: "loading", threadId: "two" });
  await flush();
  [...listeners.values()][0]?.(emptySnapshot("two"));
  await flush();
  assert.deepEqual(publications.at(-1), { status: "ready", threadId: "two" });

  controller.setAvailable(false);
  assert.deepEqual(publications.at(-1), { status: "unavailable", threadId: "two" });
  controller.setAvailable(true);
  assert.deepEqual(publications.at(-1), { status: "loading", threadId: "two" });
  await flush();
  controller.dispose();
  assert.deepEqual(publications.at(-1), { status: "idle", threadId: null });
});

test("malformed SQL data becomes a source-local failure", async () => {
  const listeners = new Map<string, (snapshot: WorkbenchTranscriptSnapshot | null) => void>();
  const states: Array<{ message?: string; status: string }> = [];
  const controller = new ThreadTranscriptProjectionController({
    available: true,
    onError: () => undefined,
    onStateChange: (state) => {
      states.push({
        ...("message" in state ? { message: state.message } : {}),
        status: state.status,
      });
    },
    transcripts: {
      subscribe: async (params, listener) => { listeners.set(params.subscriptionId, listener); },
      unsubscribe: async (params) => { listeners.delete(params.subscriptionId); },
    },
    turnLimit: 4,
  });

  controller.select({ thread: thread("thread") });
  await flush();
  const invalid = emptySnapshot("thread");
  invalid.rows.threadItems.push({
    id: 1, public_id: null, source_id: "orphan", thread_id: "thread", turn_id: "missing", type: "plan",
    item_position: 0, created_at: 1, updated_at: 1,
  });
  [...listeners.values()][0]?.(invalid);

  assert.deepEqual(states.at(-1), {
    message: "SQLite transcript data could not be projected.",
    status: "failed",
  });
  controller.dispose();
});

test("same-thread loaded-turn changes retain the previous SQL projection", async () => {
  const listeners = new Map<string, (snapshot: WorkbenchTranscriptSnapshot | null) => void>();
  const publications: Array<string | null> = [];
  const controller = new ThreadTranscriptProjectionController({
    available: true,
    onStateChange: (state) => {
      publications.push("projection" in state ? state.projection?.thread.title ?? null : null);
    },
    transcripts: {
      subscribe: async (params, listener) => { listeners.set(params.subscriptionId, listener); },
      unsubscribe: async (params) => { listeners.delete(params.subscriptionId); },
    },
    turnLimit: 4,
  });

  controller.select({ thread: thread("thread", ["turn-1"]) });
  await flush();
  [...listeners.values()][0]?.(emptySnapshot("thread"));
  await flush();
  const priorTitle = publications.at(-1);
  assert.ok(priorTitle);

  controller.select({ thread: thread("thread", ["turn-1", "turn-2"]) });
  assert.equal(publications.at(-1), priorTitle);
  controller.dispose();
});

test("the subscription follows the exact loaded turns and replaces itself when that set changes", async () => {
  const events: Array<
    | { kind: "subscribe"; params: WorkbenchTranscriptSubscribeParams }
    | { kind: "unsubscribe"; subscriptionId: string }
  > = [];
  const controller = new ThreadTranscriptProjectionController({
    available: true,
    transcripts: {
      subscribe: async (params) => { events.push({ kind: "subscribe", params }); },
      unsubscribe: async ({ subscriptionId }) => { events.push({ kind: "unsubscribe", subscriptionId }); },
    },
    turnLimit: 4,
  });

  controller.select({ thread: thread("thread", ["turn-2"]) });
  await flush();
  controller.select({ thread: thread("thread", ["turn-1", "turn-2"]) });
  await flush();
  await flush();

  const first = events[0];
  const replacement = events[2];
  assert.equal(first?.kind, "subscribe");
  assert.equal(replacement?.kind, "subscribe");
  if (first?.kind !== "subscribe" || replacement?.kind !== "subscribe") return;
  assert.notEqual(first.params.subscriptionId, replacement.params.subscriptionId);
  assert.deepEqual(events, [
    {
      kind: "subscribe",
      params: {
        subscriptionId: first.params.subscriptionId,
        threadId: "thread",
        turnIds: ["turn-2"],
        turnLimit: 4,
      },
    },
    { kind: "unsubscribe", subscriptionId: first.params.subscriptionId },
    {
      kind: "subscribe",
      params: {
        subscriptionId: replacement.params.subscriptionId,
        threadId: "thread",
        turnIds: ["turn-1", "turn-2"],
        turnLimit: 4,
      },
    },
  ]);
  controller.dispose();
});

for (const incremental of [false, true]) {
test(`a connecting turn stays visible outside durable scope with incremental=${incremental}`, async () => {
  const listeners = new Map<string, (snapshot: WorkbenchTranscriptSnapshot | null) => void>();
  const subscriptions: WorkbenchTranscriptSubscribeParams[] = [];
  const readyTurnIds: string[][] = [];
  const controller = new ThreadTranscriptProjectionController({
    available: true,
    onStateChange: (state) => {
      if ("projection" in state && state.projection) {
        readyTurnIds.push(state.projection.turns.map(({ id }) => id));
      }
    },
    transcripts: {
      subscribe: async (params, listener, stream) => {
        subscriptions.push(params);
        listeners.set(params.subscriptionId, snapshot => {
          if (!incremental || !snapshot) return listener(snapshot);
          const projected = projectWorkbenchTranscript(snapshot);
          assert.ok(projected.success);
          stream!({
            kind: "structure", reset: true, snapshot, removedItemIds: [], hasPreviousTurns: false,
            layout: createTranscriptLayoutPatch(null, createTranscriptLayout(projected.data)),
          });
        });
      },
      unsubscribe: async ({ subscriptionId }) => { listeners.delete(subscriptionId); },
    },
    turnLimit: 4,
  });
  const connectingId = "af798e44-f0a4-46b7-b249-ae89388806cc";
  const connecting = thread("thread", [connectingId]);
  connecting.status = "active";
  connecting.turns[0] = withWorkbenchTurnAdmission({
    ...connecting.turns[0]!,
    completedAt: null,
    durationMs: null,
    status: "inProgress",
  }, "connecting");
  connecting.turnHistory[0] = {
    ...connecting.turnHistory[0]!,
    completedAt: null,
    durationMs: null,
    status: "inProgress",
  };

  controller.select({ thread: connecting });
  await flush();
  assert.deepEqual(subscriptions[0]?.turnIds, []);
  listeners.get(subscriptions[0]!.subscriptionId)?.(emptySnapshot("thread"));
  assert.deepEqual(readyTurnIds.at(-1), [connectingId]);

  const admitted = thread("thread", ["provider-turn"]);
  admitted.status = "active";
  admitted.turns[0] = {
    ...admitted.turns[0]!,
    completedAt: null,
    durationMs: null,
    status: "inProgress",
  };
  controller.select({ thread: admitted });
  await flush();
  await flush();
  assert.deepEqual(subscriptions.at(-1)?.turnIds, incremental ? [] : ["provider-turn"]);
  controller.dispose();
});
}

test("selection stays inert until capability and reconnect capability creates a fresh subscription", async () => {
  const events: string[] = [];
  const states: string[] = [];
  const controller = new ThreadTranscriptProjectionController({
    onStateChange: (state) => { states.push(state.status); },
    transcripts: {
      subscribe: async (params) => { events.push(`subscribe:${params.subscriptionId}`); },
      unsubscribe: async (params) => { events.push(`unsubscribe:${params.subscriptionId}`); },
    },
    turnLimit: 4,
  });

  controller.select({ thread: thread("thread") });
  await flush();
  assert.equal(events.length, 0);
  assert.equal(states.at(-1), "loading");

  controller.setAvailable(true);
  await flush();
  assert.equal(events.length, 1);
  assert.ok(events[0]?.startsWith("subscribe:"));

  controller.setAvailable(false);
  assert.equal(states.at(-1), "unavailable");
  controller.setAvailable(true);
  await flush();
  await flush();
  assert.equal(events.length, 2);
  assert.ok(events[1]?.startsWith("subscribe:"));
  assert.notEqual(events[0], events[1]);
  controller.dispose();
});

