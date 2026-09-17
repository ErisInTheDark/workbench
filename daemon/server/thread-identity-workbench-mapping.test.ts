/*
 * Exports: none. Tests protect complete observation identity at the wire boundary.
 */
import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { installWorkbenchDatabaseSchema } from "./database/workbench-database-schema";
import WorkbenchThreadIdentityRepository from "./database/thread-identity/WorkbenchThreadIdentityRepository";
import WorkbenchTranscriptIdentityRepository from "./database/transcript/WorkbenchTranscriptIdentityRepository";
import WorkbenchThreadIdentityController from "./WorkbenchThreadIdentityController";
import WorkbenchTranscriptIdentityController from "./WorkbenchTranscriptIdentityController";
import { WorkbenchThreadObservationResultSchema, WorkbenchThreadObservationSnapshotSchema, type WorkbenchThreadObservationSnapshot } from "workbench-shared/workbench/thread/thread-state";
import { createWorkbenchQuestionnaireStatePorts, mapNativeThreadStateResult, mapNativeThreadStateSnapshot, mapWorkbenchThreadStateRequest } from "./thread-identity-workbench-mapping";
import { admitNativeTranscriptObservations } from "./thread-identity-transcript-mapping";
import * as fixtureIdentitySchemas from "workbench-shared/workbench/identity";
import { testProjectIds } from "workbench-shared/workbench/test-identities";

const fixtureIdentityValues = {
  NativeThreadId: {
    "native-child": fixtureIdentitySchemas.NativeThreadIdSchema.parse("native-child"),
  },
  NativeTurnId: {
    "native-turn": fixtureIdentitySchemas.NativeTurnIdSchema.parse("native-turn"),
  },
  ProjectId: {
    "foreign": testProjectIds.foreign,
    "project": testProjectIds.project,
  },
};

test("observation requests validate canonical ownership and outbound state needs no identity projection", async () => {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  installWorkbenchDatabaseSchema(database);
  const repository = new WorkbenchThreadIdentityRepository(database);
  const itemRepository = new WorkbenchTranscriptIdentityRepository(database);
  const threads = new WorkbenchThreadIdentityController({
    listThreadIdentities: async () => repository.list(),
    observeThreadIdentities: async input => repository.observeMany(input),
    resolveThreadIdentity: async input => repository.resolve(input),
    resolveNativeThreadIdentity: async input => repository.resolveNative(input),
    observeTurnIdentities: async input => repository.observeTurns(input),
    resolveTurnIdentity: async input => repository.resolveTurn(input),
  });
  const items = new WorkbenchTranscriptIdentityController({
    admitTranscriptItemIdentities: async input => itemRepository.admitMany(input),
    resolveTranscriptItemIdentity: async input => itemRepository.resolve(input),
  });
  try {
    await threads.start();
    const native = { harness: "codex", nativeLocation: "/repo", nativeThreadId: fixtureIdentitySchemas.NativeThreadIdSchema.parse("native-thread") };
    const thread = await threads.observe({ native, projectId: fixtureIdentityValues.ProjectId["project"], projectRoot: "/repo", title: "Thread", createdAt: 1, updatedAt: 1, activityAt: 1 });
    const turn = await threads.observeTurn({
      kind: "turn", threadId: thread.threadId, turnId: fixtureIdentityValues.NativeTurnId["native-turn"],
      harnessId: "codex", nativeLocation: "/repo", nativeThreadId: native.nativeThreadId,
      nativeTurnId: fixtureIdentityValues.NativeTurnId["native-turn"], state: "inProgress", createdAt: 2, startedAt: 2, endedAt: null, durationMs: null,
    });
    const owners = { threads, items };
    database.prepare("INSERT INTO workbench_project_aliases(alias, project_id) VALUES (?, ?)")
      .run("old/project", thread.projectId);
    const entry = {
      entryKind: "thread" as const, identity: { harness: "codex" as const, threadId: thread.threadId },
      activityAt: 1, title: "Thread", metadata: { archived: false as const, pinned: false, snoozed: false },
      lifecycle: { kind: "needsAttention" as const, reason: "noActiveTurn" as const, settled: false as const },
      profile: null, mcpGeneration: null, snoozedUntil: null, settledAt: null, gitHistoryCleanedAt: null,
      providerObserved: true,
    };
    const questionnaireState = {
      getCanonicalThreadEntry: async () => entry,
      setPendingQuestionnaire: async () => entry,
      clearPendingQuestionnaire: async () => entry,
      subscribe: () => () => true,
    };
    const ports = createWorkbenchQuestionnaireStatePorts(owners, questionnaireState, async cwd => (
      cwd === "/repo" ? thread.projectId : fixtureIdentityValues.ProjectId.foreign
    ));
    const admittedQuestionnaire = await ports.resolveThread("/repo", thread.threadId);
    assert.equal(admittedQuestionnaire.projectId, thread.projectId);
    assert.equal(admittedQuestionnaire.turnId, null);
    await assert.rejects(ports.resolveThread("/foreign", thread.threadId));
    const [question] = await items.admit([{ threadId: thread.threadId, sources: [], legacyAliases: [] }]);
    const source: WorkbenchThreadObservationSnapshot = {
      projectId: fixtureIdentityValues.ProjectId["project"], subscriptionId: "2c13640d-e0aa-441a-9ce3-a9f293bf38dc",
      target: { kind: "provider", harness: "codex", threadId: thread.threadId },
      revision: 4, version: 1, updateKind: "threadObservation", error: null, freshness: "fresh",
      entries: [{
        entryKind: "thread", identity: { harness: "codex", threadId: thread.threadId },
        activityAt: 2, title: "Thread", metadata: { archived: false, pinned: true, snoozed: false },
        lifecycle: { kind: "needsAttention", reason: "pendingInput", requestKey: "request", turnId: turn.turnId, settled: false },
        pendingQuestionnaire: {
          itemId: question!.itemId, turnId: turn.turnId, requestKey: "request",
          request: { id: "request", title: "Choose", summary: "", submitLabel: "Send", questions: [
            { id: "choice", header: "choice", question: "Proceed?", options: [], allowOther: true, isSecret: false },
          ] },
        },
      }],
    };
    const request = await mapWorkbenchThreadStateRequest(owners, {
      method: "workbench/thread-state/observe", projectId: source.projectId,
      subscriptionId: source.subscriptionId, version: 1,
      target: { kind: "provider", harness: "codex", threadId: thread.threadId },
    });
    assert.ok(request.method === "workbench/thread-state/observe");
    assert.equal(request.target.threadId, thread.threadId);
    const resolve = threads.resolve.bind(threads);
    threads.resolve = async () => { throw new Error("Outbound state performed identity lookup"); };
    const pushed = WorkbenchThreadObservationSnapshotSchema.parse(await mapNativeThreadStateSnapshot(owners, source));
    const opened = WorkbenchThreadObservationResultSchema.parse(await mapNativeThreadStateResult(owners, { observation: source }));
    threads.resolve = resolve;
    assert.deepEqual(opened.observation, pushed);
    assert.equal(pushed.projectId, source.projectId);
    assert.equal(pushed.subscriptionId, source.subscriptionId);
    assert.equal(pushed.target.threadId, thread.threadId);
    const projectedEntry = pushed.entries[0]!;
    assert.ok(projectedEntry.entryKind !== "draft");
    assert.equal(projectedEntry.identity.threadId, thread.threadId);
    assert.ok("turnId" in projectedEntry.lifecycle);
    assert.equal(projectedEntry.lifecycle.turnId, turn.turnId);
    assert.equal(projectedEntry.pendingQuestionnaire?.turnId, turn.turnId);
    assert.equal(projectedEntry.pendingQuestionnaire?.itemId, question!.itemId);
    assert.deepEqual(projectedEntry.pendingQuestionnaire?.request, source.entries[0]!.entryKind !== "draft" && source.entries[0]!.pendingQuestionnaire?.request);
    const child = await threads.observe({
      native: { harness: "opencode", nativeLocation: "/repo", nativeThreadId: fixtureIdentityValues.NativeThreadId["native-child"] },
      projectId: fixtureIdentityValues.ProjectId["project"], projectRoot: "/repo", title: "Child", createdAt: 1, updatedAt: 1, activityAt: 1,
    });
    const childTurnId = fixtureIdentitySchemas.NativeTurnIdSchema.parse("child-turn");
    await admitNativeTranscriptObservations(owners, [{
      kind: "turn", threadId: fixtureIdentityValues.NativeThreadId["native-child"], turnId: childTurnId,
      harnessId: "opencode", nativeLocation: "/repo", nativeThreadId: fixtureIdentityValues.NativeThreadId["native-child"],
      nativeTurnId: childTurnId, state: "inProgress", createdAt: 2, startedAt: 2, endedAt: null, durationMs: null,
    }, {
      kind: "item", threadId: fixtureIdentityValues.NativeThreadId["native-child"], turnId: childTurnId,
      item: { type: "reasoning", id: "item-123", summary: ["Independent provider"], content: [] },
      lifecycle: "streaming", observedAt: 2,
    }], "opencode");
    const childTurn = threads.workbenchTurnIdForNative({
      harness: "opencode", nativeLocation: "/repo", nativeThreadId: fixtureIdentityValues.NativeThreadId["native-child"],
      nativeTurnId: childTurnId,
    });
    assert.ok(items.findItemIdForSource(child.threadId, { turnId: childTurn, sourceId: "item-123", kind: "stable" }));
    assert.equal(items.findItemIdForSource(child.threadId, { turnId: childTurn, sourceId: "item-123", kind: "provisional" }), undefined);
    const childRequest = await mapWorkbenchThreadStateRequest(owners, {
      method: "workbench/thread-state/observe", projectId: fixtureIdentityValues.ProjectId["project"], subscriptionId: source.subscriptionId, version: 1,
      target: { kind: "subagent", harness: "opencode", threadId: child.threadId, parentThreadId: thread.threadId },
    });
    assert.ok(childRequest.method === "workbench/thread-state/observe" && childRequest.target.kind === "subagent");
    assert.equal(childRequest.target.threadId, child.threadId);
    assert.equal(childRequest.target.parentThreadId, thread.threadId);
    for (const target of [request.target, childRequest.target]) {
      const aliased = await mapWorkbenchThreadStateRequest(owners, {
        method: "workbench/thread-state/observe", projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("old/project"),
        subscriptionId: source.subscriptionId, version: 1, target,
      });
      assert.ok(aliased.method === "workbench/thread-state/observe");
      assert.deepEqual(aliased.target, target);
    }
    await assert.rejects(mapWorkbenchThreadStateRequest(owners, {
      method: "workbench/thread-state/observe", projectId: fixtureIdentityValues.ProjectId["foreign"], subscriptionId: source.subscriptionId, version: 1,
      target: { kind: "provider", harness: "codex", threadId: thread.threadId },
    }));
  } finally {
    threads.dispose();
    items.dispose();
    database.close();
  }
});
