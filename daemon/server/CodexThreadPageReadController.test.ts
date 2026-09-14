/*
 * No production exports. Node tests protect exact-key single-flight and reload drain ownership. Keywords: codex, thread, page, read, reload, test.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { WorkbenchThreadPageResponse } from "workbench-shared/workbench/thread/workbench-thread-page";
import CodexThreadPageReadController from "./CodexThreadPageReadController";

function deferred<TValue>() {
  let resolve!: (value: TValue) => void;
  const promise = new Promise<TValue>((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
}

function page(threadId: string): WorkbenchThreadPageResponse {
  return {
    browseResultEntries: [],
    model: null,
    nextCursor: null,
    questionnaireEntries: [],
    reasoningEffort: null,
    serviceTier: null,
    steerEntries: [],
    thread: { id: threadId } as WorkbenchThreadPageResponse["thread"],
  };
}

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
  const shared = deferred<WorkbenchThreadPageResponse>();
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
  const active = deferred<WorkbenchThreadPageResponse>();
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
