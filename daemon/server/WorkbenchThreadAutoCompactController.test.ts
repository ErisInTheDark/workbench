/* Exports: none. Protect conjunctive idle compaction, message ordering, overlap and failures. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_THREAD_AUTO_COMPACT_SETTINGS } from "workbench-shared/workbench/settings/thread-auto-compact";
import type { ThreadPayload } from "workbench-shared/types";
import type { Turn } from "workbench-shared/workbench/thread/workbench-thread-turn";
import WorkbenchThreadAdmissionController from "./WorkbenchThreadAdmissionController";
import WorkbenchThreadAutoCompactController, { type ThreadAutoCompactEvidence } from "./WorkbenchThreadAutoCompactController";

function fixture() {
  let now = 30 * 60_000;
  let settings = { ...DEFAULT_THREAD_AUTO_COMPACT_SETTINGS };
  let evidence: ThreadAutoCompactEvidence | null = {
    activityAt: 0, contextTokens: 200_000,
  };
  let active = false;
  let nativeActive = false;
  let latest: Turn | null = { id: "turn", status: "interrupted" } as Turn;
  let compact = async () => { calls.push("compact"); };
  const calls: string[] = [];
  const publications: boolean[] = [];
  const scheduled: Array<{ callback: () => void; delayMs: number }> = [];
  let settingsReads = 0;
  let publicationListener = () => {};
  const admission = new WorkbenchThreadAdmissionController();
  const owner = new WorkbenchThreadAutoCompactController(admission, {
    readSettings: async () => {
      settingsReads += 1;
      return settings;
    },
    readEvidence: async () => evidence,
    readRuntime: async () => ({
      latestTurn: latest,
      status: active ? "active" : "idle",
      turnLive: active || nativeActive,
    }),
    publish: (_target, willAutoCompact) => {
      publications.push(willAutoCompact);
      publicationListener();
    },
    schedule: (callback, delayMs) => {
      const timer = { callback, delayMs };
      scheduled.push(timer);
      return timer;
    },
    cancel: (timer) => {
      const index = scheduled.findIndex(candidate => candidate === timer);
      if (index >= 0) scheduled.splice(index, 1);
    },
    now: () => now,
    warn: () => {},
  });
  const provider = { threads: {
    read: async () => ({ status: active ? "active" : "idle" }) as ThreadPayload,
    latestTurn: async () => latest,
    isTurnLive: async () => active || nativeActive,
    compact: async () => compact(),
  } };
  return {
    owner, admission, provider, calls, publications, scheduled,
    settingsReads: () => settingsReads,
    onPublication: (listener: () => void) => { publicationListener = listener; },
    now: (next: number) => { now = next; },
    settings: (next: Partial<typeof settings>) => { settings = { ...settings, ...next }; },
    evidence: (next: ThreadAutoCompactEvidence | null) => { evidence = next; },
    active: () => { active = true; },
    inactive: () => { active = false; },
    nativeActive: () => { nativeActive = true; },
    latest: (status: Turn["status"] | null) => { latest = status === null ? null : { id: "turn", status } as Turn; },
    compact: (next: () => Promise<void>) => { compact = next; },
    admit: async () => { calls.push("admit"); active = true; return "started"; },
  };
}

test("inactive completed, failed and interrupted turns compact at both exact thresholds before admission", async () => {
  for (const status of ["completed", "failed", "interrupted"] as const) {
    const f = fixture();
    f.latest(status);
    assert.equal(await f.owner.run("thread", f.provider, f.admit), "started");
    assert.deepEqual(f.calls, ["compact", "admit"]);
    await f.owner.dispose();
  }
});

test("observed thread publishes when its daemon-owned idle deadline becomes due", async () => {
  const f = fixture();
  f.now(29 * 60_000);
  assert.equal(await f.owner.observe({ harness: "codex", threadId: "thread" }), false);
  assert.equal(f.scheduled.length, 1);
  assert.deepEqual(f.publications, []);

  const published = Promise.withResolvers<void>();
  f.onPublication(() => published.resolve());
  f.now(30 * 60_000);
  f.scheduled.shift()?.callback();
  await published.promise;

  assert.deepEqual(f.publications, [true]);
  assert.equal(f.scheduled.length, 0);
  await f.owner.dispose();
});

test("observed status replaces its deadline and fences a cancelled callback", async () => {
  const f = fixture();
  f.now(10 * 60_000);
  assert.equal(await f.owner.observe({ harness: "codex", threadId: "thread" }), false);
  const cancelled = f.scheduled[0]!;
  assert.equal(cancelled.delayMs, 20 * 60_000);

  f.settings({ idleMinutes: 40 });
  await f.owner.refreshObserved(["thread"]);
  assert.equal(f.scheduled.length, 1);
  assert.equal(f.scheduled[0]?.delayMs, 30 * 60_000);
  cancelled.callback();
  assert.equal(f.scheduled.length, 1);
  assert.deepEqual(f.publications, []);

  const published = Promise.withResolvers<void>();
  f.onPublication(() => published.resolve());
  f.now(40 * 60_000);
  f.scheduled.shift()?.callback();
  await published.promise;
  assert.deepEqual(f.publications, [true]);
  await f.owner.dispose();
});

test("observed active, natively live and turnless threads remain ineligible", async () => {
  for (const configure of [
    (f: ReturnType<typeof fixture>) => f.active(),
    (f: ReturnType<typeof fixture>) => f.nativeActive(),
    (f: ReturnType<typeof fixture>) => f.latest(null),
  ]) {
    const f = fixture();
    configure(f);
    assert.equal(await f.owner.observe({ harness: "codex", threadId: "thread" }), false);
    assert.deepEqual(f.publications, []);
    await f.owner.dispose();
  }
});

test("disposing observed status cancels its deadline", async () => {
  const f = fixture();
  f.now(29 * 60_000);
  assert.equal(await f.owner.observe({ harness: "codex", threadId: "thread" }), false);
  assert.equal(f.scheduled.length, 1);
  await f.owner.dispose();
  assert.equal(f.scheduled.length, 0);
  assert.equal(f.owner.hasPendingWork(), false);
});

test("explicit bypass skips compaction without changing the next ordinary admission", async () => {
  const f = fixture();
  assert.equal(await f.owner.run("thread", f.provider, f.admit, { skipAutoCompact: true }), "started");
  assert.deepEqual(f.calls, ["admit"]);
  assert.equal(f.settingsReads(), 0);
  f.settings({ enabled: true });
  f.inactive();
  f.latest("completed");
  assert.equal(await f.owner.run("thread", f.provider, f.admit), "started");
  assert.deepEqual(f.calls, ["admit", "compact", "admit"]);
  assert.equal(f.settingsReads(), 1);
  await f.owner.dispose();
});

test("either unmet threshold, missing evidence or turn, disabled policy and live executions leave admission unchanged", async () => {
  for (const configure of [
    (f: ReturnType<typeof fixture>) => f.settings({ enabled: false }),
    (f: ReturnType<typeof fixture>) => f.evidence(null),
    (f: ReturnType<typeof fixture>) => f.evidence({ activityAt: 1, contextTokens: 200_000 }),
    (f: ReturnType<typeof fixture>) => f.evidence({ activityAt: 0, contextTokens: 199_999 }),
    (f: ReturnType<typeof fixture>) => f.evidence({ activityAt: 0, contextTokens: null }),
    (f: ReturnType<typeof fixture>) => f.latest(null),
    (f: ReturnType<typeof fixture>) => f.active(),
    (f: ReturnType<typeof fixture>) => f.nativeActive(),
  ]) {
    const f = fixture();
    configure(f);
    await f.owner.run("thread", f.provider, f.admit);
    assert.deepEqual(f.calls, ["admit"]);
    await f.owner.dispose();
  }
});

test("overlapping messages wait for compaction and the first admission, then recheck runtime truth", async () => {
  const f = fixture();
  const started = Promise.withResolvers<void>();
  const completion = Promise.withResolvers<void>();
  f.compact(async () => { f.calls.push("compact"); started.resolve(); await completion.promise; });
  const first = f.owner.run("thread", f.provider, f.admit);
  await Promise.race([started.promise, first.then(() => assert.fail("admission finished before compaction started"))]);
  const second = f.owner.run("thread", f.provider, f.admit);
  assert.deepEqual(f.calls, ["compact"]);
  completion.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(f.calls, ["compact", "admit", "admit"]);
  await f.owner.dispose();
});

test("compaction failure rejects the message without starting a turn, and later admissions still work", async () => {
  const f = fixture();
  f.compact(async () => { throw new Error("compact failed"); });
  await assert.rejects(f.owner.run("thread", f.provider, f.admit), /compact failed/);
  assert.deepEqual(f.calls, []);
  f.settings({ enabled: false });
  await f.owner.run("thread", f.provider, f.admit);
  assert.deepEqual(f.calls, ["admit"]);
  await f.owner.dispose();
});

test("runtime drain rejects queued messages without admitting them after the earlier operation settles", async () => {
  const f = fixture();
  f.settings({ enabled: false });
  const admitted = Promise.withResolvers<void>();
  const settled = Promise.withResolvers<void>();
  const first = f.owner.run("thread", f.provider, async () => {
    admitted.resolve();
    await settled.promise;
  });
  await admitted.promise;
  const next = f.owner.run("thread", f.provider, f.admit);
  const rejected = assert.rejects(next, /reloading/);
  assert.equal(f.admission.hasPendingWork(), true);
  f.owner.beginRuntimeDrain();
  f.admission.beginRuntimeDrain();
  settled.resolve();
  await first;
  await rejected;
  await f.owner.dispose();
  await f.admission.dispose();
  assert.deepEqual(f.calls, []);
  assert.equal(f.admission.hasPendingWork(), false);
});
