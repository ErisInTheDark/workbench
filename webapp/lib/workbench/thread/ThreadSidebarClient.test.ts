/* No production exports. Tests protect subscriptions, optimistic draft queues, revisions, and leave-safe flushing. */
import assert from "node:assert/strict";
import test from "node:test";
import ThreadSidebarClient from "./ThreadSidebarClient.ts";
import type { WorkbenchThreadDraft, WorkbenchThreadSidebarSnapshot } from "./thread-state.ts";

const draft = (prompt: string, clientUpdatedAt: number): WorkbenchThreadDraft => ({
  agent: null, attachments: [], clientUpdatedAt, composerSettings: {}, createdAt: 1,
  draftId: "00000000-0000-4000-8000-000000000001", harness: "codex", model: null,
  profileId: null, projectId: "project", prompt, reasoningEffort: null, serviceTier: null, updatedAt: clientUpdatedAt,
});
const snapshot = (revision: number): WorkbenchThreadSidebarSnapshot => ({ entries: [], error: null, freshness: "fresh", projectId: "project", revision });

test("optimistic edits keep the newest value through one single-flight flush", async () => {
  const writes: WorkbenchThreadDraft[] = [];
  let releaseFirst: (() => void) | null = null;
  const first = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const client = new ThreadSidebarClient({
    onChange: () => undefined,
    transport: {
      close: async () => undefined,
      deleteDraft: async () => undefined,
      open: async () => snapshot(1),
      upsertDraft: async (_projectId, value) => { writes.push(value); if (writes.length === 1) await first; },
    },
  });
  await client.open("project");
  client.edit(draft("first value here", 2));
  const flushing = client.flush();
  await new Promise((resolve) => setTimeout(resolve, 0));
  client.edit(draft("newest value here", 3));
  releaseFirst?.();
  await flushing;
  await client.flush();
  assert.deepEqual(writes.map((value) => value.prompt), ["first value here", "newest value here"]);
});

test("optimistic draft edits preserve pushed pin and snooze metadata", async () => {
  const source = draft("keep priority", 1);
  const initial: WorkbenchThreadSidebarSnapshot = {
    ...snapshot(1),
    entries: [{ activityAt: 1, draft: source, entryKind: "draft", metadata: { archived: false, pinned: true, snoozed: true }, title: "keep priority" }],
  };
  const client = new ThreadSidebarClient({
    onChange: () => undefined,
    transport: { close: async () => undefined, deleteDraft: async () => undefined, open: async () => initial, upsertDraft: async () => undefined },
  });
  await client.open("project");
  client.edit(draft("keep newer priority", 2));
  const optimistic = client.getSnapshot()?.entries[0];
  assert.deepEqual(optimistic?.entryKind === "draft" ? optimistic.metadata : null, { archived: false, pinned: true, snoozed: true });
});

test("folder draft creation is optimistic, carries one placement write, and transfers pinned membership on materialization", async () => {
  const folderId = "00000000-0000-4000-8000-000000000010";
  const source = {
    activityAt: 1,
    entryKind: "thread" as const,
    identity: { harness: "codex" as const, threadId: "source" },
    lifecycle: { kind: "completed" as const, reason: "providerInactive" as const, settled: false },
    metadata: { archived: false as const, pinned: true, snoozed: false },
    orderAt: 1,
    title: "source",
  };
  const initial: WorkbenchThreadSidebarSnapshot = {
    ...snapshot(1),
    displayOrder: { folders: [{ folderId, section: "pinned", threadKeys: ["codex:source"], title: "Work" }] },
    entries: [source],
  };
  const placements: Array<string | undefined> = [];
  const client = new ThreadSidebarClient({
    onChange: () => undefined,
    transport: {
      close: async () => undefined,
      deleteDraft: async () => undefined,
      open: async () => initial,
      upsertDraft: async (_projectId, _draft, placement) => { placements.push(placement); },
    },
  });
  await client.open("project");
  const pending = draft("folder draft", 2);
  client.edit(pending, { folderId });
  const optimistic = client.getSnapshot();
  const optimisticDraft = optimistic?.entries.find((entry) => entry.entryKind === "draft");
  assert.deepEqual(optimisticDraft?.entryKind === "draft" ? optimisticDraft.metadata : null, { archived: false, pinned: true, snoozed: false });
  assert.deepEqual(optimistic?.displayOrder?.folders?.[0]?.threadKeys, [`draft:${pending.draftId}`, "codex:source"]);
  await client.flush();
  assert.deepEqual(placements, [folderId]);
  await client.acceptIntent({ draftId: pending.draftId, identity: { harness: "codex", threadId: "materialized" }, title: "Materialized", turnId: "turn" });
  assert.deepEqual(client.getSnapshot()?.displayOrder?.folders?.[0]?.threadKeys, ["codex:materialized", "codex:source"]);
});

test("newer pushed revisions win and foreign project revisions are ignored", async () => {
  const installed: Array<WorkbenchThreadSidebarSnapshot | null> = [];
  const client = new ThreadSidebarClient({
    onChange: (value) => installed.push(value),
    transport: { close: async () => undefined, deleteDraft: async () => undefined, open: async () => snapshot(2), upsertDraft: async () => undefined },
  });
  await client.open("project");
  client.accept(snapshot(1));
  client.accept({ ...snapshot(3), projectId: "other" });
  client.accept(snapshot(3));
  assert.deepEqual(installed.map((value) => value?.revision), [2, 3]);
});

test("activity updates preserve turn order until a new turn-start order arrives", async () => {
  const installed: Array<WorkbenchThreadSidebarSnapshot | null> = [];
  const entry = (threadId: string, activityAt: number, orderAt: number): WorkbenchThreadSidebarSnapshot["entries"][number] => ({
    activityAt,
    entryKind: "thread",
    identity: { harness: "codex", threadId },
    lifecycle: { kind: "completed", reason: "providerInactive", settled: false },
    metadata: { archived: false, pinned: false, snoozed: false },
    orderAt,
    title: threadId,
  });
  const initial: WorkbenchThreadSidebarSnapshot = {
    ...snapshot(1),
    entries: [entry("newer-turn", 2, 20), entry("older-turn", 1, 10)],
  };
  const client = new ThreadSidebarClient({
    onChange: (value) => installed.push(value),
    transport: { close: async () => undefined, deleteDraft: async () => undefined, open: async () => initial, upsertDraft: async () => undefined },
  });
  await client.open("project");
  client.acceptActivity({ activityAt: 50, identity: { harness: "codex", threadId: "older-turn" }, projectId: "project", revision: 2, updateKind: "activity" });
  assert.deepEqual(installed.at(-1)?.entries.map((candidate) => candidate.entryKind === "thread" ? candidate.identity.threadId : ""), ["newer-turn", "older-turn"]);
  client.acceptActivity({ activityAt: 60, identity: { harness: "codex", threadId: "older-turn" }, orderAt: 30, projectId: "project", revision: 3, updateKind: "activity" });
  assert.deepEqual(installed.at(-1)?.entries.map((candidate) => candidate.entryKind === "thread" ? candidate.identity.threadId : ""), ["older-turn", "newer-turn"]);
  client.acceptActivity({ activityAt: 70, identity: { harness: "codex", threadId: "newer-turn" }, projectId: "project", revision: 4, updateKind: "activity" });
  assert.deepEqual(installed.at(-1)?.entries.map((candidate) => candidate.entryKind === "thread" ? candidate.identity.threadId : ""), ["older-turn", "newer-turn"]);
});

test("activity updates project pinned rows through durable user ordering", async () => {
  const entry = (threadId: string, orderAt: number): WorkbenchThreadSidebarSnapshot["entries"][number] => ({
    activityAt: orderAt,
    entryKind: "thread",
    identity: { harness: "codex", threadId },
    lifecycle: { kind: "completed", reason: "providerInactive", settled: false },
    metadata: { archived: false, pinned: true, snoozed: false },
    orderAt,
    title: threadId,
  });
  const initial: WorkbenchThreadSidebarSnapshot = {
    ...snapshot(1),
    displayOrder: { pinned: { "codex:older": { above: [], below: ["codex:newer"] } } },
    entries: [entry("older", 1), entry("newer", 2)],
  };
  const client = new ThreadSidebarClient({
    onChange: () => undefined,
    transport: { close: async () => undefined, deleteDraft: async () => undefined, open: async () => initial, upsertDraft: async () => undefined },
  });
  await client.open("project");
  client.acceptActivity({ activityAt: 5, identity: { harness: "codex", threadId: "newer" }, orderAt: 5, projectId: "project", revision: 2, updateKind: "activity" });
  assert.deepEqual(client.getSnapshot()?.entries.map((candidate) => candidate.entryKind === "thread" ? candidate.identity.threadId : ""), ["older", "newer"]);
});

test("authoritative arrivals refresh complete user-order snapshots before later automatic movement", async () => {
  const entry = (threadId: string, orderAt: number): WorkbenchThreadSidebarSnapshot["entries"][number] => ({
    activityAt: orderAt,
    entryKind: "thread",
    identity: { harness: "codex", threadId },
    lifecycle: { kind: "completed", reason: "providerInactive", settled: false },
    metadata: { archived: false, pinned: true, snoozed: false },
    orderAt,
    title: threadId,
  });
  const initial: WorkbenchThreadSidebarSnapshot = {
    ...snapshot(1),
    displayOrder: { pinned: { "codex:older": { above: [], below: ["codex:newer"] } } },
    entries: [entry("arrival", 3), entry("newer", 2), entry("older", 1)],
  };
  const client = new ThreadSidebarClient({
    onChange: () => undefined,
    transport: { close: async () => undefined, deleteDraft: async () => undefined, open: async () => initial, upsertDraft: async () => undefined },
  });

  await client.open("project");
  assert.deepEqual(client.getSnapshot()?.entries.map((candidate) => candidate.entryKind === "thread" ? candidate.identity.threadId : ""), ["arrival", "older", "newer"]);
  assert.deepEqual(client.getSnapshot()?.displayOrder?.pinned?.["codex:older"], {
    above: ["codex:arrival"],
    below: ["codex:newer"],
  });

  client.acceptActivity({ activityAt: 5, identity: { harness: "codex", threadId: "newer" }, orderAt: 5, projectId: "project", revision: 2, updateKind: "activity" });
  assert.deepEqual(client.getSnapshot()?.entries.map((candidate) => candidate.entryKind === "thread" ? candidate.identity.threadId : ""), ["arrival", "older", "newer"]);
});

test("external-store subscribers receive each installed snapshot and can unsubscribe", async () => {
  const initial: WorkbenchThreadSidebarSnapshot = {
    ...snapshot(1),
    entries: [{
      activityAt: 1,
      entryKind: "thread",
      identity: { harness: "codex", threadId: "thread" },
      lifecycle: { kind: "completed", reason: "providerInactive", settled: false },
      metadata: { archived: false, pinned: false, snoozed: false },
      title: "Thread",
    }],
  };
  const client = new ThreadSidebarClient({
    onChange: () => undefined,
    transport: { close: async () => undefined, deleteDraft: async () => undefined, open: async () => initial, upsertDraft: async () => undefined },
  });
  await client.open("project");
  let notifications = 0;
  const unsubscribe = client.subscribe(() => { notifications += 1; });

  client.acceptActivity({ activityAt: 50, identity: { harness: "codex", threadId: "thread" }, projectId: "project", revision: 2, updateKind: "activity" });
  assert.equal(notifications, 1);
  assert.equal(client.getSnapshot()?.revision, 2);
  assert.equal(client.getSnapshot()?.entries[0]?.activityAt, 50);

  unsubscribe();
  client.acceptActivity({ activityAt: 60, identity: { harness: "codex", threadId: "thread" }, projectId: "project", revision: 3, updateKind: "activity" });
  assert.equal(notifications, 1);
  assert.equal(client.getSnapshot()?.revision, 3);
});

test("open reports observation admission while retaining bounded failure state", async () => {
  let shouldFail = true;
  let openAttempts = 0;
  const client = new ThreadSidebarClient({
    onChange: () => undefined,
    transport: {
      close: async () => undefined,
      deleteDraft: async () => undefined,
      open: async () => {
        openAttempts += 1;
        if (shouldFail) throw new Error("Observation unavailable");
        return snapshot(1);
      },
      upsertDraft: async () => undefined,
    },
  });
  assert.equal(await client.open("project"), false);
  assert.equal(client.getSnapshot()?.freshness, "partial");
  assert.match(client.getSnapshot()?.error ?? "", /Observation unavailable/u);
  shouldFail = false;
  assert.equal(await client.open("project"), true);
  assert.equal(openAttempts, 2);
  assert.equal(client.getSnapshot()?.error, null);
});

test("materialized draft becomes a working thread before its in-flight save settles", async () => {
  const installed: Array<WorkbenchThreadSidebarSnapshot | null> = [];
  const source = draft("materialize this", 2);
  let releaseSave: (() => void) | null = null;
  const save = new Promise<void>((resolve) => { releaseSave = resolve; });
  const client = new ThreadSidebarClient({
    onChange: (value) => installed.push(value),
    transport: {
      close: async () => undefined,
      deleteDraft: async () => undefined,
      open: async () => ({
        ...snapshot(1),
        entries: [{ activityAt: 2, draft: source, entryKind: "draft", metadata: { archived: false, pinned: true, snoozed: true }, title: "materialize this" }],
      }),
      upsertDraft: async () => await save,
    },
  });
  await client.open("project");
  client.edit(source);
  const flushing = client.flush();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const accepting = client.acceptIntent({
    draftId: draft("", 2).draftId,
    identity: { harness: "codex", threadId: "materialized" },
    title: "Materialized thread",
    turnId: "turn",
  });
  const optimisticEntries = installed.at(-1)?.entries ?? [];
  assert.equal(optimisticEntries.some((entry) => entry.entryKind === "draft"), false);
  assert.equal(optimisticEntries.some((entry) => entry.entryKind === "thread" && entry.identity.threadId === "materialized" && entry.lifecycle.kind === "working"), true);
  const materialized = optimisticEntries.find((entry) => entry.entryKind === "thread" && entry.identity.threadId === "materialized");
  assert.deepEqual(materialized?.entryKind === "thread" ? materialized.metadata : null, { archived: false, pinned: true, snoozed: false });
  assert.equal(materialized?.entryKind === "thread" ? materialized.orderAt : null, materialized?.activityAt);
  let acceptanceSettled = false;
  void accepting.then(() => { acceptanceSettled = true; });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(acceptanceSettled, false);
  releaseSave?.();
  await Promise.all([accepting, flushing]);
  assert.equal(acceptanceSettled, true);
});

test("accepted intent immediately revives a stopped thread and a newer snapshot remains authoritative", async () => {
  const installed: Array<WorkbenchThreadSidebarSnapshot | null> = [];
  const stoppedEntry: WorkbenchThreadSidebarSnapshot["entries"][number] = {
    activityAt: 1,
    entryKind: "thread",
    identity: { harness: "codex", threadId: "thread" },
    lifecycle: { kind: "stopped", reason: "providerInterrupted", settled: false, turnId: "old-turn" },
    metadata: { archived: false, pinned: true, snoozed: true },
    orderAt: 1,
    title: "Thread",
  };
  const client = new ThreadSidebarClient({
    onChange: (value) => installed.push(value),
    transport: { close: async () => undefined, deleteDraft: async () => undefined, open: async () => ({ ...snapshot(1), entries: [stoppedEntry] }), upsertDraft: async () => undefined },
  });
  await client.open("project");
  await client.acceptIntent({ identity: stoppedEntry.identity, title: "Thread", turnId: "new-turn" });
  const optimistic = installed.at(-1)?.entries[0];
  assert.equal(optimistic?.entryKind, "thread");
  if (optimistic?.entryKind === "thread") {
    assert.equal(optimistic.lifecycle.kind, "working");
    assert.equal(optimistic.metadata.pinned, true);
    assert.equal(optimistic.metadata.snoozed, false);
    assert.equal(optimistic.orderAt, optimistic.activityAt);
  }
  client.accept({ ...snapshot(2), entries: [{ ...stoppedEntry, lifecycle: { kind: "completed", reason: "providerInactive", settled: false } }] });
  const authoritative = installed.at(-1)?.entries[0];
  assert.equal(authoritative?.entryKind, "thread");
  if (authoritative?.entryKind === "thread") assert.equal(authoritative.lifecycle.kind, "completed");
});

test("failed navigation flush preserves the route and re-enters the same debounced edit path", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let navigated = false;
  let attempts = 0;
  const client = new ThreadSidebarClient({
    onChange: () => undefined,
    transport: {
      close: async () => undefined,
      deleteDraft: async () => undefined,
      open: async () => snapshot(1),
      upsertDraft: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("disk busy");
      },
    },
  });
  await client.open("project");
  client.edit(draft("keep this route here", 2));
  await assert.rejects(client.guardNavigation(() => { navigated = true; }), /disk busy/u);
  assert.equal(navigated, false);

  context.mock.timers.tick(500);
  assert.equal(attempts, 2);
  await client.flush();
});

test("close flushes the newest draft before releasing project observation", async () => {
  const events: string[] = [];
  const client = new ThreadSidebarClient({
    onChange: () => undefined,
    transport: {
      close: async () => { events.push("close"); },
      deleteDraft: async () => undefined,
      open: async () => snapshot(1),
      upsertDraft: async (_projectId, value) => { events.push(`save:${value.prompt}`); },
    },
  });
  await client.open("project");
  client.edit(draft("persist before close", 2));
  await client.close();
  assert.deepEqual(events, ["save:persist before close", "close"]);
});
