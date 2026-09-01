/* No production exports. Tests protect strict lifecycle, grouping, cross-project pin summaries, folder mutation, ordering, and draft rules. */
import assert from "node:assert/strict";
import test from "node:test";
import { areAllUnsnoozedThreadEntriesSettlementReady, countDraftPromptTokens, createDraftTitle, createWorkbenchProjectThreadSummary, createWorkbenchThreadPlanIntersectionSelector, getThreadSidebarGroup, getWorkbenchThreadPlanIntersections, gitArcPreventsThreadSettlement, groupWorkbenchThreadSidebarEntries, isWorkbenchThreadSettlementAvailable, isWorkbenchThreadStatusProviderOwned, normalizeWorkbenchTimestampMs, projectWorkbenchThreadSidebarEntries, reduceWorkbenchThreadLifecycle, resolveWorkbenchThreadTitle, WorkbenchDurableQuestionnaireSchema, WorkbenchPinnedThreadContextResultSchema, WorkbenchThreadDraftSchema, WorkbenchThreadLifecycleSchema, WorkbenchThreadStateMutationResultSchema, WorkbenchThreadStateRequestSchema, WorkbenchThreadStateSnapshotSchema, type WorkbenchThreadSidebarEntry } from "./thread-state";

const EMPTY_CODEX_SETTINGS = {
  agentPath: null,
  agentSource: null,
  harness: "codex" as const,
  model: "",
  reasoningEffort: null,
  serviceTier: null,
};

test("live claims and proposed commit proposals prevent thread settlement", () => {
  const resolved = {
    checkpointCommit: "a".repeat(40), claimedPaths: [], intentDescription: "", intentName: "arc",
    phase: "resolved" as const, proposals: [], updatedAt: "2026-08-23T00:00:00.000Z",
  };
  assert.equal(gitArcPreventsThreadSettlement(null), false);
  assert.equal(gitArcPreventsThreadSettlement(resolved), false);
  assert.equal(gitArcPreventsThreadSettlement({ ...resolved, claimedPaths: ["owned.ts"], phase: "active" }), true);
  assert.equal(gitArcPreventsThreadSettlement({ ...resolved, proposals: [{ proposalId: "pending", status: "proposed" }] }), true);
  assert.equal(gitArcPreventsThreadSettlement({ ...resolved, proposals: [{ proposalId: "accepted", status: "committed" }] }), false);
});

test("global observation and draft moves use distinct strict version 4 requests", () => {
  assert.deepEqual(WorkbenchThreadStateRequestSchema.parse({
    method: "workbench/thread-state/global/open",
    version: 4,
  }), {
    method: "workbench/thread-state/global/open",
    version: 4,
  });
  assert.equal(WorkbenchThreadStateRequestSchema.safeParse({
    method: "workbench/thread-state/global/open",
    projectId: "must-not-select",
    version: 4,
  }).success, false);
  assert.equal(WorkbenchThreadStateRequestSchema.safeParse({
    destinationProjectId: "beta",
    draftId: "22222222-2222-4222-8222-222222222222",
    method: "workbench/thread-state/draft/move",
    sourceProjectId: "alpha",
  }).success, true);
  assert.equal(WorkbenchThreadStateRequestSchema.safeParse({
    destinationProjectId: "alpha",
    draftId: "22222222-2222-4222-8222-222222222222",
    method: "workbench/thread-state/draft/move",
    sourceProjectId: "alpha",
  }).success, false);
});

test("settlement is available only for unsettled terminal rows without Git blockers", () => {
  const completed = {
    activityAt: 1,
    entryKind: "thread",
    identity: { harness: "codex", threadId: "thread" },
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
  assert.equal(isWorkbenchThreadSettlementAvailable({ ...completed, gitArc: { ...activeArc, claimedPaths: [], phase: "resolved", proposals: [{ proposalId: "proposal", status: "proposed" as const }] } }), false);

  const snoozed = { ...completed, metadata: { ...completed.metadata, snoozed: true } };
  const settled = { ...completed, lifecycle: { ...completed.lifecycle, settled: true } };
  const draft: WorkbenchThreadSidebarEntry = {
    activityAt: 2,
    draft: {
      agent: null, attachments: [], clientUpdatedAt: 2, composerSettings: { agentPath: null, agentSource: null, harness: "codex", model: "", reasoningEffort: null, serviceTier: null }, createdAt: 2,
      draftId: "draft", harness: "codex", model: null, profileId: null, projectId: "project", prompt: "Draft",
      reasoningEffort: null, serviceTier: null, updatedAt: 2,
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
  assert.equal(WorkbenchThreadStateSnapshotSchema.safeParse({
    displayOrder: {}, revision: 2, updateKind: "homeThreadDisplayOrder",
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
      agent: null, attachments: [], clientUpdatedAt: 1, composerSettings: { agentPath: null, agentSource: null, harness: "codex", model: "", reasoningEffort: null, serviceTier: null }, createdAt: 1,
      draftId, harness: "codex", model: null, profileId: null, projectId: "project", prompt: "Pinned draft",
      reasoningEffort: null, serviceTier: null, updatedAt: 1,
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
    draftId: "00000000-0000-4000-8000-000000000002",
    harness: "codex",
    model: "legacy-model",
    profileId: "legacy-profile",
    projectId: "project",
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
    projectId: "owner",
    target: { harness: "opencode", kind: "subagent", parentThreadId: "parent", threadId: "child" },
  };
  assert.equal(WorkbenchThreadStateRequestSchema.safeParse(request).success, true);
  assert.equal(WorkbenchThreadStateRequestSchema.safeParse({ ...request, target: { kind: "subagent", threadId: "child" } }).success, false);
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
          projectId: "owner",
          prompt: "Private pinned prompt",
          reasoningEffort: null,
          serviceTier: null,
          updatedAt: 2,
        },
        entryKind: "draft",
        metadata: { archived: false, pinned: true, snoozed: false },
        title: "Private pinned prompt",
      }],
      projectId: "owner",
      target: { draftId, kind: "draft" },
    },
  }).success, true);
});

test("display-order moves require a reorderable section and explicit insertion key", () => {
  const request = { beforeKey: null, destinationFolderId: null, method: "workbench/thread-state/display-order/move", projectId: "project", section: "snoozed", sourceKey: "codex:thread" };
  assert.equal(WorkbenchThreadStateRequestSchema.safeParse(request).success, true);
  assert.equal(WorkbenchThreadStateRequestSchema.safeParse({ ...request, beforeKey: "codex:other" }).success, true);
  assert.equal(WorkbenchThreadStateRequestSchema.safeParse({ ...request, section: "main" }).success, false);
  assert.equal(WorkbenchThreadStateRequestSchema.safeParse({ ...request, sourceKey: "" }).success, false);
});

test("folder mutations require canonical ids, durable thread keys, and non-empty bounded names", () => {
  const folderId = "00000000-0000-4000-8000-000000000020";
  const folderDraft = {
    agent: null, attachments: [], clientUpdatedAt: 2, composerSettings: EMPTY_CODEX_SETTINGS, createdAt: 2,
    draftId: "00000000-0000-4000-8000-000000000021", harness: "codex", model: null,
    profileId: null, projectId: "project", prompt: "folder draft", reasoningEffort: null, serviceTier: null, updatedAt: 2,
  };
  const create = { folderId, method: "workbench/thread-state/display-order/folder/create", projectId: "project", sourceKey: "codex:thread", title: "Work" };
  const rename = { folderId, method: "workbench/thread-state/display-order/folder/title/set", projectId: "project", title: "Later" };
  assert.equal(WorkbenchThreadStateRequestSchema.safeParse(create).success, true);
  assert.equal(WorkbenchThreadStateRequestSchema.safeParse(rename).success, true);
  assert.equal(WorkbenchThreadStateRequestSchema.safeParse({ ...create, folderId: "folder" }).success, false);
  assert.equal(WorkbenchThreadStateRequestSchema.safeParse({ ...create, sourceKey: "" }).success, false);
  assert.equal(WorkbenchThreadStateRequestSchema.safeParse({ ...rename, title: " " }).success, false);
  assert.equal(WorkbenchThreadStateRequestSchema.safeParse({ draft: folderDraft, folderId, method: "workbench/thread-state/draft/upsert", projectId: "project" }).success, true);
  assert.equal(WorkbenchThreadStateRequestSchema.safeParse({ draft: folderDraft, folderId: "folder", method: "workbench/thread-state/draft/upsert", projectId: "project" }).success, false);
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
    gitArc: working.gitArc, identity: { harness: "codex", threadId: "child" }, lifecycle: working.lifecycle,
    name: "child", parentThreadId: "owner", pinned: false, profileId: "default", profileName: "Default",
    projectId: "project", title: "child", updatedAt: 10,
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
  assert.deepEqual(intersections.activeEntries.map((entry) => entry.title), ["working", "completed", "attention", "settled"]);
  assert.deepEqual(intersections.plannedEntries.map((entry) => entry.title), ["planned"]);
  assert.equal(getWorkbenchThreadPlanIntersections(entries, { harness: "codex", threadId: "missing" }).hasPlannedClaims, false);

  const select = createWorkbenchThreadPlanIntersectionSelector(owner.identity);
  const snapshot = { entries, error: null, freshness: "fresh" as const, projectId: "project", revision: 1 };
  const first = select(snapshot);
  assert.equal(select({ ...snapshot, error: "unrelated", revision: 2 }), first);
  const changed = select({ ...snapshot, entries: entries.map((entry) => entry === working ? { ...working, title: "working changed" } : entry), revision: 3 });
  assert.notEqual(changed, first);
  assert.equal(changed.activeEntries[0]?.title, "working changed");
});

test("lifecycle parsing preserves canonical attention variants and normalizes legacy reasons", () => {
  assert.deepEqual(WorkbenchThreadLifecycleSchema.parse({ kind: "needsAttention", reason: "noActiveTurn", settled: false }), {
    kind: "needsAttention", reason: "noActiveTurn", settled: false,
  });
  assert.deepEqual(WorkbenchThreadLifecycleSchema.parse({ kind: "needsAttention", reason: "pendingInput", requestKey: "request", settled: false, turnId: "turn" }), {
    kind: "needsAttention", reason: "pendingInput", requestKey: "request", settled: false, turnId: "turn",
  });
  assert.deepEqual(
    WorkbenchThreadLifecycleSchema.parse({ agent: { agentStatus: "blocked", turnId: "turn" }, kind: "needsAttention", reason: "agentBlocked", settled: false }),
    { agent: { agentStatus: "blocked", turnId: "turn" }, kind: "needsAttention", reason: "agentBlocked", settled: false },
  );
  for (const lifecycle of [
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
  const blocked = reduceWorkbenchThreadLifecycle(working, { kind: "agentStatus", status: "blocked", turnId: "new" });
  assert.deepEqual(blocked, {
    agent: { agentStatus: "blocked", turnId: "new" },
    kind: "needsAttention",
    reason: "agentBlocked",
    settled: false,
  });
  assert.equal(reduceWorkbenchThreadLifecycle(blocked, { kind: "turnCompleted", status: "completed", turnId: "new" }), blocked);
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
  assert.equal(getThreadSidebarGroup(entry), "main");
  assert.equal(getThreadSidebarGroup({ ...entry, lifecycle: { ...entry.lifecycle, settled: true } }), "settled");
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

test("subagent waits inherit attention before working before waiting while other waits stay waiting", () => {
  const parent: Extract<WorkbenchThreadSidebarEntry, { entryKind: "thread" }> = {
    activityAt: 1, entryKind: "thread", identity: { harness: "codex", threadId: "parent" },
    lifecycle: { agent: { agentStatus: "working", turnId: "parent-turn" }, kind: "working", reason: "acceptedIntent", settled: false },
    metadata: { archived: false, pinned: false, snoozed: false }, title: "Parent", waitingFor: "subagents",
  };
  const child = (
    threadId: string,
    lifecycle: Extract<WorkbenchThreadSidebarEntry, { entryKind: "subagent" }>["lifecycle"],
    waitingFor?: "other" | "subagents",
  ): Extract<WorkbenchThreadSidebarEntry, { entryKind: "subagent" }> => ({
    activityAt: 2, createdAt: 1, cwd: "C:/repo", directSubagentIndex: 0, entryKind: "subagent",
    identity: { harness: "codex", threadId }, lifecycle, name: threadId, parentThreadId: "parent", pinned: false,
    profileId: "default", profileName: "Default", projectId: "project", title: threadId, updatedAt: 2,
    ...(waitingFor ? { waitingFor } : {}),
  });
  const waiting = child("waiting", { agent: { agentStatus: "working", turnId: "wait-turn" }, kind: "working", reason: "acceptedIntent", settled: false }, "other");
  const working = child("working", { agent: { agentStatus: "working", turnId: "work-turn" }, kind: "working", reason: "acceptedIntent", settled: false });
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
    identity: { harness: "codex", threadId },
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
    identity: { harness: "codex", threadId: "child" },
    lifecycle: { agent: { agentStatus: "working", turnId: "turn" }, kind: "working", reason: "acceptedIntent", settled: false },
    name: "child",
    parentThreadId: "parent",
    pinned: false,
    profileId: "default",
    profileName: "Default",
    projectId: "project",
    title: "child",
    updatedAt: 2,
  };
  const summary = createWorkbenchProjectThreadSummary("project", [
    parent,
    child,
    { ...thread("waiting", { agent: { agentStatus: "working", turnId: "wait-turn" }, kind: "working", reason: "acceptedIntent", settled: false }), waitingFor: "other" },
    thread("attention", { kind: "needsAttention", reason: "noActiveTurn", settled: false }),
    thread("active-attention", { kind: "needsAttention", reason: "noActiveTurn", settled: false }, arc),
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
    projectId: "project",
    revision: 7,
    unsettledThreads: [
      {
        activityAt: 1,
        identity: { harness: "codex", threadId: "parent" },
        status: "working",
        title: "parent",
      },
      {
        activityAt: 1,
        identity: { harness: "codex", threadId: "waiting" },
        status: "waiting",
        title: "waiting",
      },
      {
        activityAt: 1,
        identity: { harness: "codex", threadId: "attention" },
        status: "needsAttention",
        title: "attention",
      },
      {
        activityAt: 1,
        identity: { harness: "codex", threadId: "active-attention" },
        status: "needsAttentionActive",
        title: "active-attention",
      },
      {
        activityAt: 1,
        identity: { harness: "codex", threadId: "stopped" },
        status: "stopped",
        title: "stopped",
      },
      {
        activityAt: 1,
        identity: { harness: "codex", threadId: "proposed" },
        status: "proposedCommit",
        title: "proposed",
      },
    ],
  });
});

test("project summaries expose ordered unsnoozed pins without draft bodies", () => {
  const draftId = "00000000-0000-4000-8000-000000000031";
  const pinnedThread: WorkbenchThreadSidebarEntry = {
    activityAt: 2,
    entryKind: "thread",
    identity: { harness: "codex", threadId: "pinned" },
    lifecycle: { agent: { agentStatus: "working", turnId: "turn" }, kind: "working", reason: "acceptedIntent", settled: false },
    metadata: { archived: false, pinned: true, snoozed: false },
    title: "Pinned provider",
  };
  const summary = createWorkbenchProjectThreadSummary("project", [
    {
      activityAt: 3,
      draft: {
        agent: null,
        attachments: [{ private: "attachment body" }],
        clientUpdatedAt: 3,
        composerSettings: { agentPath: null, agentSource: null, harness: "codex", model: "", reasoningEffort: null, serviceTier: null },
        createdAt: 1,
        draftId,
        harness: "codex",
        model: null,
        profileId: null,
        projectId: "project",
        prompt: "private draft body",
        reasoningEffort: null,
        serviceTier: null,
        updatedAt: 3,
      },
      entryKind: "draft",
      metadata: { archived: false, pinned: true, snoozed: false },
      title: "Pinned draft",
    },
    pinnedThread,
    {
      ...pinnedThread,
      identity: { harness: "codex", threadId: "snoozed" },
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
