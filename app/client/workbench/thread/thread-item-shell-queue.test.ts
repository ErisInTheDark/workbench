/* No production exports. Protect how a wb shell's duration splits into queue wait and run, live and recorded. */
import assert from "node:assert/strict";
import test from "node:test";

import { deriveThreadItemShellQueue, getShellQueueTiming } from "./thread-item-shell-queue";

test("every reference naming a queued shell finds its live queue timing", () => {
  const queue = deriveThreadItemShellQueue([{ admittedAt: null, itemReferences: ["item-1", "call_1"], queuedAt: 100 }]);
  assert.deepEqual(queue.get("item-1"), { admittedAt: null, queuedAt: 100 });
  assert.deepEqual(queue.get("call_1"), { admittedAt: null, queuedAt: 100 });
  assert.equal(deriveThreadItemShellQueue(undefined).size, 0);
});

test("a waiting shell ticks only its queue time; once admitted the queue freezes and the run restarts from admission", () => {
  assert.deepEqual(
    getShellQueueTiming({ activeStartedAtMs: 90, durationMs: null, live: { admittedAt: null, queuedAt: 100 }, queuedMs: undefined }),
    { queued: { activeStartedAtMs: 100, durationMs: null }, run: null },
  );
  assert.deepEqual(
    getShellQueueTiming({ activeStartedAtMs: 90, durationMs: null, live: { admittedAt: 400, queuedAt: 100 }, queuedMs: undefined }),
    { queued: { activeStartedAtMs: null, durationMs: 300 }, run: { activeStartedAtMs: 400, durationMs: null } },
  );
});

test("a finished shell shows its recorded queue time and only the rest of its duration as the run", () => {
  assert.deepEqual(
    getShellQueueTiming({ activeStartedAtMs: null, durationMs: 1_000, live: null, queuedMs: 300 }),
    { queued: { activeStartedAtMs: null, durationMs: 300 }, run: { activeStartedAtMs: null, durationMs: 700 } },
  );
});

test("without queue evidence, the item's own timing is the run", () => {
  assert.deepEqual(
    getShellQueueTiming({ activeStartedAtMs: 50, durationMs: null, live: null, queuedMs: undefined }),
    { queued: null, run: { activeStartedAtMs: 50, durationMs: null } },
  );
  assert.deepEqual(
    getShellQueueTiming({ activeStartedAtMs: null, durationMs: 1_000, live: null, queuedMs: undefined }),
    { queued: null, run: { activeStartedAtMs: null, durationMs: 1_000 } },
  );
});
