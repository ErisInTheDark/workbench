/*
 * No production exports. Node tests protect live-only admission, goal exclusion, recency caps, and progress retirement.
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { WORKBENCH_UNFINISHED_TURN_MESSAGE } from "workbench-shared/workbench/thread/thread-recovery-message";
import WorkbenchTurnRecoveryController, { MAX_AUTOMATIC_RECOVERY_THREADS } from "./WorkbenchTurnRecoveryController";
import WorkbenchTurnRecoveryHandoffStore from "./WorkbenchTurnRecoveryHandoffStore";
import { WorkbenchTurnIdSchema } from "workbench-shared/workbench/identity";

test("future provider handoffs survive persistence without entering another provider's recovery", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-future-recovery-"));
  const store = new WorkbenchTurnRecoveryHandoffStore(root);
  const controller = new WorkbenchTurnRecoveryController(store, () => undefined);
  controller.observeRequest("future-provider", { id: "start", method: "turn/start", params: { input: [], threadId: "future-thread" } });
  controller.observeNotification("future-provider", { method: "turn/started", params: { threadId: "future-thread", turn: { id: "future-turn" } } });
  const { candidate } = await controller.persistManualResume("future-provider", "future-thread");
  assert.deepEqual((await new WorkbenchTurnRecoveryHandoffStore(root).load())?.candidates, [candidate]);
  assert.deepEqual(controller.capture(["codex"]), []);
  assert.deepEqual(controller.capture(["future-provider"]), [candidate]);
});

for (const cancelledOwner of ["controller", "bridge"] as const) {
test(`${cancelledOwner} expiry cannot settle a late provider result after rollback resumes the owner`, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-recovery-expiry-"));
  const controller = new WorkbenchTurnRecoveryController(new WorkbenchTurnRecoveryHandoffStore(root), () => {});
  controller.observeRequest("codex", { id: "start", method: "turn/start", params: { threadId: "thread", input: [] } });
  const candidates = controller.capture(["codex"]);
  let finish!: (result: "recovered") => void;
  const provider = new Promise<"recovered">((resolve) => { finish = resolve; });
  const caller = new AbortController();
  const recovery = controller.recover(candidates, () => provider, undefined, undefined, caller.signal);
  if (cancelledOwner === "controller") controller.expireRuntimeDrain();
  else caller.abort(new Error("provider bridge retired"));
  await controller.detachForReload();
  controller.resumeAfterFailedReload();
  finish("recovered");
  await recovery;
  assert.deepEqual(controller.capture(["codex"]), candidates);
  await controller.recover(candidates, async () => "recovered");
  assert.deepEqual(controller.capture(["codex"]), []);
});
}

test("controller admits only observed starts, excludes goals, and keeps newest ten", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-recovery-controller-"));
  const controller = new WorkbenchTurnRecoveryController(new WorkbenchTurnRecoveryHandoffStore(root), () => undefined);
  for (let index = 0; index < 12; index += 1) {
    controller.observeRequest("codex", { id: index, method: "turn/start", params: { input: [], threadId: `thread-${index}` } }, index);
  }
  controller.observeRequest("codex", { id: 20, method: "thread/goal/set", params: { threadId: "thread-11" } }, 20);
  const captured = controller.capture(["codex"]);
  assert.equal(captured.length, MAX_AUTOMATIC_RECOVERY_THREADS);
  assert.equal(captured.some((candidate) => candidate.threadId === "thread-11"), false);
  assert.equal(captured[0]?.threadId, "thread-10");
});

test("manual resume captures an exact active request even for a goal-owned thread", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-manual-resume-"));
  const store = new WorkbenchTurnRecoveryHandoffStore(root);
  const controller = new WorkbenchTurnRecoveryController(store, () => undefined);
  controller.observeRequest("codex", { id: "original", method: "turn/start", params: { input: [{ text: "hello", type: "text" }], threadId: "thread" } });
  controller.observeNotification("codex", { method: "turn/started", params: { threadId: "thread", turn: { id: "turn" } } });
  controller.observeRequest("codex", { id: "goal", method: "thread/goal/set", params: { threadId: "thread" } });
  const { candidate, handoff } = await controller.persistManualResume("codex", "thread");
  assert.equal(candidate.turnId, "turn");
  assert.deepEqual(candidate.request.params, { input: [{ text: "hello", type: "text" }], threadId: "thread" });
  assert.deepEqual((await store.load())?.candidates, handoff.candidates);
});

test("manual resume defers provider work through the lifecycle-owned scheduler", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-manual-resume-scheduler-"));
  const store = new WorkbenchTurnRecoveryHandoffStore(root);
  let calls = 0;
  let execute = () => undefined;
  let scheduledLabel = "";
  let taskFinished = Promise.resolve();
  const controller = new WorkbenchTurnRecoveryController(
    store,
    () => undefined,
    undefined,
    undefined,
    { codex: async () => { calls += 1; return "recovered"; } },
    (label, task) => {
      scheduledLabel = label;
      taskFinished = new Promise<void>((resolve, reject) => {
        execute = () => { void task().then(resolve, reject); };
      });
      return taskFinished;
    },
  );
  controller.observeRequest("codex", { id: "original", method: "turn/start", params: { input: [], threadId: "thread" } });
  controller.observeNotification("codex", { method: "turn/started", params: { threadId: "thread", turn: { id: "turn" } } });
  await controller.requestResume("codex", "thread");
  assert.equal(calls, 0);
  assert.equal(scheduledLabel, "manual resume codex:thread");
  execute();
  await taskFinished;
  assert.equal(calls, 1);
});

test("controller pairs the latest prompt-bearing Codex resume with its turn", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-resume-pair-"));
  const controller = new WorkbenchTurnRecoveryController(new WorkbenchTurnRecoveryHandoffStore(root), () => undefined);
  const resumeRequest = {
    method: "thread/resume",
    params: { model: "gpt", serviceTier: "priority", threadId: "thread" },
    workbenchPromptContext: { agentPath: "agent://lily.md", workflowIds: ["default"] },
  };
  controller.observeRequest("codex", resumeRequest);
  controller.observeRequest("codex", { id: "start", method: "turn/start", params: { input: [], threadId: "thread" } });
  assert.deepEqual(controller.capture(["codex"])[0]?.resumeRequest, resumeRequest);
});

test("controller handoff preserves active candidates and unmatched resume requests", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-recovery-state-"));
  const store = new WorkbenchTurnRecoveryHandoffStore(root);
  const controller = new WorkbenchTurnRecoveryController(store, () => undefined);
  controller.observeRequest("codex", { method: "thread/resume", params: { threadId: "next" }, workbenchPromptContext: { workflowIds: ["default"] } });
  controller.observeRequest("codex", { id: "start", method: "turn/start", params: { input: [], model: "gpt", threadId: "active" } });
  const restored = new WorkbenchTurnRecoveryController(store, () => undefined, undefined, await controller.detachForReload());
  assert.deepEqual(restored.capture(["codex"]), controller.capture(["codex"]));
  restored.observeRequest("codex", { id: "next-start", method: "turn/start", params: { input: [], threadId: "next" } });
  assert.deepEqual(restored.capture(["codex"]).find((candidate) => candidate.threadId === "next")?.resumeRequest, {
    method: "thread/resume",
    params: { threadId: "next" },
    workbenchPromptContext: { workflowIds: ["default"] },
  });
});

test("terminal notifications retire the exact candidate", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-recovery-terminal-"));
  const controller = new WorkbenchTurnRecoveryController(new WorkbenchTurnRecoveryHandoffStore(root), () => undefined);
  controller.observeRequest("opencode", { id: 1, method: "turn/start", params: { input: [], threadId: "thread" } });
  controller.observeNotification("opencode", { method: "turn/completed", params: { threadId: "thread", turn: { id: "turn", status: "interrupted" } } });
  assert.deepEqual(controller.capture(["opencode"]), []);
});

test("normally completed unfinished turns start one exact hidden continuation", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-unfinished-turn-"));
  const controller = new WorkbenchTurnRecoveryController(new WorkbenchTurnRecoveryHandoffStore(root), () => undefined);
  const originalRequest = {
    id: "original",
    method: "turn/start",
    params: {
      approvalPolicy: "never",
      cwd: "C:/workspace",
      input: [{ text: "hello", text_elements: [], type: "text" }],
      model: "gpt",
      threadId: "thread",
    },
    workbenchPromptContext: { agentPath: "agent://lily.md", workflowIds: ["default"] },
  };
  controller.observeRequest("copilot", originalRequest);
  controller.observeNotification("copilot", { method: "turn/started", params: { threadId: "thread", turn: { id: "turn" } } });
  controller.observeNotification("copilot", { method: "turn/completed", params: { threadId: "thread", turn: { id: "turn", status: "completed" } } });
  assert.equal(controller.capture(["codex", "opencode"]).length, 0);

  const starts: Array<{ candidateHarness: string; request: Record<string, unknown> }> = [];
  const started = await controller.completeObservedTurn(
    "copilot",
    { method: "turn/completed", params: { threadId: "thread", turn: { id: "turn", status: "completed" } } },
    { kind: "needsAttention", reason: "noActiveTurn", settled: false },
    async (candidate, request) => { starts.push({ candidateHarness: candidate.harness, request }); },
  );

  assert.equal(started, true);
  assert.equal(starts.length, 1);
  assert.equal(starts[0]?.candidateHarness, "copilot");
  assert.equal(starts[0]?.request.method, "turn/start");
  assert.deepEqual(starts[0]?.request.workbenchPromptContext, originalRequest.workbenchPromptContext);
  assert.deepEqual(starts[0]?.request.params, {
    ...originalRequest.params,
    clientUserMessageId: starts[0]?.request.id,
    input: [{ text: WORKBENCH_UNFINISHED_TURN_MESSAGE, text_elements: [], type: "text" }],
  });
});

test("unfinished-turn continuation rejects every legitimate terminal owner", async () => {
  const lifecycles = [
    { agent: { agentStatus: "completed", turnId: WorkbenchTurnIdSchema.parse("turn") }, kind: "completed", reason: "agentCompleted", settled: false } as const,
    { agent: { agentStatus: "blocked", turnId: WorkbenchTurnIdSchema.parse("turn") }, kind: "needsAttention", reason: "agentBlocked", settled: false } as const,
    { kind: "needsAttention", reason: "pendingInput", requestKey: "question", settled: false, turnId: WorkbenchTurnIdSchema.parse("turn") } as const,
  ];
  for (const [index, lifecycle] of lifecycles.entries()) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), `workbench-unfinished-gate-${index}-`));
    const controller = new WorkbenchTurnRecoveryController(new WorkbenchTurnRecoveryHandoffStore(root), () => undefined);
    controller.observeRequest("codex", { id: index, method: "turn/start", params: { input: [], threadId: "thread" } });
    controller.observeNotification("codex", { method: "turn/started", params: { threadId: "thread", turn: { id: "turn" } } });
    controller.observeNotification("codex", { method: "turn/completed", params: { threadId: "thread", turn: { id: "turn", status: "completed" } } });
    let calls = 0;
    assert.equal(await controller.completeObservedTurn(
      "codex",
      { method: "turn/completed", params: { threadId: "thread", turn: { id: "turn", status: "completed" } } },
      lifecycle,
      async () => { calls += 1; },
    ), false);
    assert.equal(calls, 0);
  }
});

test("user stops, failures, and goal-owned turns never start unfinished continuations", async () => {
  for (const status of ["interrupted", "failed"] as const) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), `workbench-unfinished-${status}-`));
    const controller = new WorkbenchTurnRecoveryController(new WorkbenchTurnRecoveryHandoffStore(root), () => undefined);
    controller.observeRequest("opencode", { id: status, method: "turn/start", params: { input: [], threadId: "thread" } });
    controller.observeNotification("opencode", { method: "turn/started", params: { threadId: "thread", turn: { id: "turn" } } });
    const notification = { method: "turn/completed", params: { threadId: "thread", turn: { id: "turn", status } } };
    controller.observeNotification("opencode", notification);
    assert.equal(await controller.completeObservedTurn(
      "opencode",
      notification,
      { kind: "needsAttention", reason: "noActiveTurn", settled: false },
      async () => { throw new Error("must not run"); },
    ), false);
  }

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-unfinished-goal-"));
  const controller = new WorkbenchTurnRecoveryController(new WorkbenchTurnRecoveryHandoffStore(root), () => undefined);
  controller.observeRequest("codex", { id: "start", method: "turn/start", params: { input: [], threadId: "thread" } });
  controller.observeNotification("codex", { method: "turn/started", params: { threadId: "thread", turn: { id: "turn" } } });
  controller.observeRequest("codex", { id: "goal", method: "thread/goal/set", params: { threadId: "thread" } });
  controller.observeRequest("codex", { id: "clear", method: "thread/goal/clear", params: { threadId: "thread" } });
  const notification = { method: "turn/completed", params: { threadId: "thread", turn: { id: "turn", status: "completed" } } };
  controller.observeNotification("codex", notification);
  assert.equal(await controller.completeObservedTurn(
    "codex",
    notification,
    { kind: "needsAttention", reason: "noActiveTurn", settled: false },
    async () => { throw new Error("must not run"); },
  ), false);
});

test("failed unfinished continuation reports once and retires its registered replacement", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-unfinished-failure-"));
  const failures: string[] = [];
  const controller = new WorkbenchTurnRecoveryController(
    new WorkbenchTurnRecoveryHandoffStore(root),
    () => undefined,
    async (candidate) => { failures.push(candidate.threadId); },
  );
  controller.observeRequest("copilot", { id: "start", method: "turn/start", params: { input: [], threadId: "thread" } });
  controller.observeNotification("copilot", { method: "turn/started", params: { threadId: "thread", turn: { id: "turn" } } });
  const notification = { method: "turn/completed", params: { threadId: "thread", turn: { id: "turn", status: "completed" } } };
  controller.observeNotification("copilot", notification);
  assert.equal(await controller.completeObservedTurn(
    "copilot",
    notification,
    { kind: "needsAttention", reason: "noActiveTurn", settled: false },
    async (candidate, request) => {
      controller.observeRequest(candidate.harness, request);
      throw new Error("provider rejected continuation");
    },
  ), false);
  assert.deepEqual(failures, ["thread"]);
  const state = await controller.detachForReload();
  assert.deepEqual(state.candidates, []);
});

test("late completion for an older turn cannot retire a newer candidate", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-recovery-late-terminal-"));
  const controller = new WorkbenchTurnRecoveryController(new WorkbenchTurnRecoveryHandoffStore(root), () => undefined);
  controller.observeRequest("codex", { id: 1, method: "turn/start", params: { input: [], threadId: "thread" } });
  controller.observeNotification("codex", { method: "turn/started", params: { threadId: "thread", turn: { id: "new-turn" } } });
  controller.observeNotification("codex", { method: "turn/completed", params: { threadId: "thread", turn: { id: "old-turn" } } });
  assert.equal(controller.capture(["codex"])[0]?.turnId, "new-turn");
});

test("recovery failures publish once and retire the failed live candidate", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-recovery-progress-"));
  const store = new WorkbenchTurnRecoveryHandoffStore(root);
  const controller = new WorkbenchTurnRecoveryController(store, () => undefined);
  controller.observeRequest("codex", { id: 1, method: "turn/start", params: { input: [], threadId: "first" } }, 2);
  controller.observeRequest("codex", { id: 2, method: "turn/start", params: { input: [], threadId: "second" } }, 1);
  const candidates = controller.capture(["codex"]);
  let calls = 0;
  const failures: string[] = [];
  const reportingController = new WorkbenchTurnRecoveryController(store, () => undefined, async (candidate) => { failures.push(candidate.threadId); });
  reportingController.loadCandidates(candidates);
  await reportingController.recover(candidates, async () => {
    calls += 1;
    if (calls === 2) throw new Error("recovery failed");
    return "recovered";
  });
  assert.deepEqual(failures, ["second"]);
});

test("recovery cannot retire a replacement candidate registered for the same thread", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-recovery-replacement-"));
  const controller = new WorkbenchTurnRecoveryController(new WorkbenchTurnRecoveryHandoffStore(root), () => undefined);
  controller.observeRequest("codex", { id: "original", method: "turn/start", params: { input: [], threadId: "thread" } });
  const original = controller.capture(["codex"])[0];
  assert.ok(original);

  await controller.recover([original], async () => {
    controller.observeRequest("codex", { id: "recovery-start", method: "turn/start", params: { input: [], threadId: "thread" } });
    return "recovered";
  });

  const replacement = controller.capture(["codex"])[0];
  assert.ok(replacement);
  assert.notEqual(replacement.recoveryId, original.recoveryId);
});

test("busy recovery candidates remain registered", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-recovery-busy-"));
  const controller = new WorkbenchTurnRecoveryController(new WorkbenchTurnRecoveryHandoffStore(root), () => undefined);
  controller.observeRequest("codex", { id: "busy", method: "turn/start", params: { input: [], threadId: "thread" } });
  const candidate = controller.capture(["codex"])[0];
  assert.ok(candidate);

  await controller.recover([candidate], async () => "busy");

  assert.equal(controller.capture(["codex"])[0]?.recoveryId, candidate.recoveryId);
});
