/*
 * No production exports. Node tests protect the internal-record/sidebar-projection boundary.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  conformStoredWorkbenchThreadStateRecord,
  parseWorkbenchThreadStateEntry,
  projectWorkbenchThreadStateEntry,
} from "./workbench-thread-state-record";
import * as fixtureIdentitySchemas from "workbench-shared/workbench/identity";

const fixtureIdentityValues = {
  ProjectId: {
    "project": fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
  },
};

const entry = {
  activityAt: 10,
  entryKind: "thread" as const,
  identity: { harness: "codex" as const, threadId: "thread" },
  lifecycle: { kind: "needsAttention" as const, reason: "noActiveTurn" as const, settled: false },
  metadata: { archived: false as const, pinned: false, snoozed: false },
  title: "Thread",
};

test("internal MCP freshness and Git retention timing never leak into the sidebar projection", () => {
  const snoozedUntil = {
    identity: { harness: "opencode" as const, threadId: "target" },
    projectId: "other-project",
  };
  const record = parseWorkbenchThreadStateEntry({ ...entry, gitHistoryCleanedAt: 456, mcpGeneration: "epoch:2", providerObserved: true, settledAt: 123, snoozedUntil });
  assert.equal(record.entryKind === "thread" ? record.gitHistoryCleanedAt : null, 456);
  assert.equal(record.entryKind === "thread" ? record.mcpGeneration : null, "epoch:2");
  assert.equal(record.entryKind === "thread" ? record.settledAt : null, 123);
  assert.deepEqual(record.entryKind === "thread" ? record.snoozedUntil : null, snoozedUntil);
  assert.deepEqual(projectWorkbenchThreadStateEntry(record), { ...entry, previousTitles: [] });
});

test("unobserved durable records remain internal until provider facts arrive", () => {
  const record = parseWorkbenchThreadStateEntry({ ...entry, mcpGeneration: null, providerObserved: false });
  assert.equal(projectWorkbenchThreadStateEntry(record), null);
});

test("settled and archived saved rows remain visible when omitted by provider listings", () => {
  for (const archived of [false, true]) {
    const record = parseWorkbenchThreadStateEntry({
      ...entry, providerObserved: false,
      lifecycle: { kind: "completed", reason: "providerInactive", settled: !archived },
      metadata: { archived, pinned: false, snoozed: false },
    });
    assert.ok(projectWorkbenchThreadStateEntry(record));
  }
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
  }, fixtureIdentityValues.ProjectId["project"]);

  assert.equal(conformed.success, true);
  if (!conformed.success) return;
  assert.deepEqual(projectWorkbenchThreadStateEntry(conformed.data), { ...entry, previousTitles: [] });
  assert.deepEqual(conformed.repairedPaths, [["gitArc"]]);
});

test("stored-record conformance repairs malformed lifecycle to a non-terminal state", () => {
  const conformed = conformStoredWorkbenchThreadStateRecord({
    ...entry,
    lifecycle: { kind: "completed", reason: "futureReason", settled: "yes" },
  }, fixtureIdentityValues.ProjectId["project"]);

  assert.equal(conformed.success, true);
  if (!conformed.success) return;
  assert.deepEqual(conformed.data.lifecycle, { kind: "completed", reason: "userCompleted", settled: false });
  assert.ok(conformed.repairedPaths.length > 0);
  assert.ok(conformed.repairedPaths.every(([owner]) => owner === "lifecycle"));
});

test("stored-record conformance rejects a record whose identity cannot be recovered", () => {
  const conformed = conformStoredWorkbenchThreadStateRecord({ ...entry, identity: { harness: "codex" } }, fixtureIdentityValues.ProjectId["project"]);
  assert.equal(conformed.success, false);
});

test("stored dependent snooze defaults safely and repairs malformed targets", () => {
  const plain = conformStoredWorkbenchThreadStateRecord(entry, fixtureIdentityValues.ProjectId["project"]);
  assert.equal(plain.success, true);
  if (!plain.success) return;
  assert.equal(plain.data.snoozedUntil, null);

  const malformed = conformStoredWorkbenchThreadStateRecord({
    ...entry,
    snoozedUntil: { identity: { harness: "future", threadId: "" }, projectId: "" },
  }, fixtureIdentityValues.ProjectId["project"]);
  assert.equal(malformed.success, true);
  if (!malformed.success) return;
  assert.equal(malformed.data.snoozedUntil, null);
});
