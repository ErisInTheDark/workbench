/*
 * No production exports. Tests protect Workbench questionnaire publication, answer correlation, cancellation, dismissal, and disposal. Keywords: questionnaire, freeform, lifecycle, wait.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { WorkbenchDurableQuestionnaire } from "workbench-shared/workbench/thread/thread-state";
import WorkbenchQuestionnaireController, {
  type WorkbenchQuestionnaireControllerOptions,
} from "./WorkbenchQuestionnaireController";

const freeformInput = {
  callerThreadId: "thread-one",
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
} = {}) {
  const listeners = new Set<Parameters<WorkbenchQuestionnaireControllerOptions["subscribePending"]>[0]>();
  const published = deferred<WorkbenchDurableQuestionnaire>();
  let pending: WorkbenchDurableQuestionnaire | null = null;
  let clearCount = 0;
  const notify = () => {
    for (const listener of listeners) {
      listener({ projectId: "project-one", requestKey: pending?.requestKey ?? null, threadId: "thread-one" });
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
    resolveThread: async () => ({ projectId: "project-one", turnId: "turn-one" }),
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
  assert.equal(questionnaire.request.questions[0]?.options.length, 0);
  assert.equal(questionnaire.request.title, freeformInput.questions[0].question);
  assert.equal(questionnaire.request.questions[0]?.header, freeformInput.questions[0].header);
  assert.deepEqual(harness.controller.list().data, [{
    itemId: null,
    request: questionnaire.request,
    requestKey: questionnaire.requestKey,
    threadId: "thread-one",
    turnId: "turn-one",
  }]);

  const response = { answers: { details: { answers: ["Keep one owner."] } } };
  const consumed = await harness.controller.respond({
    requestKey: questionnaire.requestKey,
    response,
    threadId: "thread-one",
  });
  assert.deepEqual(consumed, { ...questionnaire, response, threadId: "thread-one" });
  assert.deepEqual(await waiting, response);
  assert.deepEqual(harness.controller.list().data, []);
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
    threadId: "thread-one",
  }), null);
  cancellation.abort(new Error("caller cancelled"));
  await assert.rejects(waiting, /caller cancelled/u);
});

test("caller cancellation and durable dismissal both clear the invisible waiter", async () => {
  {
    const harness = createHarness();
    const cancellation = new AbortController();
    const waiting = harness.controller.request(freeformInput, cancellation.signal);
    await harness.published;
    cancellation.abort(new Error("caller cancelled"));
    await assert.rejects(waiting, /caller cancelled/u);
    assert.deepEqual(harness.controller.list().data, []);
  }
  {
    const harness = createHarness();
    const waiting = harness.controller.request(freeformInput, new AbortController().signal);
    await harness.published;
    harness.dismiss();
    await assert.rejects(waiting, /dismissed/u);
    assert.deepEqual(harness.controller.list().data, []);
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
    threadId: "thread-one",
  });
  await clearStarted.promise;
  const reload = new Error("Workbench command generation was replaced.");
  Reflect.set(reload, Symbol.for("workbench.agentMcpRuntimeReloadInterruption.v1"), true);
  cancellation.abort(reload);
  releaseClear.resolve();

  await assert.rejects(responding, /clear failed/u);
  await assert.rejects(waiting, /generation was replaced/u);
});

test("controller disposal rejects every pending wait and removes its projection", async () => {
  const harness = createHarness();
  const waiting = harness.controller.request(freeformInput, new AbortController().signal);
  await harness.published;
  await harness.controller.dispose();
  await assert.rejects(waiting, /disposed/u);
  assert.deepEqual(harness.controller.list().data, []);
});

test("an unrelated thread-state update during publication is not mistaken for dismissal", async () => {
  const harness = createHarness({ publishUnrelatedStateFirst: true });
  const waiting = harness.controller.request(freeformInput, new AbortController().signal);
  const questionnaire = await harness.published;
  const response = { answers: { details: { answers: ["answer"] } } };
  assert.ok(await harness.controller.respond({
    requestKey: questionnaire.requestKey,
    response,
    threadId: "thread-one",
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
    threadId: "thread-one",
  }), null);
  releasePublish.resolve();
  const questionnaire = await harness.published;
  const response = { answers: { details: { answers: ["answer"] } } };
  assert.ok(await harness.controller.respond({
    requestKey: questionnaire.requestKey,
    response,
    threadId: "thread-one",
  }));
  assert.deepEqual(await waiting, response);
});

test("disposal during answer settlement rejects the wait before releasing the owner", async () => {
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
  const responding = harness.controller.respond({
    requestKey: questionnaire.requestKey,
    response: { answers: { details: { answers: ["answer"] } } },
    threadId: "thread-one",
  });
  await clearStarted.promise;
  const disposing = harness.controller.dispose();
  releaseClear.resolve();
  await assert.rejects(responding, /disposed/u);
  await assert.rejects(waiting, /disposed/u);
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
    threadId: "thread-one",
  });
  await clearStarted.promise;
  const disposing = harness.controller.dispose();
  releaseClear.resolve();
  await assert.rejects(responding, /clear failed/u);
  assert.deepEqual(harness.controller.list().data, []);
  await assert.rejects(waiting, /disposed/u);
  await disposing;
});
