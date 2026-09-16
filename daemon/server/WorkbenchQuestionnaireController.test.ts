/*
 * No production exports. Tests protect Workbench questionnaire publication, answer correlation, cancellation, dismissal, restart, and disposal.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";

import WorkbenchQuestionnaireController, {
  type WorkbenchQuestionnaireControllerOptions,
  type WorkbenchNativeQuestionnaire,
} from "./WorkbenchQuestionnaireController";
import * as fixtureIdentitySchemas from "workbench-shared/workbench/identity";

const fixtureIdentityValues = {
  NativeThreadId: {
    "thread-one": fixtureIdentitySchemas.NativeThreadIdSchema.parse("thread-one"),
  },
  ProjectId: {
    "project-one": fixtureIdentitySchemas.ProjectIdSchema.parse("project-one"),
  },
};

const freeformInput = {
  callerThreadId: fixtureIdentityValues.NativeThreadId["thread-one"],
  cwd: "C:/workspace",
  questions: [{
    header: "details",
    id: "details",
    options: [],
    question: "What should change?",
  }],
};

function deferred<TValue>() {
  let reject!: (error: unknown) => void;
  let resolve!: (value: TValue) => void;
  const promise = new Promise<TValue>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, reject, resolve };
}

function createHarness(options: {
  beforeClear?: () => Promise<void>;
  beforePublish?: () => Promise<void>;
  publishUnrelatedStateFirst?: boolean;
  restoredQuestionnaire?: WorkbenchNativeQuestionnaire;
} = {}) {
  const listeners = new Set<Parameters<WorkbenchQuestionnaireControllerOptions["subscribePending"]>[0]>();
  const published = deferred<WorkbenchNativeQuestionnaire>();
  let pending: WorkbenchNativeQuestionnaire | null = null;
  let clearCount = 0;
  const notify = () => {
    for (const listener of listeners) {
      listener({ projectId: fixtureIdentityValues.ProjectId["project-one"], requestKey: pending?.requestKey ?? null, threadId: fixtureIdentityValues.NativeThreadId["thread-one"] });
    }
  };
  const controller = new WorkbenchQuestionnaireController({
    clearPending: async (_threadId, requestKey) => {
      clearCount += 1;
      await options.beforeClear?.();
      if (pending?.requestKey === requestKey) pending = null;
      notify();
    },
    createRequestKey: () => "workbench-mcp:question-one",
    publishPending: async (_threadId, questionnaire) => {
      await options.beforePublish?.();
      if (options.publishUnrelatedStateFirst) notify();
      pending = questionnaire;
      published.resolve(questionnaire);
      notify();
    },
    resolveThread: async () => ({
      projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project-one"), turnId: fixtureIdentitySchemas.NativeTurnIdSchema.parse("turn-one"), pendingQuestionnaire: options.restoredQuestionnaire,
    }),
    subscribePending: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
  return {
    clearCount: () => clearCount,
    controller,
    dismiss() {
      pending = null;
      notify();
    },
    published: published.promise,
    readPending: () => pending,
  };
}

test("freeform request publishes one durable question and returns its correlated answer", async () => {
  const harness = createHarness();
  const waiting = harness.controller.request(freeformInput, new AbortController().signal);
  const questionnaire = await harness.published;
  assert.equal(z.uuid().safeParse(questionnaire.itemId).success, true);
  assert.equal(questionnaire.request.questions[0]?.options.length, 0);
  assert.equal(questionnaire.request.title, freeformInput.questions[0].question);
  assert.equal(questionnaire.request.questions[0]?.header, freeformInput.questions[0].header);
  assert.deepEqual(harness.controller.list().data, [{
    itemId: questionnaire.itemId,
    request: questionnaire.request,
    requestKey: questionnaire.requestKey,
    threadId: "thread-one",
    turnId: "turn-one",
  }]);

  const response = { answers: { details: { answers: ["Keep one owner."] } } };
  const consumed = await harness.controller.respond({
    requestKey: questionnaire.requestKey,
    response,
    threadId: fixtureIdentityValues.NativeThreadId["thread-one"],
  });
  assert.deepEqual(consumed, { ...questionnaire, response, threadId: "thread-one" });
  assert.deepEqual(await waiting, response);
  assert.deepEqual(harness.controller.list().data, []);
  const next = createHarness();
  const nextWaiting = next.controller.request(freeformInput, new AbortController().signal);
  const nextQuestionnaire = await next.published;
  assert.equal(nextQuestionnaire.requestKey, questionnaire.requestKey);
  assert.notEqual(nextQuestionnaire.itemId, questionnaire.itemId);
  await next.controller.respond({ requestKey: nextQuestionnaire.requestKey, response, threadId: fixtureIdentityValues.NativeThreadId["thread-one"] });
  await nextWaiting;
});

test("daemon-owned delivery resolves the waiter without clearing durable state", async () => {
  const harness = createHarness();
  const waiting = harness.controller.request(freeformInput, new AbortController().signal);
  const questionnaire = await harness.published;
  const response = { answers: { details: { answers: ["Continue through the daemon."] } } };

  assert.equal(harness.controller.canDeliver(fixtureIdentityValues.NativeThreadId["thread-one"], questionnaire.requestKey), true);
  const delivered = await harness.controller.deliver({
    requestKey: questionnaire.requestKey,
    response,
    threadId: fixtureIdentityValues.NativeThreadId["thread-one"],
  });

  assert.deepEqual(delivered, { ...questionnaire, response, threadId: "thread-one" });
  assert.deepEqual(await waiting, response);
  assert.equal(harness.clearCount(), 0);
  assert.deepEqual(harness.readPending(), questionnaire);
  assert.equal(harness.controller.canDeliver(fixtureIdentityValues.NativeThreadId["thread-one"], questionnaire.requestKey), false);
});

for (const fails of [false, true]) {
  test(`interruption retains the pending tool until provider ${fails ? "failure" : "success"}`, async () => {
    const h = createHarness();
    const abort = new AbortController();
    let settled = false;
    const waiting = h.controller.request(freeformInput, abort.signal).then(
      () => { settled = true; }, () => { settled = true; },
    );
    const question = await h.published;
    let interrupted = false;
    const stopping = h.controller.interruptRetainingQuestionnaire(fixtureIdentityValues.NativeThreadId["thread-one"], question.requestKey, async () => {
      interrupted = true;
      abort.abort();
      await Promise.resolve();
      assert.equal(settled, false);
      assert.equal(h.clearCount(), 0);
      if (fails) throw new Error("provider stop failed");
      return true;
    });
    if (fails) await assert.rejects(stopping, /provider stop failed/u);
    else await stopping;
    await waiting;
    assert.equal(interrupted, true);
    assert.equal(settled, true);
    assert.deepEqual(h.readPending(), question);
    assert.equal(h.clearCount(), 0);
    await h.controller.dispose();
  });
}

test("interruption releases only the matching waiter and preserves its durable question after caller abort", async () => {
  const h = createHarness();
  const abort = new AbortController();
  const waiting = h.controller.request(freeformInput, abort.signal);
  const question = await h.published;
  await h.controller.interruptRetainingQuestionnaire(fixtureIdentityValues.NativeThreadId["thread-one"], "stale", async () => true);
  assert.equal(h.controller.list().data.length, 1);
  const rejected = assert.rejects(waiting, /being interrupted/u);
  await h.controller.interruptRetainingQuestionnaire(fixtureIdentityValues.NativeThreadId["thread-one"], question.requestKey, async () => true);
  await rejected;
  abort.abort();
  assert.deepEqual(h.readPending(), question);
  assert.equal(h.clearCount(), 0);
  assert.deepEqual(h.controller.list().data, []);
  await h.controller.dispose();
  assert.deepEqual(h.readPending(), question);
});

test("answer persistence wins interruption, while failed persistence retains the saved question", async () => {
  for (const fails of [false, true]) {
    const clearing = deferred<void>();
    const started = deferred<void>();
    const h = createHarness({ beforeClear: async () => { started.resolve(); await clearing.promise; } });
    const waiting = h.controller.request(freeformInput, new AbortController().signal);
    const question = await h.published;
    const response = { answers: { details: { answers: ["proceed"] } } };
    const answering = h.controller.respond({ threadId: fixtureIdentityValues.NativeThreadId["thread-one"], requestKey: question.requestKey, response });
    await started.promise;
    const released = h.controller.interruptRetainingQuestionnaire(fixtureIdentityValues.NativeThreadId["thread-one"], question.requestKey, async () => true);
    if (fails) {
      const answerFailure = assert.rejects(answering, /write failed/u);
      const waitFailure = assert.rejects(waiting, /being interrupted/u);
      clearing.reject(new Error("write failed"));
      await Promise.all([answerFailure, waitFailure, released]);
      assert.deepEqual(h.readPending(), question);
    } else {
      clearing.resolve();
      await Promise.all([answering, released]);
      assert.deepEqual(await waiting, response);
      assert.equal(h.readPending(), null);
    }
    assert.deepEqual(h.controller.list().data, []);
    await h.controller.dispose();
  }
});

test("answer persistence already in progress wins caller cancellation", async () => {
  const clearing = deferred<void>();
  const started = deferred<void>();
  const harness = createHarness({ beforeClear: async () => { started.resolve(); await clearing.promise; } });
  const cancellation = new AbortController();
  const waiting = harness.controller.request(freeformInput, cancellation.signal);
  const questionnaire = await harness.published;
  const response = { answers: { details: { answers: ["proceed"] } } };
  const answering = harness.controller.respond({
    threadId: fixtureIdentityValues.NativeThreadId["thread-one"],
    requestKey: questionnaire.requestKey,
    response,
  });
  await started.promise;
  cancellation.abort(new Error("caller cancelled"));
  clearing.resolve();

  assert.deepEqual(await answering, { ...questionnaire, response, threadId: "thread-one" });
  assert.deepEqual(await waiting, response);
  assert.equal(harness.readPending(), null);
});

test("one thread cannot open concurrent questionnaires or consume a stale answer", async () => {
  const harness = createHarness();
  const cancellation = new AbortController();
  const waiting = harness.controller.request(freeformInput, cancellation.signal);
  await harness.published;
  await assert.rejects(
    harness.controller.request(freeformInput, new AbortController().signal),
    /already has a pending questionnaire/u,
  );
  assert.equal(await harness.controller.respond({
    requestKey: "workbench-mcp:stale",
    response: { answers: {} },
    threadId: fixtureIdentityValues.NativeThreadId["thread-one"],
  }), null);
  cancellation.abort(new Error("caller cancelled"));
  await assert.rejects(waiting, /caller cancelled/u);
});

test("a resumed wait keeps the durable questionnaire identity and original turn", async () => {
  const original = createHarness();
  const cancellation = new AbortController();
  const waiting = original.controller.request(freeformInput, cancellation.signal);
  const questionnaire = await original.published;
  const reload = new Error("reload");
  Reflect.set(reload, Symbol.for("workbench.agentMcpRuntimeReloadInterruption.v1"), true);
  cancellation.abort(reload);
  await assert.rejects(waiting, /reload/u);
  const restored = { ...questionnaire, itemId: "984090b6-1d94-44cc-ab26-e6470965597e", turnId: fixtureIdentitySchemas.NativeTurnIdSchema.parse("original-turn") };
  const resumed = createHarness({ restoredQuestionnaire: restored });
  const resumedWaiting = resumed.controller.request({ ...freeformInput, requestKey: restored.requestKey }, new AbortController().signal);
  const published = await resumed.published;
  const response = { answers: { details: { answers: ["Proceed."] } } };
  const answered = await resumed.controller.respond({ requestKey: restored.requestKey, threadId: fixtureIdentityValues.NativeThreadId["thread-one"], response });
  await resumedWaiting;
  assert.equal(published.itemId, restored.itemId);
  assert.equal(published.turnId, restored.turnId);
  assert.equal(answered?.itemId, restored.itemId);
  assert.equal(answered?.turnId, restored.turnId);
});

test("caller cancellation releases the waiter while durable dismissal clears the question", async () => {
  {
    const harness = createHarness();
    const cancellation = new AbortController();
    const waiting = harness.controller.request(freeformInput, cancellation.signal);
    const questionnaire = await harness.published;
    cancellation.abort(new Error("caller cancelled"));
    await assert.rejects(waiting, /caller cancelled/u);
    assert.deepEqual(harness.controller.list().data, []);
    assert.deepEqual(harness.readPending(), questionnaire);
    assert.equal(harness.clearCount(), 0);
  }
  {
    const harness = createHarness();
    const waiting = harness.controller.request(freeformInput, new AbortController().signal);
    await harness.published;
    harness.dismiss();
    await assert.rejects(waiting, /dismissed/u);
    assert.deepEqual(harness.controller.list().data, []);
    assert.equal(harness.readPending(), null);
    assert.equal(harness.clearCount(), 1);
  }
});

test("reload interruption releases the waiter without clearing its durable projection", async () => {
  const harness = createHarness();
  const cancellation = new AbortController();
  const requestKey = "workbench-mcp:stable-reload-question";
  const waiting = harness.controller.request({ ...freeformInput, requestKey }, cancellation.signal);
  const questionnaire = await harness.published;
  assert.equal(questionnaire.requestKey, requestKey);

  const reload = new Error("Workbench command generation was replaced.");
  Reflect.set(reload, Symbol.for("workbench.agentMcpRuntimeReloadInterruption.v1"), true);
  cancellation.abort(reload);

  await assert.rejects(waiting, /generation was replaced/u);
  assert.equal(harness.clearCount(), 0);
  assert.equal(harness.readPending()?.requestKey, requestKey);
  assert.equal(harness.readPending()?.itemId, questionnaire.itemId);
  assert.deepEqual(harness.controller.list().data, []);
});

test("failed answer settlement after reload releases the original wait for re-entry", async () => {
  const clearStarted = deferred<void>();
  const releaseClear = deferred<void>();
  const harness = createHarness({
    beforeClear: async () => {
      clearStarted.resolve();
      await releaseClear.promise;
      throw new Error("clear failed");
    },
  });
  const cancellation = new AbortController();
  const waiting = harness.controller.request(freeformInput, cancellation.signal);
  const questionnaire = await harness.published;
  await Promise.resolve();
  const responding = harness.controller.respond({
    requestKey: questionnaire.requestKey,
    response: { answers: { details: { answers: ["answer"] } } },
    threadId: fixtureIdentityValues.NativeThreadId["thread-one"],
  });
  await clearStarted.promise;
  const reload = new Error("Workbench command generation was replaced.");
  Reflect.set(reload, Symbol.for("workbench.agentMcpRuntimeReloadInterruption.v1"), true);
  cancellation.abort(reload);
  releaseClear.resolve();

  await assert.rejects(responding, /clear failed/u);
  await assert.rejects(waiting, /generation was replaced/u);
});

test("controller disposal ends every pending wait without removing its durable projection", async () => {
  const harness = createHarness();
  const waiting = harness.controller.request(freeformInput, new AbortController().signal);
  const questionnaire = await harness.published;
  await harness.controller.dispose();
  await assert.rejects(waiting, /disposed/u);
  assert.deepEqual(harness.controller.list().data, []);
  assert.deepEqual(harness.readPending(), questionnaire);
  assert.equal(harness.clearCount(), 0);
});

test("an unrelated thread-state update during publication is not mistaken for dismissal", async () => {
  const harness = createHarness({ publishUnrelatedStateFirst: true });
  const waiting = harness.controller.request(freeformInput, new AbortController().signal);
  const questionnaire = await harness.published;
  const response = { answers: { details: { answers: ["answer"] } } };
  assert.ok(await harness.controller.respond({
    requestKey: questionnaire.requestKey,
    response,
    threadId: fixtureIdentityValues.NativeThreadId["thread-one"],
  }));
  assert.deepEqual(await waiting, response);
});

test("an unpublished request cannot be listed or answered", async () => {
  const publishStarted = deferred<void>();
  const releasePublish = deferred<void>();
  const harness = createHarness({
    beforePublish: async () => {
      publishStarted.resolve();
      await releasePublish.promise;
    },
  });
  const waiting = harness.controller.request(freeformInput, new AbortController().signal);
  await publishStarted.promise;
  assert.deepEqual(harness.controller.list().data, []);
  assert.equal(await harness.controller.respond({
    requestKey: "workbench-mcp:question-one",
    response: { answers: { details: { answers: ["too early"] } } },
    threadId: fixtureIdentityValues.NativeThreadId["thread-one"],
  }), null);
  releasePublish.resolve();
  const questionnaire = await harness.published;
  const response = { answers: { details: { answers: ["answer"] } } };
  assert.ok(await harness.controller.respond({
    requestKey: questionnaire.requestKey,
    response,
    threadId: fixtureIdentityValues.NativeThreadId["thread-one"],
  }));
  assert.deepEqual(await waiting, response);
});

test("answer settlement already in progress wins controller disposal", async () => {
  const clearStarted = deferred<void>();
  const releaseClear = deferred<void>();
  const harness = createHarness({
    beforeClear: async () => {
      clearStarted.resolve();
      await releaseClear.promise;
    },
  });
  const waiting = harness.controller.request(freeformInput, new AbortController().signal);
  const questionnaire = await harness.published;
  const response = { answers: { details: { answers: ["answer"] } } };
  const responding = harness.controller.respond({
    requestKey: questionnaire.requestKey,
    response,
    threadId: fixtureIdentityValues.NativeThreadId["thread-one"],
  });
  await clearStarted.promise;
  const disposing = harness.controller.dispose();
  releaseClear.resolve();
  assert.deepEqual(await responding, { ...questionnaire, response, threadId: "thread-one" });
  assert.deepEqual(await waiting, response);
  await disposing;
});

test("clear failure during disposal still settles the wait and releases the owner", async () => {
  const clearStarted = deferred<void>();
  const releaseClear = deferred<void>();
  const harness = createHarness({
    beforeClear: async () => {
      clearStarted.resolve();
      await releaseClear.promise;
      throw new Error("clear failed");
    },
  });
  const waiting = harness.controller.request(freeformInput, new AbortController().signal);
  const questionnaire = await harness.published;
  const responding = harness.controller.respond({
    requestKey: questionnaire.requestKey,
    response: { answers: { details: { answers: ["answer"] } } },
    threadId: fixtureIdentityValues.NativeThreadId["thread-one"],
  });
  await clearStarted.promise;
  const disposing = harness.controller.dispose();
  releaseClear.resolve();
  await assert.rejects(responding, /clear failed/u);
  assert.deepEqual(harness.controller.list().data, []);
  await assert.rejects(waiting, /disposed/u);
  await disposing;
  assert.deepEqual(harness.readPending(), questionnaire);
});
