/*
 * No exports. Protect independent streaming prefixes, commit-only publication and viewer replacement.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import { installWorkbenchDatabaseSchema } from "../workbench-database-schema.ts";
import WorkbenchTranscriptRepository from "./WorkbenchTranscriptRepository.ts";
import WorkbenchTranscriptLiveController from "./WorkbenchTranscriptLiveController.ts";
import WorkbenchTranscriptSubscriptionController from "./WorkbenchTranscriptSubscriptionController.ts";
import type { WorkbenchTranscriptAtomicObservation } from "./workbench-transcript-types.ts";
import {
  NativeThreadIdSchema, NativeTurnIdSchema, ProjectIdSchema, WorkbenchThreadIdSchema, WorkbenchTurnIdSchema,
} from "workbench-shared/workbench/identity";
import {
  applyTranscriptLayoutPatch, applyTranscriptStructure, writeTranscriptText,
  type TranscriptLayout, type TranscriptPatchUpdate, type TranscriptStreamUpdate, type TranscriptTextUpdate,
} from "workbench-shared/workbench/transcript/thread-transcript-stream";
import { projectWorkbenchTranscript, type WorkbenchTranscriptProjection } from "workbench-shared/workbench/transcript/workbench-transcript-projection";

function fixture() {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  installWorkbenchDatabaseSchema(database);
  const repository = new WorkbenchTranscriptRepository(database);
  const live = new WorkbenchTranscriptLiveController();
  repository.settle([
    {
      kind: "thread", threadId: WorkbenchThreadIdSchema.parse("thread"), projectId: ProjectIdSchema.parse("project"),
      projectRoot: "/project", title: "", activityAt: 1, createdAt: 1, updatedAt: 1,
    },
    {
      kind: "turn", threadId: WorkbenchThreadIdSchema.parse("thread"), turnId: WorkbenchTurnIdSchema.parse("turn"),
      harnessId: "codex", nativeLocation: "/project", nativeThreadId: NativeThreadIdSchema.parse("native"),
      nativeTurnId: NativeTurnIdSchema.parse("native-turn"), state: "inProgress",
      createdAt: 1, startedAt: 1, endedAt: null, durationMs: null,
    },
  ]);
  const record = (text: string, lifecycle: "streaming" | "completed" = "streaming") => {
    const observation: WorkbenchTranscriptAtomicObservation = {
      kind: "item", threadId: WorkbenchThreadIdSchema.parse("thread"), turnId: WorkbenchTurnIdSchema.parse("turn"),
      item: { type: "reasoning", id: "reasoning", summary: [text], content: [] },
      lifecycle, observedAt: 2,
    };
    live.settle(repository.settle([observation]).changes!);
  };
  const delta = (text: string): TranscriptTextUpdate => ({
    kind: "text", threadId: "thread", turnId: "turn", itemId: "reasoning",
    field: "reasoningSummary", index: 0, append: true, text,
  });
  return { database, repository, live, record, delta };
}

function viewer() {
  let projection: WorkbenchTranscriptProjection | null = null;
  let layout: TranscriptLayout | null = null;
  const events: TranscriptStreamUpdate[] = [];
  return {
    events,
    read: () => projection!,
    publish(update: TranscriptStreamUpdate) {
      events.push(update);
      if (update.kind === "structure") {
        layout = applyTranscriptLayoutPatch(update.reset ? null : layout, update.layout);
        projection = applyTranscriptStructure(projection, update, layout);
      } else if (update.kind === "text") {
        const item = projection?.turns.find(turn => turn.id === update.turnId)?.items.find(item => item.id === update.itemId);
        if (item) writeTranscriptText(item, update);
      } else if (update.kind === "patch") {
        const item = projection?.turns.find(turn => turn.id === update.turnId)?.items.find(item => item.id === update.itemId);
        if (item?.type === "fileChange") item.changes = update.changes;
      }
    },
  };
}

test("streaming before selection and between selections retains the full prefix without a durable delta write", () => {
  const { database, repository, live, record, delta } = fixture();
  try {
    record("first");
    live.acceptText(delta(" second"));
    const first = viewer();
    live.open("view", repository.read({ threadId: "thread", turnLimit: 1 }), first.publish);
    const item = first.read().turns[0]!.items[0]!;
    assert.equal(item.type, "reasoning");
    if (item.type === "reasoning") assert.deepEqual(item.summary, ["first second"]);
    live.close("view");
    const eventCount = first.events.length;
    live.acceptText(delta(" third"));
    assert.equal(first.events.length, eventCount);
    const replacement = viewer();
    live.open("view", repository.read({ threadId: "thread", turnLimit: 1 }), replacement.publish);
    const latest = replacement.read().turns[0]!.items[0]!;
    if (latest.type === "reasoning") assert.deepEqual(latest.summary, ["first second third"]);
    assert.equal(database.prepare<[], { text: string }>("SELECT text FROM thread_reasoning_sections").get()?.text, "first");
  } finally {
    live.dispose();
    database.close();
  }
});

test("text publishes only a field update and durable completion supersedes the transient prefix", () => {
  const { database, repository, live, record, delta } = fixture();
  try {
    record("first");
    const active = viewer();
    live.open("view", repository.read({ threadId: "thread", turnLimit: 1 }), active.publish);
    active.events.length = 0;
    live.acceptText(delta(" streamed"));
    assert.deepEqual(active.events.map(event => event.kind), ["text"]);
    record("canonical final", "completed");
    const completed = active.read().turns[0]!.items[0]!;
    if (completed.type === "reasoning") assert.deepEqual(completed.summary, ["canonical final"]);
    const reopened = viewer();
    live.open("view", repository.read({ threadId: "thread", turnLimit: 1 }), reopened.publish);
    assert.deepEqual(reopened.events.map(event => event.kind), ["structure"]);
  } finally {
    live.dispose();
    database.close();
  }
});

test("plan completion replaces its streamed prefix even though the plan table has no lifecycle column", () => {
  const { database, repository, live } = fixture();
  const recordPlan = (text: string, lifecycle: "streaming" | "completed") => live.settle(repository.settle([{
    kind: "item", threadId: WorkbenchThreadIdSchema.parse("thread"), turnId: WorkbenchTurnIdSchema.parse("turn"),
    item: { type: "plan", id: "plan", text }, lifecycle, observedAt: 2,
  }]).changes!);
  try {
    recordPlan("draft", "streaming");
    const active = viewer();
    live.open("view", repository.read({ threadId: "thread", turnLimit: 1 }), active.publish);
    live.acceptText({
      kind: "text", threadId: "thread", turnId: "turn", itemId: "plan",
      field: "planText", index: null, append: true, text: " streamed",
    });
    recordPlan("final", "completed");
    const item = active.read().turns[0]!.items[0]!;
    assert.equal(item.type, "plan");
    if (item.type === "plan") assert.equal(item.text, "final");
  } finally {
    live.dispose();
    database.close();
  }
});

test("subscription bootstrap shares event order and structural settlement does not reread its window", async () => {
  const { database, repository, live, record, delta } = fixture();
  let queue = Promise.resolve();
  const ordered = (operation: () => Promise<void>) => {
    const result = queue.then(operation);
    queue = result;
    return result;
  };
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const reading = new Promise<void>(resolve => { started = resolve; });
  let readCount = 0;
  const failures: unknown[] = [];
  const subscriptions = new WorkbenchTranscriptSubscriptionController(async () => {
    readCount++;
    const snapshot = repository.read({ threadId: "thread", turnLimit: 1 });
    started();
    await held;
    return snapshot;
  }, error => failures.push(error), { controller: live, runOrdered: ordered });
  try {
    record("prefix");
    const active = viewer();
    const subscribed = subscriptions.subscribe({
      id: "view", request: { threadId: "thread", turnLimit: 1 },
      publish: () => assert.fail("incremental subscriptions must not publish legacy snapshots"),
      publishStream: active.publish,
    });
    await reading;
    const streamed = ordered(async () => { live.acceptText(delta(" suffix")); });
    release();
    await subscribed;
    await streamed;
    const item = active.read().turns[0]!.items[0]!;
    if (item.type === "reasoning") assert.deepEqual(item.summary, ["prefix suffix"]);
    await ordered(async () => { record("completed", "completed"); subscriptions.settle(["thread"]); });
    assert.equal(readCount, 1);
    assert.deepEqual(failures, []);
  } finally {
    subscriptions.dispose();
    database.close();
  }
});

test("an absent baseline becomes readable on later settlement without changing selections", async () => {
  const { database, repository, live, record } = fixture();
  let queue = Promise.resolve();
  const ordered = (operation: () => Promise<void>) => {
    queue = queue.then(operation);
    return queue;
  };
  let available = false;
  const subscriptions = new WorkbenchTranscriptSubscriptionController(
    async () => available ? repository.read({ threadId: "thread", turnLimit: 1 }) : null,
    error => assert.fail(String(error)), { controller: live, runOrdered: ordered },
  );
  try {
    const active = viewer();
    await subscriptions.subscribe({
      id: "view", request: { threadId: "thread", turnLimit: 1 },
      publish: () => assert.fail("not a legacy snapshot"),
      publishStream: active.publish,
    });
    assert.deepEqual(active.events.map(event => event.kind), ["absent"]);
    available = true;
    record("now available");
    subscriptions.settle(["thread"]);
    await queue;
    assert.ok(active.read(), "a later commit must resolve an absent baseline");
  } finally {
    subscriptions.dispose();
    database.close();
  }
});

test("a fresh live owner seeds its prefix from the baseline before later deltas and reselection", () => {
  const { database, repository, live, record, delta } = fixture();
  const restarted = new WorkbenchTranscriptLiveController();
  try {
    record("durable prefix");
    const first = viewer();
    restarted.open("view", repository.read({ threadId: "thread", turnLimit: 1 }), first.publish);
    restarted.acceptText(delta(" suffix"));
    restarted.close("view");
    const next = viewer();
    restarted.open("view", repository.read({ threadId: "thread", turnLimit: 1 }), next.publish);
    const item = next.read().turns[0]!.items[0]!;
    if (item.type === "reasoning") assert.deepEqual(item.summary, ["durable prefix suffix"]);
  } finally {
    restarted.dispose();
    live.dispose();
    database.close();
  }
});

for (const openBeforePatch of [true, false]) {
test(`pre-admission patches stream ${openBeforePatch ? "to an attached viewer" : "on first opening mid-patch"} without durable bodies`, () => {
  const { database, repository, live, record } = fixture();
  const events: TranscriptStreamUpdate[] = [];
  const patch: TranscriptPatchUpdate = {
    kind: "patch", threadId: "thread", turnId: "turn", itemId: "preview",
    changes: [{ path: "first.ts", kind: { type: "add" }, diff: "+first" }],
  };
  const open = () => live.open("view", repository.read({ threadId: "thread", turnLimit: 1 }), event => events.push(event));
  const patches = () => events.filter(event => event.kind === "patch");
  try {
    if (openBeforePatch) open();
    live.acceptLiveUpdate(patch);
    const grown = { ...patch, changes: [...patch.changes, { path: "second.ts", kind: { type: "add" as const }, diff: "+second" }] };
    live.acceptLiveUpdate(grown);
    if (!openBeforePatch) open();
    assert.deepEqual(patches().at(-1), grown, "The latest preview must not wait for item/started");
    if (openBeforePatch) assert.deepEqual(patches(), [patch, grown]);
    record("historical baseline refresh");
    assert.deepEqual(patches().at(-1), grown, "A snapshot is not new activity");
    live.close("view");
    const finalPreview = { ...grown, changes: [{ ...grown.changes[0]!, diff: "+first\n+more" }, grown.changes[1]!] };
    live.acceptLiveUpdate(finalPreview);
    open();
    assert.deepEqual(patches().at(-1), finalPreview, "Reopening must replay the full latest preview");
    assert.equal(database.prepare<[], { count: number }>("SELECT count(*) AS count FROM thread_item_file_changes").get()!.count, 0);
    assert.equal(database.prepare<[], { count: number }>("SELECT count(*) AS count FROM thread_file_changes").get()!.count, 0);
  } finally {
    live.dispose();
    database.close();
  }
});
}

for (const attached of [false, true]) {
test(`later text retires the patch ${attached ? "while attached" : "without a viewer"} and reopening cannot revive it`, () => {
  const { database, repository, live, record, delta } = fixture();
  const events: TranscriptStreamUpdate[] = [];
  const patch: TranscriptPatchUpdate = {
    kind: "patch", threadId: "thread", turnId: "turn", itemId: "orphan",
    changes: [{ path: "file.ts", kind: { type: "add" }, diff: "+draft" }],
  };
  const open = () => live.open("view", repository.read({ threadId: "thread", turnLimit: 1 }), event => events.push(event));
  try {
    record("existing");
    if (attached) open();
    live.acceptLiveUpdate(patch);
    live.acceptText(delta(" later activity"));
    if (attached) assert.deepEqual(events.filter(event => event.kind === "patch").at(-1), { ...patch, changes: [] });
    live.close("view");
    events.length = 0;
    open();
    assert.deepEqual(events.filter(event => event.kind === "patch"), []);
  } finally {
    live.dispose();
    database.close();
  }
});
}

test("another patch replaces the accumulation, while another thread's text does not retire it", () => {
  const { database, repository, live, delta } = fixture();
  const events: TranscriptStreamUpdate[] = [];
  const patch: TranscriptPatchUpdate = {
    kind: "patch", threadId: "thread", turnId: "turn", itemId: "first",
    changes: [{ path: "file.ts", kind: { type: "add" }, diff: "+draft" }],
  };
  const next = { ...patch, itemId: "second" };
  try {
    live.open("view", repository.read({ threadId: "thread", turnLimit: 1 }), event => events.push(event));
    live.acceptLiveUpdate(patch);
    live.acceptLiveUpdate(next);
    assert.deepEqual(events.filter(event => event.kind === "patch"), [patch, { ...patch, changes: [] }, next]);
    live.acceptText({ ...delta("other activity"), threadId: "other" });
    live.close("view");
    events.length = 0;
    live.open("view", repository.read({ threadId: "thread", turnLimit: 1 }), event => events.push(event));
    assert.deepEqual(events.filter(event => event.kind === "patch"), [next]);
    live.acceptLiveUpdate({ ...next, changes: [] });
    events.length = 0;
    live.open("view", repository.read({ threadId: "thread", turnLimit: 1 }), event => events.push(event));
    assert.deepEqual(events.filter(event => event.kind === "patch"), []);
  } finally {
    live.dispose();
    database.close();
  }
});

test("a failed viewer withdrawal is reported without retaining the preview or blocking other viewers", () => {
  const { database, repository, live } = fixture();
  const failures: unknown[] = [];
  const owner = new WorkbenchTranscriptLiveController(error => failures.push(error));
  const events: TranscriptStreamUpdate[] = [];
  const failure = new Error("viewer unavailable");
  const patch: TranscriptPatchUpdate = {
    kind: "patch", threadId: "thread", turnId: "turn", itemId: "orphan",
    changes: [{ path: "file.ts", kind: { type: "add" }, diff: "+draft" }],
  };
  try {
    const snapshot = repository.read({ threadId: "thread", turnLimit: 1 });
    owner.open("failed", snapshot, event => {
      if (event.kind === "patch" && !event.changes.length) throw failure;
    });
    owner.open("healthy", snapshot, event => events.push(event));
    owner.acceptLiveUpdate(patch);
    owner.acceptActivity("thread");
    assert.deepEqual(failures, [failure]);
    assert.deepEqual(events.at(-1), { ...patch, changes: [] });
    events.length = 0;
    owner.open("healthy", snapshot, event => events.push(event));
    assert.deepEqual(events.filter(event => event.kind === "patch"), []);
  } finally {
    owner.dispose();
    live.dispose();
    database.close();
  }
});

test("preview delivery stays in its loaded turn and terminal settlement clears retained previews", () => {
  const { database, repository, live } = fixture();
  const selected: TranscriptStreamUpdate[] = [];
  const unloaded: TranscriptStreamUpdate[] = [];
  const patch: TranscriptPatchUpdate = {
    kind: "patch", threadId: "thread", turnId: "turn", itemId: "preview",
    changes: [{ path: "file.ts", kind: { type: "add" }, diff: "+first" }],
  };
  try {
    const snapshot = repository.read({ threadId: "thread", turnLimit: 1 })!;
    live.open("selected", snapshot, event => selected.push(event));
    live.open("unloaded", { ...snapshot, loadedTurnIds: [] }, event => unloaded.push(event));
    live.acceptLiveUpdate({ ...patch, threadId: "another-thread" });
    live.acceptLiveUpdate({ ...patch, turnId: "another-turn" });
    live.acceptLiveUpdate(patch);
    assert.deepEqual(selected.filter(event => event.kind === "patch"), [patch]);
    assert.deepEqual(unloaded.filter(event => event.kind === "patch"), []);
    live.settle(repository.settle([{
      kind: "turn", threadId: WorkbenchThreadIdSchema.parse("thread"), turnId: WorkbenchTurnIdSchema.parse("turn"),
      harnessId: "codex", nativeLocation: "/project", nativeThreadId: NativeThreadIdSchema.parse("native"),
      nativeTurnId: NativeTurnIdSchema.parse("native-turn"), state: "interrupted",
      createdAt: 1, startedAt: 1, endedAt: 3, durationMs: 2,
    }]).changes!);
    selected.length = 0;
    live.acceptLiveUpdate(patch);
    live.open("selected", repository.read({ threadId: "thread", turnLimit: 1 }), event => selected.push(event));
    assert.deepEqual(selected.filter(event => event.kind === "patch"), [], "Late or retained previews must not revive an interrupted turn");
  } finally {
    live.dispose();
    database.close();
  }
});

test("live patches survive selection changes without durable writes and completion replaces them", () => {
  const { database, repository, live } = fixture();
  const recordPatch = (completed: boolean, replaceLiveText = false) => live.settle(repository.settle([{
    kind: "item", threadId: WorkbenchThreadIdSchema.parse("thread"), turnId: WorkbenchTurnIdSchema.parse("turn"),
    item: { type: "fileChange", id: "patch", status: completed ? "completed" : "inProgress", changes: [] },
    lifecycle: completed ? "completed" : "streaming", observedAt: 2,
  }]).changes!, { replaceLiveText });
  try {
    recordPatch(false);
    live.acceptLiveUpdate({
      kind: "patch", threadId: "thread", turnId: "turn", itemId: "patch",
      changes: [{ path: "file.ts", diff: "+new", kind: { type: "add" } }],
    });
    const active = viewer();
    live.open("view", repository.read({ threadId: "thread", turnLimit: 1 }), active.publish);
    const item = active.read().turns[0]!.items[0]!;
    assert.equal(item.type, "fileChange");
    if (item.type === "fileChange") assert.equal(item.changes.length, 1);
    assert.equal(database.prepare<[], { count: number }>("SELECT count(*) AS count FROM thread_file_changes").get()!.count, 0);
    recordPatch(false, true);
    const refreshed = active.read().turns[0]!.items[0]!;
    assert.ok(refreshed.type === "fileChange");
    assert.equal(refreshed.changes.length, 1, "A historical refresh must not erase a newer live patch");
    recordPatch(true);
    const final = active.read().turns[0]!.items[0]!;
    if (final.type === "fileChange") assert.deepEqual(final.changes, []);
  } finally {
    live.dispose();
    database.close();
  }
});

test("a cold owner joins pre-baseline deltas to the durable prefix exactly once", () => {
  const { database, repository, live, record, delta } = fixture();
  const restarted = new WorkbenchTranscriptLiveController();
  try {
    record("durable");
    restarted.acceptText(delta(" suffix"));
    const active = viewer();
    restarted.open("view", repository.read({ threadId: "thread", turnLimit: 1 }), active.publish);
    const item = active.read().turns[0]!.items[0]!;
    assert.equal(item.type, "reasoning");
    if (item.type === "reasoning") assert.deepEqual(item.summary, ["durable suffix"]);
    restarted.open("view", repository.read({ threadId: "thread", turnLimit: 1 }), active.publish);
    const reopened = active.read().turns[0]!.items[0]!;
    if (reopened.type === "reasoning") assert.deepEqual(reopened.summary, ["durable suffix"]);
  } finally {
    restarted.dispose();
    live.dispose();
    database.close();
  }
});

test("interaction and Browse commits update an attached view without another baseline", () => {
  const { database, repository, live, record } = fixture();
  const threadId = WorkbenchThreadIdSchema.parse("thread");
  const turnId = WorkbenchTurnIdSchema.parse("turn");
  const facts: WorkbenchTranscriptAtomicObservation[] = [
    {
      kind: "questionnaire", observedAt: 4,
      entry: {
        threadId, turnId, itemId: "questionnaire", requestKey: "request",
        insertAfterItemId: null, insertAfterItemIndex: null, resolvedAt: 4,
        request: { id: "request", title: "", summary: "", submitLabel: "", questions: [] },
        response: { answers: {} },
      },
    },
    {
      kind: "steer", observedAt: 5,
      entry: {
        threadId, turnId, attemptedAt: 3, canonicalItemId: null, clientUserMessageId: "client",
        entryKey: "steer", error: null, input: [{ type: "text", text: "preserve this", text_elements: [] }],
        requestId: "steer", resolvedAt: 5, status: "interrupted",
      },
    },
    {
      kind: "browse",
      entry: {
        threadId, turnId, action: "snapshot", actionIndex: 0, assetUrl: null, commandItemId: null,
        detailKind: "text", detailLabel: "snapshot", detailText: "captured", durationMs: 1,
        entryKey: "browse", recordedAt: 6, session: "session", state: "completed",
      },
    },
  ];
  try {
    record("existing", "completed");
    const active = viewer();
    live.open("view", repository.read({ threadId, turnLimit: 1 }), active.publish);
    active.events.length = 0;
    for (const fact of facts) {
      live.settle(repository.settle([fact]).changes!);
      const fresh = projectWorkbenchTranscript(repository.read({ threadId, turnLimit: 1 })!);
      assert.ok(fresh.success);
      assert.deepEqual(active.read().turns, fresh.data.turns);
      assert.deepEqual(active.read().browseResultEntries, fresh.data.browseResultEntries);
      assert.deepEqual(active.read().display, fresh.data.display);
    }
    assert.ok(active.events.every(event => event.kind !== "structure" || !event.reset));
  } finally {
    live.dispose();
    database.close();
  }
});

test("a new reasoning section is not appended again by later structural publications", () => {
  const { database, repository, live, record, delta } = fixture();
  try {
    record("first section");
    const active = viewer();
    live.open("view", repository.read({ threadId: "thread", turnLimit: 1 }), active.publish);
    live.acceptText({ ...delta("second section"), index: 1 });
    for (const text of ["draft", "revised"]) live.settle(repository.settle([{
      kind: "item", threadId: WorkbenchThreadIdSchema.parse("thread"), turnId: WorkbenchTurnIdSchema.parse("turn"),
      item: { type: "plan", id: "other", text }, lifecycle: "streaming", observedAt: 3,
    }]).changes!);
    const item = active.read().turns[0]!.items[0]!;
    assert.equal(item.type, "reasoning");
    if (item.type === "reasoning") assert.deepEqual(item.summary, ["first section", "second section"]);
  } finally {
    live.dispose();
    database.close();
  }
});

test("provider rereads extend active text without erasing deltas admitted after the read began", () => {
  const { database, repository, live, record, delta } = fixture();
  const reread = (text: string) => live.settle(repository.settle([{
    kind: "item", threadId: WorkbenchThreadIdSchema.parse("thread"), turnId: WorkbenchTurnIdSchema.parse("turn"),
    item: { type: "reasoning", id: "reasoning", summary: [text], content: [] },
    lifecycle: "streaming", observedAt: 3,
  }]).changes!, { replaceLiveText: true });
  try {
    record("prefix");
    const active = viewer();
    live.open("view", repository.read({ threadId: "thread", turnLimit: 1 }), active.publish);
    live.acceptText(delta(" suffix"));
    reread("prefix");
    const retained = active.read().turns[0]!.items[0]!;
    if (retained.type === "reasoning") assert.deepEqual(retained.summary, ["prefix suffix"]);
    reread("prefix suffix recovered");
    const recovered = active.read().turns[0]!.items[0]!;
    if (recovered.type === "reasoning") assert.deepEqual(recovered.summary, ["prefix suffix recovered"]);
  } finally {
    live.dispose();
    database.close();
  }
});
