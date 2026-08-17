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

test("activity updates reorder only the matching observed thread", async () => {
  const installed: Array<WorkbenchThreadSidebarSnapshot | null> = [];
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
    onChange: (value) => installed.push(value),
    transport: { close: async () => undefined, deleteDraft: async () => undefined, open: async () => initial, upsertDraft: async () => undefined },
  });
  await client.open("project");
  client.acceptActivity({ activityAt: 50, identity: { harness: "codex", threadId: "thread" }, projectId: "project", revision: 2, updateKind: "activity" });
  assert.equal(installed.at(-1)?.entries[0]?.activityAt, 50);
  assert.equal(installed.at(-1)?.revision, 2);
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

test("materialized draft becomes a working thread before its in-flight save settles", async () => {
  const installed: Array<WorkbenchThreadSidebarSnapshot | null> = [];
  let releaseSave: (() => void) | null = null;
  const save = new Promise<void>((resolve) => { releaseSave = resolve; });
  const client = new ThreadSidebarClient({
    onChange: (value) => installed.push(value),
    transport: {
      close: async () => undefined,
      deleteDraft: async () => undefined,
      open: async () => snapshot(1),
      upsertDraft: async () => await save,
    },
  });
  await client.open("project");
  client.edit(draft("materialize this", 2));
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
    metadata: { archived: false, pinned: true, snoozed: false },
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
