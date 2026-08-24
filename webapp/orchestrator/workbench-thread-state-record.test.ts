/*
 * No production exports. Node tests protect the internal-record/sidebar-projection boundary. Keywords: thread, state, projection, test.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  conformStoredWorkbenchThreadStateRecord,
  parseWorkbenchThreadStateEntry,
  projectWorkbenchThreadStateEntry,
} from "./workbench-thread-state-record";

const entry = {
  activityAt: 10,
  entryKind: "thread" as const,
  identity: { harness: "codex" as const, threadId: "thread" },
  lifecycle: { kind: "needsAttention" as const, reason: "noActiveTurn" as const, settled: false },
  metadata: { archived: false as const, pinned: false, snoozed: false },
  title: "Thread",
};

test("internal MCP freshness never leaks into the sidebar projection", () => {
  const record = parseWorkbenchThreadStateEntry({ ...entry, mcpGeneration: "epoch:2", providerObserved: true });
  assert.equal(record.entryKind === "thread" ? record.mcpGeneration : null, "epoch:2");
  assert.deepEqual(projectWorkbenchThreadStateEntry(record), entry);
});

test("unobserved durable records remain internal until provider facts arrive", () => {
  const record = parseWorkbenchThreadStateEntry({ ...entry, mcpGeneration: null, providerObserved: false });
  assert.equal(projectWorkbenchThreadStateEntry(record), null);
});

test("stored-record conformance preserves lifecycle truth when an optional projection is invalid", () => {
  const conformed = conformStoredWorkbenchThreadStateRecord({
    ...entry,
    gitArc: {
      checkpointCommit: "invalid",
      claimedPaths: ["webapp"],
      intentDescription: "",
      intentName: "work",
      phase: "active",
      proposals: [],
      updatedAt: "now",
    },
    mcpGeneration: "epoch:2",
    providerObserved: true,
  }, "project");

  assert.equal(conformed.success, true);
  if (!conformed.success) return;
  assert.deepEqual(projectWorkbenchThreadStateEntry(conformed.data), entry);
  assert.deepEqual(conformed.repairedPaths, [["gitArc"]]);
});

test("stored-record conformance repairs malformed lifecycle to a non-terminal state", () => {
  const conformed = conformStoredWorkbenchThreadStateRecord({
    ...entry,
    lifecycle: { kind: "completed", reason: "futureReason", settled: "yes" },
  }, "project");

  assert.equal(conformed.success, true);
  if (!conformed.success) return;
  assert.deepEqual(conformed.data.lifecycle, { kind: "completed", reason: "userCompleted", settled: false });
  assert.ok(conformed.repairedPaths.length > 0);
  assert.ok(conformed.repairedPaths.every(([owner]) => owner === "lifecycle"));
});

test("stored-record conformance rejects a record whose identity cannot be recovered", () => {
  const conformed = conformStoredWorkbenchThreadStateRecord({ ...entry, identity: { harness: "codex" } }, "project");
  assert.equal(conformed.success, false);
});
