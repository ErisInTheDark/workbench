/* No production exports. Protect durable identity admission, observations and shared publication. */
/*
 * No exports. Tests protect canonical references, durable alias convergence, projection timing and body-free live projection.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { captureTestOutput } from "../../test/capture-test-output.mts";
import Database from "better-sqlite3";
import type { Thread } from "workbench-shared/codex/generated/app-server/v2/Thread";
import { readWorkbenchTurnHistory } from "workbench-shared/codex/thread-adapter";
import type { WorkbenchThreadTurnHistoryEntry } from "workbench-shared/types";
import type { ThreadItem } from "workbench-shared/codex/generated/app-server/v2/ThreadItem";
import { getWorkbenchThreadItemIdentityKind } from "workbench-shared/workbench/thread/thread-item-identity";
import { getWorkbenchInputState } from "workbench-shared/workbench/thread/thread-input-item";
import { installWorkbenchDatabaseSchema } from "./database/workbench-database-schema";
import WorkbenchThreadIdentityRepository from "./database/thread-identity/WorkbenchThreadIdentityRepository";
import WorkbenchTranscriptIdentityRepository from "./database/transcript/WorkbenchTranscriptIdentityRepository";
import WorkbenchThreadIdentityController from "./WorkbenchThreadIdentityController";
import WorkbenchTranscriptIdentityController from "./WorkbenchTranscriptIdentityController";
import { admitProviderThreads, admitProviderThreadItems, admitProviderNotifications, mapProviderThread, mapProviderThreadItem, mapProviderTurn, mapProviderNotification } from "./CodexProviderIdentity";
import { withWorkbenchTurnAdmission } from "workbench-shared/workbench/thread/thread-admission";
import { normalizeProviderSidebarEntry } from "./WorkbenchThreadStateFeature";
import CodexProviderObservations, { mapProviderLifecycleNotification } from "./CodexProviderObservations";
import { admitCodexTranscriptObservations as admitNativeTranscriptObservations, mapCodexTranscriptObservation as mapNativeTranscriptObservation } from "./CodexProviderObservations";
import { createWorkbenchQuestionnaireStatePorts } from "./thread-identity-workbench-mapping";
import { mapNativeProviderResponse, mapWorkbenchProviderRequest } from "./CodexPublicIdentity";
import { resolveQuestionnaireHistoryItemId } from "workbench-shared/workbench/thread/thread-questionnaire-identity";
import WorkbenchHarnessController from "./WorkbenchHarnessController";
import WorkbenchWebSocketRequestController from "./WorkbenchWebSocketRequestController";
import type { BridgeClient, JsonRpcRequest } from "./bridge-types";
import WorkbenchTranscriptRepository from "./database/transcript/WorkbenchTranscriptRepository";
import WorkbenchThreadStateRelationalRepository from "./database/thread-state/WorkbenchThreadStateRelationalRepository";
import WorkbenchThreadStateQuestionnaireRepository from "./database/thread-state/WorkbenchThreadStateQuestionnaireRepository";
import type { NativeTranscriptAtomicObservation } from "./database/transcript/workbench-transcript-types";
import type { ServerNotification } from "workbench-shared/codex/generated/app-server/ServerNotification";
import WorkbenchThreadGitFeature from "./WorkbenchThreadGitFeature";
import WorkbenchGitArcFeature from "./WorkbenchGitArcFeature";
import type WorkbenchWorkspaceGitArcController from "./WorkbenchWorkspaceGitArcController";
import { NativeThreadIdSchema, NativeTurnIdSchema, ProjectIdSchema } from "workbench-shared/workbench/identity";
import { WorkbenchThreadSidebarEntrySchema } from "workbench-shared/workbench/thread/thread-state";
import type WorkbenchThreadStateController from "./WorkbenchThreadStateController";
import * as fixtureIdentitySchemas from "workbench-shared/workbench/identity";
import { testProjectIds } from "workbench-shared/workbench/test-identities";

const fixtureIdentityValues = {
  NativeThreadId: {
    "remote-child": fixtureIdentitySchemas.NativeThreadIdSchema.parse("remote-child"),
    "session": fixtureIdentitySchemas.NativeThreadIdSchema.parse("session"),
  },
  NativeTurnId: {
    "unobserved-turn": fixtureIdentitySchemas.NativeTurnIdSchema.parse("unobserved-turn"),
  },
  ProjectId: {
    "project": testProjectIds.project,
  },
};

async function setup(platform: NodeJS.Platform = process.platform) {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  installWorkbenchDatabaseSchema(database);
  const repository = new WorkbenchThreadIdentityRepository(database, platform);
  const itemRepository = new WorkbenchTranscriptIdentityRepository(database);
  const threads = new WorkbenchThreadIdentityController({
    listThreadIdentities: async () => repository.list(),
    observeThreadIdentities: async (inputs) => repository.observeMany(inputs),
    resolveThreadIdentity: async (input) => repository.resolve(input),
    resolveNativeThreadIdentity: async (input) => repository.resolveNative(input),
    observeTurnIdentities: async (inputs) => repository.observeTurns(inputs),
    resolveTurnIdentity: async (input) => repository.resolveTurn(input),
  }, platform);
  let admissions = 0;
  const items = new WorkbenchTranscriptIdentityController({
    admitTranscriptItemIdentities: async (input) => {
      admissions += 1;
      return itemRepository.admitMany(input);
    },
    resolveTranscriptItemIdentity: async () => { throw new Error("Unexpected projection database read"); },
  });
  const native = { harness: "codex", nativeLocation: "C:/repo", nativeThreadId: NativeThreadIdSchema.parse("native-parent"), nativeTurnId: NativeTurnIdSchema.parse("native-turn") };
  const parent = await threads.observe({
    native, projectId: fixtureIdentityValues.ProjectId.project, projectRoot: "C:/repo", title: "Parent",
    createdAt: 1, updatedAt: 1, activityAt: 1,
  });
  const child = await threads.observe({
    native: { ...native, nativeThreadId: NativeThreadIdSchema.parse("native-child") },
    projectId: fixtureIdentityValues.ProjectId.project, projectRoot: "C:/repo", title: "Child",
    createdAt: 1, updatedAt: 1, activityAt: 1,
  });
  const turn = await threads.observeTurn({
    kind: "turn", threadId: parent.threadId, turnId: native.nativeTurnId, harnessId: native.harness,
    nativeLocation: native.nativeLocation, nativeThreadId: native.nativeThreadId, nativeTurnId: native.nativeTurnId,
    state: "inProgress", createdAt: 1, startedAt: 1, endedAt: null, durationMs: null,
  });
  return { database, owners: { threads, items }, native, parent, child, turn, admissions: () => admissions };
}

test("accepted-intent ingress resolves canonical ownership before publishing lifecycle evidence", async () => {
  const { database, owners, native, parent, child, turn } = await setup();
  const emitted: Array<{ id?: number; error?: { message: string }; result?: { accepted: boolean } }> = [];
  const accepted: Array<{ threadId: string; turnId: string }> = [];
  const client: BridgeClient = {
    OPEN: 1, readyState: 1, close() {}, on() {}, once() {},
    send(data, callback) { emitted.push(JSON.parse(String(data))); callback?.(); },
  };
  const harnesses = new WorkbenchHarnessController({
    identities: owners.threads,
    providers: { get: () => { throw new Error("Lifecycle evidence must not execute a provider request"); } },
  });
  const controller = new WorkbenchWebSocketRequestController({
    harnesses, identities: owners,
    reportDelivery: delivery => controller.completeDelivery(delivery),
    setTimeout: () => 0 as unknown as ReturnType<typeof setTimeout>, clearTimeout() {},
    reload: { getReloadDirtSnapshot: () => ({ dirtyScopes: [], error: null, pendingScopes: [] }), subscribeReloadDirt: () => () => {} },
    threadState: {
      acceptIntent: async (_connection, input) => {
        const admitted = owners.threads.knownTurn(input.turnId);
        assert.equal(admitted.threadId, input.threadId);
        accepted.push(input);
        return { accepted: true, revision: accepted.length };
      },
      disconnect: async () => {},
      handleRequest: async () => { throw new Error("Unexpected thread-state request"); },
    },
    transcript: { read: async () => null, subscribe: async () => {}, unsubscribe() {} },
    writeLine() {},
  });
  const send = async (id: number, projectId: string, threadId: string, turnId: string) => {
    await controller.handleMessage(client, "socket", Buffer.from(JSON.stringify({
      id, method: "workbench/thread-state/accepted",
      params: { harness: "codex", projectId, threadId, turnId },
    })), false);
    return emitted.find(message => message.id === id);
  };
  try {
    assert.equal((await send(1, parent.projectId, parent.threadId, turn.turnId))?.error, undefined);
    assert.equal((await send(2, parent.projectId, native.nativeThreadId, native.nativeTurnId))?.error, undefined);
    assert.deepEqual(accepted.map(({ threadId, turnId }) => ({ threadId, turnId })), [
      { threadId: parent.threadId, turnId: turn.turnId },
      { threadId: parent.threadId, turnId: turn.turnId },
    ]);
    assert.ok((await send(3, "wrong-project", parent.threadId, turn.turnId))?.error);
    assert.ok((await send(4, child.projectId, child.threadId, turn.turnId))?.error);
    assert.equal(accepted.length, 2);
  } finally {
    controller.dispose();
    owners.threads.dispose();
    owners.items.dispose();
    database.close();
  }
});

test("Git arc mutations and state callbacks share the canonical Workbench owner", async () => {
  const { database, owners, native, parent } = await setup();
  const contexts: string[] = [];
  const refreshed: string[] = [];
  const registryOwners: string[] = [];
  const feature = new WorkbenchGitArcFeature({
    identities: owners.threads,
    getThreadCreatedAt: async () => 1,
    getThreadClaimContext: async (_projectId, _harness, threadId) => {
      contexts.push(threadId);
      return threadId === parent.threadId
        ? { title: "Parent", lifecycle: { kind: "needsAttention", reason: "noActiveTurn", settled: false } }
        : null;
    },
    refreshThreadGitArcState: async (_projectId, _harness, threadId) => { refreshed.push(threadId); },
    resolveProjectFromCwd: async () => ({ cwd: native.nativeLocation, project: { id: parent.projectId } }),
    transitions: { run: async (_key, operation) => operation() },
  });
  const local = (feature as unknown as {
    controller: { createAndStartPlan: (input: { threadId: string }) => Promise<object> };
  }).controller;
  local.createAndStartPlan = async input => {
    registryOwners.push(input.threadId);
    return { phase: "active" };
  };
  try {
    const response = await feature.executeRequest({
      action: "planStart", cwd: native.nativeLocation, harness: "codex",
      threadId: parent.threadId, intentName: "identity boundary", paths: ["src/example.ts"],
    });
    assert.equal(response.status, 200, await response.text());
    assert.deepEqual(registryOwners, [parent.threadId]);
    assert.deepEqual(contexts, [parent.threadId, parent.threadId]);
    assert.deepEqual(refreshed, [parent.threadId]);
    const registry = (feature as unknown as { workspaceController: WorkbenchWorkspaceGitArcController }).workspaceController;
    const base = {
      checkpointCommit: "a".repeat(40), harness: "codex", intentDescription: "", intentName: "identity boundary",
      threadId: parent.threadId, updatedAt: "2026-09-10T00:00:00.000Z",
    };
    const member = { ...base, repoRoot: native.nativeLocation, rootId: parent.projectId, rootIds: [parent.projectId] };
    const lifecycle = {
      ...base, phase: "active" as const, claimedPaths: ["src/example.ts"], proposals: [],
      members: [{ ...member, phase: "active" as const, claimedPaths: ["src/example.ts"], proposals: [] }],
    };
    const plan = { ...base, scopePaths: ["src/example.ts"], members: [{ ...member, scopePaths: ["src/example.ts"] }] };
    registry.findLifecycleState = async (_project, _harness, threadId) => threadId === parent.threadId ? lifecycle : null;
    registry.findPlanState = async (_project, _harness, threadId) => threadId === parent.threadId ? plan : null;
    registry.listLifecycleStates = async () => [lifecycle];
    registry.listPlanStates = async () => [plan];
    registry.hasLiveClaims = async (_project, _harness, threadId) => threadId === parent.threadId;
    const pruned: string[] = [];
    registry.pruneThreadHistories = async (_project, identities) => {
      pruned.push(...identities.map(identity => identity.threadId));
      return { prunedRefCount: 0, registryEntryRemoved: false };
    };
    assert.equal((await feature.findLifecycleState(native.nativeLocation, "codex", parent.threadId))?.threadId, parent.threadId);
    assert.equal((await feature.findPlanState(native.nativeLocation, "codex", parent.threadId))?.threadId, parent.threadId);
    assert.equal(await feature.hasLiveClaims(native.nativeLocation, "codex", parent.threadId), true);
    const [listedLifecycle] = await feature.listLifecycleStates(native.nativeLocation);
    const [listedPlan] = await feature.listPlanStates(native.nativeLocation);
    assert.equal(listedLifecycle?.threadId, parent.threadId);
    assert.equal(listedLifecycle?.members[0]?.threadId, parent.threadId);
    assert.equal(listedPlan?.threadId, parent.threadId);
    assert.equal(listedPlan?.members[0]?.threadId, parent.threadId);
    await feature.pruneThreadHistories(native.nativeLocation, [{ harness: "codex", threadId: parent.threadId }]);
    assert.deepEqual(pruned, [parent.threadId]);
  } finally {
    feature.dispose();
    owners.threads.dispose();
    owners.items.dispose();
    database.close();
  }
});

test("questionnaire ports retain WB identities through resolve, publication, clearing and observation", async () => {
  const { database, owners, native, parent, turn } = await setup();
  const questionnaire = {
    itemId: randomUUID(), turnId: turn.turnId, requestKey: "question",
    request: { id: "question", questions: [{ id: "q", header: "", question: "Continue?", allowOther: true, isSecret: false, options: [] }],
      submitLabel: "Submit", summary: "", title: "Continue?" },
  };
  const entry = WorkbenchThreadSidebarEntrySchema.parse({
    entryKind: "thread", identity: { harness: "codex", threadId: parent.threadId },
    title: "Parent", activityAt: 1, metadata: { archived: false, pinned: false, snoozed: false },
    lifecycle: { kind: "needsAttention", reason: "pendingInput", requestKey: "question", turnId: turn.turnId, settled: false },
    pendingQuestionnaire: questionnaire,
  });
  let listener: Parameters<WorkbenchThreadStateController["subscribe"]>[0] | undefined;
  const observed: Array<{ threadId: typeof parent.threadId; questionnaire: Parameters<WorkbenchThreadStateController["setPendingQuestionnaire"]>[2] | null }> = [];
  assert.ok(entry.entryKind === "thread");
  const storedEntry = {
    ...entry, providerObserved: true, mcpGeneration: null,
    profile: null, settledAt: null, gitHistoryCleanedAt: null, snoozedUntil: null,
  };
  new WorkbenchThreadStateRelationalRepository(database).writeRecords([{ ...storedEntry, pendingQuestionnaire: null }]);
  const questionnaires = new WorkbenchThreadStateQuestionnaireRepository(database);
  const ports = createWorkbenchQuestionnaireStatePorts(owners, {
    getCanonicalThreadEntry: async () => storedEntry,
    setPendingQuestionnaire: async (_projectId, threadId, questionnaire) => {
      questionnaires.replace(threadId, { pending: questionnaire, history: [] });
      observed.push({ threadId, questionnaire });
      return storedEntry;
    },
    clearPendingQuestionnaire: async (_projectId, threadId) => {
      questionnaires.replace(threadId, { pending: null, history: [] });
      observed.push({ threadId, questionnaire: null });
      return storedEntry;
    },
    subscribe: callback => { listener = callback; return () => { listener = undefined; return true; }; },
  }, async () => parent.projectId);
  try {
    const resolved = await ports.resolveThread(native.nativeLocation, parent.threadId);
    assert.equal(resolved.turnId, turn.turnId);
    assert.equal(resolved.pendingQuestionnaire?.turnId, turn.turnId);
    assert.equal(resolved.pendingQuestionnaire?.itemId, questionnaire.itemId);
    await ports.publishPending(parent.threadId, questionnaire);
    assert.equal(observed[0]?.threadId, parent.threadId);
    const pending = observed[0]?.questionnaire;
    assert.ok(pending);
    assert.equal(pending.turnId, turn.turnId);
    assert.equal(questionnaires.read(parent.threadId).pending?.itemId, questionnaire.itemId);
    await ports.publishPending(parent.threadId, questionnaire);
    assert.equal(questionnaires.read(parent.threadId).pending?.itemId, questionnaire.itemId);
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM workbench_transcript_item_identities WHERE id = ?")
      .get(questionnaire.itemId) as { count: number }).count, 1);
    const published = observed.length;
    owners.items.admit = async () => { throw new Error("item admission failed"); };
    await assert.rejects(ports.publishPending(parent.threadId, {
      ...questionnaire, itemId: randomUUID(),
    }), /item admission failed/);
    assert.equal(observed.length, published);
    assert.equal(questionnaires.read(parent.threadId).pending?.itemId, questionnaire.itemId);
    await ports.clearPending(parent.threadId, questionnaire.requestKey);
    assert.equal(observed.at(-1)?.threadId, parent.threadId);
    assert.equal(questionnaires.read(parent.threadId).pending, null);
    const notices: Array<{ threadId: string; requestKey: string | null }> = [];
    const stop = ports.subscribePending(notice => notices.push(notice));
    listener?.(parent.projectId, entry);
    assert.equal(notices[0]?.threadId, parent.threadId);
    assert.equal(notices[0]?.requestKey, questionnaire.requestKey);
    stop();
  } finally {
    owners.threads.dispose();
    owners.items.dispose();
    database.close();
  }
});

test("unowned native evidence cannot publish a turn as canonical ownership", async () => {
  const { database, owners, native } = await setup();
  try {
    assert.throws(() => mapNativeTranscriptObservation(owners, native, {
      kind: "nativeEvidence", harnessId: "codex", nativeLocation: native.nativeLocation,
      nativeThreadId: native.nativeThreadId, nativeTurnId: native.nativeTurnId, nativeItemId: null,
      nativeEventId: null, clientId: null, nativeSequence: null, recordKind: "event", payloadJson: "{}",
      recordedAt: 1, threadId: null, turnId: native.nativeTurnId, itemId: null,
    }), /owning thread/);
  } finally {
    owners.threads.dispose();
    owners.items.dispose();
    database.close();
  }
});

test("equivalent Windows paths preserve the admitted turn location at durable recording", async () => {
  const { database, owners, native, parent, turn } = await setup("win32");
  try {
    const observation = mapNativeTranscriptObservation(owners, { ...native, nativeLocation: "\\\\?\\C:\\REPO" }, {
      kind: "turn", threadId: native.nativeThreadId, turnId: native.nativeTurnId,
      harnessId: native.harness, nativeLocation: "\\\\?\\C:\\REPO", nativeThreadId: native.nativeThreadId,
      nativeTurnId: native.nativeTurnId, state: "completed", createdAt: 1, startedAt: 1, endedAt: 2, durationMs: 1,
    });
    assert.equal(observation.kind, "turn");
    if (observation.kind !== "turn") throw new Error("Expected a turn observation.");
    assert.equal(observation.nativeLocation, native.nativeLocation);
    assert.equal(observation.turnId, turn.turnId);
    new WorkbenchTranscriptRepository(database).settle([observation]);
    assert.equal(owners.threads.knownTurn(turn.turnId).threadId, parent.threadId);
    assert.deepEqual(database.pragma("foreign_key_check"), []);
  } finally { owners.threads.dispose(); owners.items.dispose(); database.close(); }
});

test("thread Git resolves public and native callers to the same existing selection", async () => {
  const { database, owners, native, parent } = await setup();
  const selected: string[] = [];
  const feature = new WorkbenchThreadGitFeature({
    identities: owners.threads,
    resolveProjectFromCwd: async () => ({ cwd: "C:/repo", project: { id: fixtureIdentityValues.ProjectId.project } }),
    transitions: { run: async (_root, operation) => operation() },
    createThreadGit: async ({ threadId }) => {
      selected.push(threadId);
      return {
        repoRoot: "C:/repo",
        add: async () => ({ changedPaths: [], selectedPaths: [] }),
        unstage: async () => ({ changedPaths: [], selectedPaths: [] }),
        commit: async () => { throw new Error("Unexpected commit"); },
      };
    },
  });
  try {
    for (const threadId of [native.nativeThreadId, parent.threadId]) {
      assert.equal((await feature.executeRequest({ action: "add", cwd: "C:/repo", threadId, paths: [] })).status, 200);
    }
    assert.deepEqual(selected, [parent.threadId, parent.threadId]);
    assert.equal((await feature.executeRequest({ action: "add", cwd: "C:/repo", threadId: "missing", paths: [] })).status, 400);
    assert.equal(selected.length, 2);
  } finally { database.close(); }
});

test("cold native thread lookup admits exact metadata before public request routing", async () => {
  const { database, owners } = await setup();
  const requests: JsonRpcRequest[] = [];
  const { default: CodexThreadOperations } = await import("./CodexThreadOperations");
  const request = async (request: JsonRpcRequest) => {
    requests.push(request);
    return { id: request.id ?? null, result: { thread: {
      id: "unobserved", cwd: "C:/repo", createdAt: 1, updatedAt: 1,
      name: "Cold", source: "cli", parentThreadId: null, turns: [], status: { type: "idle" },
    } as Thread } };
  };
  const operations = new CodexThreadOperations({
    identities: owners,
    resolveProject: async () => ({ id: fixtureIdentityValues.ProjectId.project, rootPath: "C:/repo" }),
    bridge: {
      canDeliverQuestionnaire: () => false,
      ensureInitialized: async () => {},
      handleServerRequest: request,
    },
  });
  const unused = async (): Promise<never> => { throw new Error("Unexpected configuration read"); };
  const harnesses = new WorkbenchHarnessController({
    identities: owners.threads,
    providers: { get: () => ({
      threads: operations,
      configuration: { models: { read: unused }, modelContext: { read: unused }, guidance: { contains: unused } },
    }) },
  });
  try {
    const request = { method: "thread/read", params: { threadId: "unobserved", includeTurns: false } };
    await harnesses.resolveThreadIdentity({ harness: "codex", threadId: fixtureIdentitySchemas.ThreadReferenceSchema.parse("unobserved") });
    const routed = await mapWorkbenchProviderRequest(owners.threads, "codex", request);
    const identity = await owners.threads.resolve({ threadId: fixtureIdentitySchemas.ThreadReferenceSchema.parse("unobserved"), harness: "codex" });
    assert.ok(identity);
    assert.notEqual(identity.threadId, "unobserved");
    assert.equal((routed.request.params as { threadId: string }).threadId, "unobserved");
    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.method, "thread/read");
    assert.equal((requests[0]!.params as { includeTurns: boolean }).includeTurns, false);
    await harnesses.resolveThreadIdentity({ harness: "codex", threadId: identity.threadId });
    assert.equal(requests.length, 1);
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM thread_items").get() as { count: number }).count, 0);
  } finally { database.close(); }
});

test("repeated provider catalogues admit only new identity evidence without hiding conflicts", async (context) => {
  const warnings = captureTestOutput(context, process.stderr, text => text.startsWith("[workbench-transcript] conflicting aliases retained"));
  context.after(() => assert.equal(warnings.length, 1));
  const fixture = await setup();
  const { database, owners, native, parent, turn } = fixture;
  try {
    const message: ThreadItem = { type: "userMessage", id: "native-message", content: [], clientId: null };
    const thread: Thread & { workbenchTurnHistory: WorkbenchThreadTurnHistoryEntry[] } = {
      id: native.nativeThreadId, cwd: native.nativeLocation, createdAt: 1, updatedAt: 2,
      extra: null, sessionId: "native-session", forkedFromId: null, preview: "", ephemeral: false,
      section: null, sectionEnteredAt: null, projectId: null, historyMode: "paginated",
      modelProvider: "openai", model: null, reasoningEffort: null, recencyAt: null,
      status: { type: "idle" }, path: null, cliVersion: "test", canAcceptDirectInput: null,
      threadSource: null, agentNickname: null, agentRole: null, gitInfo: null, name: null,
      source: "cli", parentThreadId: null,
      turns: [{
        id: native.nativeTurnId, items: [message], itemsView: "full", status: "completed",
        error: null, startedAt: 1, completedAt: 2, durationMs: 1,
      }],
      workbenchTurnHistory: [{
        turnId: native.nativeTurnId, loadState: "loaded", status: "completed",
        startedAt: 1, completedAt: 2, durationMs: 1, itemCount: 1, itemIds: [message.id],
      }],
    };
    const admit = () => admitProviderThreads(owners, [{
      metadata: { native, projectId: fixtureIdentityValues.ProjectId["project"], projectRoot: "C:/repo", title: "Parent",
        createdAt: 1, updatedAt: 2, activityAt: 2 },
      thread,
    }]);
    await admit();
    const itemId = mapProviderThread(owners, native, thread).turns[0]!.items[0]!.id;
    const initialAdmissions = fixture.admissions();
    await admit();
    assert.equal(fixture.admissions(), initialAdmissions, "Unchanged catalogues must not queue database admission");

    message.clientId = "new-client";
    thread.workbenchTurnHistory[0]!.itemTimeline = [{
      itemId: message.id, aliases: ["retained-message"], firstSeenAt: 1, lastSeenAt: 2, startedAt: 1, completedAt: 2,
    }];
    await admit();
    const repository = new WorkbenchTranscriptIdentityRepository(database);
    for (const reference of ["new-client", "retained-message"]) {
      assert.equal(repository.resolve({ threadId: parent.threadId, turnId: turn.turnId, itemId: fixtureIdentitySchemas.ItemReferenceSchema.parse(reference) })?.itemId, itemId);
    }
    assert.equal(fixture.admissions(), initialAdmissions + 1);
    await admit();
    assert.equal(fixture.admissions(), initialAdmissions + 1);

    await owners.items.admit([{
      threadId: parent.threadId, sources: [{ turnId: turn.turnId, kind: "client", reference: "other-client" }],
    }]);
    const otherClientId = repository.resolve({ threadId: parent.threadId, turnId: turn.turnId, itemId: fixtureIdentitySchemas.ItemReferenceSchema.parse("other-client") })!.itemId;
    message.clientId = "other-client";
    await admit();
    assert.equal(mapProviderThread(owners, native, thread).turns[0]!.items[0]!.id, itemId);
    assert.equal(repository.resolve({ threadId: parent.threadId, turnId: turn.turnId, itemId: fixtureIdentitySchemas.ItemReferenceSchema.parse("other-client") })?.itemId, otherClientId);
    assert.equal(repository.resolve({ threadId: parent.threadId, turnId: turn.turnId, itemId: fixtureIdentitySchemas.ItemReferenceSchema.parse("new-client") })?.itemId, itemId);
    assert.deepEqual(database.pragma("foreign_key_check"), []);
  } finally { owners.items.dispose(); owners.threads.dispose(); database.close(); }
});

for (const route of ["catalogue", "event", "recorder"] as const) {
  for (const evidence of ["recorded-client", "structural-client"] as const) {
  test(`correlated identity refreshes warm projection references through ${route} admission (${evidence})`, async (context) => {
    const fixture = await setup();
    const { database, owners, native, parent, turn } = fixture;
    const warnings = context.mock.method(console, "warn", () => undefined);
    try {
      const sourceId = evidence === "recorded-client" ? "native-message" : "item-1";
      const message: ThreadItem = {
        type: "userMessage", id: sourceId, clientId: "submitted",
        content: [{ type: "text", text: "preserve my input", text_elements: [] }],
      };
      const clientSource = { turnId: turn.turnId, kind: "client" as const, reference: "submitted" };
      const [structural] = await owners.items.admit([
        { threadId: parent.threadId, sources: [
          { turnId: turn.turnId, kind: "stable", reference: "native-message" },
          ...(evidence === "structural-client" ? [clientSource] : []),
        ] },
      ]);
      const recorded = new WorkbenchTranscriptIdentityRepository(database).admit(
        { threadId: parent.threadId, sources: [
          { turnId: turn.turnId, kind: "provisional", reference: "item-1" },
          ...(evidence === "recorded-client" ? [clientSource] : []),
        ] },
      );
      const repository = new WorkbenchTranscriptRepository(database);
      repository.settle([{
        kind: "turn", threadId: parent.threadId, turnId: turn.turnId, harnessId: native.harness,
        nativeLocation: native.nativeLocation, nativeThreadId: native.nativeThreadId, nativeTurnId: native.nativeTurnId,
        state: "completed", createdAt: 1, startedAt: 1, endedAt: 2, durationMs: 1,
      }, {
        kind: "item", threadId: parent.threadId, turnId: turn.turnId, publicItemId: recorded!.itemId,
        lifecycle: "completed", observedAt: 3, item: { ...message, id: "item-1" },
      }]);
      const before = database.prepare("SELECT * FROM thread_items").all();
      const event = { method: "item/completed" as const, params: {
        threadId: native.nativeThreadId, turnId: native.nativeTurnId, item: message, completedAtMs: 2_000,
      } };
      const observation: NativeTranscriptAtomicObservation = {
        kind: "item", threadId: native.nativeThreadId, turnId: native.nativeTurnId,
        lifecycle: "completed", observedAt: 3, item: message,
      };
      const thread: Thread = {
        id: native.nativeThreadId, cwd: native.nativeLocation, createdAt: 1, updatedAt: 2,
        extra: null, sessionId: "native-session", forkedFromId: null, preview: "", ephemeral: false,
        section: null, sectionEnteredAt: null, projectId: null, historyMode: "paginated",
        modelProvider: "openai", model: null, reasoningEffort: null, recencyAt: null,
        status: { type: "idle" }, path: null, cliVersion: "test", canAcceptDirectInput: null,
        threadSource: null, agentNickname: null, agentRole: null, gitInfo: null, name: null,
        source: "cli", parentThreadId: null,
        turns: [{ id: native.nativeTurnId, items: [message], itemsView: "full", status: "completed",
          error: null, startedAt: 1, completedAt: 2, durationMs: 1 }],
      };
      const admit = () => route === "catalogue"
        ? admitProviderThreads(owners, [{ thread, metadata: {
          native, projectId: fixtureIdentityValues.ProjectId["project"], projectRoot: "C:/repo", title: "Parent",
          createdAt: 1, updatedAt: 2, activityAt: 2,
        } }])
        : route === "event" ? admitProviderNotifications(owners, native, [event])
          : admitNativeTranscriptObservations(owners, [observation]);
      await admit();
      const admissions = fixture.admissions();
      await admit();
      assert.equal(fixture.admissions(), admissions, "The repaired evidence must stop scheduling duplicate admission.");
      const canonicalItemId = owners.items.itemIdForReference(
        parent.threadId,
        turn.turnId,
        fixtureIdentitySchemas.ItemReferenceSchema.parse("submitted"),
      );
      assert.ok(canonicalItemId);
      for (const reference of ["native-message", "item-1", "submitted"]) {
        assert.equal(
          owners.items.itemIdForReference(
            parent.threadId,
            turn.turnId,
            fixtureIdentitySchemas.ItemReferenceSchema.parse(reference),
          ),
          canonicalItemId,
        );
      }
      assert.equal(mapProviderThread(owners, native, thread).turns[0]!.items[0]!.id, canonicalItemId);
      const mappedEvent = mapProviderNotification(owners, native, event);
      assert.equal(mappedEvent.method, "item/completed");
      if (mappedEvent.method === "item/completed") assert.equal(mappedEvent.params.item.id, canonicalItemId);
      const mappedObservation = mapNativeTranscriptObservation(owners, native, observation);
      assert.equal(mappedObservation.kind, "item");
      if (mappedObservation.kind === "item") assert.equal(mappedObservation.publicItemId, canonicalItemId);
      assert.deepEqual(database.prepare("SELECT * FROM thread_items").all(), before);
      assert.deepEqual(database.pragma("foreign_key_check"), []);
      assert.equal(warnings.mock.callCount(), 0);
    } finally { owners.items.dispose(); owners.threads.dispose(); database.close(); }
  });
  }
}

test("provider event batches admit starts before deltas without storing pending turns", async () => {
  const { database, owners, native, parent } = await setup();
  try {
    const pending = withWorkbenchTurnAdmission({
      id: "3201f023-7830-4daf-a77b-23535c40b84b",
      items: [], status: "inProgress" as const, itemsView: "full" as const,
      error: null, startedAt: 1, completedAt: null, durationMs: null,
    }, "providerPending");
    const pendingEvent = { method: "turn/started" as const, params: { threadId: native.nativeThreadId, turn: pending } };
    await admitProviderNotifications(owners, native, [pendingEvent]);
    assert.equal((mapProviderNotification(owners, native, pendingEvent).params as { threadId: string }).threadId, parent.threadId);
    assert.equal(mapProviderTurn(owners, native, pending).id, pending.id);
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM thread_turns WHERE id = ?").get(pending.id) as { count: number }).count, 0);
    const metadata: Thread = {
      id: native.nativeThreadId, cwd: native.nativeLocation, name: "Parent",
      createdAt: 1, updatedAt: 1, parentThreadId: null, source: "cli", turns: [pending],
      extra: null, sessionId: "native-session", forkedFromId: null, preview: "", ephemeral: false,
      section: null, sectionEnteredAt: null, projectId: null, historyMode: "paginated",
      modelProvider: "openai", model: null, reasoningEffort: null, recencyAt: null,
      status: { type: "active", activeFlags: [] }, path: null, cliVersion: "test", canAcceptDirectInput: null,
      threadSource: null, agentNickname: null, agentRole: null, gitInfo: null,
    };
    const snapshot = { ...metadata,
      workbenchTurnHistory: [{
        turnId: pending.id, status: pending.status, startedAt: 1, completedAt: null,
        durationMs: null, itemCount: 0, loadState: "loaded",
      }],
    };
    await admitProviderThreads(owners, [{
      metadata: { native, projectId: fixtureIdentityValues.ProjectId["project"], projectRoot: "C:/repo", title: "Parent", createdAt: 1, updatedAt: 1, activityAt: 1 },
      thread: snapshot,
    }]);
    assert.equal(await owners.threads.resolveTurn({ threadId: parent.threadId, turnId: fixtureIdentitySchemas.TurnReferenceSchema.parse(pending.id) }), null);
    assert.deepEqual(readWorkbenchTurnHistory(mapProviderThread(owners, native, snapshot)), []);
    assert.equal(mapProviderThread(owners, native, snapshot).turns[0], pending);
    const sidebarEntry = normalizeProviderSidebarEntry("codex", {
      ...mapProviderThread(owners, native, snapshot), status: { type: "active" },
    }, owners.threads);
    assert.ok(sidebarEntry && sidebarEntry.entryKind !== "draft");
    assert.deepEqual(sidebarEntry.lifecycle, {
      agent: { agentStatus: "working" }, kind: "working", reason: "acceptedIntent", settled: false,
    });
    assert.equal(mapProviderLifecycleNotification(
      mapProviderNotification(owners, native, pendingEvent), owners.threads,
    ), null);
    const turn = { ...pending, id: "next-native-turn", workbenchAdmission: "admitted" as const };
    const item: ThreadItem = { id: "first-reasoning", type: "reasoning", summary: [], content: [] };
    const events = [
      { method: "turn/started" as const, params: { threadId: native.nativeThreadId, turn } },
      { method: "item/started" as const, params: { threadId: native.nativeThreadId, turnId: turn.id, item, startedAtMs: 1_000 } },
      { method: "item/reasoning/textDelta" as const, params: { threadId: native.nativeThreadId, turnId: turn.id, itemId: item.id, delta: "first", contentIndex: 0 } },
    ];
    await admitProviderNotifications(owners, native, events);
    const mapped = events.map((event) => mapProviderNotification(owners, native, event));
    assert.equal((mapped[0]!.params as { threadId: string }).threadId, parent.threadId);
    assert.equal((mapped[1]!.params as { item: ThreadItem }).item.id, (mapped[2]!.params as { itemId: string }).itemId);
    const writes = database.prepare("SELECT total_changes() AS count").get();
    await admitProviderNotifications(owners, native, [events[2]!]);
    assert.deepEqual(database.prepare("SELECT total_changes() AS count").get(), writes);
  } finally {
    owners.items.dispose();
    owners.threads.dispose();
    database.close();
  }
});

test("notification admission restores cold durable references without replaying starts or querying warm deltas", async () => {
  const { database, owners, native, parent, child, turn } = await setup();
  const repository = new WorkbenchThreadIdentityRepository(database);
  const itemRepository = new WorkbenchTranscriptIdentityRepository(database);
  const item: ThreadItem = { type: "reasoning", id: "cold-reasoning", summary: ["title"], content: [] };
  const [admitted] = await admitProviderThreadItems(owners, native, [item]);
  owners.threads.dispose();
  owners.items.dispose();
  let reads = 0;
  let writes = 0;
  const cold = {
    threads: new WorkbenchThreadIdentityController({
      listThreadIdentities: async () => repository.list(),
      observeThreadIdentities: async (inputs) => { writes++; return repository.observeMany(inputs); },
      observeTurnIdentities: async (inputs) => { writes++; return repository.observeTurns(inputs); },
      resolveThreadIdentity: async (input) => { reads++; return repository.resolve(input); },
      resolveNativeThreadIdentity: async (input) => { reads++; return repository.resolveNative(input); },
      resolveTurnIdentity: async (input) => { reads++; return repository.resolveTurn(input); },
    }),
    items: new WorkbenchTranscriptIdentityController({
      admitTranscriptItemIdentities: async (inputs) => { writes++; return itemRepository.admitMany(inputs); },
      resolveTranscriptItemIdentity: async (input) => { reads++; return itemRepository.resolve(input); },
    }),
  };
  const event: ServerNotification = {
    method: "item/reasoning/summaryTextDelta",
    params: {
      threadId: native.nativeThreadId, turnId: native.nativeTurnId, itemId: item.id, summaryIndex: 0, delta: "continued",
    },
  };
  try {
    await cold.threads.start();
    assert.equal(cold.threads.findNativeTurn(native), undefined);
    await admitProviderNotifications(cold, native, [event]);
    const projected = mapProviderNotification(cold, native, event);
    assert.deepEqual(projected.params, {
      ...event.params, threadId: parent.threadId, turnId: turn.turnId, itemId: admitted!.id,
    });
    const coldReads = reads;
    assert.ok(coldReads > 0, "The replacement must resolve retained SQLite identities");
    for (let index = 0; index < 3; index++) {
      await admitProviderNotifications(cold, native, [event]);
      assert.deepEqual(mapProviderNotification(cold, native, event), projected);
    }
    assert.equal(reads, coldReads, "Warm deltas remain memory-only");
    assert.equal(writes, 0, "Identifier-only events must not allocate replacement identities");

    const foreign = { ...native, nativeThreadId: fixtureIdentitySchemas.NativeThreadIdSchema.parse("native-child") };
    const foreignEvent = { ...event, params: { ...event.params, threadId: foreign.nativeThreadId } };
    await assert.rejects(async () => {
      await admitProviderNotifications(cold, foreign, [foreignEvent]);
      mapProviderNotification(cold, foreign, foreignEvent);
    }, /turn identity has not been admitted/);
    assert.equal(cold.threads.findNativeTurn(foreign), undefined);
    assert.equal(cold.items.findItemIdForReference(child.threadId, turn.turnId, fixtureIdentitySchemas.ItemReferenceSchema.parse(item.id)), undefined);
    const absentItem = { ...event, params: { ...event.params, itemId: "absent-item" } };
    await assert.rejects(async () => {
      await admitProviderNotifications(cold, native, [absentItem]);
      mapProviderNotification(cold, native, absentItem);
    }, /item reference has not been admitted/);
    assert.equal(writes, 0);
  } finally {
    cold.items.dispose();
    cold.threads.dispose();
    database.close();
  }
});

test("socket reload preserves canonical publications without resolving their identities again", async (t) => {
  const fixture = await setup();
  const { owners, native, parent, turn } = fixture;
  const emitted: Array<Record<string, unknown>> = [];
  const lines: string[] = [];
  let now = 0;
  const client: BridgeClient = {
    OPEN: 1, readyState: 1, close() {}, on() {}, once() {},
    send(data, callback) { emitted.push(JSON.parse(String(data))); now += 500; callback?.(); },
  };
  const harnesses = new WorkbenchHarnessController({
    identities: owners.threads,
    providers: { get: () => { throw new Error("Canonical publications must not call the provider"); } },
  });
  const create = (initialState?: ReturnType<WorkbenchWebSocketRequestController["detachForReload"]>) => (
    new WorkbenchWebSocketRequestController({
      reportDelivery: (delivery) => controller.completeDelivery(delivery),
      harnesses, identities: owners, initialState,
      now: () => now,
      setTimeout: () => 0 as unknown as ReturnType<typeof setTimeout>, clearTimeout() {},
      reload: { getReloadDirtSnapshot: () => ({ dirtyScopes: [], error: null, pendingScopes: [] }), subscribeReloadDirt: () => () => {} },
      threadState: { acceptIntent: async () => ({ accepted: true, revision: 0 }), disconnect: async () => {},
        handleRequest: async () => { throw new Error("Unexpected thread state request"); } },
      transcript: { read: async () => { throw new Error("Unexpected transcript read"); }, subscribe: async () => {}, unsubscribe() {} },
      writeLine(line) { lines.push(line.replace(/\u001b\[[0-9;]*m/gu, "")); },
    })
  );
  let controller = create();
  try {
    const item: ThreadItem = { type: "reasoning", id: "native-reasoning", summary: ["title"], content: [] };
    const [admitted] = await admitProviderThreadItems(owners, native, [item]);
    controller = create(controller.detachForReload());
    const publication = new CodexProviderObservations(owners).native({ method: "item/reasoning/textDelta",
      params: { threadId: native.nativeThreadId, turnId: native.nativeTurnId, itemId: item.id, delta: "native-parent is text" } });
    await controller.sendJsonToClient(client, { ...publication.notification, workbenchHarness: "codex" });
    const event = emitted.find((message) => message.method === "item/reasoning/textDelta");
    assert.deepEqual(event?.params, { threadId: parent.threadId, turnId: turn.turnId, itemId: admitted!.id, delta: "native-parent is text" });
    const lookup = t.mock.method(owners.threads, "resolve", async () => {
      throw new Error("Canonical thread-state delivery must not resolve provider identities");
    });
    const sidebarMessage = { method: "workbench/thread-state/updated", params: {
      projectId: fixtureIdentityValues.ProjectId.project, revision: 1, error: null, freshness: "fresh",
      entries: [{
        entryKind: "thread", activityAt: 1, title: native.nativeThreadId,
        identity: { harness: "codex", threadId: parent.threadId },
        metadata: { archived: false, pinned: true, snoozed: false },
        lifecycle: { kind: "working", reason: "acceptedIntent", settled: false,
          agent: { agentStatus: "working", turnId: turn.turnId } },
      }],
      displayOrder: { pinned: { [`codex:${parent.threadId}`]: { above: [], below: [] } } },
    } };
    await controller.sendJsonToClient(client, sidebarMessage);
    const secondClient: BridgeClient = { ...client };
    const beforeFanout = emitted.length;
    await controller.sendJsonToClient(secondClient, {
      method: sidebarMessage.method,
      params: { updateKind: "projectThreadSidebar", sidebar: { ...sidebarMessage.params } },
    });
    assert.equal(emitted.length, beforeFanout + 1);
    const nextPublication = {
      ...sidebarMessage,
      params: { ...sidebarMessage.params, entries: [...sidebarMessage.params.entries] },
    };
    await controller.sendJsonToClient(client, nextPublication);
    const summary = { projectId: fixtureIdentityValues.ProjectId.project, revision: 1, counts: {}, unsettledThreads: [], pinnedThreads: [] };
    await controller.sendJsonToClient(client, { method: sidebarMessage.method, params: { updateKind: "projectThreadSummary", summary } });
    await controller.sendJsonToClient(secondClient, { method: sidebarMessage.method, params: { updateKind: "projectThreadSummary", summary } });
    const sidebar = emitted.find((message) => message.method === "workbench/thread-state/updated")?.params as {
      entries: Array<{ identity: { threadId: string }; lifecycle: { agent: { turnId: string } }; title: string }>;
      displayOrder: { pinned: Record<string, object> };
    };
    assert.equal(sidebar.entries[0]?.identity.threadId, parent.threadId);
    assert.equal(sidebar.entries[0]?.lifecycle.agent.turnId, turn.turnId);
    assert.equal(sidebar.entries[0]?.title, native.nativeThreadId);
    assert.deepEqual(Object.keys(sidebar.displayOrder.pinned), [`codex:${parent.threadId}`]);
    assert.equal(lookup.mock.callCount(), 0);
    lookup.mock.restore();
    assert.deepEqual(controller.detachForReload().pending, []);
  } finally {
    controller.dispose();
    owners.items.dispose();
    owners.threads.dispose();
    fixture.database.close();
  }
});

test("provider item admission preserves opaque content and enables synchronous projection", async () => {
  const fixture = await setup();
  try {
    const { owners, native, parent, turn, database } = fixture;
    const source: ThreadItem[] = [
      { type: "reasoning", id: "item-1", summary: ["native-parent"], content: ["native-turn"] },
      { type: "userMessage", id: "native-message", clientId: "client-id", content: [
        { type: "text", text: "native-parent native-turn item-1", text_elements: [] },
      ] },
      { type: "dynamicToolCall", id: "native-tool", namespace: null, tool: "inspect",
        arguments: { threadId: "native-parent", itemId: "native-message" },
        status: "completed", contentItems: null, success: true, durationMs: null },
      { type: "userMessage", id: "workbench:steer-history:failed:native-parent:request",
        clientId: null, content: [{ type: "text", text: "retained steer", text_elements: [] }] },
    ];
    assert.throws(() => mapProviderThreadItem(owners, native, source[0]!), /not been admitted/iu);
    const projected = await admitProviderThreadItems(owners, native, source);
    assert.equal(fixture.admissions(), 1);
    assert.equal(new Set(projected.map((item) => item.id)).size, source.length);
    for (const [index, item] of projected.entries()) {
      assert.notEqual(item.id, source[index]!.id);
      assert.deepEqual(mapProviderThreadItem(owners, native, source[index]!), item);
    }
    assert.equal(getWorkbenchThreadItemIdentityKind(projected[0]!), "provisional");
    assert.deepEqual(getWorkbenchInputState(projected[3]!), { kind: "steer", status: "failed" });
    assert.deepEqual((projected[1] as Extract<ThreadItem, { type: "userMessage" }>).content,
      (source[1] as Extract<ThreadItem, { type: "userMessage" }>).content);
    assert.deepEqual((projected[2] as Extract<ThreadItem, { type: "dynamicToolCall" }>).arguments,
      (source[2] as Extract<ThreadItem, { type: "dynamicToolCall" }>).arguments);
    assert.equal(owners.items.itemIdForSource(parent.threadId, {
      turnId: turn.turnId, kind: "client", reference: "client-id",
    }), projected[1]!.id);
    assert.deepEqual(await admitProviderThreadItems(owners, native, source), projected);
    assert.deepEqual(database.prepare("SELECT id FROM thread_items").all(), []);
  } finally {
    fixture.owners.items.dispose();
    fixture.owners.threads.dispose();
    fixture.database.close();
  }
});

test("provider relationship references map without rewriting prompts or hiding unresolved targets", async () => {
  const fixture = await setup();
  try {
    const { owners, native, parent, child } = fixture;
    const item: ThreadItem = {
      type: "collabAgentToolCall", id: "native-collab", tool: "spawnAgent", status: "completed",
      senderThreadId: native.nativeThreadId, receiverThreadIds: ["native-child"],
      prompt: "tell native-child about native-parent", model: null, reasoningEffort: null,
      agentsStates: { "native-child": { status: "completed", message: "native-parent" } },
    };
    const [mapped] = await admitProviderThreadItems(owners, native, [item]);
    assert.equal(mapped?.type, "collabAgentToolCall");
    if (mapped?.type !== "collabAgentToolCall") throw new Error("Expected collaboration item");
    assert.equal(mapped.senderThreadId, parent.threadId);
    assert.deepEqual(mapped.receiverThreadIds, [child.threadId]);
    assert.deepEqual(mapped.agentsStates, { [child.threadId]: item.agentsStates["native-child"] });
    assert.equal(mapped.prompt, item.prompt);
    const elsewhere = await owners.threads.observe({
      native: { harness: "codex", nativeLocation: "C:/another-worktree", nativeThreadId: fixtureIdentityValues.NativeThreadId["remote-child"] },
      projectId: fixtureIdentityValues.ProjectId["project"], projectRoot: "C:/another-worktree", title: "Remote child", createdAt: 1, updatedAt: 1, activityAt: 1,
    });
    const crossDirectory = mapProviderThreadItem(owners, native, { ...item, receiverThreadIds: ["remote-child"] });
    assert.equal(crossDirectory.type, "collabAgentToolCall");
    if (crossDirectory.type !== "collabAgentToolCall") throw new Error("Expected collaboration item");
    assert.deepEqual(crossDirectory.receiverThreadIds, [elsewhere.threadId]);
    assert.throws(() => mapProviderThreadItem(owners, native, {
      ...item, receiverThreadIds: ["unobserved-child"],
    }), /not been admitted/iu);
  } finally {
    fixture.owners.items.dispose();
    fixture.owners.threads.dispose();
    fixture.database.close();
  }
});

test("turn snapshots and consecutive deltas share committed item identity without new admission", async () => {
  const fixture = await setup();
  try {
    const { owners, native, parent, turn } = fixture;
    const item: ThreadItem = { type: "reasoning", id: "item-1", summary: [], content: [] };
    const [mapped] = await admitProviderThreadItems(owners, native, [item]);
    const nativeTurn = {
      id: native.nativeTurnId, items: [item], itemsView: "full" as const,
      status: "inProgress" as const, error: null, startedAt: 1, completedAt: null, durationMs: null,
    };
    const projectedTurn = mapProviderTurn(owners, native, nativeTurn);
    assert.equal(projectedTurn.id, turn.turnId);
    assert.equal(projectedTurn.items[0]?.id, mapped!.id);
    const delta = (text: string) => ({
      method: "item/reasoning/summaryTextDelta" as const,
      params: { threadId: native.nativeThreadId, turnId: native.nativeTurnId,
        itemId: item.id, summaryIndex: 0, delta: text },
    });
    const text = ["native-parent", " native-turn", " item-1"];
    for (const chunk of text) {
      assert.deepEqual(mapProviderNotification(owners, native, delta(chunk)), {
        method: "item/reasoning/summaryTextDelta",
        params: { threadId: parent.threadId, turnId: turn.turnId, itemId: mapped!.id, summaryIndex: 0, delta: chunk },
      });
    }
    assert.deepEqual(mapProviderNotification(owners, native, {
      method: "turn/started", params: { threadId: native.nativeThreadId, turn: nativeTurn },
    }), { method: "turn/started", params: { threadId: parent.threadId, turn: projectedTurn } });
    for (const notification of [
      { method: "item/started" as const, params: { threadId: native.nativeThreadId, turnId: native.nativeTurnId, item, startedAtMs: 1 } },
      { method: "item/completed" as const, params: { threadId: native.nativeThreadId, turnId: native.nativeTurnId, item, completedAtMs: 2 } },
    ]) {
      assert.deepEqual(mapProviderNotification(owners, native, notification), {
        ...notification, params: { ...notification.params, threadId: parent.threadId, turnId: turn.turnId, item: mapped },
      });
    }
    assert.deepEqual(mapProviderNotification(owners, native, {
      method: "serverRequest/resolved", params: { threadId: native.nativeThreadId, requestId: native.nativeTurnId },
    }), { method: "serverRequest/resolved", params: { threadId: parent.threadId, requestId: native.nativeTurnId } });
    assert.deepEqual(mapProviderNotification(owners, native, {
      method: "turn/moderationMetadata",
      params: { threadId: native.nativeThreadId, turnId: native.nativeTurnId, metadata: { itemId: item.id } },
    }), { method: "turn/moderationMetadata",
      params: { threadId: parent.threadId, turnId: turn.turnId, metadata: { itemId: item.id } } });
    assert.equal(fixture.admissions(), 1);
    assert.equal(nativeTurn.items[0]?.id, item.id);
    assert.throws(() => mapProviderNotification(owners, native, {
      ...delta("later"), params: { ...delta("later").params, itemId: "unadmitted" },
    }), /not been admitted/iu);
  } finally {
    fixture.owners.items.dispose();
    fixture.owners.threads.dispose();
    fixture.database.close();
  }
});

test("thread metadata maps known parents without admitting unsupported fork ancestry", async () => {
  const fixture = await setup();
  try {
    const { owners, native, parent, child } = fixture;
    const thread: Thread = {
      id: "native-child", extra: null, sessionId: "native-session", forkedFromId: "unobserved-fork",
      parentThreadId: native.nativeThreadId, preview: "native-parent", ephemeral: false,
      section: null, sectionEnteredAt: null, projectId: null, historyMode: "paginated",
      modelProvider: "openai", model: null, reasoningEffort: null, createdAt: 1, updatedAt: 1, recencyAt: null,
      status: { type: "idle" }, path: null, cwd: "C:/repo", cliVersion: "test", canAcceptDirectInput: null,
      source: { subAgent: { thread_spawn: { parent_thread_id: native.nativeThreadId,
        depth: 1, agent_path: null, agent_nickname: null, agent_role: null } } },
      threadSource: null, agentNickname: null, agentRole: null, gitInfo: null, name: null, turns: [],
    };
    const mapped = mapProviderNotification(owners, native, { method: "thread/started", params: { thread } });
    assert.equal(mapped.method, "thread/started");
    if (mapped.method !== "thread/started") throw new Error("Expected thread metadata");
    assert.equal(mapped.params.thread.id, child.threadId);
    assert.equal(mapped.params.thread.parentThreadId, parent.threadId);
    assert.equal(mapped.params.thread.forkedFromId, null);
    assert.deepEqual(mapped.params.thread.source, { subAgent: { thread_spawn: {
      parent_thread_id: parent.threadId, depth: 1, agent_path: null, agent_nickname: null, agent_role: null,
    } } });
    assert.equal(mapped.params.thread.preview, thread.preview);
    assert.equal(thread.parentThreadId, native.nativeThreadId);
    assert.equal(fixture.admissions(), 0);
    const childNative = { ...native, nativeThreadId: fixtureIdentitySchemas.NativeThreadIdSchema.parse("native-child"), nativeTurnId: fixtureIdentitySchemas.NativeTurnIdSchema.parse("child-turn") };
    const childTurn = await owners.threads.observeTurn({
      kind: "turn", threadId: child.threadId, turnId: childNative.nativeTurnId,
      nativeThreadId: childNative.nativeThreadId, nativeTurnId: childNative.nativeTurnId,
      harnessId: native.harness, nativeLocation: native.nativeLocation,
      state: "completed", createdAt: 1, startedAt: 1, endedAt: 2, durationMs: 1,
    });
    const [childItem] = await admitProviderThreadItems(owners, childNative, [
      { type: "reasoning", id: "child-reasoning", summary: ["keep title"], content: [] },
    ]);
    const history: WorkbenchThreadTurnHistoryEntry[] = [{
      turnId: childNative.nativeTurnId, loadState: "loaded", itemCount: 1, itemIds: ["child-reasoning"],
      itemTimeline: [{ itemId: "child-reasoning", firstSeenAt: 1, lastSeenAt: 2, startedAt: 1, completedAt: 2 }],
      startedAt: 1, completedAt: 2, durationMs: 1, status: "completed",
    }];
    const withHistory = mapProviderNotification(owners, native, {
      method: "thread/started", params: { thread: { ...thread, workbenchTurnHistory: history } as Thread },
    });
    if (withHistory.method !== "thread/started") throw new Error("Expected thread metadata");
    assert.deepEqual(readWorkbenchTurnHistory(withHistory.params.thread), [{
      ...history[0], turnId: childTurn.turnId, itemIds: [childItem!.id],
      itemTimeline: [{ ...history[0]!.itemTimeline![0], itemId: childItem!.id }],
    }]);
  } finally {
    fixture.owners.items.dispose();
    fixture.owners.threads.dispose();
    fixture.database.close();
  }
});

for (const deliveryFirst of [true, false]) {
  test(`queued steer identity does not compete with delivered message identity (delivery first: ${deliveryFirst})`, async () => {
    const { database, owners, native, parent, turn } = await setup();
    try {
      const pending = {
        threadId: native.nativeThreadId, turnId: native.nativeTurnId, itemId: randomUUID(),
        entryKey: "queued-steer", input: [{ type: "text" as const, text: "continue", text_elements: [] }],
        status: "pending" as const, attemptedAt: 1, resolvedAt: null, requestId: "request",
        clientUserMessageId: randomUUID(), canonicalItemId: null, error: null,
      };
      await admitNativeTranscriptObservations(owners, [{ kind: "steer", entry: pending, observedAt: 1 }]);
      const source: ThreadItem = {
        type: "userMessage", id: "item-42", clientId: pending.clientUserMessageId, content: pending.input,
      };
      const sent = { ...pending, status: "sent" as const, canonicalItemId: source.id, resolvedAt: 2 };
      if (deliveryFirst) await admitProviderThreadItems(owners, native, [source]);
      await admitNativeTranscriptObservations(owners, [{ kind: "steer", entry: sent, observedAt: 2 }]);
      const [delivered] = await admitProviderThreadItems(owners, native, [source]);
      for (let iteration = 0; iteration < 2; iteration += 1) {
        await admitNativeTranscriptObservations(owners, [{ kind: "steer", entry: sent, observedAt: 2 }]);
        const mapped = mapNativeTranscriptObservation(owners, native, { kind: "steer", entry: sent, observedAt: 2 });
        assert.equal(mapped.kind, "steer");
        if (mapped.kind !== "steer") throw new Error("Expected steer.");
        assert.equal(mapped.publicItemId, delivered!.id);
        assert.equal(mapped.entry.itemId, delivered!.id);
        assert.equal(mapped.entry.canonicalItemId, delivered!.id);
      }
      for (const status of ["failed", "interrupted"] as const) {
        const attempt = { ...pending, status, resolvedAt: 2 };
        await admitNativeTranscriptObservations(owners, [{ kind: "steer", entry: attempt, observedAt: 2 }]);
        const mapped = mapNativeTranscriptObservation(owners, native, {
          kind: "steer", entry: attempt, observedAt: 2,
        });
        if (mapped.kind !== "steer") throw new Error("Expected steer.");
        assert.equal(mapped.publicItemId, pending.itemId);
      }
      assert.equal(owners.items.itemIdForReference(parent.threadId, turn.turnId, fixtureIdentitySchemas.ItemReferenceSchema.parse(pending.itemId)), pending.itemId);
      assert.deepEqual(database.pragma("foreign_key_check"), []);
    } finally { owners.items.dispose(); owners.threads.dispose(); database.close(); }
  });
}

for (const evidence of ["provisional", "retained-collision", "client-only"] as const) {
  test(`sent steer page context reuses its admitted message (${evidence})`, async () => {
    const { database, owners, native, parent, turn } = await setup();
    try {
      const source: ThreadItem = {
        type: "userMessage", id: evidence === "client-only" ? "native-message" : "item-42",
        clientId: "submitted-client", content: [{ type: "text", text: "submitted", text_elements: [] }],
      };
      const [message] = await admitProviderThreadItems(owners, native, [source]);
      let retainedWrongId: string | undefined;
      if (evidence === "retained-collision") {
        const [wrong] = await owners.items.admit([{
          threadId: parent.threadId,
          sources: [{ turnId: turn.turnId, kind: "stable", reference: source.id }],
        }]);
        retainedWrongId = wrong!.itemId;
        assert.notEqual(retainedWrongId, message!.id);
      }
      const entry = {
        threadId: native.nativeThreadId, turnId: native.nativeTurnId,
        entryKey: "submitted-steer", input: source.content, status: "sent" as const,
        attemptedAt: 1, resolvedAt: 2, requestId: "request",
        clientUserMessageId: source.clientId,
        canonicalItemId: evidence === "client-only" ? null : source.id,
        error: null,
      };
      const failed = { ...entry, entryKey: "interrupted-steer", status: "interrupted" as const, canonicalItemId: null };
      await admitNativeTranscriptObservations(owners, [entry, failed].map((entry) => ({
        kind: "steer", entry, observedAt: 2,
      })));
      const providerThread: Thread & { workbenchTurnHistory: WorkbenchThreadTurnHistoryEntry[] } = {
        id: native.nativeThreadId, cwd: native.nativeLocation, createdAt: 1, updatedAt: 2,
        extra: null, sessionId: "native-session", forkedFromId: null, preview: "", ephemeral: false,
        section: null, sectionEnteredAt: null, projectId: null, historyMode: "paginated",
        modelProvider: "openai", model: null, reasoningEffort: null, recencyAt: null,
        status: { type: "idle" }, path: null, cliVersion: "test", canAcceptDirectInput: null,
        threadSource: null, agentNickname: null, agentRole: null, gitInfo: null, name: null,
        source: "cli", parentThreadId: null,
        turns: [{
          id: native.nativeTurnId, items: [source], itemsView: "full", status: "completed",
          error: null, startedAt: 1, completedAt: 2, durationMs: 1,
        }],
        workbenchTurnHistory: [{
          turnId: native.nativeTurnId, loadState: "loaded", status: "completed",
          startedAt: 1, completedAt: 2, durationMs: 1, itemCount: 1, itemIds: [source.id],
          itemTimeline: [{ itemId: source.id, firstSeenAt: 1, lastSeenAt: 2, startedAt: 1, completedAt: 2 }],
        }],
      };
      const response = await mapNativeProviderResponse(owners, "codex", {
        method: "workbench/thread/page/read", params: { threadId: native.nativeThreadId, cursor: null },
      }, { id: 1, result: { thread: providerThread, steerEntries: [entry, failed], questionnaireEntries: [], browseResultEntries: [] } });
      const result = response.result as { thread: Thread; steerEntries: Array<{ itemId: string; canonicalItemId: string | null }> };
      assert.equal(result.steerEntries[0]!.itemId, message!.id);
      assert.deepEqual(readWorkbenchTurnHistory(result.thread)![0]!.itemIds, [message!.id]);
      assert.equal(result.steerEntries[0]!.canonicalItemId, entry.canonicalItemId === null ? null : message!.id);
      assert.notEqual(result.steerEntries[1]!.itemId, message!.id, "Unsent history remains a separate durable fact");
      if (retainedWrongId) {
        assert.ok(database.prepare("SELECT id FROM workbench_transcript_item_identities WHERE id = ?").get(retainedWrongId),
          "Projection must not delete unrelated identity rows to hide the collision");
      }
      await admitNativeTranscriptObservations(owners, [{ kind: "steer", entry, observedAt: 2 }]);
      assert.equal(mapNativeTranscriptObservation(owners, native, { kind: "steer", entry, observedAt: 2 }).kind, "steer");
      assert.deepEqual(new Set((database.prepare("SELECT id FROM workbench_transcript_item_identities").all() as Array<{ id: string }>).map(({ id }) => id)),
        new Set([message!.id, result.steerEntries[1]!.itemId, ...(retainedWrongId ? [retainedWrongId] : [])]));
    } finally { owners.items.dispose(); owners.threads.dispose(); database.close(); }
  });
}

test("live provisional references retain their source kind when another identity shares the spelling", async () => {
  const { database, owners, native, parent, turn } = await setup();
  try {
    const item: ThreadItem = { type: "reasoning", id: "item-1", summary: [], content: [] };
    const [message] = await admitProviderThreadItems(owners, native, [item]);
    await owners.items.admit([{
      threadId: parent.threadId, sources: [{ turnId: turn.turnId, kind: "stable", reference: item.id }],
    }]);
    const event = mapProviderNotification(owners, native, {
      method: "item/reasoning/summaryTextDelta",
      params: { threadId: native.nativeThreadId, turnId: native.nativeTurnId, itemId: item.id, summaryIndex: 0, delta: "live" },
    });
    assert.equal(event.method, "item/reasoning/summaryTextDelta");
    if (event.method !== "item/reasoning/summaryTextDelta") throw new Error("Unexpected notification kind");
    assert.equal(event.params.itemId, message!.id);
  } finally { owners.items.dispose(); owners.threads.dispose(); database.close(); }
});

test("canonical recording maps structural references without changing evidence, positions or content", async () => {
  const fixture = await setup();
  try {
    const { owners, native, parent, turn, database } = fixture;
    const sourceItem: ThreadItem = {
      type: "dynamicToolCall", id: "native-tool", namespace: null, tool: "inspect",
      arguments: { threadId: native.nativeThreadId }, status: "completed",
      contentItems: null, success: true, durationMs: null,
    };
    const [item] = await admitProviderThreadItems(owners, native, [sourceItem]);
    const [questionnaire, steer] = await owners.items.admit(["native-questionnaire", "native-steer"].map((reference) => ({
      threadId: parent.threadId, sources: [{ turnId: turn.turnId, kind: "stable", reference }],
    })));
    const observations: NativeTranscriptAtomicObservation[] = [
      { kind: "thread", threadId: native.nativeThreadId, projectId: fixtureIdentityValues.ProjectId["project"], projectRoot: "C:/repo",
        title: "Parent", createdAt: 1, updatedAt: 2, activityAt: 2 },
      { kind: "turn", threadId: native.nativeThreadId, turnId: native.nativeTurnId,
        harnessId: native.harness, nativeLocation: native.nativeLocation, nativeThreadId: native.nativeThreadId,
        nativeTurnId: native.nativeTurnId, state: "completed", createdAt: 1, startedAt: 1, endedAt: 2,
        durationMs: 1, turnIndex: 0 },
      { kind: "item", threadId: native.nativeThreadId, turnId: native.nativeTurnId, item: sourceItem,
        lifecycle: "completed", observedAt: 2, itemPosition: 0 },
      { kind: "questionnaire", observedAt: 3, itemPosition: 1, entry: {
        threadId: native.nativeThreadId, turnId: native.nativeTurnId, itemId: "native-questionnaire",
        requestKey: "request", insertAfterItemId: "unresolved-legacy-aggregate", insertAfterItemIndex: null,
        request: { id: "request", title: "Choose", summary: "", submitLabel: "", questions: [] },
        response: { answers: {} }, resolvedAt: 3,
      } },
      { kind: "steer", observedAt: 4, itemPosition: 2, entry: {
        itemId: "native-steer", entryKey: "steer", threadId: native.nativeThreadId, turnId: native.nativeTurnId,
        input: [{ type: "text", text: "keep native-parent in this text", text_elements: [] }],
        status: "failed", attemptedAt: 3, resolvedAt: 4, requestId: "request",
        canonicalItemId: null, error: "not delivered",
      } },
      { kind: "browse", entry: {
        threadId: native.nativeThreadId, turnId: native.nativeTurnId, commandItemId: sourceItem.id,
        action: "snapshot", actionIndex: 0, assetUrl: null, durationMs: 1, entryKey: "browse",
        recordedAt: 4, session: null, state: "completed",
      } },
      { kind: "nativeEvidence", threadId: native.nativeThreadId, turnId: native.nativeTurnId, itemId: fixtureIdentitySchemas.ItemReferenceSchema.parse(sourceItem.id),
        harnessId: native.harness, nativeLocation: native.nativeLocation, nativeThreadId: native.nativeThreadId,
        nativeTurnId: native.nativeTurnId, nativeItemId: fixtureIdentitySchemas.NativeItemIdSchema.parse(sourceItem.id), nativeEventId: null, clientId: null,
        nativeSequence: null, recordKind: "event", payloadJson: '{"threadId":"native-parent"}', recordedAt: 4 },
    ];
    const original = structuredClone(observations);
    const mapped = mapNativeTranscriptObservation(owners, native, {
      kind: "canonicalWindow", threadId: native.nativeThreadId, contentVersion: 3,
      materializedTurnIds: [native.nativeTurnId], observations,
    });
    assert.equal(mapped.kind, "canonicalWindow");
    if (mapped.kind !== "canonicalWindow") throw new Error("Expected canonical window");
    assert.equal(mapped.threadId, parent.threadId);
    assert.deepEqual(mapped.materializedTurnIds, [turn.turnId]);
    const repository = new WorkbenchTranscriptRepository(database);
    repository.settle([mapped]);
    const snapshot = repository.read({ threadId: parent.threadId, turnLimit: 1 })!;
    assert.deepEqual(snapshot.rows.threadItems.map(({ public_id, item_position }) => [public_id, item_position]),
      [[item!.id, 0], [questionnaire!.itemId, 1], [steer!.itemId, 2]]);
    assert.deepEqual(database.prepare("SELECT native_thread_id, native_item_id, payload_json FROM transcript_native_records").all(),
      [{ native_thread_id: native.nativeThreadId, native_item_id: sourceItem.id, payload_json: '{"threadId":"native-parent"}' }]);
    assert.deepEqual(observations, original);
    assert.deepEqual(snapshot.rows.threadOperationCallableToolSources.map(({ arguments_json }) => arguments_json),
      [JSON.stringify(sourceItem.arguments)]);
    assert.equal(snapshot.rows.threadBrowseEntries[0]?.item_id, snapshot.rows.threadItems[0]?.id);
    const legacyQuestionnaire = {
      ...observations.find((entry) => entry.kind === "questionnaire")!.entry,
      itemId: null, insertAfterItemId: null,
    };
    await owners.items.admit([{
      threadId: parent.threadId,
      itemId: questionnaire!.itemId,
      sources: [{
        turnId: turn.turnId,
        kind: "stable",
        reference: resolveQuestionnaireHistoryItemId(legacyQuestionnaire),
      }],
    }]);
    const context = { questionnaireEntries: [legacyQuestionnaire], steerEntries: [], browseResultEntries: [] };
    const response = await mapNativeProviderResponse(owners, "codex", {
      method: "thread/context/read", params: { threadId: native.nativeThreadId },
    }, { id: 1, result: context });
    assert.deepEqual(response.result, {
      ...context, questionnaireEntries: [{
        ...legacyQuestionnaire, threadId: parent.threadId, turnId: turn.turnId, itemId: questionnaire!.itemId,
      }],
    });
    assert.throws(() => mapNativeTranscriptObservation(owners, native, {
      kind: "item", threadId: native.nativeThreadId, turnId: fixtureIdentityValues.NativeTurnId["unobserved-turn"], item: sourceItem,
      lifecycle: "completed", observedAt: 4,
    }), /not been admitted/iu);
  } finally {
    fixture.owners.items.dispose();
    fixture.owners.threads.dispose();
    fixture.database.close();
  }
});
