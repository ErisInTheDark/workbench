/*
 * Exports: none. Tests protect state transitions, eligibility, durable schemas and sidebar projection.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { isWorkbenchSidebarThreadCompletionAvailable, WorkbenchPinnedThreadSummaryEntrySchema, WorkbenchThreadObservationSnapshotSchema } from "./thread-state.ts";
import { areAllUnsnoozedThreadEntriesSettlementReady, countDraftPromptTokens, createDraftTitle, createWorkbenchProjectThreadSummary, createWorkbenchThreadPlanIntersectionSelector, getThreadSidebarGroup, getWorkbenchThreadPlanIntersections, gitArcPreventsThreadSettlement, groupWorkbenchThreadSidebarEntries, isWorkbenchThreadSettlementAvailable, isWorkbenchThreadStatusProviderOwned, normalizeWorkbenchTimestampMs, projectWorkbenchThreadSidebarEntries, reduceWorkbenchThreadLifecycle, resolveWorkbenchThreadTitle, WorkbenchDurableQuestionnaireSchema, WorkbenchGitArcLifecycleStateSchema, WorkbenchGitArcPlanStateSchema, WorkbenchPinnedThreadContextResultSchema, WorkbenchThreadDraftSchema, WorkbenchThreadLifecycleSchema, WorkbenchThreadStateMutationResultSchema, WorkbenchThreadStateRequestSchema, WorkbenchThreadStateSnapshotSchema, type WorkbenchThreadSidebarEntry } from "./thread-state.ts";
import * as fixtureIdentitySchemas from "workbench-shared/workbench/identity";

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

const EMPTY_CODEX_SETTINGS = {
  agentPath: null,
  agentSource: null,
  harness: "codex" as const,
  model: "",
  reasoningEffort: null,
  serviceTier: null,
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
    entries: [entry], error: null, freshness: "fresh", revision: 1, updateKind: "threadObservation", version: 1,
  };
  assert.deepEqual(WorkbenchThreadObservationSnapshotSchema.parse(observation).entries, [entry]);
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

test("sidebar completion and pinned eligibility exclude working threads and approval requests", () => {
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
  const approval = { ...entry, pendingQuestionnaire: {
    ...question, request: { ...question.request, questions: [{
      id: "decision", header: "approval", question: "Allow?", allowOther: false, isSecret: false,
      options: [{ label: "Allow once", description: "" }, { label: "Decline", description: "" }],
    }] },
  } };
  assert.equal(isWorkbenchSidebarThreadCompletionAvailable(approval), false);
  for (const [source, expected] of [[entry, true], [approval, false]] as const) {
    const pin = createWorkbenchProjectThreadSummary(fixtureIdentityValues.ProjectId["project"], [source], 1).pinnedThreads[0]!;
    assert.equal(pin.entryKind === "thread" && pin.canCompleteQuestionnaire, expected);
    assert.equal(isWorkbenchSidebarThreadCompletionAvailable(pin), expected);
    const { canCompleteQuestionnaire: _eligibility, ...legacy } = pin as Extract<typeof pin, { entryKind: "thread" }>;
    assert.equal(isWorkbenchSidebarThreadCompletionAvailable(WorkbenchPinnedThreadSummaryEntrySchema.parse(legacy)), false);
  }
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
  assert.equal(gitArcPreventsThreadSettlement(stashed), true);
  assert.equal(gitArcPreventsThreadSettlement({ ...resolved, proposals: [{ proposalId: "pending", status: "proposed" }] }), false);
  assert.equal(gitArcPreventsThreadSettlement({ ...resolved, proposals: [{ proposalId: "accepted", status: "committed" }] }), false);
});

test("current project and global observation versions stay distinct from draft moves", () => {
  assert.deepEqual(WorkbenchThreadStateRequestSchema.parse({
    method: "workbench/thread-state/global/open",
    version: 6,
  }), {
    method: "workbench/thread-state/global/open",
    version: 6,
  });
  assert.equal(WorkbenchThreadStateRequestSchema.safeParse({
    method: "workbench/thread-state/global/open",
    projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("must-not-select"),
    version: 6,
  }).success, false);
  assert.equal(WorkbenchThreadStateRequestSchema.safeParse({
    destinationProjectId: fixtureIdentitySchemas.ProjectIdSchema.parse("beta"),
    draftId: fixtureIdentitySchemas.DraftIdSchema.parse("22222222-2222-4222-8222-222222222222"),
    method: "workbench/thread-state/draft/move",
    sourceProjectId: fixtureIdentitySchemas.ProjectIdSchema.parse("alpha"),
  }).success, true);
  assert.equal(WorkbenchThreadStateRequestSchema.safeParse({
    destinationProjectId: fixtureIdentitySchemas.ProjectIdSchema.parse("alpha"),
    draftId: fixtureIdentitySchemas.DraftIdSchema.parse("22222222-2222-4222-8222-222222222222"),
    method: "workbench/thread-state/draft/move",
    sourceProjectId: fixtureIdentitySchemas.ProjectIdSchema.parse("alpha"),
  }).success, false);
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

test("durable draft writes require prompt or attachment content while stored drafts remain readable", () => {
  const draft = {
    attachments: [],
    clientUpdatedAt: 2,
    composerSettings: EMPTY_CODEX_SETTINGS,
    createdAt: 1,
    draftId: fixtureIdentitySchemas.DraftIdSchema.parse("00000000-0000-4000-8000-000000000022"),
    profileId: null,
    projectId: fixtureIdentityValues.ProjectId.project,
    prompt: " ",
    updatedAt: 2,
  };
  assert.equal(WorkbenchThreadDraftSchema.safeParse(draft).success, true);
  assert.equal(WorkbenchThreadStateRequestSchema.safeParse({
    draft,
    method: "workbench/thread-state/draft/upsert",
    projectId: draft.projectId,
  }).success, false);
  assert.equal(WorkbenchThreadStateRequestSchema.safeParse({
    draft: { ...draft, attachments: [{ id: "shot", url: "image:shot" }] },
    method: "workbench/thread-state/draft/upsert",
    projectId: draft.projectId,
  }).success, true);
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
    entries: [], error: null, freshness: "fresh", projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), revision: 1,
  }).success, true);
  assert.equal(WorkbenchThreadStateSnapshotSchema.safeParse({
    activityAt: 10, identity: { harness: "codex", threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("thread") }, projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), revision: 2, updateKind: "activity",
  }).success, true);
  assert.equal(WorkbenchThreadStateSnapshotSchema.safeParse({
    activityAt: 10, identity: { harness: "codex", threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("thread") }, orderAt: 9, projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), revision: 2, updateKind: "activity",
  }).success, true);
  assert.equal(WorkbenchThreadStateSnapshotSchema.safeParse({
    displayOrder: {}, revision: 2, updateKind: "homeThreadDisplayOrder",
  }).success, true);
  const projectUpdate = WorkbenchThreadStateSnapshotSchema.safeParse({
    projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
    revision: 3,
    snapshot: {
      changes: {}, projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), root: "Project", rootPath: "C:/project",
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
    activityAt: 10, projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), revision: 4, updateKind: "activity",
  }).success, false);
  assert.equal(WorkbenchThreadStateSnapshotSchema.safeParse({
    entries: [], error: null, freshness: "fresh", projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), revision: 5, updateKind: "sidebar",
  }).success, false);
});

test("strict lifecycle rejects impossible combinations", () => {
  assert.equal(WorkbenchThreadLifecycleSchema.safeParse({ kind: "working", reason: "acceptedIntent", settled: true, agent: { agentStatus: "working", turnId: fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("t") } }).success, false);
  assert.equal(WorkbenchThreadLifecycleSchema.safeParse({ kind: "needsAttention", reason: "pendingInput", settled: false, turnId: fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("t") }).success, false);
  assert.equal(WorkbenchThreadLifecycleSchema.safeParse({ kind: "stopped", reason: "providerInterrupted", settled: false }).success, false);
  assert.equal(WorkbenchThreadLifecycleSchema.safeParse({ kind: "completed", reason: "providerInactive", settled: false }).success, true);
});

test("manual status request accepts exactly the three radio statuses", () => {
  const request = { identity: { harness: "codex", threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("thread") }, method: "workbench/thread-state/status/set", projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project") };
  for (const status of ["needsAttention", "completed", "stopped"]) {
    assert.equal(WorkbenchThreadStateRequestSchema.safeParse({ ...request, status }).success, true);
  }
  assert.equal(WorkbenchThreadStateRequestSchema.safeParse({ ...request, status: "working" }).success, false);
  assert.equal(WorkbenchThreadStateRequestSchema.safeParse({ ...request, status: "idle" }).success, false);
});

test("draft priority requests use draft identity and drive shared grouping and ordering", () => {
  const draftId = fixtureIdentitySchemas.DraftIdSchema.parse("00000000-0000-4000-8000-000000000001");
  assert.equal(WorkbenchThreadStateRequestSchema.safeParse({ draftId, method: "workbench/thread-state/draft/pin/set", pinned: true, projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project") }).success, true);
  assert.equal(WorkbenchThreadStateRequestSchema.safeParse({ draftId, method: "workbench/thread-state/draft/snooze/set", projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), snoozed: true }).success, true);
  assert.equal(WorkbenchThreadStateRequestSchema.safeParse({ method: "workbench/thread-state/draft/pin/set", pinned: true, projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project") }).success, false);
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

test("home display-order request requires qualified source and optional destination keys", () => {
  const request = {
    beforeKey: "beta/codex%3Ab",
    destinationFolderKey: null,
    method: "workbench/thread-state/home-display-order/move",
    section: "pinned",
    sourceKey: "alpha/codex%3Aa",
  };
  assert.equal(WorkbenchThreadStateRequestSchema.safeParse(request).success, true);
  assert.equal(WorkbenchThreadStateRequestSchema.safeParse({ ...request, sourceKey: "" }).success, false);
  assert.equal(WorkbenchThreadStateRequestSchema.safeParse({ ...request, section: "main" }).success, false);
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

test("pinned context requests preserve full target identity and responses admit full durable drafts", () => {
  const draftId = "00000000-0000-4000-8000-000000000019";
  const request = {
    method: "workbench/thread-state/pin/open",
    projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("owner"),
    target: { harness: "opencode", kind: "subagent", parentThreadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("parent"), threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("child") },
  };
  assert.equal(WorkbenchThreadStateRequestSchema.safeParse(request).success, true);
  assert.equal(WorkbenchThreadStateRequestSchema.safeParse({ ...request, target: { kind: "subagent", threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("child") } }).success, false);
  assert.equal(WorkbenchPinnedThreadContextResultSchema.safeParse({
    context: {
      entries: [{
        activityAt: 2,
        draft: {
          agent: null,
          attachments: [{ id: "attachment", url: "data:text/plain,hello" }],
          clientUpdatedAt: 2,
          composerSettings: EMPTY_CODEX_SETTINGS,
          createdAt: 1,
          draftId,
          harness: "codex",
          model: null,
          profileId: null,
          projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("owner"),
          prompt: "Private pinned prompt",
          reasoningEffort: null,
          serviceTier: null,
          updatedAt: 2,
        },
        entryKind: "draft",
        metadata: { archived: false, pinned: true, snoozed: false },
        title: "Private pinned prompt",
      }],
      projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("owner"),
      target: { draftId, kind: "draft" },
    },
  }).success, true);
});

test("display-order moves require a reorderable section and explicit insertion key", () => {
  const request = { beforeKey: null, destinationFolderId: null, method: "workbench/thread-state/display-order/move", projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), section: "snoozed", sourceKey: "codex:thread" };
  assert.equal(WorkbenchThreadStateRequestSchema.safeParse(request).success, true);
  assert.equal(WorkbenchThreadStateRequestSchema.safeParse({ ...request, beforeKey: "codex:other" }).success, true);
  assert.equal(WorkbenchThreadStateRequestSchema.safeParse({ ...request, section: "main" }).success, false);
  assert.equal(WorkbenchThreadStateRequestSchema.safeParse({ ...request, sourceKey: "" }).success, false);
});

test("folder mutations require canonical ids, durable thread keys, and non-empty bounded names", () => {
  const folderId = "00000000-0000-4000-8000-000000000020";
  const folderDraft = {
    agent: null, attachments: [], clientUpdatedAt: 2, composerSettings: EMPTY_CODEX_SETTINGS, createdAt: 2,
    draftId: fixtureIdentitySchemas.DraftIdSchema.parse("00000000-0000-4000-8000-000000000021"), harness: "codex", model: null,
    profileId: null, projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), prompt: "folder draft", reasoningEffort: null, serviceTier: null, updatedAt: 2,
  };
  const create = { folderId, method: "workbench/thread-state/display-order/folder/create", projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), sourceKey: "codex:thread", title: "Work" };
  const rename = { folderId, method: "workbench/thread-state/display-order/folder/title/set", projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), title: "Later" };
  assert.equal(WorkbenchThreadStateRequestSchema.safeParse(create).success, true);
  assert.equal(WorkbenchThreadStateRequestSchema.safeParse(rename).success, true);
  assert.equal(WorkbenchThreadStateRequestSchema.safeParse({ ...create, folderId: fixtureIdentitySchemas.FolderIdSchema.parse("folder") }).success, false);
  assert.equal(WorkbenchThreadStateRequestSchema.safeParse({ ...create, sourceKey: "" }).success, false);
  assert.equal(WorkbenchThreadStateRequestSchema.safeParse({ ...rename, title: " " }).success, false);
  assert.equal(WorkbenchThreadStateRequestSchema.safeParse({ draft: folderDraft, folderId, method: "workbench/thread-state/draft/upsert", projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project") }).success, true);
  assert.equal(WorkbenchThreadStateRequestSchema.safeParse({ draft: folderDraft, folderId: fixtureIdentitySchemas.FolderIdSchema.parse("folder"), method: "workbench/thread-state/draft/upsert", projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project") }).success, false);
});

test("drag mutations strictly identify priority, folder, and dependent-snooze intent", () => {
  const folderId = "00000000-0000-4000-8000-000000000022";
  const identity = { harness: "codex", threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("source") };
  const target = { identity: { harness: "opencode", threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("target") }, projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("beta") };
  assert.equal(WorkbenchThreadStateRequestSchema.safeParse({
    method: "workbench/thread-state/priority/set",
    priority: "main",
    projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("alpha"),
    sourceKey: "codex:source",
  }).success, true);
  assert.equal(WorkbenchThreadStateRequestSchema.safeParse({
    destinationFolderId: null,
    folderId,
    method: "workbench/thread-state/display-order/folder/drop",
    projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("alpha"),
    section: "snoozed",
    sourceKey: "codex:source",
    targetKey: "codex:target",
  }).success, true);
  assert.equal(WorkbenchThreadStateRequestSchema.safeParse({
    destinationFolderId: folderId,
    folderId: null,
    method: "workbench/thread-state/pinned-display-order/folder/drop",
    sourceKey: "alpha/codex%3Asource",
    targetKey: "beta/codex%3Atarget",
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
    method: "workbench/thread-state/questionnaire/dismiss",
    projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
    requestKey: "request-key",
  }).success, true);
  assert.equal(WorkbenchThreadStateRequestSchema.safeParse({
    identity: { harness: "codex", threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("thread") },
    method: "workbench/thread-state/questionnaire/dismiss",
    projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
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
  assert.deepEqual(getWorkbenchThreadPlanIntersections([owner], owner.identity), {
    activeEntries: [],
    hasPlannedClaims: true,
    plannedEntries: [],
  });
  const intersections = getWorkbenchThreadPlanIntersections(entries, owner.identity);
  assert.deepEqual(intersections.activeEntries.map(({ entry }) => entry.title), ["working", "completed", "attention", "settled"]);
  assert.deepEqual(intersections.activeEntries.map(({ paths }) => paths), [
    ["src/feature"], ["src/feature"], ["src/feature/card.tsx"], ["src/feature/deep/file.ts"],
  ]);
  assert.deepEqual(intersections.plannedEntries.map(({ entry, paths }) => [entry.title, paths]), [["planned", ["src/feature/planned.ts"]]]);
  const duplicateMatches = getWorkbenchThreadPlanIntersections([
    { ...owner, gitArcPlan: { ...owner.gitArcPlan, scopePaths: ["src/feature", "src/feature/card.tsx"] } },
    { ...attention, gitArc: { ...attention.gitArc!, claimedPaths: ["src/feature/card.tsx", "docs/unrelated.ts"] } },
  ], owner.identity);
  assert.deepEqual(duplicateMatches.activeEntries.map(({ paths }) => paths), [["src/feature/card.tsx"]]);
  assert.equal(getWorkbenchThreadPlanIntersections(entries, { harness: "codex", threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("missing") }).hasPlannedClaims, false);

  const select = createWorkbenchThreadPlanIntersectionSelector(owner.identity);
  const snapshot = { entries, error: null, freshness: "fresh" as const, projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), revision: 1 };
  const first = select(snapshot);
  assert.equal(select({ ...snapshot, error: "unrelated", revision: 2 }), first);
  const changed = select({ ...snapshot, entries: entries.map((entry) => entry === working ? { ...working, title: "working changed" } : entry), revision: 3 });
  assert.notEqual(changed, first);
  assert.equal(changed.activeEntries[0]?.entry.title, "working changed");
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

test("exact-turn transitions reject stale completion and manual settlement becomes completed", () => {
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
  const settled = reduceWorkbenchThreadLifecycle(completed, { kind: "settle" });
  assert.equal(settled.settled, true);
  assert.deepEqual(reduceWorkbenchThreadLifecycle(settled, { kind: "restore" }), completed);
  const stopped = reduceWorkbenchThreadLifecycle(working, { kind: "turnCompleted", status: "interrupted", turnId: fixtureIdentityValues.WorkbenchTurnId["new"] });
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
    agent: { agentStatus: "completed", turnId: fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("new") }, kind: "stopped", reason: "userMarkedStopped", settled: false,
  });
  assert.deepEqual(reduceWorkbenchThreadLifecycle(stopped, { kind: "userCompleted" }), {
    kind: "completed", reason: "userCompleted", settled: false,
  });
  const pendingInput = reduceWorkbenchThreadLifecycle(working, { kind: "pendingInput", requestKey: "request", turnId: fixtureIdentityValues.WorkbenchTurnId["new"] });
  assert.equal(isWorkbenchThreadStatusProviderOwned(pendingInput), true);
  assert.deepEqual(
    reduceWorkbenchThreadLifecycle(pendingInput, { kind: "acceptedIntent", turnId: fixtureIdentityValues.WorkbenchTurnId["new"] }),
    pendingInput,
  );
  assert.equal(reduceWorkbenchThreadLifecycle(pendingInput, { kind: "settle" }), pendingInput);
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
  const providerStopped = reduceWorkbenchThreadLifecycle(working, { kind: "turnCompleted", status: "interrupted", turnId: fixtureIdentityValues.WorkbenchTurnId["old-turn"] });
  const userStopped = reduceWorkbenchThreadLifecycle(completed, { kind: "userStopped" });
  const pendingInput = reduceWorkbenchThreadLifecycle(working, { kind: "pendingInput", requestKey: "request", turnId: fixtureIdentityValues.WorkbenchTurnId["old-turn"] });
  assert.equal(reduceWorkbenchThreadLifecycle(providerStopped, { kind: "userInputDelivered", turnId: fixtureIdentityValues.WorkbenchTurnId["old-turn"] }), providerStopped);
  assert.deepEqual(reduceWorkbenchThreadLifecycle(providerStopped, delivered), reactivated);
  assert.equal(reduceWorkbenchThreadLifecycle(userCompleted, delivered), userCompleted);
  assert.equal(reduceWorkbenchThreadLifecycle(userStopped, delivered), userStopped);
  assert.equal(reduceWorkbenchThreadLifecycle(pendingInput, delivered), pendingInput);
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

test("late same-turn intent admission preserves an unresolved questionnaire", () => {
  const turnId = fixtureIdentityValues.WorkbenchTurnId["turn"];
  const pendingInput = reduceWorkbenchThreadLifecycle(
    reduceWorkbenchThreadLifecycle(null, { kind: "acceptedIntent", turnId }),
    { kind: "pendingInput", requestKey: "request", turnId },
  );

  assert.equal(
    reduceWorkbenchThreadLifecycle(pendingInput, { kind: "acceptedIntent", turnId }),
    pendingInput,
  );
  assert.deepEqual(
    reduceWorkbenchThreadLifecycle(pendingInput, {
      kind: "acceptedIntent",
      turnId: fixtureIdentityValues.WorkbenchTurnId["new"],
    }),
    {
      agent: {
        agentStatus: "working",
        turnId: fixtureIdentityValues.WorkbenchTurnId["new"],
      },
      kind: "working",
      reason: "acceptedIntent",
      settled: false,
    },
  );

  const uncorrelatedPendingInput = reduceWorkbenchThreadLifecycle(
    null,
    { kind: "pendingInput", requestKey: "request" },
  );
  assert.equal(
    reduceWorkbenchThreadLifecycle(uncorrelatedPendingInput, { kind: "acceptedIntent", turnId }),
    uncorrelatedPendingInput,
  );
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

test("completed parent status derives attention before working without mutating durable lifecycle", () => {
  const parent: WorkbenchThreadSidebarEntry = {
    activityAt: 1, entryKind: "thread", identity: { harness: "codex", threadId: fixtureIdentityValues.WorkbenchThreadId["parent"] },
    lifecycle: { kind: "completed", reason: "providerInactive", settled: true },
    metadata: { archived: false, pinned: false, snoozed: false }, title: "Parent",
  };
  const child = (threadId: string, lifecycle: Extract<WorkbenchThreadSidebarEntry, { entryKind: "subagent" }>["lifecycle"]): WorkbenchThreadSidebarEntry => ({
    activityAt: 2, createdAt: 1, cwd: "C:/repo", directSubagentIndex: 0, entryKind: "subagent",
    identity: { harness: "codex", threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse(threadId) }, lifecycle, name: threadId, parentThreadId: fixtureIdentityValues.WorkbenchThreadId["parent"], pinned: false,
    profileId: "default", profileName: "Default", projectId: fixtureIdentityValues.ProjectId["project"], title: threadId, updatedAt: 2,
  });
  const working = child("working", { agent: { agentStatus: "working", turnId: fixtureIdentityValues.WorkbenchTurnId["turn"] }, kind: "working", reason: "acceptedIntent", settled: false });
  const attention = child("attention", { kind: "needsAttention", reason: "noActiveTurn", settled: false });
  const projectedWorking = projectWorkbenchThreadSidebarEntries([parent, working])[0]!;
  const projectedAttention = projectWorkbenchThreadSidebarEntries([parent, working, attention])[0]!;
  assert.equal(projectedWorking.entryKind === "draft" ? null : projectedWorking.lifecycle.kind, "working");
  assert.equal(projectedAttention.entryKind === "draft" ? null : projectedAttention.lifecycle.kind, "needsAttention");
  assert.equal(parent.lifecycle.kind, "completed");
  assert.equal(projectWorkbenchThreadSidebarEntries([parent])[0], parent);
});

test("subagent waits inherit attention before working before waiting while other waits stay waiting", () => {
  const parent: Extract<WorkbenchThreadSidebarEntry, { entryKind: "thread" }> = {
    activityAt: 1, entryKind: "thread", identity: { harness: "codex", threadId: fixtureIdentityValues.WorkbenchThreadId["parent"] },
    lifecycle: { agent: { agentStatus: "working", turnId: fixtureIdentityValues.WorkbenchTurnId["parent-turn"] }, kind: "working", reason: "acceptedIntent", settled: false },
    metadata: { archived: false, pinned: false, snoozed: false }, title: "Parent", waitingFor: "subagents",
  };
  const child = (
    threadId: string,
    lifecycle: Extract<WorkbenchThreadSidebarEntry, { entryKind: "subagent" }>["lifecycle"],
    waitingFor?: "other" | "subagents",
  ): Extract<WorkbenchThreadSidebarEntry, { entryKind: "subagent" }> => ({
    activityAt: 2, createdAt: 1, cwd: "C:/repo", directSubagentIndex: 0, entryKind: "subagent",
    identity: { harness: "codex", threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse(threadId) }, lifecycle, name: threadId, parentThreadId: fixtureIdentityValues.WorkbenchThreadId["parent"], pinned: false,
    profileId: "default", profileName: "Default", projectId: fixtureIdentityValues.ProjectId["project"], title: threadId, updatedAt: 2,
    ...(waitingFor ? { waitingFor } : {}),
  });
  const waiting = child("waiting", { agent: { agentStatus: "working", turnId: fixtureIdentityValues.WorkbenchTurnId["wait-turn"] }, kind: "working", reason: "acceptedIntent", settled: false }, "other");
  const working = child("working", { agent: { agentStatus: "working", turnId: fixtureIdentityValues.WorkbenchTurnId["work-turn"] }, kind: "working", reason: "acceptedIntent", settled: false });
  const attention = child("attention", { kind: "needsAttention", reason: "noActiveTurn", settled: false });
  const projectedWaiting = projectWorkbenchThreadSidebarEntries([parent, waiting])[0]!;
  const projectedWorking = projectWorkbenchThreadSidebarEntries([parent, waiting, working])[0]!;
  const projectedAttention = projectWorkbenchThreadSidebarEntries([parent, waiting, working, attention])[0]!;
  assert.equal(projectedWaiting.entryKind === "thread" ? projectedWaiting.waitingFor : null, "subagents");
  assert.equal(projectedWorking.entryKind === "draft" ? null : projectedWorking.lifecycle.kind, "working");
  assert.equal(projectedWorking.entryKind === "thread" ? projectedWorking.waitingFor : null, undefined);
  assert.equal(projectedAttention.entryKind === "draft" ? null : projectedAttention.lifecycle.kind, "needsAttention");
  assert.equal(projectWorkbenchThreadSidebarEntries([{ ...parent, waitingFor: "other" }, working])[0]!.entryKind === "thread"
    ? (projectWorkbenchThreadSidebarEntries([{ ...parent, waitingFor: "other" }, working])[0] as Extract<WorkbenchThreadSidebarEntry, { entryKind: "thread" }>).waitingFor
    : null, "other");
});

test("project summaries count unsettled top-level status after direct-child projection", () => {
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
  const child: WorkbenchThreadSidebarEntry = {
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
    { ...thread("waiting", { agent: { agentStatus: "working", turnId: fixtureIdentityValues.WorkbenchTurnId["wait-turn"] }, kind: "working", reason: "acceptedIntent", settled: false }), waitingFor: "other" },
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
      working: 1,
    },
    lastThreadUpdateAt: 4,
    pinnedThreads: [],
    projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
    revision: 7,
    unsettledThreads: [
      {
        activityAt: 1,
        identity: { harness: "codex", threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("parent") },
        status: "working",
        title: "parent",
      },
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
  assert.equal(summary.pinnedThreads.some((entry) => entry.title === "Snoozed pin"), false);
  const projectedDraft = summary.pinnedThreads.find((entry) => entry.entryKind === "draft");
  assert.deepEqual(projectedDraft, {
    activityAt: 3,
    draftId,
    entryKind: "draft",
    metadata: { archived: false, pinned: true, snoozed: false },
    status: "draft",
    title: "Pinned draft",
  });
});
