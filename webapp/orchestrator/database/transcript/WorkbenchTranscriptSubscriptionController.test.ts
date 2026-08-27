/*
 * No production exports. Tests protect latest-window-only refresh ownership, replacement, and stale publish suppression. Keywords: transcript, subscription, test.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import WorkbenchTranscriptSubscriptionController from "./WorkbenchTranscriptSubscriptionController.ts";
import type { WorkbenchTranscriptSnapshot } from "./workbench-transcript-types.ts";

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

test("subscriptions refresh only changed latest windows and replacement suppresses stale publication", async () => {
  const reads: string[] = [];
  const pending: Array<ReturnType<typeof deferred<WorkbenchTranscriptSnapshot | null>>> = [];
  const controller = new WorkbenchTranscriptSubscriptionController((request) => {
    reads.push(request.threadId);
    const next = deferred<WorkbenchTranscriptSnapshot | null>();
    pending.push(next);
    return next.promise;
  });
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

  await controller.settle(["one"]);
  assert.deepEqual(reads, ["one", "two"]);
  const refresh = controller.settle(["two"]);
  await Promise.resolve();
  assert.deepEqual(reads, ["one", "two", "two"]);
  pending[2]!.resolve(null);
  await refresh;
  assert.deepEqual(published, [null, null]);

  await assert.rejects(controller.subscribe({
    id: "previous",
    request: { threadId: "two", beforeTurnIndex: 2, turnLimit: 10 },
    publish: () => undefined,
  }), /Only the active latest transcript window/);
  controller.dispose();
});
