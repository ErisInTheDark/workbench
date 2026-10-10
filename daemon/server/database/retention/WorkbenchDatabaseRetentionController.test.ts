/*
 * No production exports. Tests protect retention clocks, non-overlap, disposal, and surfaced failures.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import WorkbenchDatabaseRetentionController from "./WorkbenchDatabaseRetentionController.ts";

const DAY_MS = 86_400_000;

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
  await controller.dispose();
  assert.equal(fake.cleared, true);
});

test("retention disposal waits for active work and failures surface at the owner", async () => {
  const active = deferred<{
    expiredResults: number;
    expiredTurns: number;
    expiredAssets: number;
    expiredProposalCaches: number;
    fullCompaction: boolean;
    reclaimedPages: number;
  }>();
  const database = {
    runRetention: () => active.promise,
  };
  const fake = createScheduler();
  const controller = new WorkbenchDatabaseRetentionController(database, () => 0, fake.scheduling);
  controller.start();

  let disposed = false;
  const disposal = controller.dispose().then(() => { disposed = true; });
  await Promise.resolve();
  assert.equal(disposed, false);
  active.resolve({
    expiredResults: 0, expiredTurns: 0, expiredAssets: 0, expiredProposalCaches: 0,
    fullCompaction: false, reclaimedPages: 0,
  });
  await disposal;
  assert.equal(disposed, true);

  const messages: string[] = [];
  const original = console.error;
  console.error = (message?: unknown) => { messages.push(String(message)); };
  try {
    const failing = new WorkbenchDatabaseRetentionController({
      runRetention: async () => { throw new Error("retention exploded"); },
    }, () => 0, createScheduler().scheduling);
    await failing.run();
  } finally {
    console.error = original;
  }
  assert.deepEqual(messages, ["database retention failed: retention exploded"]);
});
