/*
 * No production exports. Node tests protect the internal-record/sidebar-projection boundary. Keywords: thread, state, projection, test.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { parseWorkbenchThreadStateEntry, projectWorkbenchThreadStateEntry } from "./workbench-thread-state-record";

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
