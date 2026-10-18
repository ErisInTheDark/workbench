/* Exports: none. Protect conjunctive idle compaction, message ordering, queued user messages, overlap and failures. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_THREAD_AUTO_COMPACT_SETTINGS } from "workbench-shared/workbench/settings/thread-auto-compact";
import type { ThreadPayload } from "workbench-shared/types";
import type { Turn } from "workbench-shared/workbench/thread/workbench-thread-turn";
import type WorkbenchProvider from "./WorkbenchProvider";
import WorkbenchThreadAdmissionController from "./WorkbenchThreadAdmissionController";
import WorkbenchThreadAutoCompactController, { type ThreadAutoCompactEvidence } from "./WorkbenchThreadAutoCompactController";
import WorkbenchThreadCompactionController, { type QueuedThreadMessage } from "./WorkbenchThreadCompactionController";

const compaction = {
  compactInsideAdmission: async (
    threadId: string,
    provider: { threads: { compact: WorkbenchProvider["threads"]["compact"] } },
    signal?: AbortSignal,
  ) => provider.threads.compact(threadId, {
    scope: { itemId: "item", turnId: "turn" } as never,
    signal,
  }),
  enqueue: async () => false,
};

function fixture() {
  let now = 30 * 60_000;
  let settings = { ...DEFAULT_THREAD_AUTO_COMPACT_SETTINGS };
  let evidence: ThreadAutoCompactEvidence | null = {
    activityAt: 0, contextTokens: 200_000,
  };
  let active = false;
  let waitingOnInput = false;
  let nativeActive = false;
  const status = () => active ? "active" : waitingOnInput ? "active:waitingOnUserInput" : "idle";
  let latest: Turn | null = { id: "turn", status: "interrupted" } as Turn;
  let compact = async () => { calls.push("compact"); };
  const calls: string[] = [];
  const publications: boolean[] = [];
  const scheduled: Array<{ callback: () => void; delayMs: number }> = [];
  let settingsReads = 0;
  let publicationListener = () => {};
  const admission = new WorkbenchThreadAdmissionController();
  const owner = new WorkbenchThreadAutoCompactController(admission, compaction, {
    readSettings: async () => {
      settingsReads += 1;
      return settings;
    },
    readEvidence: async () => evidence,
    readRuntime: async () => ({
      latestTurn: latest,
      status: status(),
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
    read: async () => ({ status: status() }) as ThreadPayload,
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
    waitingOnInput: () => { waitingOnInput = true; },
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

test("a held questionnaire compacts before its answer, while a live one stays ineligible", async () => {
  const held = fixture();
  held.waitingOnInput();
  assert.equal(await held.owner.observe({ harness: "claude", threadId: "thread" }), true);
  assert.equal(await held.owner.run("thread", held.provider, held.admit), "started");
  assert.deepEqual(held.calls, ["compact", "admit"]);
  await held.owner.dispose();

  const live = fixture();
  live.waitingOnInput();
  live.nativeActive();
  assert.equal(await live.owner.observe({ harness: "claude", threadId: "thread" }), false);
  await live.owner.run("thread", live.provider, live.admit);
  assert.deepEqual(live.calls, ["admit"]);
  await live.owner.dispose();
});

test("observing many threads decides from supplied facts with one settings read and no per-thread port reads", async () => {
  let settingsReads = 0;
  const owner = new WorkbenchThreadAutoCompactController(new WorkbenchThreadAdmissionController(), compaction, {
    readSettings: async () => { settingsReads += 1; return { ...DEFAULT_THREAD_AUTO_COMPACT_SETTINGS }; },
    readEvidence: async () => { throw new Error("Supplied evidence is never reread."); },
    readRuntime: async () => { throw new Error("Supplied runtime is never reread."); },
    publish: () => {},
    schedule: () => ({}),
    cancel: () => {},
    now: () => 30 * 60_000,
    warn: () => {},
  });
  const settled = { latestTurn: { id: "turn" }, status: "idle", turnLive: false };
  const decisions = await owner.observeMany([
    { target: { harness: "claude", threadId: "due" }, evidence: { activityAt: 0, contextTokens: 200_000 }, runtime: settled },
    { target: { harness: "claude", threadId: "small" }, evidence: { activityAt: 0, contextTokens: 10 }, runtime: settled },
    { target: { harness: "claude", threadId: "live" }, evidence: { activityAt: 0, contextTokens: 200_000 },
      runtime: { ...settled, status: "active", turnLive: true } },
  ]);
  assert.deepEqual(Object.fromEntries(decisions), { due: true, small: false, live: false });
  assert.equal(settingsReads, 1);
  await owner.dispose();
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

const queueThreadId = "00000000-0000-4000-8000-000000000011";

/** A due thread whose compaction stays open until released, with the real compaction queue. */
function queueFixture(due = true) {
  const admission = new WorkbenchThreadAdmissionController();
  const release = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const delivered = Promise.withResolvers<QueuedThreadMessage>();
  const direct: QueuedThreadMessage[] = [];
  const compaction = new WorkbenchThreadCompactionController(admission, {
    record: async () => ({ changedThreadIds: [], compactionCompletions: [] }),
    now: () => 1,
  });
  const owner = new WorkbenchThreadAutoCompactController(admission, compaction, {
    readSettings: async () => DEFAULT_THREAD_AUTO_COMPACT_SETTINGS,
    readEvidence: async () => ({ activityAt: 0, contextTokens: due ? 200_000 : 0 }),
    readRuntime: async () => ({ latestTurn: null, status: "idle", turnLive: false }),
    publish: () => {},
    now: () => 30 * 60_000,
    warn: () => {},
  });
  const provider = { threads: {
    read: async () => ({ status: "idle" }) as ThreadPayload,
    latestTurn: async () => ({ id: "00000000-0000-4000-8000-000000000012" }) as Turn,
    isTurnLive: async () => false,
    compact: async () => { entered.resolve(); await release.promise; },
  } };
  const deliver = async (message: QueuedThreadMessage, options: { skipAutoCompact?: boolean }) => {
    if (options.skipAutoCompact && message.clientMessageId !== "direct") delivered.resolve(message);
    else direct.push(message);
    return { kind: "steered" as const, turnId: "turn" };
  };
  const message = (clientMessageId: string): QueuedThreadMessage => ({
    clientMessageId, intent: "continue", input: [{ type: "text", text: clientMessageId, text_elements: [] }],
  });
  return { owner, provider, deliver, message, direct, entered: entered.promise, delivered: delivered.promise, release: release.resolve };
}

test("a send that makes compaction due returns queued at once and heads the merged delivery", async () => {
  const f = queueFixture();
  assert.deepEqual(await f.owner.submit(queueThreadId, f.provider, f.message("first"), f.deliver), { kind: "queued" });
  await f.entered;
  assert.deepEqual(await f.owner.submit(queueThreadId, f.provider, f.message("second"), f.deliver), { kind: "queued" },
    "a running compaction absorbs follow-ups without waiting on admission");
  f.release();
  const merged = await f.delivered;
  assert.deepEqual(merged.input.map(part => part.type === "text" ? part.text : part.type), ["first", "second"]);
  assert.deepEqual(f.direct, []);
  await f.owner.dispose();
});

test("a send with nothing to compact is delivered directly", async () => {
  const f = queueFixture(false);
  assert.deepEqual(await f.owner.submit(queueThreadId, f.provider, f.message("direct"), f.deliver), { kind: "steered", turnId: "turn" });
  assert.deepEqual(f.direct.map(message => message.clientMessageId), ["direct"]);
  await f.owner.dispose();
});
