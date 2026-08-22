/* No production exports. Tests protect strict lifecycle, grouping, ordering, and draft rules. */
import assert from "node:assert/strict";
import test from "node:test";
import { countDraftPromptTokens, createDraftTitle, createWorkbenchThreadPlanConflictSelector, getThreadSidebarGroup, getWorkbenchThreadPlanConflictEntries, groupWorkbenchThreadSidebarEntries, isWorkbenchThreadStatusProviderOwned, normalizeWorkbenchTimestampMs, projectWorkbenchThreadSidebarEntries, reduceWorkbenchThreadLifecycle, resolveWorkbenchThreadTitle, sortThreadSidebarEntries, WorkbenchDurableQuestionnaireSchema, WorkbenchThreadLifecycleSchema, WorkbenchThreadStateRequestSchema, WorkbenchThreadStateSnapshotSchema, type WorkbenchThreadSidebarEntry } from "./thread-state";

test("provider timestamps normalize seconds without double-converting milliseconds", () => {
  assert.equal(normalizeWorkbenchTimestampMs(1_723_456_789), 1_723_456_789_000);
  assert.equal(normalizeWorkbenchTimestampMs(1_723_456_789_123), 1_723_456_789_123);
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
  assert.equal(WorkbenchThreadStateSnapshotSchema.safeParse({
    activityAt: 10, identity: { harness: "codex", threadId: "thread" }, orderAt: 9, projectId: "project", revision: 2, updateKind: "activity",
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

test("manual status request accepts exactly the three radio statuses", () => {
  const request = { identity: { harness: "codex", threadId: "thread" }, method: "workbench/thread-state/status/set", projectId: "project" };
  for (const status of ["needsAttention", "completed", "stopped"]) {
    assert.equal(WorkbenchThreadStateRequestSchema.safeParse({ ...request, status }).success, true);
  }
  assert.equal(WorkbenchThreadStateRequestSchema.safeParse({ ...request, status: "working" }).success, false);
  assert.equal(WorkbenchThreadStateRequestSchema.safeParse({ ...request, status: "idle" }).success, false);
});

test("draft priority requests use draft identity and drive shared grouping and ordering", () => {
  const draftId = "00000000-0000-4000-8000-000000000001";
  assert.equal(WorkbenchThreadStateRequestSchema.safeParse({ draftId, method: "workbench/thread-state/draft/pin/set", pinned: true, projectId: "project" }).success, true);
  assert.equal(WorkbenchThreadStateRequestSchema.safeParse({ draftId, method: "workbench/thread-state/draft/snooze/set", projectId: "project", snoozed: true }).success, true);
  assert.equal(WorkbenchThreadStateRequestSchema.safeParse({ method: "workbench/thread-state/draft/pin/set", pinned: true, projectId: "project" }).success, false);
  const entry: Extract<WorkbenchThreadSidebarEntry, { entryKind: "draft" }> = {
    activityAt: 1,
    draft: {
      agent: null, attachments: [], clientUpdatedAt: 1, composerSettings: {}, createdAt: 1,
      draftId, harness: "codex", model: null, profileId: null, projectId: "project", prompt: "Pinned draft",
      reasoningEffort: null, serviceTier: null, updatedAt: 1,
    },
    entryKind: "draft",
    metadata: { archived: false, pinned: true, snoozed: true },
    title: "Pinned draft",
  };
  assert.equal(getThreadSidebarGroup(entry), "snoozed");
  const first = sortThreadSidebarEntries([{ ...entry, metadata: { ...entry.metadata, pinned: false } }, entry])[0];
  assert.equal(first?.entryKind === "draft" ? first.metadata.pinned : null, true);
});

test("durable questionnaire state accepts proper questions and rejects approvals", () => {
  const request = {
    id: "request",
    questions: [{ allowOther: false, header: "Route", id: "route", isSecret: false, options: [{ description: "Continue", label: "Approve" }], question: "Continue?" }],
    submitLabel: "Send",
    summary: "Choose a route",
    title: "Questionnaire",
  };
  const pending = { itemId: "item", request, requestKey: "request-key", turnId: "turn" };
  assert.equal(WorkbenchDurableQuestionnaireSchema.safeParse(pending).success, true);
  assert.equal(WorkbenchDurableQuestionnaireSchema.safeParse({ ...pending, request: { ...request, approval: {} } }).success, false);

  const entry = {
    insertAfterItemId: "item",
    insertAfterItemIndex: 1,
    itemId: "item",
    request,
    requestKey: "request-key",
    resolvedAt: 2,
    response: { answers: { route: { answers: ["Approve"] } } },
    threadId: "thread",
    turnId: "turn",
  };
  assert.equal(WorkbenchThreadStateRequestSchema.safeParse({
    entry,
    identity: { harness: "codex", threadId: "thread" },
    method: "workbench/thread-state/questionnaire/resolve",
    projectId: "project",
  }).success, true);
  assert.equal(WorkbenchThreadStateRequestSchema.safeParse({
    identity: { harness: "codex", threadId: "thread" },
    method: "workbench/thread-state/questionnaire/dismiss",
    projectId: "project",
    requestKey: "request-key",
  }).success, true);
  assert.equal(WorkbenchThreadStateRequestSchema.safeParse({
    identity: { harness: "codex", threadId: "thread" },
    method: "workbench/thread-state/questionnaire/dismiss",
    projectId: "project",
  }).success, false);
});

test("top-level threads sort by latest turn start while activity remains display-only", () => {
  const entry = (threadId: string, activityAt: number, orderAt?: number): Extract<WorkbenchThreadSidebarEntry, { entryKind: "thread" }> => ({
    activityAt,
    entryKind: "thread",
    identity: { harness: "codex", threadId },
    lifecycle: { kind: "completed", reason: "providerInactive", settled: false },
    metadata: { archived: false, pinned: false, snoozed: false },
    ...(orderAt === undefined ? {} : { orderAt }),
    title: threadId,
  });
  assert.deepEqual(
    sortThreadSidebarEntries([entry("older-turn-busy", 100, 10), entry("newer-turn-quiet", 1, 20)]).map((candidate) => candidate.entryKind === "thread" ? candidate.identity.threadId : ""),
    ["newer-turn-quiet", "older-turn-busy"],
  );
  assert.deepEqual(
    sortThreadSidebarEntries([entry("fallback-older", 10), entry("fallback-newer", 20)]).map((candidate) => candidate.entryKind === "thread" ? candidate.identity.threadId : ""),
    ["fallback-newer", "fallback-older"],
  );
});

test("planned conflicts share sidebar grouping, exclude subagents, and stabilize irrelevant snapshots", () => {
  const thread = (
    threadId: string,
    lifecycle: Extract<WorkbenchThreadSidebarEntry, { entryKind: "thread" }>["lifecycle"],
    claimedPaths: string[] = [],
  ): Extract<WorkbenchThreadSidebarEntry, { entryKind: "thread" }> => ({
    activityAt: 10,
    entryKind: "thread",
    gitArc: claimedPaths.length ? {
      checkpointCommit: "a".repeat(40), claimedPaths, intentDescription: "", intentName: threadId,
      phase: "active", proposals: [], updatedAt: "2026-08-20T00:00:00.000Z",
    } : null,
    identity: { harness: "codex", threadId },
    lifecycle,
    metadata: { archived: false, pinned: false, snoozed: false },
    title: threadId,
  });
  const owner = {
    ...thread("owner", { kind: "completed", reason: "providerInactive", settled: false }),
    gitArcPlan: {
      checkpointCommit: "b".repeat(40), intentDescription: "", intentName: "plan",
      scopePaths: ["src/feature"], updatedAt: "2026-08-21T00:00:00.000Z",
    },
  };
  const attention = thread("attention", { kind: "needsAttention", reason: "noActiveTurn", settled: false }, ["src/feature/card.tsx"]);
  const pendingAttention = thread("pending-attention", { kind: "needsAttention", reason: "noActiveTurn", settled: false });
  const resolvedAttention = {
    ...thread("resolved-attention", { kind: "needsAttention", reason: "noActiveTurn", settled: false }),
    gitArc: {
      checkpointCommit: "c".repeat(40), claimedPaths: [], intentDescription: "", intentName: "resolved-attention",
      phase: "resolved" as const, proposals: [], updatedAt: "2026-08-20T00:00:00.000Z",
    },
  };
  const completed = thread("completed", { kind: "completed", reason: "providerInactive", settled: false }, ["src/feature"]);
  const working = thread("working", { agent: { agentStatus: "working", turnId: "turn" }, kind: "working", reason: "acceptedIntent", settled: false }, ["src"]);
  const settled = thread("settled", { kind: "completed", reason: "providerInactive", settled: true }, ["src/feature/deep/file.ts"]);
  const unrelated = thread("unrelated", { kind: "completed", reason: "providerInactive", settled: false }, ["docs"]);
  const snoozedAttention = {
    ...thread("snoozed-attention", { kind: "needsAttention", reason: "noActiveTurn", settled: false }),
    metadata: { archived: false as const, pinned: false, snoozed: true },
  };
  const child: Extract<WorkbenchThreadSidebarEntry, { entryKind: "subagent" }> = {
    activityAt: 10, createdAt: 1, cwd: "C:/repo", directSubagentIndex: 0, entryKind: "subagent",
    gitArc: working.gitArc, identity: { harness: "codex", threadId: "child" }, lifecycle: working.lifecycle,
    name: "child", parentThreadId: "owner", pinned: false, profileId: "default", profileName: "Default",
    projectId: "project", title: "child", updatedAt: 10,
  };
  const entries = [owner, settled, working, pendingAttention, completed, attention, unrelated, resolvedAttention, snoozedAttention, child];
  assert.equal(getThreadSidebarGroup(attention), "needsAttentionActive");
  assert.equal(getThreadSidebarGroup(pendingAttention), "needsAttentionPending");
  assert.equal(getThreadSidebarGroup(resolvedAttention), "needsAttentionPending");
  assert.equal(getThreadSidebarGroup(snoozedAttention), "snoozed");
  assert.deepEqual(groupWorkbenchThreadSidebarEntries(entries).primaryEntries.map((entry) => entry.title), [
    "attention", "owner", "completed", "unrelated", "working", "pending-attention", "resolved-attention", "snoozed-attention",
  ]);
  assert.deepEqual(getWorkbenchThreadPlanConflictEntries(entries, owner.identity).map((entry) => entry.title), ["attention", "completed", "working", "settled"]);

  const select = createWorkbenchThreadPlanConflictSelector(owner.identity);
  const snapshot = { entries, error: null, freshness: "fresh" as const, projectId: "project", revision: 1 };
  const first = select(snapshot);
  assert.equal(select({ ...snapshot, error: "unrelated", revision: 2 }), first);
  const changed = select({ ...snapshot, entries: entries.map((entry) => entry === working ? { ...working, title: "working changed" } : entry), revision: 3 });
  assert.notEqual(changed, first);
  assert.equal(changed[2]?.title, "working changed");
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

test("exact-turn transitions reject stale completion and manual settlement becomes completed", () => {
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
  const attention = reduceWorkbenchThreadLifecycle(completed, { kind: "userNeedsAttention" });
  assert.equal(isWorkbenchThreadStatusProviderOwned(attention), false);
  assert.deepEqual(reduceWorkbenchThreadLifecycle(attention, { kind: "settle" }), {
    kind: "completed",
    reason: "userCompleted",
    settled: true,
  });
  assert.equal(reduceWorkbenchThreadLifecycle(working, { kind: "restore" }), working);
  assert.deepEqual(reduceWorkbenchThreadLifecycle(completed, { kind: "userNeedsAttention" }), {
    kind: "needsAttention", reason: "noActiveTurn", settled: false,
  });
  assert.deepEqual(reduceWorkbenchThreadLifecycle(completed, { kind: "userStopped" }), {
    agent: { agentStatus: "completed", turnId: "new" }, kind: "stopped", reason: "userMarkedStopped", settled: false,
  });
  assert.deepEqual(reduceWorkbenchThreadLifecycle(stopped, { kind: "userCompleted" }), {
    kind: "completed", reason: "userCompleted", settled: false,
  });
  const pendingInput = reduceWorkbenchThreadLifecycle(working, { kind: "pendingInput", requestKey: "request", turnId: "new" });
  assert.equal(isWorkbenchThreadStatusProviderOwned(pendingInput), true);
  assert.equal(reduceWorkbenchThreadLifecycle(pendingInput, { kind: "settle" }), pendingInput);
  assert.equal(reduceWorkbenchThreadLifecycle(pendingInput, { kind: "userNeedsAttention" }), pendingInput);
});

test("delivered user input reactivates provider-owned terminal state without overriding user-owned state", () => {
  const working = reduceWorkbenchThreadLifecycle(null, { kind: "acceptedIntent", turnId: "old-turn" });
  const completed = reduceWorkbenchThreadLifecycle(working, { kind: "agentStatus", status: "completed", turnId: "old-turn" });
  const blocked = reduceWorkbenchThreadLifecycle(working, { kind: "agentStatus", status: "blocked", turnId: "old-turn" });
  const delivered = { kind: "userInputDelivered" as const, turnId: "delivered-turn" };
  const reactivated = {
    agent: { agentStatus: "working" as const, turnId: "delivered-turn" },
    kind: "working" as const,
    reason: "acceptedIntent" as const,
    settled: false as const,
  };

  assert.deepEqual(reduceWorkbenchThreadLifecycle(completed, delivered), reactivated);
  assert.deepEqual(reduceWorkbenchThreadLifecycle(blocked, delivered), reactivated);
  assert.deepEqual(reduceWorkbenchThreadLifecycle({ kind: "completed", reason: "providerInactive", settled: true }, delivered), reactivated);

  const userCompleted = reduceWorkbenchThreadLifecycle(completed, { kind: "userCompleted" });
  const providerStopped = reduceWorkbenchThreadLifecycle(working, { kind: "turnCompleted", status: "interrupted", turnId: "old-turn" });
  const userStopped = reduceWorkbenchThreadLifecycle(completed, { kind: "userStopped" });
  const pendingInput = reduceWorkbenchThreadLifecycle(working, { kind: "pendingInput", requestKey: "request", turnId: "old-turn" });
  assert.equal(reduceWorkbenchThreadLifecycle(providerStopped, { kind: "userInputDelivered", turnId: "old-turn" }), providerStopped);
  assert.deepEqual(reduceWorkbenchThreadLifecycle(providerStopped, delivered), reactivated);
  assert.equal(reduceWorkbenchThreadLifecycle(userCompleted, delivered), userCompleted);
  assert.equal(reduceWorkbenchThreadLifecycle(userStopped, delivered), userStopped);
  assert.equal(reduceWorkbenchThreadLifecycle(pendingInput, delivered), pendingInput);
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
