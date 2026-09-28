/*
 * Exports: none. Tests protect canonical mutation and questionnaire ownership at the wire boundary.
 */
import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { installWorkbenchDatabaseSchema } from "./database/workbench-database-schema";
import WorkbenchThreadIdentityRepository from "./database/thread-identity/WorkbenchThreadIdentityRepository";
import WorkbenchTranscriptIdentityRepository from "./database/transcript/WorkbenchTranscriptIdentityRepository";
import WorkbenchThreadIdentityController from "./WorkbenchThreadIdentityController";
import WorkbenchTranscriptIdentityController from "./WorkbenchTranscriptIdentityController";
import { createWorkbenchQuestionnaireStatePorts, mapNativeQuestionnaire, mapWorkbenchThreadStateRequest } from "./thread-identity-workbench-mapping";
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

test("mutations and questionnaires retain canonical identity and reject foreign project ownership", async () => {
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
    const [question] = await items.admit([{ threadId: thread.threadId, sources: [] }]);
    const questionnaire = await mapNativeQuestionnaire(owners, entry.identity, {
      itemId: question!.itemId, turnId: fixtureIdentityValues.NativeTurnId["native-turn"], requestKey: "request",
      request: { id: "request", title: "Choose", summary: "", submitLabel: "Send", questions: [
        { id: "choice", header: "choice", question: "Proceed?", options: [], allowOther: true, isSecret: false },
      ] },
    });
    assert.equal(questionnaire.itemId, question!.itemId);
    assert.equal(questionnaire.turnId, turn.turnId);
    const request = await mapWorkbenchThreadStateRequest(owners, {
      method: "workbench/thread-state/pin/set", projectId: thread.projectId,
      identity: { harness: "codex", threadId: thread.threadId }, pinned: true,
    });
    assert.ok(request.method === "workbench/thread-state/pin/set");
    assert.equal(request.identity.threadId, thread.threadId);
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
    assert.ok(items.findItemIdForSource(child.threadId, { turnId: childTurn, reference: "item-123", kind: "stable" }));
    assert.equal(items.findItemIdForSource(child.threadId, { turnId: childTurn, reference: "item-123", kind: "provisional" }), undefined);
    const childRequest = await mapWorkbenchThreadStateRequest(owners, {
      method: "workbench/thread-state/snooze/until", projectId: fixtureIdentityValues.ProjectId["project"],
      identity: { harness: "opencode", threadId: child.threadId },
      target: { projectId: thread.projectId, identity: { harness: "codex", threadId: thread.threadId } },
    });
    assert.ok(childRequest.method === "workbench/thread-state/snooze/until");
    assert.equal(childRequest.identity.threadId, child.threadId);
    assert.equal(childRequest.target.identity.threadId, thread.threadId);
    for (const identity of [request.identity, childRequest.identity]) {
      const aliased = await mapWorkbenchThreadStateRequest(owners, {
        method: "workbench/thread-state/pin/set", projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("old/project"),
        identity, pinned: true,
      });
      assert.ok(aliased.method === "workbench/thread-state/pin/set");
      assert.deepEqual(aliased.identity, identity);
    }
    await assert.rejects(mapWorkbenchThreadStateRequest(owners, {
      method: "workbench/thread-state/pin/set", projectId: fixtureIdentityValues.ProjectId["foreign"],
      identity: { harness: "codex", threadId: thread.threadId }, pinned: true,
    }));
  } finally {
    threads.dispose();
    items.dispose();
    database.close();
  }
});
