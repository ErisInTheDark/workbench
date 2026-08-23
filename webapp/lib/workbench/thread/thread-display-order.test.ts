/*
 * Tests:
 * - partial display-order projection, relation snapshots, lifecycle-section exits, and malformed-cycle fallback.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  getWorkbenchThreadDisplayKey,
  moveWorkbenchThreadDisplayOrder,
  projectWorkbenchThreadDisplayOrder,
  reconcileWorkbenchThreadDisplayOrder,
  type WorkbenchThreadDisplayOrder,
} from "./thread-display-order";
import type { WorkbenchThreadSidebarEntry } from "./thread-state";

function thread(id: string, orderAt: number, options: { pinned?: boolean; settled?: boolean; snoozed?: boolean } = {}): WorkbenchThreadSidebarEntry {
  return {
    activityAt: orderAt,
    entryKind: "thread",
    identity: { harness: "codex", threadId: id },
    lifecycle: { kind: "completed", reason: "providerInactive", settled: options.settled ?? false },
    metadata: { archived: false, pinned: options.pinned ?? false, snoozed: options.snoozed ?? false },
    orderAt,
    title: id,
  };
}

function ids(entries: readonly WorkbenchThreadSidebarEntry[]) {
  return entries.map((entry) => getWorkbenchThreadDisplayKey(entry));
}

test("a moved row stays projected while an ordinary arrival is inserted and snapshotted", () => {
  const newest = thread("newest", 3, { snoozed: true });
  const middle = thread("middle", 2, { snoozed: true });
  const oldest = thread("oldest", 1, { snoozed: true });
  const moved = moveWorkbenchThreadDisplayOrder([newest, middle, oldest], {}, "snoozed", "codex:oldest", "codex:newest");
  assert.ok(moved);
  assert.deepEqual(ids(projectWorkbenchThreadDisplayOrder([newest, middle, oldest], moved)), ["codex:oldest", "codex:newest", "codex:middle"]);

  const arrival = thread("arrival", 4, { snoozed: true });
  const reconciled = reconcileWorkbenchThreadDisplayOrder([arrival, newest, middle, oldest], moved);
  assert.deepEqual(ids(projectWorkbenchThreadDisplayOrder([arrival, newest, middle, oldest], reconciled)), ["codex:arrival", "codex:oldest", "codex:newest", "codex:middle"]);
  assert.deepEqual(reconciled.snoozed?.["codex:oldest"], {
    above: ["codex:arrival"],
    below: ["codex:newest", "codex:middle"],
  });
});

test("leaving a reorderable section clears the row and every touching relation", () => {
  const first = thread("first", 2, { pinned: true });
  const second = thread("second", 1, { pinned: true });
  const moved = moveWorkbenchThreadDisplayOrder([first, second], {}, "pinned", "codex:second", "codex:first");
  assert.ok(moved);
  const reconciled = reconcileWorkbenchThreadDisplayOrder([first, thread("second", 1)], moved);
  assert.deepEqual(reconciled, {});
});

test("cyclic persisted relations fall back to natural order", () => {
  const first = thread("first", 2, { pinned: true });
  const second = thread("second", 1, { pinned: true });
  const cyclic: WorkbenchThreadDisplayOrder = {
    pinned: {
      "codex:first": { above: ["codex:second"], below: [] },
      "codex:second": { above: ["codex:first"], below: [] },
    },
  };
  assert.deepEqual(ids(projectWorkbenchThreadDisplayOrder([first, second], cyclic)), ["codex:first", "codex:second"]);
});

test("invalid stored ordering safely becomes empty ordering", () => {
  const first = thread("first", 2, { pinned: true });
  const second = thread("second", 1, { pinned: true });
  assert.deepEqual(ids(projectWorkbenchThreadDisplayOrder([first, second], { pinned: "nope" })), ["codex:first", "codex:second"]);
});
