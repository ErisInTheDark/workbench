/* No production exports. Tests protect strict lifecycle, grouping, ordering, and draft rules. */
import assert from "node:assert/strict";
import test from "node:test";
import { countDraftPromptTokens, createDraftTitle, getThreadSidebarGroup, normalizeWorkbenchActivityTimestampMs, projectWorkbenchThreadSidebarEntries, reduceWorkbenchThreadLifecycle, WorkbenchThreadLifecycleSchema, type WorkbenchThreadSidebarEntry } from "./thread-state";

test("provider activity timestamps normalize seconds without double-converting milliseconds", () => {
  assert.equal(normalizeWorkbenchActivityTimestampMs(1_723_456_789), 1_723_456_789_000);
  assert.equal(normalizeWorkbenchActivityTimestampMs(1_723_456_789_123), 1_723_456_789_123);
});

test("draft threshold and title follow prompt text only", () => {
  assert.equal(countDraftPromptTokens(" one  two\nthree "), 3);
  assert.equal(countDraftPromptTokens("   "), 0);
  assert.equal(createDraftTitle("\n  First   line \nsecond"), "First line");
});

test("strict lifecycle rejects impossible combinations", () => {
  assert.equal(WorkbenchThreadLifecycleSchema.safeParse({ kind: "working", reason: "acceptedIntent", settled: true, agent: { agentStatus: "working", turnId: "t" } }).success, false);
  assert.equal(WorkbenchThreadLifecycleSchema.safeParse({ kind: "needsAttention", reason: "pendingInput", settled: false, turnId: "t" }).success, false);
  assert.equal(WorkbenchThreadLifecycleSchema.safeParse({ kind: "stopped", reason: "providerInterrupted", settled: false }).success, false);
  assert.equal(WorkbenchThreadLifecycleSchema.safeParse({ kind: "completed", reason: "providerInactive", settled: false }).success, true);
});

test("exact-turn transitions reject stale completion and settlement is a terminal-only toggle", () => {
  const working = reduceWorkbenchThreadLifecycle(null, { kind: "acceptedIntent", turnId: "new" });
  assert.equal(reduceWorkbenchThreadLifecycle(working, { kind: "turnCompleted", status: "completed", turnId: "old" }), working);
  const completed = reduceWorkbenchThreadLifecycle(working, { kind: "agentStatus", status: "completed", turnId: "new" });
  assert.equal(completed.kind, "completed");
  const settled = reduceWorkbenchThreadLifecycle(completed, { kind: "settle" });
  assert.equal(settled.settled, true);
  assert.deepEqual(reduceWorkbenchThreadLifecycle(settled, { kind: "restore" }), completed);
  assert.equal(reduceWorkbenchThreadLifecycle(working, { kind: "restore" }), working);
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
  const attention = child("attention", { agent: { agentStatus: "working", turnId: "turn" }, kind: "needsAttention", reason: "turnEnded", settled: false });
  const projectedWorking = projectWorkbenchThreadSidebarEntries([parent, working])[0]!;
  const projectedAttention = projectWorkbenchThreadSidebarEntries([parent, working, attention])[0]!;
  assert.equal(projectedWorking.entryKind === "draft" ? null : projectedWorking.lifecycle.kind, "working");
  assert.equal(projectedAttention.entryKind === "draft" ? null : projectedAttention.lifecycle.kind, "needsAttention");
  assert.equal(parent.lifecycle.kind, "completed");
  assert.equal(projectWorkbenchThreadSidebarEntries([parent])[0], parent);
});
