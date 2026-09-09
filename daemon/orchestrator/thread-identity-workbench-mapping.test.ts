/*
 * Keywords: observations, canonical identity, native routing, questionnaires.
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
import { mapNativeThreadStateResult, mapNativeThreadStateSnapshot, mapWorkbenchThreadStateRequest } from "./thread-identity-workbench-mapping";

test("observation requests, bootstrap and pushes preserve their owner and map all thread-owned identities", async () => {
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
    const native = { harness: "codex", nativeLocation: "/repo", nativeThreadId: "native-thread" };
    const thread = await threads.observe({ native, projectId: "project", projectRoot: "/repo", title: "Thread", createdAt: 1, updatedAt: 1, activityAt: 1 });
    const turn = await threads.observeTurn({
      kind: "turn", threadId: thread.threadId, turnId: "native-turn",
      harnessId: "codex", nativeLocation: "/repo", nativeThreadId: native.nativeThreadId,
      nativeTurnId: "native-turn", state: "inProgress", createdAt: 2, startedAt: 2, endedAt: null, durationMs: null,
    });
    const owners = { threads, items };
    const source: WorkbenchThreadObservationSnapshot = {
      projectId: "project", subscriptionId: "2c13640d-e0aa-441a-9ce3-a9f293bf38dc",
      target: { kind: "provider", harness: "codex", threadId: native.nativeThreadId },
      revision: 4, version: 1, updateKind: "threadObservation", error: null, freshness: "fresh",
      entries: [{
        entryKind: "thread", identity: { harness: "codex", threadId: native.nativeThreadId },
        activityAt: 2, title: "Thread", metadata: { archived: false, pinned: true, snoozed: false },
        lifecycle: { kind: "needsAttention", reason: "pendingInput", requestKey: "request", turnId: "native-turn", settled: false },
        pendingQuestionnaire: {
          itemId: "native-question", turnId: "native-turn", requestKey: "request",
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
    assert.equal(request.target.threadId, native.nativeThreadId);
    const pushed = WorkbenchThreadObservationSnapshotSchema.parse(await mapNativeThreadStateSnapshot(owners, source));
    const opened = WorkbenchThreadObservationResultSchema.parse(await mapNativeThreadStateResult(owners, { observation: source }));
    assert.deepEqual(opened.observation, pushed);
    assert.equal(pushed.projectId, source.projectId);
    assert.equal(pushed.subscriptionId, source.subscriptionId);
    assert.equal(pushed.target.threadId, thread.threadId);
    const entry = pushed.entries[0]!;
    assert.ok(entry.entryKind !== "draft");
    assert.equal(entry.identity.threadId, thread.threadId);
    assert.ok("turnId" in entry.lifecycle);
    assert.equal(entry.lifecycle.turnId, turn.turnId);
    assert.equal(entry.pendingQuestionnaire?.turnId, turn.turnId);
    assert.notEqual(entry.pendingQuestionnaire?.itemId, "native-question");
    assert.deepEqual(entry.pendingQuestionnaire?.request, source.entries[0]!.entryKind !== "draft" && source.entries[0]!.pendingQuestionnaire?.request);
    const child = await threads.observe({
      native: { harness: "opencode", nativeLocation: "/repo", nativeThreadId: "native-child" },
      projectId: "project", projectRoot: "/repo", title: "Child", createdAt: 1, updatedAt: 1, activityAt: 1,
    });
    const childRequest = await mapWorkbenchThreadStateRequest(owners, {
      method: "workbench/thread-state/observe", projectId: "project", subscriptionId: source.subscriptionId, version: 1,
      target: { kind: "subagent", harness: "opencode", threadId: child.threadId, parentThreadId: thread.threadId },
    });
    assert.ok(childRequest.method === "workbench/thread-state/observe" && childRequest.target.kind === "subagent");
    assert.equal(childRequest.target.threadId, "native-child");
    assert.equal(childRequest.target.parentThreadId, "native-thread");
  } finally {
    threads.dispose();
    items.dispose();
    database.close();
  }
});
