/* No production exports. Protect explicit refresh, unfinished continuation and generation ownership. */
import assert from "node:assert/strict";
import test from "node:test";
import { WORKBENCH_UNFINISHED_TURN_MESSAGE } from "workbench-shared/workbench/thread/thread-recovery-message";
import { WorkbenchThreadIdSchema, WorkbenchTurnIdSchema } from "workbench-shared/workbench/identity";
import CodexRecoveryController, { type CodexRecoveryOptions } from "./CodexRecoveryController";
import WorkbenchTurnRecoveryController from "./WorkbenchTurnRecoveryController";
import type { JsonRpcRequest } from "./bridge-types";

function createRecovery(options: Partial<CodexRecoveryOptions> = {}) {
  return new CodexRecoveryController({
    coordinator: new WorkbenchTurnRecoveryController(() => undefined),
    log: () => undefined,
    reportFailure: async () => undefined,
    runTask: async (_label, task) => task(),
    ...options,
  });
}

function observe(controller: CodexRecoveryController, harness = "codex", threadId = "thread", id = "original") {
  controller.observeRequest(harness, {
    id, method: "turn/start",
    params: { cwd: "C:/workspace", input: [{ text: "hello", type: "text" }], model: "model", threadId },
    workbenchPromptContext: { agentPath: "agent://lily.md", workflowIds: ["default"] },
  });
  controller.observeNotification(harness, { method: "turn/started", params: { threadId, turn: { id: "turn" } } });
}

test("explicit refresh validates an observed started turn and uses the lifecycle scheduler", async () => {
  let execute!: () => void;
  let finishTask = Promise.resolve();
  const received: JsonRpcRequest[] = [];
  const controller = createRecovery({
    recover: async candidate => { received.push(candidate.request); return "recovered"; },
    coordinator: new WorkbenchTurnRecoveryController(() => undefined, (_label, task) => {
      finishTask = new Promise<void>((resolve, reject) => {
        execute = () => { void task().then(resolve, reject); };
      });
      return finishTask;
    }),
  });
  await assert.rejects(controller.requestResume("codex", "thread"), /no captured/);
  controller.observeRequest("codex", { id: "early", method: "turn/start", params: { threadId: "thread", input: [] } });
  await assert.rejects(controller.requestResume("codex", "thread"), /not started/);
  observe(controller);
  await controller.requestResume("codex", "thread");
  assert.equal(received.length, 0);
  assert.equal(controller.listRuntimeDrainPending().length, 1);
  execute();
  await finishTask;
  await controller.waitForIdle();
  assert.equal(received.length, 1);
  assert.deepEqual(received[0].workbenchPromptContext, { agentPath: "agent://lily.md", workflowIds: ["default"] });
  assert.deepEqual(received[0].params, { cwd: "C:/workspace", input: [{ text: "hello", type: "text" }], model: "model", threadId: "thread" });
  assert.equal(controller.listRuntimeDrainPending().length, 0);
});

test("code replacement retains exact active context and unmatched resume context", async () => {
  const controller = createRecovery();
  const resumeRequest = {
    method: "thread/resume", params: { model: "new-model", serviceTier: "priority", threadId: "next" },
    workbenchPromptContext: { workflowIds: ["default"] },
  };
  controller.observeRequest("codex", resumeRequest);
  observe(controller);
  const state = await controller.detachForReload();
  const requests: Array<{ threadId: string; resume?: JsonRpcRequest | null }> = [];
  const restored = createRecovery({
    state, recover: async candidate => { requests.push({ threadId: candidate.threadId, resume: candidate.resumeRequest }); return "recovered"; },
  });
  await restored.requestResume("codex", "thread");
  await restored.waitForIdle();
  observe(restored, "codex", "next");
  await restored.requestResume("codex", "next");
  await restored.waitForIdle();
  assert.deepEqual(requests.map(request => request.threadId), ["thread", "next"]);
  assert.deepEqual(requests[1].resume, resumeRequest);
  assert.deepEqual(requests[0].resume, {
    method: "thread/resume", params: { cwd: "C:/workspace", model: "model", threadId: "thread" },
    workbenchPromptContext: { agentPath: "agent://lily.md", workflowIds: ["default"] },
  });
});

test("retired generation cannot settle a late refresh after the owner resumes", async () => {
  let finish!: (value: "recovered") => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const provider = new Promise<"recovered">(resolve => { finish = resolve; });
  const controller = createRecovery({
    recover: async () => { entered(); return await provider; },
  });
  observe(controller);
  await controller.requestResume("codex", "thread");
  await started;
  controller.expireRuntimeDrain();
  const state = await controller.detachForReload();
  controller.resumeAfterFailedReload();
  finish("recovered");
  await provider;
  await controller.waitForIdle();
  assert.deepEqual((await controller.detachForReload()).candidates, state.candidates);
});

test("explicit refresh failures publish once and never retire a replacement turn", async () => {
  const failures: string[] = [];
  const controller = createRecovery({
    reportFailure: async candidate => { failures.push(candidate.threadId); },
  });
  observe(controller);
  await controller.requestResume("codex", "thread", async () => { throw new Error("provider failure"); });
  await controller.waitForIdle();
  assert.deepEqual(failures, ["thread"]);
  await assert.rejects(controller.requestResume("codex", "thread", async () => "recovered"), /no captured/);
  observe(controller);
  await controller.requestResume("codex", "thread", async () => {
    observe(controller, "codex", "thread", "replacement");
    return "recovered";
  });
  await controller.waitForIdle();
  const state = await controller.detachForReload();
  assert.equal(state.candidates[0].request.id, "replacement");
});

test("busy refresh retains the observed turn and draining rejects new work", async () => {
  const controller = createRecovery();
  observe(controller);
  await controller.requestResume("codex", "thread", async () => "busy");
  await controller.waitForIdle();
  let calls = 0;
  await controller.requestResume("codex", "thread", async () => { calls++; return "recovered"; });
  await controller.waitForIdle();
  assert.equal(calls, 1);
  controller.beginRuntimeDrain();
  await assert.rejects(controller.requestResume("codex", "thread", async () => "recovered"), /draining/);
});

const target = {
  threadId: WorkbenchThreadIdSchema.parse("00000000-0000-4000-8000-000000000001"),
  turnId: WorkbenchTurnIdSchema.parse("00000000-0000-4000-8000-000000000002"),
};
const completed = (status = "completed", id = "turn") => (
  { method: "turn/completed", params: { threadId: "thread", turn: { id, status } } }
);
const resolveThread = async () => "thread";

test("a completed turn continues once, across a reload, with its exact request context", async () => {
  const controller = createRecovery({ resolveThread });
  observe(controller);
  controller.observeNotification("codex", completed());
  await assert.rejects(controller.requestResume("codex", "thread", async () => "recovered"), /no captured/,
    "a completed turn cannot be refreshed");
  const restored = createRecovery({ resolveThread, state: await controller.detachForReload() });
  const starts: JsonRpcRequest[] = [];
  const port = async (_candidate: object, request: JsonRpcRequest) => { starts.push(request); };
  await restored.continueUnfinished(target, port);
  await restored.continueUnfinished(target, port);
  assert.equal(starts.length, 1);
  assert.deepEqual(starts[0].workbenchPromptContext, { agentPath: "agent://lily.md", workflowIds: ["default"] });
  assert.deepEqual(starts[0].params, {
    cwd: "C:/workspace", model: "model", threadId: "thread", clientUserMessageId: starts[0].id,
    input: [{ text: WORKBENCH_UNFINISHED_TURN_MESSAGE, text_elements: [], type: "text" }],
  });
});

test("stopped, failed and superseded turns never continue", async () => {
  const never = async () => assert.fail("this turn must not continue");
  for (const status of ["interrupted", "failed"]) {
    const controller = createRecovery({ resolveThread });
    observe(controller);
    controller.observeNotification("codex", completed(status));
    await controller.continueUnfinished(target, never);
  }
  const superseded = createRecovery({ resolveThread });
  observe(superseded);
  superseded.observeNotification("codex", completed());
  observe(superseded, "codex", "thread", "user-message");
  await superseded.continueUnfinished(target, never);
});

test("failed unfinished continuation throws to its caller and retires its own replacement", async () => {
  const controller = createRecovery({ resolveThread });
  observe(controller);
  controller.observeNotification("codex", completed());
  await assert.rejects(controller.continueUnfinished(target, async (candidate, request) => {
    controller.observeRequest(candidate.harness, request);
    throw new Error("provider rejected continuation");
  }), /provider rejected continuation/);
  assert.deepEqual((await controller.detachForReload()).candidates, []);
});

test("late completion of another turn cannot retire current context", async () => {
  const controller = createRecovery({ resolveThread });
  observe(controller);
  controller.observeNotification("codex", completed("completed", "older"));
  await controller.continueUnfinished(target, async () => assert.fail("must not continue an older turn"));
  const state = await controller.detachForReload();
  assert.equal(state.candidates[0].turnId, "turn");
});
