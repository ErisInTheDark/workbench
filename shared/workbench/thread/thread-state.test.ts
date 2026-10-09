/*
 * Exports: none. Tests protect state transitions, eligibility, durable schemas and sidebar projection.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { isWorkbenchSidebarThreadCompletionAvailable, WorkbenchPinnedThreadSummaryEntrySchema, WorkbenchThreadObservationSnapshotSchema } from "./thread-state.ts";
import { areAllUnsnoozedThreadEntriesSettlementReady, countDraftPromptTokens, createDraftTitle, createWorkbenchProjectThreadSummary, createWorkbenchThreadClaimIntersectionSelector, getThreadSidebarGroup, getWorkbenchThreadClaimIntersections, gitArcPreventsThreadSettlement, groupWorkbenchThreadSidebarEntries, hasUnarchivedSidebarWork, isWorkbenchThreadSettlementAvailable, isWorkbenchThreadStatusProviderOwned, normalizeWorkbenchTimestampMs, reduceWorkbenchThreadLifecycle, resolveWorkbenchThreadTitle, WorkbenchDurableQuestionnaireSchema, WorkbenchGitArcLifecycleStateSchema, WorkbenchGitArcPlanStateSchema, WorkbenchThreadDraftSchema, WorkbenchThreadLifecycleSchema, WorkbenchThreadStateMutationResultSchema, WorkbenchThreadStateRequestSchema, type WorkbenchThreadSidebarEntry } from "./thread-state.ts";
import * as fixtureIdentitySchemas from "workbench-shared/workbench/identity";
import { projectSidebarRow } from "./thread-sidebar-row";

const fixtureIdentityValues = {
  DraftId: {
    "draft": fixtureIdentitySchemas.DraftIdSchema.parse("draft"),
  },
  ProjectId: {
    "project": fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
  },
  WorkbenchThreadId: {
    "child": fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("child"),
    "owner": fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("owner"),
    "parent": fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("parent"),
    "pinned": fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("pinned"),
    "thread": fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("thread"),
  },
  WorkbenchTurnId: {
    "new": fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("new"),
    "old": fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("old"),
    "old-turn": fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("old-turn"),
    "parent-turn": fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("parent-turn"),
    "turn": fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("turn"),
    "wait-turn": fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("wait-turn"),
    "work-turn": fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("work-turn"),
  },
};

test("thread status applies without a turn and remains until new work is accepted", () => {
  for (const status of ["completed", "blocked"] as const) {
    const state = reduceWorkbenchThreadLifecycle(null, { kind: "agentStatus", status });
    assert.equal(state?.kind, status === "completed" ? "completed" : "needsAttention");
    assert.equal(WorkbenchThreadLifecycleSchema.safeParse(state).success, true);
    for (const outcome of ["completed", "interrupted", "failed"] as const) {
      assert.deepEqual(reduceWorkbenchThreadLifecycle(state, {
        kind: "turnCompleted", turnId: fixtureIdentityValues.WorkbenchTurnId.old, status: outcome,
      }), state);
    }
    assert.equal(reduceWorkbenchThreadLifecycle(state, {
      kind: "acceptedIntent", turnId: fixtureIdentityValues.WorkbenchTurnId.new,
    }).kind, "working");
  }
});

test("thread input is resolved by question identity rather than turn identity", () => {
  const state = reduceWorkbenchThreadLifecycle(null, { kind: "pendingInput", requestKey: "question" });
  assert.equal(WorkbenchThreadLifecycleSchema.safeParse(state).success, true);
  assert.deepEqual(reduceWorkbenchThreadLifecycle(state, { kind: "inputResolved", requestKey: "other" }), state);
  assert.equal(reduceWorkbenchThreadLifecycle(state, { kind: "inputResolved", requestKey: "question" }).kind, "working");
});

test("observations carry a complete entry without admitting a different thread family", () => {
  const entry: Extract<WorkbenchThreadSidebarEntry, { entryKind: "thread" }> = {
    activityAt: 1, title: "Thread", entryKind: "thread", identity: { harness: "codex", threadId: fixtureIdentityValues.WorkbenchThreadId["thread"] },
    metadata: { archived: false, pinned: true, snoozed: false },
    lifecycle: { kind: "needsAttention", reason: "noActiveTurn", settled: false },
    previousTitles: [{ title: "Earlier", usedAt: 1 }],
    pendingQuestionnaire: {
      itemId: "743c92b1-b79c-49d4-98a4-5b402bf6de6f", requestKey: "request", turnId: fixtureIdentityValues.WorkbenchTurnId["turn"],
      request: { id: "question", title: "Choose", summary: "", submitLabel: "Send", questions: [
        { id: "choice", header: "choice", question: "Proceed?", options: [], allowOther: true, isSecret: false },
      ] },
    },
  };
  const observation = {
    projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), subscriptionId: "7a74a3d2-8223-4cf1-b348-92d299480570",
    target: { kind: "provider", harness: "codex", threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("thread") },
    entries: [entry], error: null, freshness: "fresh", revision: 1, updateKind: "threadObservation", version: 2,
  };
  assert.deepEqual(WorkbenchThreadObservationSnapshotSchema.parse(observation).entries, [{ ...entry, waitingOnThreads: [] }]);
  assert.equal(WorkbenchThreadObservationSnapshotSchema.safeParse({ ...observation, entries: [] }).success, true);
  assert.equal(WorkbenchThreadObservationSnapshotSchema.safeParse({
    ...observation, target: { ...observation.target, threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("another") },
  }).success, false);
  assert.equal(WorkbenchThreadObservationSnapshotSchema.safeParse({ ...observation, entries: [entry, entry] }).success, false);
  const child = {
    activityAt: 1, createdAt: 1, updatedAt: 1, cwd: "/repo", directSubagentIndex: 0, entryKind: "subagent",
    identity: { harness: "opencode", threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("child") }, lifecycle: entry.lifecycle,
    name: "Child", parentThreadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("thread"), pinned: false, profileId: "profile", profileName: "Profile", projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), title: "Child",
  };
  const childObservation = { ...observation, entries: [entry, child],
    target: { kind: "subagent", harness: "opencode", threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("child"), parentThreadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("thread") } };
  assert.equal(WorkbenchThreadObservationSnapshotSchema.safeParse(childObservation).success, true);
  assert.equal(WorkbenchThreadObservationSnapshotSchema.safeParse({
    ...childObservation, target: { ...childObservation.target, harness: "codex" },
  }).success, false);
});

test("sidebar completion and pinned eligibility exclude working threads", () => {
  const question = {
    itemId: "b5bf699f-ea4b-45cf-9583-7449b536ea44", requestKey: "request", turnId: fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("turn"),
    request: { id: "request", title: "Choose", summary: "", submitLabel: "Submit", questions: [] },
  };
  const entry: Extract<WorkbenchThreadSidebarEntry, { entryKind: "thread" }> = {
    activityAt: 1, title: "Task", entryKind: "thread", identity: { harness: "codex", threadId: fixtureIdentityValues.WorkbenchThreadId["thread"] },
    metadata: { archived: false, pinned: true, snoozed: false }, pendingQuestionnaire: question,
    lifecycle: { kind: "needsAttention", reason: "pendingInput", requestKey: "request", turnId: fixtureIdentityValues.WorkbenchTurnId["turn"], settled: false },
  };
  assert.equal(isWorkbenchSidebarThreadCompletionAvailable(entry), true);
  assert.equal(isWorkbenchSidebarThreadCompletionAvailable({ ...entry, pendingQuestionnaire: null }), false);
  assert.equal(isWorkbenchSidebarThreadCompletionAvailable({
    ...entry, lifecycle: { kind: "working", reason: "acceptedIntent", agent: { agentStatus: "working", turnId: fixtureIdentityValues.WorkbenchTurnId["turn"] }, settled: false },
  }), false);
  const pin = createWorkbenchProjectThreadSummary(fixtureIdentityValues.ProjectId["project"], [entry], 1).pinnedThreads[0]!;
  assert.equal(pin.entryKind === "thread" && pin.canCompleteQuestionnaire, true);
  assert.equal(isWorkbenchSidebarThreadCompletionAvailable(pin), true);
  const { canCompleteQuestionnaire: _eligibility, ...legacy } = pin as Extract<typeof pin, { entryKind: "thread" }>;
  assert.equal(isWorkbenchSidebarThreadCompletionAvailable(WorkbenchPinnedThreadSummaryEntrySchema.parse(legacy)), false);
  const completed = reduceWorkbenchThreadLifecycle(entry.lifecycle, { kind: "userCompleted" });
  assert.deepEqual(reduceWorkbenchThreadLifecycle(completed, { kind: "turnCompleted", status: "interrupted", turnId: fixtureIdentityValues.WorkbenchTurnId["turn"] }), completed);
});

test("live claims prevent thread settlement while proposals do not", () => {
  const resolved = {
    checkpointCommit: "a".repeat(40), claimedPaths: [], intentDescription: "", intentName: "arc",
    phase: "resolved" as const, proposals: [], updatedAt: "2026-08-23T00:00:00.000Z",
  };
  assert.equal(gitArcPreventsThreadSettlement(null), false);
  assert.equal(gitArcPreventsThreadSettlement(resolved), false);
  assert.equal(gitArcPreventsThreadSettlement({ ...resolved, claimedPaths: ["owned.ts"], phase: "active" }), true);
  const stashed = {
    ...resolved,
    phase: "stashed" as const,
    stashedPaths: ["owned.ts"],
  };
  assert.equal(WorkbenchGitArcLifecycleStateSchema.safeParse(stashed).success, true);
  assert.equal(WorkbenchGitArcLifecycleStateSchema.safeParse({
    ...stashed, phase: "active", claimedPaths: ["live.ts"],
  }).success, true);
  assert.equal(gitArcPreventsThreadSettlement(stashed), true);
  assert.equal(gitArcPreventsThreadSettlement({ ...resolved, proposals: [{ proposalId: "pending", status: "proposed" }] }), false);
  assert.equal(gitArcPreventsThreadSettlement({ ...resolved, proposals: [{ proposalId: "accepted", status: "committed" }] }), false);
});

test("current Git arc schemas reject retired reload scopes", () => {
  const lifecycle = {
    checkpointCommit: "a".repeat(40),
    claimedPaths: ["webapp"],
    intentDescription: "",
    intentName: "work",
    phase: "active",
    proposals: [],
    reloadScopes: ["server:core"],
    updatedAt: "2026-09-02T00:00:00.000Z",
  };
  const plan = {
    checkpointCommit: "a".repeat(40),
    intentDescription: "",
    intentName: "work",
    reloadScopes: ["server:core"],
    scopePaths: ["webapp"],
    updatedAt: "2026-09-02T00:00:00.000Z",
  };
  assert.equal(WorkbenchGitArcLifecycleStateSchema.safeParse(lifecycle).success, false);
  assert.equal(WorkbenchGitArcPlanStateSchema.safeParse(plan).success, false);
});

test("settlement is available only for unsettled terminal rows without Git blockers", () => {
  const completed = {
    activityAt: 1,
    entryKind: "thread",
    identity: { harness: "codex", threadId: fixtureIdentityValues.WorkbenchThreadId["thread"] },
    lifecycle: { kind: "completed", reason: "providerInactive", settled: false },
    metadata: { archived: false, pinned: false, snoozed: false },
    title: "Thread",
  } satisfies Extract<WorkbenchThreadSidebarEntry, { entryKind: "thread" }>;
  const activeArc = {
    checkpointCommit: "a".repeat(40), claimedPaths: ["owned.ts"], intentDescription: "", intentName: "arc",
    phase: "active" as const, proposals: [], updatedAt: "2026-08-23T00:00:00.000Z",
  };
  assert.equal(isWorkbenchThreadSettlementAvailable(completed), true);
  assert.equal(isWorkbenchThreadSettlementAvailable({ ...completed, lifecycle: { kind: "stopped", reason: "userMarkedStopped", settled: false } }), true);
  assert.equal(isWorkbenchThreadSettlementAvailable({ ...completed, lifecycle: { kind: "needsAttention", reason: "noActiveTurn", settled: false } }), false);
  assert.equal(isWorkbenchThreadSettlementAvailable({ ...completed, lifecycle: { ...completed.lifecycle, settled: true } }), false);
  assert.equal(isWorkbenchThreadSettlementAvailable({ ...completed, gitArc: activeArc }), false);
  assert.equal(isWorkbenchThreadSettlementAvailable({ ...completed, gitArc: { ...activeArc, claimedPaths: [], phase: "resolved", proposals: [{ proposalId: "proposal", status: "proposed" as const }] } }), true);

  const snoozed = { ...completed, metadata: { ...completed.metadata, snoozed: true } };
  const settled = { ...completed, lifecycle: { ...completed.lifecycle, settled: true } };
  const draft: WorkbenchThreadSidebarEntry = {
    activityAt: 2,
    draft: {
      attachments: [], clientUpdatedAt: 2, composerSettings: { agentPath: null, agentSource: null, harness: "codex", model: "", reasoningEffort: null, serviceTier: null }, createdAt: 2,
      draftId: fixtureIdentityValues.DraftId["draft"], profileId: null, projectId: fixtureIdentityValues.ProjectId["project"], prompt: "Draft", updatedAt: 2,
    },
    entryKind: "draft",
    metadata: { archived: false, pinned: false, snoozed: false },
    title: "Draft",
  };
  assert.equal(areAllUnsnoozedThreadEntriesSettlementReady([completed, snoozed, settled]), true);
  assert.equal(areAllUnsnoozedThreadEntriesSettlementReady([{ ...completed, lifecycle: { kind: "needsAttention", reason: "noActiveTurn", settled: false } }, snoozed]), false);
  assert.equal(areAllUnsnoozedThreadEntriesSettlementReady([{ ...completed, gitArc: activeArc }, snoozed]), false);
  assert.equal(areAllUnsnoozedThreadEntriesSettlementReady([draft, snoozed]), false);
});

test("project placement includes settled work and drafts until they are archived", () => {
  const settled = {
    activityAt: 1, entryKind: "thread",
    identity: { harness: "codex", threadId: fixtureIdentityValues.WorkbenchThreadId.thread },
    lifecycle: { kind: "completed", reason: "providerInactive", settled: true },
    metadata: { archived: false, pinned: false, snoozed: false }, title: "Settled",
  } satisfies Extract<WorkbenchThreadSidebarEntry, { entryKind: "thread" }>;
  const draft = {
    activityAt: 2, entryKind: "draft",
    draft: {
      attachments: [], clientUpdatedAt: 2, composerSettings: { agentPath: null, agentSource: null,
        harness: "codex", model: "", reasoningEffort: null, serviceTier: null }, createdAt: 2,
      draftId: fixtureIdentityValues.DraftId.draft, profileId: null,
      projectId: fixtureIdentityValues.ProjectId.project, prompt: "Draft", updatedAt: 2,
    },
    metadata: { archived: false, pinned: false, snoozed: false }, title: "Draft",
  } satisfies Extract<WorkbenchThreadSidebarEntry, { entryKind: "draft" }>;
  assert.equal(hasUnarchivedSidebarWork([settled]), true);
  assert.equal(hasUnarchivedSidebarWork([draft]), true);
  assert.equal(hasUnarchivedSidebarWork([{ ...settled, metadata: { ...settled.metadata, archived: true } }]), false);
  assert.equal(hasUnarchivedSidebarWork([]), false);
});

test("thread state mutation results preserve explicit rejection", () => {
  assert.deepEqual(WorkbenchThreadStateMutationResultSchema.parse({ accepted: false, revision: 4 }), { accepted: false, revision: 4 });
});

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

test("strict lifecycle rejects impossible combinations", () => {
  assert.equal(WorkbenchThreadLifecycleSchema.safeParse({ kind: "working", reason: "acceptedIntent", settled: true, agent: { agentStatus: "working", turnId: fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("t") } }).success, false);
  assert.equal(WorkbenchThreadLifecycleSchema.safeParse({ kind: "needsAttention", reason: "pendingInput", settled: false, turnId: fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("t") }).success, false);
  assert.equal(WorkbenchThreadLifecycleSchema.safeParse({ kind: "stopped", reason: "providerInterrupted", settled: false }).success, false);
  assert.equal(WorkbenchThreadLifecycleSchema.safeParse({ kind: "needsAttention", reason: "interrupted", settled: false }).success, false);
  assert.equal(WorkbenchThreadLifecycleSchema.safeParse({ kind: "completed", reason: "providerInactive", settled: false }).success, true);
});

test("legacy provider-interrupted stops read as interrupts", () => {
  const turnId = fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("t");
  assert.deepEqual(
    WorkbenchThreadLifecycleSchema.parse({ kind: "stopped", reason: "providerInterrupted", settled: false, turnId }),
    { kind: "needsAttention", reason: "interrupted", settled: false, turnId },
  );
  assert.deepEqual(
    WorkbenchThreadLifecycleSchema.parse({ kind: "stopped", reason: "providerInterrupted", settled: true, turnId }),
    { kind: "completed", reason: "userCompleted", settled: true },
  );
});

test("manual status request accepts exactly the three radio statuses", () => {
  const request = { identity: { harness: "codex", threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("thread") }, method: "workbench/thread-state/status/set", projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project") };
  for (const status of ["needsAttention", "completed", "stopped"]) {
    assert.equal(WorkbenchThreadStateRequestSchema.safeParse({ ...request, status }).success, true);
  }
  assert.equal(WorkbenchThreadStateRequestSchema.safeParse({ ...request, status: "working" }).success, false);
  assert.equal(WorkbenchThreadStateRequestSchema.safeParse({ ...request, status: "idle" }).success, false);
});

test("snoozed draft grouping takes precedence over its retained pin", () => {
  const draftId = fixtureIdentitySchemas.DraftIdSchema.parse("00000000-0000-4000-8000-000000000001");
  const entry: Extract<WorkbenchThreadSidebarEntry, { entryKind: "draft" }> = {
    activityAt: 1,
    draft: {
      attachments: [], clientUpdatedAt: 1, composerSettings: { agentPath: null, agentSource: null, harness: "codex", model: "", reasoningEffort: null, serviceTier: null }, createdAt: 1,
      draftId, profileId: null, projectId: fixtureIdentityValues.ProjectId["project"], prompt: "Pinned draft", updatedAt: 1,
    },
    entryKind: "draft",
    metadata: { archived: false, pinned: true, snoozed: true },
    title: "Pinned draft",
  };
  assert.equal(getThreadSidebarGroup(entry), "snoozed");
  assert.equal(entry.metadata.pinned, true);
});

test("legacy draft settings conform from reload-compatible flattened fields", () => {
  const draft = WorkbenchThreadDraftSchema.parse({
    agent: "legacy-agent.md",
    attachments: [],
    clientUpdatedAt: 2,
    composerSettings: {},
    createdAt: 1,
    draftId: fixtureIdentitySchemas.DraftIdSchema.parse("00000000-0000-4000-8000-000000000002"),
    harness: "codex",
    model: "legacy-model",
    profileId: "legacy-profile",
    projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
    prompt: "Legacy draft",
    reasoningEffort: "high",
    serviceTier: "fast",
    updatedAt: 2,
  });
  assert.deepEqual(draft.composerSettings, {
    agentPath: "legacy-agent.md",
    agentSource: null,
    harness: "codex",
    model: "legacy-model",
    reasoningEffort: "high",
    serviceTier: "fast",
  });
});

test("priority and dependent-snooze requests reject invalid intent", () => {
  const identity = { harness: "codex", threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("source") };
  const target = { identity: { harness: "opencode", threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("target") }, projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("beta") };
  assert.equal(WorkbenchThreadStateRequestSchema.safeParse({
    method: "workbench/thread-state/priority/set",
    priority: "main",
    projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("alpha"),
    sourceKey: "codex:source",
  }).success, true);
  assert.equal(WorkbenchThreadStateRequestSchema.safeParse({
    identity,
    method: "workbench/thread-state/snooze/until",
    projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("alpha"),
    target,
  }).success, true);
  assert.equal(WorkbenchThreadStateRequestSchema.safeParse({
    method: "workbench/thread-state/priority/set",
    priority: "settled",
    projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("alpha"),
    sourceKey: "codex:source",
  }).success, false);
  assert.equal(WorkbenchThreadStateRequestSchema.safeParse({
    identity,
    method: "workbench/thread-state/snooze/until",
    projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("alpha"),
    target: { ...target, extra: true },
  }).success, false);
});

test("durable questionnaire state accepts proper questions and rejects approvals", () => {
  const request = {
    id: "request",
    questions: [{ allowOther: false, header: "Route", id: "route", isSecret: false, options: [{ description: "Continue", label: "Approve" }], question: "Continue?" }],
    submitLabel: "Send",
    summary: "Choose a route",
    title: "Questionnaire",
  };
  const pending = { itemId: "item", request, requestKey: "request-key", turnId: fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("turn") };
  assert.equal(WorkbenchDurableQuestionnaireSchema.safeParse(pending).success, true);
  assert.equal(WorkbenchDurableQuestionnaireSchema.safeParse({
    ...pending,
    request: {
      ...request,
      questions: [{ ...request.questions[0], options: [] }],
    },
  }).success, true);
  assert.equal(WorkbenchDurableQuestionnaireSchema.safeParse({ ...pending, request: { ...request, approval: {} } }).success, false);

  const entry = {
    insertAfterItemId: "item",
    insertAfterItemIndex: 1,
    itemId: "item",
    request,
    requestKey: "request-key",
    resolvedAt: 2,
    response: { answers: { route: { answers: ["Approve"] } } },
    threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("thread"),
    turnId: fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("turn"),
  };
  assert.equal(WorkbenchThreadStateRequestSchema.safeParse({
    entry,
    identity: { harness: "codex", threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("thread") },
    method: "workbench/thread-state/questionnaire/resolve",
    projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
  }).success, true);
  assert.equal(WorkbenchThreadStateRequestSchema.safeParse({
    identity: { harness: "codex", threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("thread") },
    method: "workbench/thread-state/stop",
    projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
    requestKey: "request-key",
  }).success, true);
  assert.equal(WorkbenchThreadStateRequestSchema.safeParse({
    identity: { harness: "codex", threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("thread") },
    method: "workbench/thread-state/stop",
    projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
    requestKey: "",
  }).success, false);
});

test("plan intersections classify active and planned siblings while stabilizing irrelevant snapshots", () => {
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
    identity: { harness: "codex", threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse(threadId) },
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
  const working = thread("working", { agent: { agentStatus: "working", turnId: fixtureIdentityValues.WorkbenchTurnId["turn"] }, kind: "working", reason: "acceptedIntent", settled: false }, ["src"]);
  const settled = thread("settled", { kind: "completed", reason: "providerInactive", settled: true }, ["src/feature/deep/file.ts"]);
  const unrelated = thread("unrelated", { kind: "completed", reason: "providerInactive", settled: false }, ["docs"]);
  const planned = {
    ...thread("planned", { kind: "completed", reason: "providerInactive", settled: false }),
    gitArcPlan: {
      checkpointCommit: "d".repeat(40), intentDescription: "", intentName: "planned",
      scopePaths: ["src/feature/planned.ts"], updatedAt: "2026-08-21T00:00:00.000Z",
    },
  };
  const unrelatedPlan = {
    ...thread("unrelated-plan", { kind: "completed", reason: "providerInactive", settled: false }),
    gitArcPlan: {
      checkpointCommit: "e".repeat(40), intentDescription: "", intentName: "unrelated",
      scopePaths: ["docs"], updatedAt: "2026-08-21T00:00:00.000Z",
    },
  };
  const snoozedAttention = {
    ...thread("snoozed-attention", { kind: "needsAttention", reason: "noActiveTurn", settled: false }),
    metadata: { archived: false as const, pinned: false, snoozed: true },
  };
  const child: Extract<WorkbenchThreadSidebarEntry, { entryKind: "subagent" }> = {
    activityAt: 10, createdAt: 1, cwd: "C:/repo", directSubagentIndex: 0, entryKind: "subagent",
    gitArc: working.gitArc, identity: { harness: "codex", threadId: fixtureIdentityValues.WorkbenchThreadId["child"] }, lifecycle: working.lifecycle,
    name: "child", parentThreadId: fixtureIdentityValues.WorkbenchThreadId["owner"], pinned: false, profileId: "default", profileName: "Default",
    projectId: fixtureIdentityValues.ProjectId["project"], title: "child", updatedAt: 10,
  };
  const entries = [owner, settled, working, pendingAttention, completed, attention, unrelated, planned, unrelatedPlan, resolvedAttention, snoozedAttention, child];
  assert.equal(getThreadSidebarGroup(attention), "main");
  assert.equal(getThreadSidebarGroup(pendingAttention), "main");
  assert.equal(getThreadSidebarGroup(resolvedAttention), "main");
  assert.equal(getThreadSidebarGroup(snoozedAttention), "snoozed");
  const grouped = groupWorkbenchThreadSidebarEntries(entries);
  assert.deepEqual(grouped.mainEntries.map((entry) => entry.title), ["owner", "working", "pending-attention", "completed", "attention", "unrelated", "planned", "unrelated-plan", "resolved-attention"]);
  assert.deepEqual(grouped.snoozedEntries.map((entry) => entry.title), ["snoozed-attention"]);
  assert.deepEqual(grouped.settledEntries.map((entry) => entry.title), ["settled"]);
  assert.deepEqual(getWorkbenchThreadClaimIntersections([owner], owner.identity, "plan"), {
    activeEntries: [],
    hasScope: true,
    plannedEntries: [],
  });
  const intersections = getWorkbenchThreadClaimIntersections(entries, owner.identity, "plan");
  assert.deepEqual(intersections.activeEntries.map(({ entry }) => entry.title), ["working", "completed", "attention", "settled"]);
  assert.deepEqual(intersections.activeEntries.map(({ paths }) => paths), [
    ["src/feature"], ["src/feature"], ["src/feature/card.tsx"], ["src/feature/deep/file.ts"],
  ]);
  assert.deepEqual(intersections.plannedEntries.map(({ entry, paths }) => [entry.title, paths]), [["planned", ["src/feature/planned.ts"]]]);
  const duplicateMatches = getWorkbenchThreadClaimIntersections([
    { ...owner, gitArcPlan: { ...owner.gitArcPlan, scopePaths: ["src/feature", "src/feature/card.tsx"] } },
    { ...attention, gitArc: { ...attention.gitArc!, claimedPaths: ["src/feature/card.tsx", "docs/unrelated.ts"] } },
  ], owner.identity, "plan");
  assert.deepEqual(duplicateMatches.activeEntries.map(({ paths }) => paths), [["src/feature/card.tsx"]]);
  assert.equal(getWorkbenchThreadClaimIntersections(entries, { harness: "codex", threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("missing") }, "plan").hasScope, false);

  const select = createWorkbenchThreadClaimIntersectionSelector(owner.identity, "plan");
  const snapshot = { entries, error: null, freshness: "fresh" as const, projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), revision: 1 };
  const first = select(snapshot);
  assert.equal(select({ ...snapshot, error: "unrelated", revision: 2 }), first);
  const changed = select({ ...snapshot, entries: entries.map((entry) => entry === working ? { ...working, title: "working changed" } : entry), revision: 3 });
  assert.notEqual(changed, first);
  assert.equal(changed.activeEntries[0]?.entry.title, "working changed");
});

test("stashed claim intersections use retained paths rather than a pending plan", () => {
  const owner: Extract<WorkbenchThreadSidebarEntry, { entryKind: "thread" }> = {
    activityAt: 10,
    entryKind: "thread" as const,
    gitArc: {
      checkpointCommit: "a".repeat(40), claimedPaths: [], intentDescription: "", intentName: "stash",
      phase: "stashed" as const, proposals: [], stashedPaths: ["src/feature"], updatedAt: "2026-08-20",
    },
    gitArcPlan: {
      checkpointCommit: "b".repeat(40), intentDescription: "", intentName: "plan",
      scopePaths: ["docs"], updatedAt: "2026-08-20",
    },
    identity: { harness: "codex" as const, threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("stashed") },
    lifecycle: { kind: "completed" as const, reason: "providerInactive" as const, settled: false },
    metadata: { archived: false, pinned: false, snoozed: false },
    title: "stashed",
  };
  const sibling = (threadId: string, paths: string[]): Extract<WorkbenchThreadSidebarEntry, { entryKind: "thread" }> => ({
    ...owner,
    gitArc: {
      checkpointCommit: "c".repeat(40), claimedPaths: paths, intentDescription: "", intentName: "active",
      phase: "active" as const, proposals: [], updatedAt: "2026-08-20",
    },
    gitArcPlan: null,
    identity: { harness: "codex" as const, threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse(threadId) },
    title: threadId,
  });
  const entries = [owner, sibling("blocking", ["src/feature/card.tsx"]), sibling("unrelated", ["docs"])];
  const stashed = getWorkbenchThreadClaimIntersections(entries, owner.identity, "stashed");
  assert.deepEqual(stashed.activeEntries.map(({ entry, paths }) => [entry.title, paths]), [["blocking", ["src/feature/card.tsx"]]]);
  assert.deepEqual(stashed.plannedEntries, []);
  assert.deepEqual(getWorkbenchThreadClaimIntersections(entries, owner.identity, "plan").activeEntries.map(({ entry }) => entry.title), ["unrelated"]);
  assert.deepEqual(getWorkbenchThreadClaimIntersections([owner], owner.identity, "stashed").activeEntries, []);
  const mixed = {
    ...owner,
    gitArc: WorkbenchGitArcLifecycleStateSchema.parse({
      ...owner.gitArc, phase: "active", claimedPaths: ["live.ts"],
    }),
  };
  assert.deepEqual(getWorkbenchThreadClaimIntersections(
    [mixed, ...entries.slice(1)].map(projectSidebarRow), owner.identity, "stashed",
  ).activeEntries.map(({ entry }) => entry.title), ["blocking"]);
});

test("lifecycle parsing preserves canonical attention variants and normalizes legacy reasons", () => {
  assert.deepEqual(WorkbenchThreadLifecycleSchema.parse({ kind: "needsAttention", reason: "noActiveTurn", settled: false }), {
    kind: "needsAttention", reason: "noActiveTurn", settled: false,
  });
  assert.deepEqual(WorkbenchThreadLifecycleSchema.parse({ kind: "needsAttention", reason: "pendingInput", requestKey: "request", settled: false, turnId: fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("turn") }), {
    kind: "needsAttention", reason: "pendingInput", requestKey: "request", settled: false, turnId: fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("turn"),
  });
  assert.deepEqual(
    WorkbenchThreadLifecycleSchema.parse({ agent: { agentStatus: "blocked", turnId: fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("turn") }, kind: "needsAttention", reason: "agentBlocked", settled: false }),
    { agent: { agentStatus: "blocked", turnId: fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("turn") }, kind: "needsAttention", reason: "agentBlocked", settled: false },
  );
  for (const lifecycle of [
    { agent: { agentStatus: "working", turnId: fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("turn") }, kind: "needsAttention", reason: "turnEnded", settled: false },
    { kind: "needsAttention", reason: "restartRecoveryFailed", settled: false },
    { kind: "needsAttention", reason: "providerSystemError", settled: false },
  ]) {
    assert.deepEqual(WorkbenchThreadLifecycleSchema.parse(lifecycle), { kind: "needsAttention", reason: "noActiveTurn", settled: false });
  }
  assert.deepEqual(WorkbenchThreadLifecycleSchema.parse({ kind: "completed", reason: "providerInactive", settled: true }), {
    kind: "completed", reason: "providerInactive", settled: true,
  });
});

test("exact-turn transitions reject stale completion and stopped settlement preserves lifecycle", () => {
  const working = reduceWorkbenchThreadLifecycle(null, { kind: "acceptedIntent", turnId: fixtureIdentityValues.WorkbenchTurnId["new"] });
  assert.equal(reduceWorkbenchThreadLifecycle(working, { kind: "turnCompleted", status: "completed", turnId: fixtureIdentityValues.WorkbenchTurnId["old"] }), working);
  const completed = reduceWorkbenchThreadLifecycle(working, { kind: "agentStatus", status: "completed", turnId: fixtureIdentityValues.WorkbenchTurnId["new"] });
  assert.equal(completed.kind, "completed");
  const blocked = reduceWorkbenchThreadLifecycle(working, { kind: "agentStatus", status: "blocked", turnId: fixtureIdentityValues.WorkbenchTurnId["new"] });
  assert.deepEqual(blocked, {
    agent: { agentStatus: "blocked", turnId: fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("new") },
    kind: "needsAttention",
    reason: "agentBlocked",
    settled: false,
  });
  assert.equal(reduceWorkbenchThreadLifecycle(blocked, { kind: "turnCompleted", status: "completed", turnId: fixtureIdentityValues.WorkbenchTurnId["new"] }), blocked);
  const settled = reduceWorkbenchThreadLifecycle(completed, { kind: "settle", entryKind: "thread" });
  assert.equal(settled.settled, true);
  assert.deepEqual(reduceWorkbenchThreadLifecycle(settled, { kind: "restore" }), completed);
  const interrupted = reduceWorkbenchThreadLifecycle(working, { kind: "turnCompleted", status: "interrupted", turnId: fixtureIdentityValues.WorkbenchTurnId["new"] });
  assert.deepEqual(interrupted, { kind: "needsAttention", reason: "interrupted", settled: false, turnId: fixtureIdentityValues.WorkbenchTurnId["new"] });
  assert.equal(isWorkbenchThreadStatusProviderOwned(interrupted), false);
  for (const entryKind of ["thread", "subagent"] as const) {
    assert.deepEqual(reduceWorkbenchThreadLifecycle(interrupted, { kind: "settle", entryKind }), { kind: "completed", reason: "userCompleted", settled: true });
  }
  // A stop marks the thread stopped before the provider's interrupt event can land.
  const stoppedWhileWorking = reduceWorkbenchThreadLifecycle(working, { kind: "userStopped" });
  assert.equal(reduceWorkbenchThreadLifecycle(stoppedWhileWorking, { kind: "turnCompleted", status: "interrupted", turnId: fixtureIdentityValues.WorkbenchTurnId["new"] }), stoppedWhileWorking);
  for (const lifecycle of [reduceWorkbenchThreadLifecycle(completed, { kind: "userStopped" })]) {
    const settledStop = reduceWorkbenchThreadLifecycle(lifecycle, { kind: "settle", entryKind: "thread" });
    assert.deepEqual(settledStop, { ...lifecycle, settled: true });
    assert.deepEqual(reduceWorkbenchThreadLifecycle(settledStop, { kind: "settle", entryKind: "thread" }), settledStop);
    assert.deepEqual(reduceWorkbenchThreadLifecycle(settledStop, { kind: "restore" }), lifecycle);
    const settledSubagent = reduceWorkbenchThreadLifecycle(lifecycle, { kind: "settle", entryKind: "subagent" });
    assert.deepEqual(settledSubagent, {
      ...("agent" in lifecycle && lifecycle.agent ? { agent: lifecycle.agent } : {}),
      kind: "completed", reason: "userCompleted", settled: true,
    });
  }
  const attention = reduceWorkbenchThreadLifecycle(completed, { kind: "userNeedsAttention" });
  assert.equal(isWorkbenchThreadStatusProviderOwned(attention), false);
  assert.deepEqual(reduceWorkbenchThreadLifecycle(attention, { kind: "settle", entryKind: "thread" }), {
    kind: "completed",
    reason: "userCompleted",
    settled: true,
  });
  assert.equal(reduceWorkbenchThreadLifecycle(working, { kind: "restore" }), working);
  assert.deepEqual(reduceWorkbenchThreadLifecycle(completed, { kind: "userNeedsAttention" }), {
    kind: "needsAttention", reason: "noActiveTurn", settled: false,
  });
  assert.deepEqual(reduceWorkbenchThreadLifecycle(completed, { kind: "userStopped" }), {
    agent: { agentStatus: "completed", turnId: fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("new") }, kind: "stopped", reason: "userMarkedStopped", settled: false,
  });
  assert.deepEqual(reduceWorkbenchThreadLifecycle(interrupted, { kind: "userCompleted" }), {
    kind: "completed", reason: "userCompleted", settled: false,
  });
  const pendingInput = reduceWorkbenchThreadLifecycle(working, { kind: "pendingInput", requestKey: "request", turnId: fixtureIdentityValues.WorkbenchTurnId["new"] });
  assert.equal(isWorkbenchThreadStatusProviderOwned(pendingInput), true);
  assert.deepEqual(
    reduceWorkbenchThreadLifecycle(pendingInput, { kind: "acceptedIntent", turnId: fixtureIdentityValues.WorkbenchTurnId["new"] }),
    working,
  );
  assert.equal(reduceWorkbenchThreadLifecycle(pendingInput, { kind: "settle", entryKind: "thread" }), pendingInput);
  assert.equal(reduceWorkbenchThreadLifecycle(pendingInput, { kind: "userNeedsAttention" }), pendingInput);
});

test("delivered user input reactivates provider-owned terminal state without overriding user-owned state", () => {
  const working = reduceWorkbenchThreadLifecycle(null, { kind: "acceptedIntent", turnId: fixtureIdentityValues.WorkbenchTurnId["old-turn"] });
  const completed = reduceWorkbenchThreadLifecycle(working, { kind: "agentStatus", status: "completed", turnId: fixtureIdentityValues.WorkbenchTurnId["old-turn"] });
  const blocked = reduceWorkbenchThreadLifecycle(working, { kind: "agentStatus", status: "blocked", turnId: fixtureIdentityValues.WorkbenchTurnId["old-turn"] });
  const delivered = { kind: "userInputDelivered" as const, turnId: fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("delivered-turn") };
  const reactivated = {
    agent: { agentStatus: "working" as const, turnId: fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("delivered-turn") },
    kind: "working" as const,
    reason: "acceptedIntent" as const,
    settled: false as const,
  };

  assert.deepEqual(reduceWorkbenchThreadLifecycle(completed, delivered), reactivated);
  assert.deepEqual(reduceWorkbenchThreadLifecycle(blocked, delivered), reactivated);
  assert.deepEqual(reduceWorkbenchThreadLifecycle({ kind: "completed", reason: "providerInactive", settled: true }, delivered), reactivated);

  const userCompleted = reduceWorkbenchThreadLifecycle(completed, { kind: "userCompleted" });
  const interrupted = reduceWorkbenchThreadLifecycle(working, { kind: "turnCompleted", status: "interrupted", turnId: fixtureIdentityValues.WorkbenchTurnId["old-turn"] });
  const userStopped = reduceWorkbenchThreadLifecycle(completed, { kind: "userStopped" });
  const pendingInput = reduceWorkbenchThreadLifecycle(working, { kind: "pendingInput", requestKey: "request", turnId: fixtureIdentityValues.WorkbenchTurnId["old-turn"] });
  assert.equal(reduceWorkbenchThreadLifecycle(interrupted, { kind: "userInputDelivered", turnId: fixtureIdentityValues.WorkbenchTurnId["old-turn"] }), interrupted);
  assert.deepEqual(reduceWorkbenchThreadLifecycle(interrupted, delivered), reactivated);
  assert.equal(reduceWorkbenchThreadLifecycle(userCompleted, delivered), userCompleted);
  assert.equal(reduceWorkbenchThreadLifecycle(userStopped, delivered), userStopped);
  assert.equal(reduceWorkbenchThreadLifecycle(pendingInput, delivered), pendingInput);
});

test("a live provider turn revives only lifecycles a turn end or provider snapshot left behind", () => {
  const liveTurnId = fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("live-turn");
  const live = { kind: "providerTurnActive" as const, turnId: liveTurnId };
  const revived = { agent: { agentStatus: "working" as const, turnId: liveTurnId }, kind: "working" as const, reason: "acceptedIntent" as const, settled: false as const };
  const working = reduceWorkbenchThreadLifecycle(null, { kind: "acceptedIntent", turnId: fixtureIdentityValues.WorkbenchTurnId["old-turn"] });
  const ended = reduceWorkbenchThreadLifecycle(working, { kind: "turnCompleted", status: "completed", turnId: fixtureIdentityValues.WorkbenchTurnId["old-turn"] });
  const interrupted = reduceWorkbenchThreadLifecycle(working, { kind: "turnCompleted", status: "interrupted", turnId: fixtureIdentityValues.WorkbenchTurnId["old-turn"] });

  assert.deepEqual(reduceWorkbenchThreadLifecycle(ended, live), revived);
  assert.deepEqual(reduceWorkbenchThreadLifecycle(interrupted, live), revived);
  assert.deepEqual(reduceWorkbenchThreadLifecycle({ kind: "completed", reason: "providerInactive", settled: false }, live), revived);
  assert.deepEqual(reduceWorkbenchThreadLifecycle(working, live), revived, "working follows the turn that is actually moving");
  assert.equal(reduceWorkbenchThreadLifecycle(interrupted, { ...live, turnId: fixtureIdentityValues.WorkbenchTurnId["old-turn"] }), interrupted);

  // Agents keep streaming after reporting status, and questions or user decisions outrank activity.
  const completed = reduceWorkbenchThreadLifecycle(working, { kind: "agentStatus", status: "completed", turnId: fixtureIdentityValues.WorkbenchTurnId["old-turn"] });
  const blocked = reduceWorkbenchThreadLifecycle(working, { kind: "agentStatus", status: "blocked", turnId: fixtureIdentityValues.WorkbenchTurnId["old-turn"] });
  const pendingInput = reduceWorkbenchThreadLifecycle(working, { kind: "pendingInput", requestKey: "request", turnId: fixtureIdentityValues.WorkbenchTurnId["old-turn"] });
  for (const kept of [completed, blocked, pendingInput, reduceWorkbenchThreadLifecycle(ended, { kind: "userCompleted" }), reduceWorkbenchThreadLifecycle(working, { kind: "userStopped" })]) {
    assert.equal(reduceWorkbenchThreadLifecycle(kept, live), kept);
  }
});

test("answered input can reopen terminal lifecycle without changing ordinary resolution", () => {
  const turnId = fixtureIdentityValues.WorkbenchTurnId["turn"];
  for (const status of ["blocked", "completed"] as const) {
    const terminal = reduceWorkbenchThreadLifecycle(
      reduceWorkbenchThreadLifecycle(null, { kind: "acceptedIntent", turnId }),
      { kind: "agentStatus", status, turnId },
    );
    const resolution = { kind: "inputResolved" as const, requestKey: "question", turnId };
    assert.equal(reduceWorkbenchThreadLifecycle(terminal, resolution), terminal);
    const answered = { ...resolution, answered: true as const };
    assert.equal(reduceWorkbenchThreadLifecycle(terminal, answered).kind, "working");
    assert.equal(reduceWorkbenchThreadLifecycle(terminal, { ...answered, turnId: fixtureIdentityValues.WorkbenchTurnId["new"] }), terminal);
  }
});

test("accepted provider intent replaces pending input regardless of its prior turn correlation", () => {
  const turnId = fixtureIdentityValues.WorkbenchTurnId["turn"];
  const pendingInput = reduceWorkbenchThreadLifecycle(
    reduceWorkbenchThreadLifecycle(null, { kind: "acceptedIntent", turnId }),
    { kind: "pendingInput", requestKey: "request", turnId },
  );

  for (const acceptedTurnId of [turnId, fixtureIdentityValues.WorkbenchTurnId["new"]]) {
    assert.deepEqual(reduceWorkbenchThreadLifecycle(pendingInput, {
      kind: "acceptedIntent",
      turnId: acceptedTurnId,
    }), {
      agent: {
        agentStatus: "working",
        turnId: acceptedTurnId,
      },
      kind: "working",
      reason: "acceptedIntent",
      settled: false,
    });
  }

  const uncorrelatedPendingInput = reduceWorkbenchThreadLifecycle(
    null,
    { kind: "pendingInput", requestKey: "request" },
  );
  assert.deepEqual(reduceWorkbenchThreadLifecycle(uncorrelatedPendingInput, { kind: "acceptedIntent", turnId }), {
    agent: { agentStatus: "working", turnId },
    kind: "working",
    reason: "acceptedIntent",
    settled: false,
  });
});

test("grouping keeps terminal status while settlement moves it to other", () => {
  const entry = {
    activityAt: 1,
    entryKind: "thread" as const,
    identity: { harness: "codex" as const, threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("thread") },
    lifecycle: { agent: { agentStatus: "completed" as const, turnId: fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("turn") }, kind: "completed" as const, reason: "agentCompleted" as const, settled: false },
    metadata: { archived: false as const, pinned: false, snoozed: false },
    title: "Thread",
  };
  assert.equal(getThreadSidebarGroup(entry), "main");
  assert.equal(getThreadSidebarGroup({ ...entry, lifecycle: { ...entry.lifecycle, settled: true } }), "settled");
});

test("project summaries count each top-level thread's own status", () => {
  type ThreadEntry = Extract<WorkbenchThreadSidebarEntry, { entryKind: "thread" }>;
  const thread = (
    threadId: string,
    lifecycle: ThreadEntry["lifecycle"],
    gitArc?: ThreadEntry["gitArc"],
    activityAt = 1,
    snoozed = false,
  ): ThreadEntry => ({
    activityAt,
    entryKind: "thread",
    ...(gitArc ? { gitArc } : {}),
    identity: { harness: "codex", threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse(threadId) },
    lifecycle,
    metadata: { archived: false, pinned: false, snoozed },
    title: threadId,
  });
  const arc = {
    checkpointCommit: "a".repeat(40),
    claimedPaths: ["owned.ts"],
    intentDescription: "",
    intentName: "arc",
    phase: "active" as const,
    proposals: [],
    updatedAt: "2026-08-26T00:00:00.000Z",
  };
  const parent = thread("parent", { kind: "completed", reason: "providerInactive", settled: true });
  const child: Extract<WorkbenchThreadSidebarEntry, { entryKind: "subagent" }> = {
    activityAt: 2,
    createdAt: 1,
    cwd: "C:/repo",
    directSubagentIndex: 0,
    entryKind: "subagent",
    identity: { harness: "codex", threadId: fixtureIdentityValues.WorkbenchThreadId["child"] },
    lifecycle: { agent: { agentStatus: "working", turnId: fixtureIdentityValues.WorkbenchTurnId["turn"] }, kind: "working", reason: "acceptedIntent", settled: false },
    name: "child",
    parentThreadId: fixtureIdentityValues.WorkbenchThreadId["parent"],
    pinned: false,
    profileId: "default",
    profileName: "Default",
    projectId: fixtureIdentityValues.ProjectId["project"],
    title: "child",
    updatedAt: 2,
  };
  const summary = createWorkbenchProjectThreadSummary(fixtureIdentityValues.ProjectId["project"], [
    parent,
    child,
    { ...thread("waiting", { agent: { agentStatus: "working", turnId: fixtureIdentityValues.WorkbenchTurnId["wait-turn"] }, kind: "working", reason: "acceptedIntent", settled: false }), waitingFor: "subagents" },
    { ...child, identity: { ...child.identity, threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("blocked-child") }, parentThreadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("waiting"), lifecycle: { agent: { agentStatus: "blocked" }, kind: "needsAttention", reason: "agentBlocked", settled: false } },
    thread("attention", { kind: "needsAttention", reason: "noActiveTurn", settled: false }, arc, 1, true),
    thread("active-attention", { kind: "needsAttention", reason: "noActiveTurn", settled: false }),
    thread("stopped", { kind: "stopped", reason: "userMarkedStopped", settled: false }),
    thread("completed", { kind: "completed", reason: "providerInactive", settled: false }, undefined, 4, true),
    thread("proposed", { kind: "completed", reason: "providerInactive", settled: false }, {
      ...arc,
      claimedPaths: [],
      phase: "resolved",
      proposals: [{ proposalId: "proposal", status: "proposed" }],
    }),
    thread("settled", { kind: "completed", reason: "providerInactive", settled: true }),
  ], 7);
  assert.deepEqual(summary, {
    counts: {
      completed: 0,
      needsAttention: 1,
      needsAttentionActive: 1,
      proposedCommit: 1,
      stopped: 1,
      waiting: 1,
      working: 0,
    },
    lastThreadUpdateAt: 4,
    pinnedThreads: [],
    projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
    revision: 7,
    unsettledThreads: [
      {
        activityAt: 1,
        identity: { harness: "codex", threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("waiting") },
        status: "waiting",
        title: "waiting",
      },
      {
        activityAt: 1,
        identity: { harness: "codex", threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("attention") },
        status: "needsAttention",
        title: "attention",
      },
      {
        activityAt: 1,
        identity: { harness: "codex", threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("active-attention") },
        status: "needsAttentionActive",
        title: "active-attention",
      },
      {
        activityAt: 1,
        identity: { harness: "codex", threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("stopped") },
        status: "stopped",
        title: "stopped",
      },
      {
        activityAt: 1,
        identity: { harness: "codex", threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("proposed") },
        status: "proposedCommit",
        title: "proposed",
      },
    ],
  });
});

test("project summaries expose ordered unsnoozed pins without draft bodies", () => {
  const draftId = fixtureIdentitySchemas.DraftIdSchema.parse("00000000-0000-4000-8000-000000000031");
  const pinnedThread: WorkbenchThreadSidebarEntry = {
    activityAt: 2,
    entryKind: "thread",
    identity: { harness: "codex", threadId: fixtureIdentityValues.WorkbenchThreadId["pinned"] },
    lifecycle: { agent: { agentStatus: "working", turnId: fixtureIdentityValues.WorkbenchTurnId["turn"] }, kind: "working", reason: "acceptedIntent", settled: false },
    metadata: { archived: false, pinned: true, snoozed: false },
    title: "Pinned provider",
    waitingOnThreads: [{
      identity: { harness: "codex", threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("target") },
      projectId: fixtureIdentityValues.ProjectId["project"], title: "Target",
    }],
  };
  const summary = createWorkbenchProjectThreadSummary(fixtureIdentityValues.ProjectId["project"], [
    {
      activityAt: 3,
      draft: {
        attachments: [{ id: "private-attachment", url: "https://example.invalid/private" }],
        clientUpdatedAt: 3,
        composerSettings: { agentPath: null, agentSource: null, harness: "codex", model: "", reasoningEffort: null, serviceTier: null },
        createdAt: 1,
        draftId,
        profileId: null,
        projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
        prompt: "private draft body",
        updatedAt: 3,
      },
      entryKind: "draft",
      metadata: { archived: false, pinned: true, snoozed: false },
      title: "Pinned draft",
    },
    pinnedThread,
    {
      ...pinnedThread,
      identity: { harness: "codex", threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("snoozed") },
      metadata: { archived: false, pinned: true, snoozed: true },
      title: "Snoozed pin",
    },
  ], 4, {
    pinned: {
      "codex:pinned": { above: [], below: [`draft:${draftId}`] },
      [`draft:${draftId}`]: { above: ["codex:pinned"], below: [] },
    },
  });

  assert.deepEqual(summary.pinnedThreads.map((entry) => entry.title), ["Pinned provider", "Pinned draft"]);
  const projectedThread = summary.pinnedThreads.find((entry) => entry.entryKind === "thread");
  assert.deepEqual(projectedThread?.waitingOnThreads, pinnedThread.waitingOnThreads);
  const parsedOldPin = WorkbenchPinnedThreadSummaryEntrySchema.parse({
    ...projectedThread, waitingOnThreads: undefined,
  });
  assert.equal(parsedOldPin.entryKind, "thread");
  if (parsedOldPin.entryKind === "thread") assert.deepEqual(parsedOldPin.waitingOnThreads, []);
  assert.equal(summary.pinnedThreads.some((entry) => entry.title === "Snoozed pin"), false);
  const projectedDraft = summary.pinnedThreads.find((entry) => entry.entryKind === "draft");
  assert.deepEqual(projectedDraft, {
    activityAt: 3,
    draftId,
    entryKind: "draft",
    hasAttachments: true,
    metadata: { archived: false, pinned: true, snoozed: false },
    status: "draft",
    title: "Pinned draft",
  });
});
