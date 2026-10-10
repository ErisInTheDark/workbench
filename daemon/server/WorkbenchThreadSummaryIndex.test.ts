/*
 * Exports:
 * - No production exports; tests protect summary reads, seeded and pushed facts, and project-driven row changes.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { ProjectId } from "workbench-shared/workbench/identity";
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

function harness(todoCounts: ReadonlyMap<string, number> = new Map()) {
  let snapshot = { entries: [entry("a", "first")], error: null, freshness: "fresh", projectId: PROJECT, revision: 1 } as unknown as WorkbenchThreadSidebarSnapshot;
  let notify: (projectId: ProjectId) => void = () => {};
  const changed: string[] = [];
  const index = new WorkbenchThreadSummaryIndex({
    resolveProject: async threadId => threadId === "missing" ? null : PROJECT,
    peekProject: () => snapshot,
    readProject: async () => snapshot,
    subscribeProjects: listener => { notify = listener; return () => {}; },
    readTodoCounts: async () => todoCounts,
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

test("a read summary carries its seeded todo count and stays the same object until it changes", async () => {
  const h = harness(new Map([["a", 3]]));
  const summary = await h.index.read("a");
  assert.equal(summary?.row.title, "first");
  assert.deepEqual(summary?.facts, { todoCount: 3 });
  assert.equal(h.index.peek("a"), summary);
  assert.equal(await h.index.read("missing"), null);
});

test("project changes re-project only threads whose row changed, and a thread that leaves reads as unknown", async () => {
  const h = harness();
  await h.index.read("a");
  h.setEntries([entry("a", "first"), entry("b", "unread")]);
  assert.deepEqual(h.changed, [], "an unchanged row and an unread thread announce nothing");
  h.setEntries([entry("a", "renamed")]);
  assert.deepEqual(h.changed, ["a"]);
  assert.equal(h.index.peek("a")?.row.title, "renamed");
  h.setEntries([]);
  assert.deepEqual(h.changed, ["a", "a"]);
  assert.equal(h.index.peek("a"), null);
});

test("pushed facts announce read threads and wait for unread ones", async () => {
  const h = harness();
  h.index.setTodoCount("a", 2);
  assert.deepEqual(h.changed, []);
  assert.deepEqual((await h.index.read("a"))?.facts, { todoCount: 2 });
  h.index.setCompacting("a", true);
  h.index.setCompacting("a", true);
  assert.deepEqual(h.changed, ["a"], "repeating a fact changes nothing");
  assert.deepEqual(h.index.peek("a")?.facts, { compacting: true, todoCount: 2 });
  h.index.setTodoCount("a", 0);
  assert.deepEqual(h.index.peek("a")?.facts, { compacting: true }, "zero counts read as absent");
});
