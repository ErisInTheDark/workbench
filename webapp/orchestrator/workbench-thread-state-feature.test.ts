/* No production exports. Tests protect provider timestamp and lifecycle notification normalization. */
import assert from "node:assert/strict";
import test from "node:test";

import { mapProviderActivityNotification, mapProviderLifecycleNotification, normalizeProviderSidebarEntry, normalizeSubagentProviderLifecycle } from "./WorkbenchThreadStateFeature";

test("provider sidebar normalization converts seconds at the reloadable feature boundary", () => {
  const entry = normalizeProviderSidebarEntry("codex", { id: "thread", status: { type: "idle" }, updatedAt: 1_723_456_789 });
  assert.equal(entry?.activityAt, 1_723_456_789_000);
});

test("provider sidebar normalization replaces identifier titles with first-message previews", () => {
  const id = "123e4567-e89b-42d3-a456-426614174000";
  const entry = normalizeProviderSidebarEntry("codex", { id, name: id, preview: "First request", status: { type: "idle" }, updatedAt: 1 });
  assert.equal(entry?.title, "First request");
});

test("inactive subagents remain completed but unsettled until an explicit settlement overlay exists", () => {
  assert.deepEqual(normalizeSubagentProviderLifecycle({ kind: "completed", reason: "providerInactive", settled: true }), {
    kind: "completed",
    reason: "providerInactive",
    settled: false,
  });
  const explicitlySettled = { agent: { agentStatus: "completed" as const, turnId: "turn" }, kind: "completed" as const, reason: "agentCompleted" as const, settled: true };
  assert.equal(normalizeSubagentProviderLifecycle(explicitlySettled), explicitlySettled);
});

test("provider lifecycle notification mapping is exact and bounded", () => {
  assert.deepEqual(mapProviderLifecycleNotification({ method: "turn/completed", params: { threadId: "child", turn: { id: "turn", status: "completed" } } }), {
    event: { kind: "turnCompleted", status: "completed", turnId: "turn" }, threadId: "child",
  });
  assert.deepEqual(mapProviderLifecycleNotification({ method: "questionnaire/requested", params: { requestKey: "question", threadId: "child", turnId: null } }), {
    event: { kind: "pendingInput", requestKey: "question", turnId: null }, threadId: "child",
  });
  assert.equal(mapProviderLifecycleNotification({ method: "turn/completed", params: { threadId: "child", turn: { id: "turn", status: "inProgress" } } }), null);
});

test("provider activity mapping observes meaningful cross-provider work without token deltas", () => {
  assert.equal(mapProviderActivityNotification({ method: "turn/started", params: { threadId: "thread", turn: { id: "turn" } } }), "thread");
  assert.equal(mapProviderActivityNotification({ method: "item/completed", params: { threadId: "thread", turnId: "turn" } }), "thread");
  assert.equal(mapProviderActivityNotification({ method: "item/agentMessage/delta", params: { threadId: "thread", turnId: "turn" } }), null);
});
