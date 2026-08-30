/*
 * No production exports. Node tests protect exact background single-flight and reload drain ownership. Keywords: codex, thread, page, read, reload, test.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { WorkbenchThreadPageResponse } from "../lib/workbench/thread/workbench-thread-page";
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

test("identical background reads share one active operation while foreground reads stay distinct", async () => {
  const controller = new CodexThreadPageReadController();
  const background = deferred<WorkbenchThreadPageResponse>();
  let backgroundCalls = 0;
  let foregroundCalls = 0;

  const first = controller.run(async () => {
    backgroundCalls += 1;
    return await background.promise;
  }, { backgroundKey: "thread" });
  const second = controller.run(async () => {
    backgroundCalls += 1;
    return page("wrong");
  }, { backgroundKey: "thread" });
  const foreground = controller.run(async () => {
    foregroundCalls += 1;
    return page("foreground");
  });

  assert.equal(first, second);
  assert.equal((await foreground).thread.id, "foreground");
  assert.equal(foregroundCalls, 1);
  background.resolve(page("background"));
  assert.equal((await first).thread.id, "background");
  assert.equal(backgroundCalls, 1);
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
