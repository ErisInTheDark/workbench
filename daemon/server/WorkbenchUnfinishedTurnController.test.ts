/* No production exports. Tests protect which completed turns Workbench core continues, the pre-continuation lifecycle fence, unsupported providers, and failure reporting. */
import assert from "node:assert/strict";
import test from "node:test";
import { ProjectIdSchema, WorkbenchThreadIdSchema, WorkbenchTurnIdSchema } from "workbench-shared/workbench/identity";
import type { WorkbenchProviderObservation } from "workbench-shared/workbench/provider/provider-observation";
import type { WorkbenchThreadLifecycle } from "workbench-shared/workbench/thread/thread-state";
import WorkbenchTurnRecoveryController from "./WorkbenchTurnRecoveryController";
import WorkbenchUnfinishedTurnController, { type WorkbenchUnfinishedTurnOptions } from "./WorkbenchUnfinishedTurnController";

const projectId = ProjectIdSchema.parse("00000000-0000-4000-8000-000000000003");
const threadId = WorkbenchThreadIdSchema.parse("00000000-0000-4000-8000-000000000001");
const turnId = WorkbenchTurnIdSchema.parse("00000000-0000-4000-8000-000000000002");
const unfinished: WorkbenchThreadLifecycle = { kind: "needsAttention", reason: "noActiveTurn", settled: false };
const completedByAgent: WorkbenchThreadLifecycle = {
  kind: "completed", reason: "agentCompleted", settled: false, agent: { agentStatus: "completed", turnId },
};

const completion = (status: "completed" | "interrupted" | "failed" = "completed"): WorkbenchProviderObservation => ({
  turnStarted: null, displayLabel: null, lifecycle: { threadId, event: { kind: "turnCompleted", turnId, status } },
});

function fixture(options: Partial<WorkbenchUnfinishedTurnOptions> & { current?: WorkbenchThreadLifecycle } = {}) {
  const coordinator = new WorkbenchTurnRecoveryController(() => undefined);
  const continued: string[] = [];
  const failures: string[] = [];
  const logs: string[] = [];
  const owner = new WorkbenchUnfinishedTurnController({
    coordinator,
    readLifecycle: async () => ({ projectId, lifecycle: options.current ?? unfinished }),
    continueUnfinished: async (harness, target) => { continued.push(`${harness}:${target.turnId}`); return "handled"; },
    reportFailed: async (_projectId, harness, failed) => { failures.push(`${harness}:${failed}`); },
    log: message => { logs.push(message); },
    ...options,
  });
  return { owner, continued, failures, logs, idle: () => coordinator.waitForIdle() };
}

test("only a completed turn that left its thread unfinished is continued", async () => {
  const { owner, continued, idle } = fixture();
  owner.observe("claude", completion("interrupted"), unfinished);
  owner.observe("claude", completion("failed"), unfinished);
  owner.observe("claude", completion(), completedByAgent);
  owner.observe("claude", { turnStarted: null, displayLabel: null, lifecycle: null }, unfinished);
  await idle();
  assert.deepEqual(continued, []);
  owner.observe("claude", completion(), unfinished);
  await idle();
  assert.deepEqual(continued, [`claude:${turnId}`]);
});

test("a thread that moved on before the scheduled continuation ran is left alone", async () => {
  const { owner, continued, idle } = fixture({
    current: { kind: "working", reason: "acceptedIntent", settled: false, agent: { agentStatus: "working", turnId } },
  });
  owner.observe("opencode", completion(), unfinished);
  await idle();
  assert.deepEqual(continued, []);
});

test("providers without the capability are skipped without reporting failure", async () => {
  const { owner, failures, idle } = fixture({ continueUnfinished: async () => "unsupported" });
  owner.observe("codex", completion(), unfinished);
  await idle();
  assert.deepEqual(failures, []);
});

test("a failed continuation reports recovery failure once and logs it", async () => {
  const { owner, failures, logs, idle } = fixture({
    continueUnfinished: async () => { throw new Error("admission rejected"); },
  });
  owner.observe("claude", completion(), unfinished);
  await idle();
  assert.deepEqual(failures, [`claude:${threadId}`]);
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /admission rejected/u);
});

test("a disposed generation schedules nothing more", async () => {
  const { owner, continued, idle } = fixture();
  owner.dispose();
  owner.observe("claude", completion(), unfinished);
  await idle();
  assert.deepEqual(continued, []);
});
