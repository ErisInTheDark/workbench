/*
 * No production exports. Protect shared refresh, failure isolation, and reload drain ownership.
 */
import type { CodexThreadPageResponse } from "workbench-shared/codex/thread-context";
import assert from "node:assert/strict";
import test from "node:test";


import CodexThreadPageReadController from "./CodexThreadPageReadController";

function deferred<TValue>() {
  let resolve!: (value: TValue) => void;
  const promise = new Promise<TValue>((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
}

function page(threadId: string): CodexThreadPageResponse {
  return {
    browseResultEntries: [],
    model: null,
    nextCursor: null,
    questionnaireEntries: [],
    reasoningEffort: null,
    serviceTier: null,
    steerEntries: [],
    thread: { id: threadId } as CodexThreadPageResponse["thread"],
  };
}

test("detached refreshes share work, report failure, and permit a later attempt", async () => {
  const controller = new CodexThreadPageReadController();
  const entered = deferred<void>();
  const release = deferred<void>();
  const failures: unknown[] = [];
  const report = (error: unknown) => { failures.push(error); };
  let attempts = 0;
  const failure = new Error("recording failed");
  const refresh = async () => {
    attempts++;
    entered.resolve();
    await release.promise;
    throw failure;
  };
  controller.refresh(refresh, "thread", report);
  controller.refresh(refresh, "thread", report);
  await entered.promise;
  assert.equal(attempts, 1);
  release.resolve();
  await controller.waitForIdle();
  assert.deepEqual(failures, [failure]);
  controller.refresh(async () => { attempts++; return page("thread"); }, "thread", report);
  await controller.waitForIdle();
  assert.equal(attempts, 2);
  assert.deepEqual(failures, [failure]);
});

test("refresh retirement fences late writes without reporting owned cancellation", async () => {
  const controller = new CodexThreadPageReadController();
  const entered = deferred<void>();
  const release = deferred<void>();
  const finished = deferred<void>();
  const failures: unknown[] = [];
  let writes = 0;
  controller.refresh(async signal => {
    entered.resolve();
    try {
      await release.promise;
      signal.throwIfAborted();
      writes++;
      return page("old");
    } finally { finished.resolve(); }
  }, "thread", error => failures.push(error));
  await entered.promise;
  controller.expire();
  await controller.waitForIdle();
  controller.resumeAfterFailedReload();
  assert.equal((await controller.run(async () => page("new"), { key: "thread" })).thread.id, "new");
  release.resolve();
  await finished.promise;
  assert.equal(writes, 0);
  assert.deepEqual(failures, []);
});

test("expiry releases hung reads and fences their continuations across rollback", async () => {
  const controller = new CodexThreadPageReadController();
  const entered = deferred<void>();
  const provider = deferred<void>();
  const finished = deferred<void>();
  let writes = 0;
  const reading = controller.run(async (signal) => {
    entered.resolve();
    try {
      await provider.promise;
      signal.throwIfAborted();
      writes += 1;
      return page("old");
    } finally {
      finished.resolve();
    }
  }, { key: "thread" });
  const rejected = assert.rejects(reading, /retired/u);
  await entered.promise;
  controller.expire();
  controller.resumeAfterFailedReload();
  assert.equal((await controller.run(async () => page("new"), { key: "thread" })).thread.id, "new");
  await controller.waitForIdle();
  await rejected;
  provider.resolve();
  await finished.promise;
  assert.equal(writes, 0);
});

test("identical keyed reads share one active operation while distinct keys stay independent", async () => {
  const controller = new CodexThreadPageReadController();
  const shared = deferred<CodexThreadPageResponse>();
  let sharedCalls = 0;
  let distinctCalls = 0;

  const first = controller.run(async () => {
    sharedCalls += 1;
    return await shared.promise;
  }, { key: "thread" });
  const second = controller.run(async () => {
    sharedCalls += 1;
    return page("wrong");
  }, { key: "thread" });
  const distinct = controller.run(async () => {
    distinctCalls += 1;
    return page("distinct");
  }, { key: "other-thread" });

  assert.equal(first, second);
  assert.equal((await distinct).thread.id, "distinct");
  assert.equal(distinctCalls, 1);
  shared.resolve(page("shared"));
  assert.equal((await first).thread.id, "shared");
  assert.equal(sharedCalls, 1);
});

test("reload drain rejects new reads, waits for active reads, and reopens after failure", async () => {
  const controller = new CodexThreadPageReadController();
  const active = deferred<CodexThreadPageResponse>();
  const read = controller.run(async () => await active.promise);
  controller.beginDrain();

  assert.throws(
    () => controller.run(async () => page("late")),
    /draining for reload/u,
  );
  let drained = false;
  const drain = controller.waitForIdle().then(() => { drained = true; });
  await Promise.resolve();
  assert.equal(drained, false);
  active.resolve(page("active"));
  await read;
  await drain;
  assert.equal(drained, true);

  controller.resumeAfterFailedReload();
  assert.equal((await controller.run(async () => page("reopened"))).thread.id, "reopened");
});
