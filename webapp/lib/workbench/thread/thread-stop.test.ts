/*
 * No production exports. Node tests protect goal-clear ordering and provider-specific stop behavior. Keywords: thread, stop, goal, interrupt, test.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { WorkbenchHarness } from "../../types";
import { stopWorkbenchThread } from "./thread-stop";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

test("Codex stop awaits goal clearing before interrupting the active turn", async () => {
  const clearGate = deferred();
  const methods: string[] = [];
  const stopping = stopWorkbenchThread({
    harness: "codex",
    sendRequest: async (_harness, request) => {
      methods.push(request.method);
      if (request.method === "thread/goal/clear") {
        await clearGate.promise;
      }
    },
    threadId: "thread-1",
    turnId: "turn-1",
  });

  await Promise.resolve();
  assert.deepEqual(methods, ["thread/goal/clear"]);

  clearGate.resolve();
  await stopping;
  assert.deepEqual(methods, ["thread/goal/clear", "turn/interrupt"]);
});

test("Codex stop does not interrupt when goal clearing fails", async () => {
  const methods: string[] = [];

  await assert.rejects(stopWorkbenchThread({
    harness: "codex",
    sendRequest: async (_harness, request) => {
      methods.push(request.method);
      if (request.method === "thread/goal/clear") {
        throw new Error("goal clear failed");
      }
    },
    threadId: "thread-1",
    turnId: "turn-1",
  }), /goal clear failed/u);

  assert.deepEqual(methods, ["thread/goal/clear"]);
});

for (const harness of ["copilot", "opencode"] satisfies WorkbenchHarness[]) {
  test(`${harness} stop preserves interrupt-only behavior`, async () => {
    const requests: Array<{ harness: WorkbenchHarness; method: string; params: object }> = [];

    await stopWorkbenchThread({
      harness,
      sendRequest: async (requestHarness, request) => {
        requests.push({ harness: requestHarness, method: request.method, params: request.params });
      },
      threadId: "thread-1",
      turnId: "turn-1",
    });

    assert.deepEqual(requests, [{
      harness,
      method: "turn/interrupt",
      params: { threadId: "thread-1", turnId: "turn-1" },
    }]);
  });
}
