/*
 * No exports. Tests protect structural state from reordered partial deliveries.
 */
import assert from "node:assert/strict";
import test from "node:test";
import ThreadSidebarProjectState from "./ThreadSidebarProjectState.ts";
import { createWorkbenchProjectThreadSummary, type WorkbenchThreadActivityUpdate, type WorkbenchThreadSidebarSnapshot } from "workbench-shared/workbench/thread/thread-state";

const sidebar = (revision: number): WorkbenchThreadSidebarSnapshot => ({
  projectId: "project", revision, error: null, freshness: "fresh",
  entries: ["one", "two"].map((threadId) => ({
    entryKind: "thread", identity: { harness: "codex", threadId }, title: threadId,
    activityAt: 1, orderAt: 1,
    metadata: { archived: false, pinned: false, snoozed: false },
    lifecycle: { kind: "completed", reason: "providerInactive", settled: false },
  })),
});
const activity = (revision: number, threadId = "one", fields: Partial<WorkbenchThreadActivityUpdate> = {}): WorkbenchThreadActivityUpdate => ({
  updateKind: "activity", projectId: "project", revision, activityAt: revision,
  identity: { harness: "codex", threadId }, ...fields,
});

async function createState() {
  const state = new ThreadSidebarProjectState();
  state.acceptSidebar(sidebar(1));
  return state;
}

test("changed entries survive overtaken bootstrap and activity without erasing independent local intent", async () => {
  const state = await createState();
  const changed = sidebar(3).entries[0]!;
  changed.title = "renamed";
  const delta = {
    updateKind: "threadStateDelta" as const, projectId: "project", revision: 3,
    upserts: [changed], removedKeys: [], error: null, freshness: "fresh" as const,
  };
  state.acceptDelta(delta);
  state.acceptSidebar(sidebar(2));
  assert.equal(state.getSnapshot()!.entries.find(entry => entry.title === "renamed")?.title, "renamed");
  const local = structuredClone(state.getSnapshot()!);
  local.entries[0]!.title = "local intent";
  state.replaceLocalSidebar(local);
  state.acceptDelta({ ...delta, revision: 4, upserts: [{ ...sidebar(4).entries[1]!, title: "other change" }] });
  state.acceptActivity(activity(5, "two"));
  assert.ok(state.getSnapshot()!.entries.some(entry => entry.title === "local intent"));
  assert.ok(state.getSnapshot()!.entries.some(entry => entry.title === "other change"));
  state.acceptDelta({ ...delta, revision: 6, upserts: [], removedKeys: ["codex:one"] });
  state.acceptSidebar(sidebar(5));
  assert.equal(state.getSnapshot()!.entries.length, 1);
  state.acceptSidebar(sidebar(7));
  assert.equal(state.getSnapshot()!.entries.length, 2);
});

test("entry updates arriving before bootstrap survive the older complete response", () => {
  const state = new ThreadSidebarProjectState();
  const entry = sidebar(2).entries[0]!;
  state.acceptDelta({
    updateKind: "threadStateDelta", projectId: "project", revision: 2,
    upserts: [{ ...entry, title: "before bootstrap" }], removedKeys: [], error: null, freshness: "fresh",
  });
  state.acceptSidebar(sidebar(1));
  assert.equal(state.getSnapshot()!.entries[0]!.title, "before bootstrap");
});

test("unrelated and older draft deliveries preserve the local draft body", async () => {
  const state = await createState();
  const draft = {
    draftId: "00000000-0000-4000-8000-000000000001", projectId: "project",
    prompt: "local body", attachments: [], clientUpdatedAt: 20, createdAt: 1, updatedAt: 20, profileId: null,
    composerSettings: { harness: "codex" as const, agentPath: null, agentSource: null, model: "", reasoningEffort: null, serviceTier: null },
  };
  const entry = {
    entryKind: "draft" as const, draft, activityAt: 20, title: "local body",
    metadata: { archived: false as const, pinned: false, snoozed: false },
  };
  state.replaceLocalSidebar({ ...state.getSnapshot()!, entries: [...state.getSnapshot()!.entries, entry] });
  state.acceptDelta({
    updateKind: "threadStateDelta", projectId: "project", revision: 3, error: null, freshness: "fresh", removedKeys: [],
    upserts: [{ ...entry, draft: { ...draft, clientUpdatedAt: 10, prompt: "older body" } }, sidebar(3).entries[0]!],
  });
  assert.equal(state.getSnapshot()!.entries.find(value => value.entryKind === "draft")?.title, "local body");
  const retained = state.getSnapshot()!.entries.find(value => value.entryKind === "draft");
  assert.equal(retained?.entryKind === "draft" && retained.draft.prompt, "local body");
});
for (const change of ["title", "status", "settle", "priority"] as const) {
  test(`${change} survives a later activity update overtaking its full sidebar`, async () => {
    const state = await createState();
    const changed = sidebar(2);
    const entry = changed.entries[0]!;
    assert.equal(entry.entryKind, "thread");
    if (entry.entryKind !== "thread") throw new Error("Expected thread");
    if (change === "title") entry.title = "renamed";
    if (change === "status") entry.lifecycle = { kind: "stopped", reason: "userMarkedStopped", settled: false };
    if (change === "settle") entry.lifecycle = { kind: "completed", reason: "providerInactive", settled: true };
    if (change === "priority") entry.metadata = { archived: false, pinned: true, snoozed: false };
    state.acceptActivity(activity(3));
    state.acceptSidebar(changed);
    const actual = state.getSnapshot()!.entries.find((item) => item.entryKind !== "draft" && item.identity.threadId === "one")!;
    assert.deepEqual(actual, { ...entry, activityAt: 3 });
  });
}

test("out-of-order activity preserves each thread and independently supplied turn ordering", async () => {
  const state = await createState();
  state.acceptActivity(activity(5, "two"));
  state.acceptActivity(activity(4));
  state.acceptActivity(activity(3, "one", { orderAt: 30 }));
  state.acceptSidebar(sidebar(2));
  const entries = state.getSnapshot()!.entries;
  const one = entries.find((entry) => entry.entryKind !== "draft" && entry.identity.threadId === "one")!;
  const two = entries.find((entry) => entry.entryKind !== "draft" && entry.identity.threadId === "two")!;
  assert.equal(one.activityAt, 4);
  assert.equal(one.entryKind === "thread" ? one.orderAt : null, 30);
  assert.equal(two.activityAt, 5);
  state.acceptSidebar(sidebar(6));
  const covered = state.getSnapshot();
  state.acceptActivity(activity(3, "one", { orderAt: 300 }));
  state.acceptSidebar(sidebar(2));
  assert.equal(state.getSnapshot(), covered);
  assert.deepEqual(covered!.entries, sidebar(6).entries);
});

test("newer full summaries are not fenced out by activity from an older sidebar", async () => {
  const state = await createState();
  state.acceptActivity(activity(5));
  const changed = sidebar(3);
  changed.entries[0]!.title = "renamed";
  state.acceptSummary(createWorkbenchProjectThreadSummary("project", changed.entries, 3));
  assert.equal(state.getSummary()!.unsettledThreads.find((entry) => entry.identity.threadId === "one")!.title, "renamed");
  assert.equal(state.getSummary()!.unsettledThreads.find((entry) => entry.identity.threadId === "one")!.activityAt, 5);
  state.acceptSidebar(sidebar(2));
  assert.equal(state.getSummary()!.unsettledThreads.find((entry) => entry.identity.threadId === "one")!.title, "renamed");
  state.acceptSidebar(changed);
  assert.equal(state.getSnapshot()!.entries[0]!.title, "renamed");
});

test("complete display ordering survives later activity that does not supply ordering", async () => {
  const state = await createState();
  const pinned = sidebar(2);
  for (const entry of pinned.entries) {
    if (entry.entryKind === "thread") entry.metadata = { archived: false, pinned: true, snoozed: false };
  }
  const displayOrder = { pinned: { "codex:one": { above: ["codex:two"], below: [] } } };
  state.acceptActivity(activity(4));
  state.acceptActivity(activity(3, "two", { displayOrder }));
  state.acceptSidebar(pinned);
  assert.deepEqual(state.getSnapshot()!.displayOrder, displayOrder);
  const latest = state.getSnapshot();
  state.acceptActivity(activity(3, "two", { displayOrder }));
  assert.equal(state.getSnapshot(), latest);
});
