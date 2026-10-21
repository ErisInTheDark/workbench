/* No production exports. Tests protect which turns core continues or refreshes, the in-lane supersession check, and failure reporting. */
import assert from "node:assert/strict";
import test from "node:test";
import { ProjectIdSchema, WorkbenchThreadIdSchema, WorkbenchTurnIdSchema } from "workbench-shared/workbench/identity";
import type { WorkbenchProviderObservation } from "workbench-shared/workbench/provider/provider-observation";
import type { WorkbenchThreadLifecycle } from "workbench-shared/workbench/thread/thread-state";
import {
  isWorkbenchThreadRecoveryInput, isWorkbenchUnfinishedTurnInput,
} from "workbench-shared/workbench/thread/thread-recovery-message";
import WorkbenchTurnRecoveryController from "../WorkbenchTurnRecoveryController";
import WorkbenchTurnContinuationController, { type WorkbenchTurnContinuationOptions } from "./WorkbenchTurnContinuationController";

const projectId = ProjectIdSchema.parse("00000000-0000-4000-8000-000000000003");
const threadId = WorkbenchThreadIdSchema.parse("00000000-0000-4000-8000-000000000001");
const turnId = WorkbenchTurnIdSchema.parse("00000000-0000-4000-8000-000000000002");
const unfinished: WorkbenchThreadLifecycle = { kind: "needsAttention", reason: "noActiveTurn", settled: false };
const working: WorkbenchThreadLifecycle = {
  kind: "working", reason: "acceptedIntent", settled: false, agent: { agentStatus: "working", turnId },
};

const completion = (status: "completed" | "interrupted" | "failed" = "completed"): WorkbenchProviderObservation => ({
  turnStarted: null, displayLabel: null, lifecycle: { threadId, event: { kind: "turnCompleted", turnId, status } },
});

function fixture(options: {
  lifecycle?: () => WorkbenchThreadLifecycle;
  latest?: () => { id: string; status: string } | null;
  live?: () => boolean;
  admit?: WorkbenchTurnContinuationOptions["admitHiddenTurn"];
} = {}) {
  const coordinator = new WorkbenchTurnRecoveryController(() => undefined);
  const events: string[] = [];
  const failures: string[] = [];
  const logs: string[] = [];
  const owner = new WorkbenchTurnContinuationController({
    coordinator,
    readLifecycle: async () => ({ projectId, lifecycle: options.lifecycle?.() ?? unfinished }),
    canonicalTurnId: reference => WorkbenchTurnIdSchema.parse(reference),
    interrupt: async () => { events.push("interrupt"); },
    admitHiddenTurn: options.admit ?? (async (_harness, turn) => {
      const current = await turn.isCurrent({
        latestTurn: async () => (options.latest ? options.latest() : { id: turnId, status: "completed" }) as never,
        isTurnLive: async () => options.live?.() ?? false,
      });
      if (!current) return "superseded";
      events.push(isWorkbenchUnfinishedTurnInput(turn.input as never) ? "unfinished"
        : isWorkbenchThreadRecoveryInput(turn.input as never) ? "resume" : "other");
      return "started";
    }),
    reportFailed: async (_projectId, harness, failed) => { failures.push(`${harness}:${failed}`); },
    log: message => { logs.push(message); },
  });
  return { owner, coordinator, events, failures, logs, idle: () => coordinator.waitForIdle() };
}

test("only a completed turn that left its thread unfinished is continued, with the hidden unfinished input", async () => {
  const { owner, events, idle } = fixture();
  owner.observe("claude", completion("interrupted"), unfinished);
  owner.observe("claude", completion("failed"), unfinished);
  owner.observe("claude", completion(), working);
  owner.observe("claude", { turnStarted: null, displayLabel: null, lifecycle: null }, unfinished);
  await idle();
  assert.deepEqual(events, []);
  owner.observe("opencode", completion(), unfinished);
  await idle();
  assert.deepEqual(events, ["unfinished"]);
});

test("a continuation superseded by lifecycle, a newer turn or its turn reopening is skipped without reporting", async () => {
  for (const variant of [
    { lifecycle: () => working },
    { latest: () => ({ id: "newer-turn", status: "inProgress" }) },
    { latest: () => ({ id: turnId, status: "inProgress" }) },
  ]) {
    const { owner, events, failures, idle } = fixture(variant);
    owner.observe("codex", completion(), unfinished);
    await idle();
    assert.deepEqual(events, []);
    assert.deepEqual(failures, []);
  }
});

test("refresh interrupts first, then resumes the same turn in a hidden turn", async () => {
  const { owner, events, failures, idle } = fixture({ lifecycle: () => working, latest: () => ({ id: turnId, status: "interrupted" }) });
  owner.refresh("claude", { threadId, turnId });
  await idle();
  assert.deepEqual(events, ["interrupt", "resume"]);
  assert.deepEqual(failures, []);
});

test("refresh yields to a message admitted after the interruption, but reports a turn that would not stop", async () => {
  const yielded = fixture({ latest: () => ({ id: "user-turn", status: "inProgress" }), live: () => true });
  yielded.owner.refresh("opencode", { threadId, turnId });
  await yielded.idle();
  assert.deepEqual(yielded.events, ["interrupt"]);
  assert.deepEqual(yielded.failures, []);

  const stuck = fixture({ latest: () => ({ id: turnId, status: "inProgress" }), live: () => true });
  stuck.owner.refresh("opencode", { threadId, turnId });
  await stuck.idle();
  assert.deepEqual(stuck.failures, [`opencode:${threadId}`]);
  assert.match(stuck.logs[0]!, /did not stop/u);
});

test("a failed hidden admission reports recovery failure once and logs it", async () => {
  const { owner, failures, logs, idle } = fixture({ admit: async () => { throw new Error("admission rejected"); } });
  owner.observe("claude", completion(), unfinished);
  await idle();
  assert.deepEqual(failures, [`claude:${threadId}`]);
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /admission rejected/u);
});

test("cancel stops a pending hidden turn at its check and waits for one the provider is already admitting", async () => {
  const pending = fixture();
  pending.owner.observe("claude", completion(), unfinished);
  await pending.owner.cancel(threadId);
  await pending.idle();
  assert.deepEqual(pending.events, []);

  const providerAdmitting = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const order: string[] = [];
  const admitting = fixture({ admit: async (_harness, turn) => {
    assert.equal(await turn.isCurrent({
      latestTurn: async () => ({ id: turnId, status: "completed" }) as never, isTurnLive: async () => false,
    }), true);
    providerAdmitting.resolve();
    await release.promise;
    order.push("started");
    return "started";
  } });
  admitting.owner.observe("claude", completion(), unfinished);
  await providerAdmitting.promise;
  const cancelled = admitting.owner.cancel(threadId).then(() => { order.push("cancelled"); });
  release.resolve();
  await cancelled;
  assert.deepEqual(order, ["started", "cancelled"]);
  await admitting.idle();
  assert.deepEqual(admitting.failures, []);
});

test("a disposed generation schedules nothing more, and refresh rejects while draining", async () => {
  const { owner, events, idle } = fixture();
  owner.dispose();
  owner.observe("claude", completion(), unfinished);
  await idle();
  assert.deepEqual(events, []);

  const draining = fixture();
  draining.coordinator.beginRuntimeDrain();
  assert.throws(() => draining.owner.refresh("codex", { threadId, turnId }), /draining/u);
});
