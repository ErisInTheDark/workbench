/* No production exports. Protect the shared limits read cadence: demand, activity spacing, idle refresh and release. */
import assert from "node:assert/strict";
import test from "node:test";
import type { WorkbenchAccountLimits } from "workbench-shared/workbench/provider/provider-account";
import WorkbenchAccountLimitsController from "./WorkbenchAccountLimitsController";

const limits = (usedPercent: number): WorkbenchAccountLimits => ({
  preferredLimitId: null, rateLimitsByLimitId: null,
  rateLimits: { credits: null, individualLimit: null, limitId: "claude", limitName: null, planType: null,
    primary: { usedPercent, windowDurationMins: 300, resetsAt: null }, rateLimitReachedType: null, secondary: null, spendControlReached: null },
});

function fixture() {
  let now = 0;
  let reads = 0;
  let next: () => Promise<WorkbenchAccountLimits> = async () => limits(reads);
  const timers = new Set<{ due: number; run: () => void }>();
  const recorded: number[] = [];
  const owner = new WorkbenchAccountLimitsController({
    read: () => { reads++; return next(); },
    record: (_harness, value) => recorded.push(value.rateLimits?.primary?.usedPercent ?? -1),
    warn: () => {},
    now: () => now,
    schedule: (run, delayMs) => {
      const timer = { due: now + delayMs, run };
      timers.add(timer);
      return () => { timers.delete(timer); };
    },
  });
  const settle = () => new Promise(resolve => setImmediate(resolve));
  return {
    owner, recorded, timers,
    get reads() { return reads; },
    fail(message: string) { next = async () => { throw new Error(message); }; },
    async advance(ms: number) {
      const target = now + ms;
      for (;;) {
        const due = [...timers].filter(timer => timer.due <= target).sort((a, b) => a.due - b.due)[0];
        if (!due) break;
        now = due.due;
        timers.delete(due);
        due.run();
        await settle();
      }
      now = target;
      await settle();
    },
    settle,
  };
}

test("tabs share one read; activity rereads at most every 15s, idle every 5 minutes, and nothing reads unobserved", async () => {
  const f = fixture();
  let changes = 0;
  const first = f.owner.observe("claude", () => changes++);
  const second = f.owner.observe("claude", () => {});
  await f.settle();
  assert.equal(f.reads, 1, "two observers share the opening read");
  assert.equal(first.read().limits?.rateLimits?.primary?.usedPercent, 1);
  assert.deepEqual(f.recorded, [1], "every read feeds stats");

  for (let event = 0; event < 20; event++) { f.owner.noteActivity("claude"); await f.advance(1_000); }
  assert.equal(f.reads, 2, "a burst of activity costs one read per 15s window");
  await f.advance(15_000);
  assert.equal(f.reads, 3, "activity during the window is answered once the window ends");
  // That read landed at 30s; the idle reread is due 5 minutes later.
  await f.advance(294_000);
  assert.equal(f.reads, 3);
  await f.advance(1_000);
  assert.equal(f.reads, 4, "idle observers still see usage from elsewhere every 5 minutes");
  assert.ok(changes > 0);

  f.fail("usage endpoint down");
  f.owner.noteActivity("claude");
  await f.advance(15_000);
  assert.equal(first.read().phase, "stale", "a failed read keeps the last limits");
  assert.equal(first.read().limits?.rateLimits?.primary?.usedPercent, 4);

  first.release();
  second.release();
  assert.equal(f.timers.size, 0, "the last release stops the cadence");
  f.owner.noteActivity("claude");
  await f.advance(600_000);
  assert.equal(f.reads, 5, "unobserved providers are never read");
  f.owner.dispose();
});
