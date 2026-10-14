/*
 * Exports:
 * - No production exports; tests protect summary reads, seeded and pushed facts, and project-driven row changes.
 */
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";

import { ProjectIdSchema, WorkbenchThreadIdSchema, type ProjectId } from "workbench-shared/workbench/identity";
import type { WorkbenchThreadSidebarSnapshot } from "workbench-shared/workbench/thread/thread-state";
import WorkbenchThreadSummaryIndex from "./WorkbenchThreadSummaryIndex";

const PROJECT = "project" as ProjectId;

function entry(threadId: string, title: string) {
  return {
    activityAt: 1_000_000, entryKind: "thread", title,
    identity: { harness: "codex", threadId },
    lifecycle: { kind: "completed", reason: "agentCompleted", settled: false },
    metadata: { archived: false, pinned: false, snoozed: false },
  };
}

function harness(
  todoCounts: ReadonlyMap<string, number> = new Map(),
  addressedFeedbackCounts: ReadonlyMap<string, number> | Promise<ReadonlyMap<string, number>> = new Map(),
) {
  let snapshot = { entries: [entry("a", "first")], error: null, freshness: "fresh", projectId: PROJECT, revision: 1 } as unknown as WorkbenchThreadSidebarSnapshot;
  let notify: (projectId: ProjectId) => void = () => {};
  const changed: string[] = [];
  const index = new WorkbenchThreadSummaryIndex({
    resolveProject: async threadId => threadId === "missing" ? null : PROJECT,
    peekProject: () => snapshot,
    readProject: async () => snapshot,
    subscribeProjects: listener => { notify = listener; return () => {}; },
    readRequiredTodoCounts: async () => todoCounts,
    readAddressedFeedbackCounts: async () => await addressedFeedbackCounts,
    warn: message => { throw new Error(message); },
  });
  index.subscribe(threadId => changed.push(threadId));
  return {
    index, changed,
    setEntries(entries: object[]) {
      snapshot = { ...snapshot, entries } as WorkbenchThreadSidebarSnapshot;
      notify(PROJECT);
    },
  };
}

test("a read summary carries its owner project and seeded required todo count, and stays the same object until it changes", async () => {
  const h = harness(new Map([["a", 3]]), new Map([["a", 2]]));
  const located = await h.index.read("a");
  assert.equal(located?.projectId, PROJECT);
  assert.equal(located?.summary.row.title, "first");
  assert.deepEqual(located?.summary.facts, { addressedFeedbackCount: 2, requiredTodoCount: 3 });
  assert.equal(h.index.peek("a"), located);
  assert.equal(await h.index.read("missing"), null);
});

test("project changes re-project only threads whose row changed, and a thread that leaves reads as unknown", async () => {
  const h = harness();
  await h.index.read("a");
  h.setEntries([entry("a", "first"), entry("b", "unread")]);
  assert.deepEqual(h.changed, [], "an unchanged row and an unread thread announce nothing");
  h.setEntries([entry("a", "renamed")]);
  assert.deepEqual(h.changed, ["a"]);
  assert.equal(h.index.peek("a")?.summary.row.title, "renamed");
  h.setEntries([]);
  assert.deepEqual(h.changed, ["a", "a"]);
  assert.equal(h.index.peek("a"), null);
});

test("pushed facts announce read threads and wait for unread ones", async () => {
  const h = harness();
  h.index.setRequiredTodoCount("a", 2);
  assert.deepEqual(h.changed, []);
  assert.deepEqual((await h.index.read("a"))?.summary.facts, { requiredTodoCount: 2 });
  h.index.setCompacting("a", true);
  h.index.setCompacting("a", true);
  assert.deepEqual(h.changed, ["a"], "repeating a fact changes nothing");
  assert.deepEqual(h.index.peek("a")?.summary.facts, { compacting: true, requiredTodoCount: 2 });
  h.index.setRequiredTodoCount("a", 0);
  assert.deepEqual(h.index.peek("a")?.summary.facts, { compacting: true }, "zero counts read as absent");
  h.index.setAddressedFeedbackCount("a", 2);
  h.index.setAddressedFeedbackCount("a", 2);
  assert.deepEqual(h.index.peek("a")?.summary.facts, { addressedFeedbackCount: 2, compacting: true });
  h.index.setAddressedFeedbackCount("a", 0);
  assert.deepEqual(h.index.peek("a")?.summary.facts, { compacting: true });
});

test("a feedback change during startup wins over the older count seed", async () => {
  const pending = Promise.withResolvers<ReadonlyMap<string, number>>();
  const h = harness(new Map(), pending.promise);
  const read = h.index.read("a");
  h.index.setAddressedFeedbackCount("a", 0);
  pending.resolve(new Map([["a", 3]]));
  assert.deepEqual((await read)?.summary.facts, {});
});

function batchFixture(context: TestContext) {
  const firstProject = ProjectIdSchema.parse("first");
  const secondProject = ProjectIdSchema.parse("second");
  const ids = [1, 2, 3].map(index => WorkbenchThreadIdSchema.parse(`00000000-0000-4000-8000-${String(index).padStart(12, "0")}`));
  const snapshot = (projectId: ProjectId): WorkbenchThreadSidebarSnapshot => ({
    projectId, revision: 1, freshness: "fresh", error: null, displayOrder: {},
    entries: ids.map(threadId => ({
      activityAt: 1, entryKind: "thread", title: threadId,
      identity: { harness: "codex", threadId },
      lifecycle: { kind: "needsAttention", reason: "noActiveTurn", settled: false },
      metadata: { archived: false, pinned: false, snoozed: false },
    })),
  });
  const reads: ProjectId[] = [];
  const peeks: ProjectId[] = [];
  const entered = Promise.withResolvers<void>();
  const held = Promise.withResolvers<WorkbenchThreadSidebarSnapshot>();
  let cached = false;
  const index = new WorkbenchThreadSummaryIndex({
    resolveProject: async id => id === ids[2] ? secondProject : firstProject,
    peekProject: projectId => { peeks.push(projectId); return cached ? snapshot(projectId) : null; },
    readProject: async projectId => {
      reads.push(projectId);
      if (projectId === secondProject) return snapshot(projectId);
      entered.resolve();
      return held.promise;
    },
    subscribeProjects: () => () => {},
    readRequiredTodoCounts: async () => new Map(),
    readAddressedFeedbackCounts: async () => new Map(),
    warn: message => { throw new Error(message); },
  });
  context.after(() => index.dispose());
  return { index, ids, firstProject, secondProject, reads, peeks, entered, held, snapshot,
    cache: () => { cached = true; } };
}

test("concurrent reads share one project snapshot and cached summaries need no new snapshot", async context => {
  const f = batchFixture(context);
  f.cache();
  const values = await Promise.all([f.index.read(f.ids[0]!), f.index.read(f.ids[1]!), f.index.read(f.ids[0]!)]);
  assert.deepEqual(f.peeks, [f.firstProject]);
  assert.deepEqual(f.reads, []);
  assert.equal(values[0], values[2]);
  assert.deepEqual(values.slice(0, 2).map(value => value?.summary.row.identity.threadId), f.ids.slice(0, 2));
  assert.equal(await f.index.read(f.ids[0]!), values[0]);
  assert.deepEqual(f.peeks, [f.firstProject]);
});

test("reads joining a held project share its snapshot without blocking other projects", async context => {
  const f = batchFixture(context);
  const first = f.index.read(f.ids[0]!);
  await f.entered.promise;
  const joined = f.index.read(f.ids[1]!);
  const duplicate = f.index.read(f.ids[0]!);
  const independent = await f.index.read(f.ids[2]!);
  assert.equal(independent?.projectId, f.secondProject);
  f.held.resolve(f.snapshot(f.firstProject));
  const values = await Promise.all([first, joined, duplicate]);
  assert.deepEqual(f.reads, [f.firstProject, f.secondProject]);
  assert.equal(values[0], values[2]);
  assert.deepEqual(values.slice(0, 2).map(value => value?.summary.row.identity.threadId), f.ids.slice(0, 2));
});

test("a failed project batch rejects its readers and a later read can retry", async context => {
  const f = batchFixture(context);
  const reads = [f.index.read(f.ids[0]!), f.index.read(f.ids[1]!)];
  const rejected = reads.map(read => assert.rejects(read, /project unavailable/u));
  await f.entered.promise;
  f.held.reject(new Error("project unavailable"));
  await Promise.all(rejected);
  assert.deepEqual(f.reads, [f.firstProject]);
  f.cache();
  assert.equal((await f.index.read(f.ids[0]!))?.projectId, f.firstProject);
});

test("disposing a held project batch cannot populate retired summaries", async context => {
  const f = batchFixture(context);
  const read = f.index.read(f.ids[0]!);
  await f.entered.promise;
  f.index.dispose();
  f.held.resolve(f.snapshot(f.firstProject));
  assert.equal(await read, null);
  assert.equal(f.index.peek(f.ids[0]!), null);
  assert.equal(await f.index.read(f.ids[1]!), null);
});
