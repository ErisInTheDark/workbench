/*
 * No production exports. Protect native questionnaire projection and delivery to the existing WB waiter.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { NativeThreadIdSchema, NativeTurnIdSchema, ThreadReferenceSchema } from "workbench-shared/workbench/identity";
import CodexQuestionnaireAdapter from "./CodexQuestionnaireAdapter";
import WorkbenchQuestionnaireController from "./WorkbenchQuestionnaireController";
import { createThreadStateTestDatabase } from "./workbench-thread-state-test-database";

test("Codex questionnaire views translate identities without exposing another provider or changing wait ownership", async () => {
  const database = createThreadStateTestDatabase();
  const identities = database.identities.threads;
  const nativeThreadId = NativeThreadIdSchema.parse("native-thread");
  const nativeTurnId = NativeTurnIdSchema.parse("native-turn");
  const records = await Promise.all(["codex", "another-provider"].map(async harness => {
    database.admitThread("local:///project", `wb-${harness}`, harness, nativeThreadId, "C:/project");
    const thread = await identities.resolve({ threadId: ThreadReferenceSchema.parse(`wb-${harness}`) });
    assert.ok(thread);
    const turn = await identities.observeTurn({
      kind: "turn", threadId: thread.threadId, turnId: nativeTurnId, harnessId: harness,
      nativeThreadId, nativeLocation: "C:/project", nativeTurnId,
      state: "inProgress", createdAt: 1, startedAt: 1, endedAt: null, durationMs: null,
    });
    return { thread, turn };
  }));
  const published = records.map(() => Promise.withResolvers<void>());
  const controller = new WorkbenchQuestionnaireController({
    clearPending: async () => {},
    publishPending: async threadId => { published[records.findIndex(record => record.thread.threadId === threadId)].resolve(); },
    resolveThread: async (_cwd, threadId) => {
      const record = records.find(record => record.thread.threadId === threadId)!;
      return { projectId: record.thread.projectId, turnId: record.turn.turnId };
    },
    subscribePending: () => () => {},
  });
  const adapter = new CodexQuestionnaireAdapter(controller, identities);
  const cancellations = records.map(() => new AbortController());
  const waiting = records.map((record, index) => controller.request({
    callerThreadId: record.thread.threadId, cwd: "C:/project", requestKey: `question-${index}`,
    questions: [{ id: "choice", header: "", question: "Continue?", options: [] }],
  }, cancellations[index].signal).then(value => value, error => error));
  try {
    await Promise.all(published.map(result => result.promise));
    const pending = await adapter.list();
    assert.equal(pending.data.length, 1);
    assert.equal(pending.data[0].threadId, nativeThreadId);
    assert.equal(pending.data[0].turnId, nativeTurnId);
    assert.equal(pending.data[0].requestKey, "question-0");
    assert.equal(controller.list().data.length, 2);
    const response = { answers: { choice: { answers: ["continue"] } } };
    const answered = await adapter.respond({ threadId: nativeThreadId, requestKey: "question-0", response });
    assert.equal(answered?.threadId, nativeThreadId);
    assert.equal(answered?.turnId, nativeTurnId);
    assert.equal(answered?.itemId, pending.data[0].itemId);
    assert.deepEqual(await waiting[0], response);
    assert.equal(controller.canDeliver(records[1].thread.threadId, "question-1"), true);
    assert.equal(await adapter.respond({ threadId: nativeThreadId, requestKey: "question-1", response }), null);
  } finally {
    cancellations.forEach(cancellation => cancellation.abort(new Error("test complete")));
    await Promise.all(waiting);
    await controller.dispose();
  }
});
