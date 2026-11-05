/*
 * No production exports. Regression wards for when threads auto resume: attribution, waiting, spreading, re-gating, the idle threshold and giving up.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { WorkbenchThreadIdSchema, WorkbenchTurnIdSchema } from "workbench-shared/workbench/identity";
import type { WorkbenchAccountLimits } from "workbench-shared/workbench/provider/provider-account";
import type { WorkbenchThreadLifecycle } from "workbench-shared/workbench/thread/thread-state";
import WorkbenchThreadAutoResumeController, { countEndedAlike, type AutoResumeThread } from "./WorkbenchThreadAutoResumeController";

const MINUTE = 60_000;
const START = 1_000_000_000;
const turnId = WorkbenchTurnIdSchema.parse("turn");
const failed = (resumeAt?: number): WorkbenchThreadLifecycle => ({
  kind: "needsAttention", reason: "providerFailed", settled: false, turnId, error: "boom", ...(resumeAt === undefined ? {} : { resumeAt }),
});
const interrupted: WorkbenchThreadLifecycle = { kind: "needsAttention", reason: "interrupted", settled: false, turnId };
const question: WorkbenchThreadLifecycle = { kind: "needsAttention", reason: "pendingInput", requestKey: "key", settled: false, turnId };

function capped(resetsAt: number | null): WorkbenchAccountLimits {
  return { preferredLimitId: null, rateLimitsByLimitId: null, rateLimits: {
    limitId: null, limitName: null, primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: resetsAt === null ? null : resetsAt / 1_000 },
    secondary: null, credits: null, individualLimit: null, spendControlReached: null, planType: null, rateLimitReachedType: null,
  } };
}

/** Time only moves through `advance`, which fires due timers and lets their passes finish. */
function harness(options: { threads: Record<string, WorkbenchThreadLifecycle>; limits?: WorkbenchAccountLimits | null; statuses?: readonly string[]; enabled?: boolean; idleMinutes?: number }) {
  let now = START;
  const threads = new Map(Object.entries(options.threads).map(([id, lifecycle]) => [id, { lifecycle, activityAt: START }]));
  const resumed: string[] = [];
  const onFailed = new Map<string, () => void>();
  const timers = new Set<{ at: number; run: () => void }>();
  const state = { limits: options.limits ?? null };
  const read = (id: string): AutoResumeThread | null => {
    const thread = threads.get(id);
    return thread ? { harness: "claude", threadId: WorkbenchThreadIdSchema.parse(id), ...thread } : null;
  };
  const controller = new WorkbenchThreadAutoResumeController({
    readSettings: async () => ({ enabled: options.enabled ?? true, idleMinutes: options.idleMinutes ?? 60 }),
    listThreads: async () => [...threads.keys()].map(id => read(id)!),
    readThread: async id => read(id),
    readLimits: async () => state.limits,
    readTurnStatuses: async () => options.statuses ?? ["failed"],
    setResumeAt: async (thread, _turn, resumeAt) => {
      const { resumeAt: _old, ...lifecycle } = thread.lifecycle as Extract<WorkbenchThreadLifecycle, { reason: "providerFailed" }>;
      threads.get(thread.threadId)!.lifecycle = resumeAt === null ? lifecycle : { ...lifecycle, resumeAt };
    },
    resume: async (thread, _turn, failedToStart) => {
      resumed.push(thread.threadId);
      onFailed.set(thread.threadId, failedToStart);
      threads.get(thread.threadId)!.lifecycle = { kind: "working", reason: "acceptedIntent", settled: false, agent: { agentStatus: "working", turnId } };
    },
    schedule: (run, delayMs) => { const timer = { at: now + delayMs, run }; timers.add(timer); return timer; },
    cancel: timer => { timers.delete(timer as { at: number; run: () => void }); },
    now: () => now,
    warn: message => { throw new Error(message); },
  });
  const settle = async () => { for (let index = 0; index < 20; index += 1) await new Promise(resolve => { setImmediate(resolve); }); };
  return {
    controller, resumed, threads, onFailed, settle, state,
    fail(id: string, usageLimit?: { resumeAt: number | null }) {
      threads.get(id)!.lifecycle = failed();
      controller.observe({ turnStarted: null, displayLabel: null, lifecycle: {
        threadId: WorkbenchThreadIdSchema.parse(id),
        event: { kind: "turnCompleted", status: "failed", turnId, error: "boom", ...(usageLimit ? { usageLimit } : {}) },
      } });
    },
    async advance(ms: number) {
      const end = now + ms;
      await settle();
      for (;;) {
        const due = [...timers].filter(timer => timer.at <= end).sort((left, right) => left.at - right.at)[0];
        if (!due) break;
        now = Math.max(now, due.at);
        timers.delete(due);
        due.run();
        await settle();
      }
      now = end;
    },
    now: () => now,
  };
}

test("a failure at the usage cap waits for the latest reset, whatever the error said", async () => {
  const resetAt = START + 300 * MINUTE;
  const run = harness({ threads: { a: failed() }, limits: capped(resetAt) });
  run.fail("a");
  await run.advance(299 * MINUTE);
  assert.deepEqual(run.threads.get("a")!.lifecycle, failed(resetAt));
  assert.deepEqual(run.resumed, []);
  run.state.limits = null;
  await run.advance(2 * MINUTE);
  assert.deepEqual(run.resumed, ["a"]);
});

test("a failure below the cap with no provider word stays a plain thread error", async () => {
  const run = harness({ threads: { a: failed() } });
  run.fail("a");
  await run.advance(600 * MINUTE);
  assert.deepEqual(run.threads.get("a")!.lifecycle, failed());
  assert.deepEqual(run.resumed, []);
  assert.equal(run.controller.hasPendingWork(), false);
});

test("the provider's word arms a failure when limits cannot answer, backing off without a reset", async () => {
  const run = harness({ threads: { a: failed() } });
  run.fail("a", { resumeAt: null });
  await run.advance(4 * MINUTE);
  assert.deepEqual(run.resumed, []);
  await run.advance(2 * MINUTE);
  assert.deepEqual(run.resumed, ["a"]);
});

test("a thread holding a question is never armed or resumed", async () => {
  const run = harness({ threads: { a: question }, limits: capped(START + MINUTE) });
  await run.controller.start();
  run.controller.observe({ turnStarted: null, displayLabel: null, lifecycle: {
    threadId: WorkbenchThreadIdSchema.parse("a"), event: { kind: "turnCompleted", status: "failed", turnId, usageLimit: { resumeAt: START + MINUTE } },
  } });
  await run.advance(60 * MINUTE);
  assert.deepEqual(run.resumed, []);
  assert.deepEqual(run.threads.get("a")!.lifecycle, question);
});

test("a question arriving while armed ends the wait", async () => {
  const run = harness({ threads: { a: failed(START + 10 * MINUTE) } });
  await run.controller.start();
  run.threads.get("a")!.lifecycle = question;
  await run.advance(30 * MINUTE);
  assert.deepEqual(run.resumed, []);
  assert.equal(run.controller.hasPendingWork(), false);
});

test("a stop before the reset cancels the resume", async () => {
  const run = harness({ threads: { a: failed(START + 10 * MINUTE) } });
  await run.controller.start();
  assert.equal(run.controller.hasPendingWork(), true);
  run.threads.get("a")!.lifecycle = { kind: "stopped", reason: "userMarkedStopped", settled: false };
  await run.advance(30 * MINUTE);
  assert.deepEqual(run.resumed, []);
});

test("many waiting threads resume spaced apart, and one failing on the limit re-gates the rest", async () => {
  const resetAt = START + 10 * MINUTE;
  const run = harness({ threads: { a: failed(resetAt), b: failed(resetAt), c: failed(resetAt) } });
  await run.controller.start();
  await run.advance(10.5 * MINUTE + 1_000);
  assert.equal(run.resumed.length, 1);
  const later = run.now() + 120 * MINUTE;
  run.fail(run.resumed[0]!, { resumeAt: later });
  await run.advance(MINUTE);
  assert.equal(run.resumed.length, 1);
  const waiting = ["a", "b", "c"].filter(id => id !== run.resumed[0]);
  for (const id of waiting) assert.deepEqual(run.threads.get(id)!.lifecycle, failed(later), "peers show the moved time, and stay inside the idle threshold");
  await run.advance(119.5 * MINUTE + 1_000);
  assert.equal(run.resumed.length, 2);
  await run.advance(15_000);
  assert.equal(run.resumed.length, 3);
});

test("a process death resumes after its grace, past any split-second stop", async () => {
  const run = harness({ threads: { a: interrupted, b: interrupted } });
  await run.controller.start();
  run.threads.get("b")!.lifecycle = { kind: "stopped", reason: "userMarkedStopped", settled: false };
  await run.advance(10_000);
  assert.deepEqual(run.resumed, []);
  await run.advance(10_000);
  assert.deepEqual(run.resumed, ["a"]);
});

test("a thread idle past the threshold stays put", async () => {
  const run = harness({ threads: { a: interrupted }, idleMinutes: 60 });
  run.threads.get("a")!.activityAt = START - 61 * MINUTE;
  await run.controller.start();
  await run.advance(MINUTE);
  assert.deepEqual(run.resumed, []);
  assert.equal(run.controller.hasPendingWork(), false);
});

test("waiting on quota is not idling, but coming back long after the reset is", async () => {
  const onTime = harness({ threads: { a: failed(START + 300 * MINUTE) }, idleMinutes: 60 });
  await onTime.controller.start();
  await onTime.advance(301 * MINUTE);
  assert.deepEqual(onTime.resumed, ["a"]);

  const late = harness({ threads: { a: failed(START - 90 * MINUTE) }, idleMinutes: 60 });
  await late.controller.start();
  await late.advance(MINUTE);
  assert.deepEqual(late.resumed, []);
  assert.deepEqual(late.threads.get("a")!.lifecycle, failed());
});

test("turning the setting off leaves armed threads alone", async () => {
  const run = harness({ threads: { a: failed(START), b: interrupted }, enabled: false });
  await run.controller.start();
  await run.advance(MINUTE);
  assert.deepEqual(run.resumed, []);
});

test("repeated endings give up: a crash loop stops, and so does a limit that never lifts", async () => {
  const crashing = harness({ threads: { a: interrupted }, statuses: ["completed", "interrupted", "interrupted", "interrupted", "interrupted"] });
  await crashing.controller.start();
  await crashing.advance(MINUTE);
  assert.deepEqual(crashing.resumed, []);

  const limited = harness({ threads: { a: failed() }, limits: capped(START + MINUTE), statuses: Array.from({ length: 7 }, () => "failed") });
  limited.fail("a");
  await limited.advance(10 * MINUTE);
  assert.deepEqual(limited.threads.get("a")!.lifecycle, failed());
  assert.deepEqual(limited.resumed, []);
});

test("a resume that never ran tries again later, still bounded by the threshold", async () => {
  const run = harness({ threads: { a: interrupted }, idleMinutes: 60 });
  await run.controller.start();
  await run.advance(MINUTE);
  assert.deepEqual(run.resumed, ["a"]);
  run.threads.get("a")!.lifecycle = interrupted;
  run.onFailed.get("a")!();
  await run.advance(6 * MINUTE);
  assert.deepEqual(run.resumed, ["a", "a"]);
  run.threads.get("a")!.lifecycle = interrupted;
  run.threads.get("a")!.activityAt = run.now() - 61 * MINUTE;
  run.onFailed.get("a")!();
  await run.advance(6 * MINUTE);
  assert.deepEqual(run.resumed, ["a", "a"]);
});

test("countEndedAlike counts only the unbroken latest run", () => {
  assert.equal(countEndedAlike(["failed", "completed", "failed", "failed"], "failed"), 2);
  assert.equal(countEndedAlike(["completed"], "failed"), 0);
  assert.equal(countEndedAlike([], "interrupted"), 0);
});
