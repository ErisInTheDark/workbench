/* No production exports. Tests protect strict lifecycle, grouping, ordering, and draft rules. */
import assert from "node:assert/strict";
import test from "node:test";
import { countDraftPromptTokens, createDraftTitle, getThreadSidebarGroup, normalizeWorkbenchActivityTimestampMs, projectWorkbenchThreadSidebarEntries, reduceWorkbenchThreadLifecycle, resolveWorkbenchThreadTitle, WorkbenchThreadLifecycleSchema, WorkbenchThreadStateSnapshotSchema, type WorkbenchThreadSidebarEntry } from "./thread-state";

test("provider activity timestamps normalize seconds without double-converting milliseconds", () => {
  assert.equal(normalizeWorkbenchActivityTimestampMs(1_723_456_789), 1_723_456_789_000);
  assert.equal(normalizeWorkbenchActivityTimestampMs(1_723_456_789_123), 1_723_456_789_123);
});

test("draft threshold and title follow prompt text only", () => {
  assert.equal(countDraftPromptTokens(" one  two\nthree "), 3);
  assert.equal(countDraftPromptTokens("   "), 0);
  assert.equal(createDraftTitle("\n  First   line \nsecond"), "First line");
});

test("thread titles ignore identifier-shaped provider names and prefer the first user preview", () => {
  const id = "123e4567-e89b-42d3-a456-426614174000";
  assert.equal(resolveWorkbenchThreadTitle({ id, name: id, preview: "  First user message\nsecond line" }), "First user message");
  assert.equal(resolveWorkbenchThreadTitle({ id, name: "New thread", preview: "First user message" }), "First user message");
  assert.equal(resolveWorkbenchThreadTitle({ id, name: "Useful title", preview: "First user message" }), "Useful title");
  assert.equal(resolveWorkbenchThreadTitle({ id, name: "550e8400-e29b-41d4-a716-446655440000", preview: "" }), "New thread");
});

test("multiplexed updates strictly distinguish sidebar, activity, and project payloads", () => {
  assert.equal(WorkbenchThreadStateSnapshotSchema.safeParse({
    entries: [], error: null, freshness: "fresh", projectId: "project", revision: 1,
  }).success, true);
  assert.equal(WorkbenchThreadStateSnapshotSchema.safeParse({
    activityAt: 10, identity: { harness: "codex", threadId: "thread" }, projectId: "project", revision: 2, updateKind: "activity",
  }).success, true);
  const projectUpdate = WorkbenchThreadStateSnapshotSchema.safeParse({
    projectId: "project",
    revision: 3,
    snapshot: {
      changes: {}, projectId: "project", root: "Project", rootPath: "C:/project",
      roots: [{ id: "project", isPrimary: true, name: "Project", relativePath: "project", rootPath: "C:/project" }],
      tree: [{ isIgnored: true, name: ".env.local", path: ".env.local", type: "file" }], workbenchStorageRootPath: "C:/workbench",
    },
    updateKind: "project",
  });
  assert.equal(projectUpdate.success, true);
  assert.equal(projectUpdate.success && "snapshot" in projectUpdate.data && projectUpdate.data.snapshot.tree[0]?.type === "file"
    ? projectUpdate.data.snapshot.tree[0].isIgnored
    : null, true);
  assert.equal(WorkbenchThreadStateSnapshotSchema.safeParse({
    activityAt: 10, projectId: "project", revision: 4, updateKind: "activity",
  }).success, false);
  assert.equal(WorkbenchThreadStateSnapshotSchema.safeParse({
    entries: [], error: null, freshness: "fresh", projectId: "project", revision: 5, updateKind: "sidebar",
  }).success, false);
});

test("strict lifecycle rejects impossible combinations", () => {
  assert.equal(WorkbenchThreadLifecycleSchema.safeParse({ kind: "working", reason: "acceptedIntent", settled: true, agent: { agentStatus: "working", turnId: "t" } }).success, false);
  assert.equal(WorkbenchThreadLifecycleSchema.safeParse({ kind: "needsAttention", reason: "pendingInput", settled: false, turnId: "t" }).success, false);
  assert.equal(WorkbenchThreadLifecycleSchema.safeParse({ kind: "stopped", reason: "providerInterrupted", settled: false }).success, false);
  assert.equal(WorkbenchThreadLifecycleSchema.safeParse({ kind: "completed", reason: "providerInactive", settled: false }).success, true);
});

test("lifecycle parsing preserves two attention variants and normalizes legacy reasons", () => {
  assert.deepEqual(WorkbenchThreadLifecycleSchema.parse({ kind: "needsAttention", reason: "noActiveTurn", settled: false }), {
    kind: "needsAttention", reason: "noActiveTurn", settled: false,
  });
  assert.deepEqual(WorkbenchThreadLifecycleSchema.parse({ kind: "needsAttention", reason: "pendingInput", requestKey: "request", settled: false, turnId: "turn" }), {
    kind: "needsAttention", reason: "pendingInput", requestKey: "request", settled: false, turnId: "turn",
  });
  for (const lifecycle of [
    { agent: { agentStatus: "blocked", turnId: "turn" }, kind: "needsAttention", reason: "agentBlocked", settled: false },
    { agent: { agentStatus: "working", turnId: "turn" }, kind: "needsAttention", reason: "turnEnded", settled: false },
    { kind: "needsAttention", reason: "restartRecoveryFailed", settled: false },
    { kind: "needsAttention", reason: "providerSystemError", settled: false },
  ]) {
    assert.deepEqual(WorkbenchThreadLifecycleSchema.parse(lifecycle), { kind: "needsAttention", reason: "noActiveTurn", settled: false });
  }
  assert.deepEqual(WorkbenchThreadLifecycleSchema.parse({ kind: "completed", reason: "providerInactive", settled: true }), {
    kind: "completed", reason: "providerInactive", settled: true,
  });
});

test("exact-turn transitions reject stale completion and stopped settlement becomes completed", () => {
  const working = reduceWorkbenchThreadLifecycle(null, { kind: "acceptedIntent", turnId: "new" });
  assert.equal(reduceWorkbenchThreadLifecycle(working, { kind: "turnCompleted", status: "completed", turnId: "old" }), working);
  const completed = reduceWorkbenchThreadLifecycle(working, { kind: "agentStatus", status: "completed", turnId: "new" });
  assert.equal(completed.kind, "completed");
  const settled = reduceWorkbenchThreadLifecycle(completed, { kind: "settle" });
  assert.equal(settled.settled, true);
  assert.deepEqual(reduceWorkbenchThreadLifecycle(settled, { kind: "restore" }), completed);
  const stopped = reduceWorkbenchThreadLifecycle(working, { kind: "turnCompleted", status: "interrupted", turnId: "new" });
  assert.deepEqual(reduceWorkbenchThreadLifecycle(stopped, { kind: "settle" }), {
    kind: "completed",
    reason: "userCompleted",
    settled: true,
  });
  assert.equal(reduceWorkbenchThreadLifecycle(working, { kind: "restore" }), working);
  assert.deepEqual(reduceWorkbenchThreadLifecycle(completed, { kind: "userNeedsAttention" }), {
    kind: "needsAttention", reason: "noActiveTurn", settled: false,
  });
  const pendingInput = reduceWorkbenchThreadLifecycle(working, { kind: "pendingInput", requestKey: "request", turnId: "new" });
  assert.equal(reduceWorkbenchThreadLifecycle(pendingInput, { kind: "userNeedsAttention" }), pendingInput);
});

test("grouping keeps terminal status while settlement moves it to other", () => {
  const entry = {
    activityAt: 1,
    entryKind: "thread" as const,
    identity: { harness: "codex" as const, threadId: "thread" },
    lifecycle: { agent: { agentStatus: "completed" as const, turnId: "turn" }, kind: "completed" as const, reason: "agentCompleted" as const, settled: false },
    metadata: { archived: false as const, pinned: false, snoozed: false },
    title: "Thread",
  };
  assert.equal(getThreadSidebarGroup(entry), "completed");
  assert.equal(getThreadSidebarGroup({ ...entry, lifecycle: { ...entry.lifecycle, settled: true } }), "other");
});

test("completed parent status derives attention before working without mutating durable lifecycle", () => {
  const parent: WorkbenchThreadSidebarEntry = {
    activityAt: 1, entryKind: "thread", identity: { harness: "codex", threadId: "parent" },
    lifecycle: { kind: "completed", reason: "providerInactive", settled: true },
    metadata: { archived: false, pinned: false, snoozed: false }, title: "Parent",
  };
  const child = (threadId: string, lifecycle: Extract<WorkbenchThreadSidebarEntry, { entryKind: "subagent" }>["lifecycle"]): WorkbenchThreadSidebarEntry => ({
    activityAt: 2, createdAt: 1, cwd: "C:/repo", directSubagentIndex: 0, entryKind: "subagent",
    identity: { harness: "codex", threadId }, lifecycle, name: threadId, parentThreadId: "parent", pinned: false,
    profileId: "default", profileName: "Default", projectId: "project", title: threadId, updatedAt: 2,
  });
  const working = child("working", { agent: { agentStatus: "working", turnId: "turn" }, kind: "working", reason: "acceptedIntent", settled: false });
  const attention = child("attention", { kind: "needsAttention", reason: "noActiveTurn", settled: false });
  const projectedWorking = projectWorkbenchThreadSidebarEntries([parent, working])[0]!;
  const projectedAttention = projectWorkbenchThreadSidebarEntries([parent, working, attention])[0]!;
  assert.equal(projectedWorking.entryKind === "draft" ? null : projectedWorking.lifecycle.kind, "working");
  assert.equal(projectedAttention.entryKind === "draft" ? null : projectedAttention.lifecycle.kind, "needsAttention");
  assert.equal(parent.lifecycle.kind, "completed");
  assert.equal(projectWorkbenchThreadSidebarEntries([parent])[0], parent);
});
