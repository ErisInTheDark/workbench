/*
 * No production exports. Tests protect retention clocks, non-overlap, sleep-holding pending work, step-boundary disposal, and surfaced failures.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import WorkbenchDatabaseRetentionController from "./WorkbenchDatabaseRetentionController.ts";

const DAY_MS = 86_400_000;

test("retention delegates live observation sampling for each expiry dispatch", async () => {
  let observed = ["first"];
  const protections: string[][] = [];
  const owner = new WorkbenchDatabaseRetentionController({
    runRetention: async (_cutoffs, _cacheCutoff, _signal, readObservedThreadIds) => {
      protections.push(readObservedThreadIds?.() ?? []);
      return { expiredResults: 0, expiredTurns: 0, expiredAssets: 0, expiredProposalCaches: 0, fullCompaction: false, reclaimedPages: 0 };
    },
  }, () => 0, createScheduler().scheduling, () => observed);
  try {
    await owner.run();
    observed = ["second"];
    await owner.run();
    assert.deepEqual(protections, [["first"], ["second"]]);
  } finally { await owner.dispose(); }
});

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((accept) => { resolve = accept; });
  return { promise, resolve };
}

function createScheduler() {
  let callback: (() => void) | null = null;
  let cleared = false;
  const handle = {} as ReturnType<typeof setInterval>;
  return {
    scheduling: {
      clear(received: ReturnType<typeof setInterval>) {
        assert.equal(received, handle);
        cleared = true;
      },
      every(received: () => void, intervalMs: number) {
        assert.equal(intervalMs, DAY_MS);
        callback = received;
        return handle;
      },
    },
    get callback() { return callback; },
    get cleared() { return cleared; },
  };
}

test("retention starts immediately, uses exact clocks, and never overlaps", async () => {
  const first = deferred<{
    expiredResults: number;
    expiredTurns: number;
    expiredAssets: number;
    expiredProposalCaches: number;
    fullCompaction: boolean;
    reclaimedPages: number;
  }>();
  const calls: Array<{
    input: { expiredAt: number; resultCutoff: number; transcriptCutoff: number };
    proposalCacheCutoff: number;
  }> = [];
  const database = {
    runRetention(input: typeof calls[number]["input"], proposalCacheCutoff: number) {
      calls.push({ input, proposalCacheCutoff });
      return first.promise;
    },
  };
  const fake = createScheduler();
  const controller = new WorkbenchDatabaseRetentionController(database, () => 10 * DAY_MS, fake.scheduling);

  controller.start();
  assert.equal(controller.hasPendingWork(), true, "an in-flight pass holds the daemon awake");
  assert.deepEqual(calls, [{
    input: {
      expiredAt: 10 * DAY_MS,
      resultCutoff: 9 * DAY_MS,
      transcriptCutoff: 7 * DAY_MS,
    },
    proposalCacheCutoff: 9 * DAY_MS,
  }]);
  assert.ok(fake.callback);
  fake.callback();
  await Promise.resolve();
  assert.equal(calls.length, 1);

  first.resolve({
    expiredResults: 0, expiredTurns: 0, expiredAssets: 0, expiredProposalCaches: 0,
    fullCompaction: false, reclaimedPages: 0,
  });
  await controller.run();
  assert.equal(controller.hasPendingWork(), false);
  await controller.dispose();
  assert.equal(fake.cleared, true);
});

test("retention disposal stops the active pass at its current step without reporting failure", async () => {
  const step = deferred<void>();
  let received: AbortSignal | undefined;
  const database = {
    async runRetention(_input: unknown, _proposalCacheCutoff: number, signal?: AbortSignal): Promise<never> {
      received = signal;
      await step.promise;
      signal?.throwIfAborted();
      throw new Error("retention continued after disposal");
    },
  };
  const fake = createScheduler();
  const controller = new WorkbenchDatabaseRetentionController(database, () => 0, fake.scheduling);
  const messages: string[] = [];
  const original = console.error;
  console.error = (message?: unknown) => { messages.push(String(message)); };
  try {
    controller.start();
    let disposed = false;
    const disposal = controller.dispose().then(() => { disposed = true; });
    assert.equal(received?.aborted, true);
    await Promise.resolve();
    assert.equal(disposed, false);
    step.resolve();
    await disposal;
    assert.equal(disposed, true);
    assert.equal(controller.hasPendingWork(), false);
    assert.equal(fake.cleared, true);
  } finally {
    console.error = original;
  }
  assert.deepEqual(messages, []);
});

test("retention failures surface at the owner", async () => {
  const messages: string[] = [];
  const original = console.error;
  console.error = (message?: unknown) => { messages.push(String(message)); };
  try {
    const failing = new WorkbenchDatabaseRetentionController({
      runRetention: async () => { throw new Error("retention exploded"); },
    }, () => 0, createScheduler().scheduling);
    await failing.run();
    assert.equal(failing.hasPendingWork(), false, "a failed pass must not hold the daemon awake");
  } finally {
    console.error = original;
  }
  assert.deepEqual(messages, ["database retention failed: retention exploded"]);
});
