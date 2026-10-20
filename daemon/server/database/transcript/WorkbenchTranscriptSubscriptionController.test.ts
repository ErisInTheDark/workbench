/*
 * No production exports. Tests protect observation lifetime, latest-window refresh ownership, replacement, and stale publish suppression.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import WorkbenchTranscriptSubscriptionController from "./WorkbenchTranscriptSubscriptionController.ts";
import type { WorkbenchTranscriptSnapshot } from "./workbench-transcript-types.ts";

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Value>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, reject, resolve };
}

test("observation protection spans opening, multiple views, replacement, failure and disposal", async () => {
  const pending = deferred<WorkbenchTranscriptSnapshot | null>();
  const owner = new WorkbenchTranscriptSubscriptionController(() => pending.promise, assert.fail);
  const subscribe = (id: string, threadId = "thread") => owner.subscribe({
    id, request: { threadId, turnLimit: 1 }, publish: () => undefined,
  });
  const first = subscribe("first");
  const second = subscribe("second");
  assert.deepEqual(owner.observedThreadIds, ["thread"]);
  owner.unsubscribe("first");
  assert.equal(owner.isThreadObserved("thread"), true);
  pending.resolve(null);
  await Promise.all([first, second]);
  await subscribe("second", "replacement");
  assert.equal(owner.isThreadObserved("thread"), false);
  assert.deepEqual(owner.observedThreadIds, ["replacement"]);
  owner.dispose();
  assert.deepEqual(owner.observedThreadIds, []);

  const failed = new WorkbenchTranscriptSubscriptionController(async () => { throw new Error("read failed"); }, assert.fail);
  await assert.rejects(failed.subscribe({
    id: "failed", request: { threadId: "thread", turnLimit: 1 }, publish: () => undefined,
  }), /read failed/);
  assert.equal(failed.isThreadObserved("thread"), false);
  failed.dispose();
});

test("the first read's credit-sized window stays pinned as a plain turn count for rereads", async () => {
  const window = (loadedTurnIds: string[], hasPreviousTurns: boolean) => ({
    thread: { id: "thread" }, turns: [], loadedTurnIds, hasPreviousTurns,
  }) as unknown as WorkbenchTranscriptSnapshot;
  for (const [first, pinned] of [
    [window(["latest"], true), { threadId: "thread", turnLimit: 1 }],
    [window(["older", "latest"], false), { threadId: "thread", turnLimit: 4 }],
  ] as const) {
    const requests: unknown[] = [];
    const controller = new WorkbenchTranscriptSubscriptionController(async (request) => {
      requests.push(request);
      return first;
    }, assert.fail);
    let published = 0;
    await controller.subscribe({
      id: "subscription", request: { threadId: "thread", turnLimit: 4, itemCredit: 96 }, publish: () => { published++; },
    });
    controller.settle(["thread"]);
    for (let turn = 0; turn < 20 && published < 2; turn++) await Promise.resolve();
    assert.deepEqual(requests, [{ threadId: "thread", turnLimit: 4, itemCredit: 96 }, pinned]);
    controller.dispose();
  }
});

test("subscriptions refresh only changed latest windows and replacement suppresses stale publication", async () => {
  const reads: string[] = [];
  const pending: Array<ReturnType<typeof deferred<WorkbenchTranscriptSnapshot | null>>> = [];
  const failures: unknown[] = [];
  const controller = new WorkbenchTranscriptSubscriptionController(
    (request) => {
      reads.push(request.threadId);
      const next = deferred<WorkbenchTranscriptSnapshot | null>();
      pending.push(next);
      return next.promise;
    },
    (error) => failures.push(error),
  );
  const published: Array<string | null> = [];

  const firstSubscribe = controller.subscribe({
    id: "subscription",
    request: { threadId: "one", turnLimit: 10 },
    publish: (snapshot) => {
      published.push(snapshot?.thread.id ?? null);
    },
  });
  await Promise.resolve();
  assert.deepEqual(reads, ["one"]);

  const replacementSubscribe = controller.subscribe({
    id: "subscription",
    request: { threadId: "two", turnLimit: 10 },
    publish: (snapshot) => {
      published.push(snapshot?.thread.id ?? null);
    },
  });
  await Promise.resolve();
  assert.deepEqual(reads, ["one", "two"]);
  pending[0]!.resolve(null);
  await firstSubscribe;
  assert.deepEqual(published, []);
  pending[1]!.resolve(null);
  await replacementSubscribe;
  assert.deepEqual(published, [null]);

  controller.settle(["one"]);
  assert.deepEqual(reads, ["one", "two"]);
  controller.settle(["two"]);
  await Promise.resolve();
  assert.deepEqual(reads, ["one", "two", "two"]);
  pending[2]!.resolve(null);
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(published, [null, null]);
  assert.deepEqual(failures, []);

  await assert.rejects(controller.subscribe({
    id: "previous",
    request: { threadId: "two", beforeTurnIndex: 2, turnLimit: 10 },
    publish: () => undefined,
  }), /Only the active latest transcript window/);
  controller.dispose();
});

test("subscription settlement is latest-only and a failed background refresh retries later", async () => {
  const reads: Array<ReturnType<typeof deferred<WorkbenchTranscriptSnapshot | null>>> = [];
  const readStarts = Array.from(
    { length: 5 },
    () => deferred<void>(),
  );
  const failures: unknown[] = [];
  const published: Array<string | null> = [];
  const controller = new WorkbenchTranscriptSubscriptionController(
    () => {
      const next = deferred<WorkbenchTranscriptSnapshot | null>();
      reads.push(next);
      readStarts[reads.length - 1]!.resolve();
      return next.promise;
    },
    (error) => failures.push(error),
  );

  const subscription = controller.subscribe({
    id: "latest",
    request: { threadId: "thread", turnLimit: 10 },
    publish: (snapshot) => {
      published.push(snapshot?.thread.id ?? null);
    },
  });
  await readStarts[0]!.promise;
  reads[0]!.resolve(null);
  await subscription;

  assert.equal(controller.settle(["thread"]), undefined);
  await readStarts[1]!.promise;
  assert.equal(reads.length, 2);
  controller.settle(["thread"]);
  controller.settle(["thread"]);
  reads[1]!.resolve(null);
  await readStarts[2]!.promise;
  assert.equal(reads.length, 3);
  reads[2]!.resolve(null);
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(published, [null, null, null]);

  controller.settle(["thread"]);
  await readStarts[3]!.promise;
  reads[3]!.reject(new Error("projection failed"));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(failures.length, 1);
  assert.match(String(failures[0]), /projection failed/u);

  controller.settle(["thread"]);
  await readStarts[4]!.promise;
  assert.equal(reads.length, 5);
  reads[4]!.resolve(null);
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(published, [null, null, null, null]);
  controller.dispose();
});
