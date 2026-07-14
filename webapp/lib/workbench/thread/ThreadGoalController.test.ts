/*
 * No production exports. Node tests protect typed goal requests, notification ordering, mutation failures, and disposal. Keywords: thread, goal, controller, test.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { ThreadGoal } from "../../codex/generated/app-server/v2/ThreadGoal";
import type { ThreadGoalClearParams } from "../../codex/generated/app-server/v2/ThreadGoalClearParams";
import type { ThreadGoalGetParams } from "../../codex/generated/app-server/v2/ThreadGoalGetParams";
import type { ThreadGoalSetParams } from "../../codex/generated/app-server/v2/ThreadGoalSetParams";
import ThreadGoalController from "./ThreadGoalController";

function goal(objective: string): ThreadGoal {
  return {
    createdAt: 1,
    objective,
    status: "active",
    threadId: "thread-1",
    timeUsedSeconds: 60,
    tokenBudget: 50_000,
    tokensUsed: 12_000,
    updatedAt: 2,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

test("controller loads a goal and sends an objective-only update", async () => {
  const setRequests: ThreadGoalSetParams[] = [];
  const controller = new ThreadGoalController({
    clear: async () => ({ cleared: true }),
    get: async () => ({ goal: goal("Original") }),
    set: async (params) => {
      setRequests.push(params);
      return { goal: { ...goal(params.objective ?? ""), updatedAt: 3 } };
    },
  });

  await controller.load("thread-1");
  assert.equal(controller.getSnapshot("thread-1").goal?.objective, "Original");

  await controller.updateObjective("thread-1", "Revised");
  assert.deepEqual(setRequests, [{ objective: "Revised", threadId: "thread-1" }]);
  assert.equal(controller.getSnapshot("thread-1").goal?.objective, "Revised");
  assert.equal(controller.getSnapshot("thread-1").goal?.tokenBudget, 50_000);
});

test("a push notification wins over a stale initial read", async () => {
  const read = deferred<{ goal: ThreadGoal | null }>();
  const controller = new ThreadGoalController({
    clear: async () => ({ cleared: true }),
    get: async () => read.promise,
    set: async () => ({ goal: goal("unused") }),
  });

  const loading = controller.load("thread-1");
  controller.observeNotification({
    method: "thread/goal/updated",
    params: { goal: goal("New notification"), threadId: "thread-1", turnId: null },
  });
  read.resolve({ goal: goal("Stale read") });
  await loading;

  assert.equal(controller.getSnapshot("thread-1").goal?.objective, "New notification");
  assert.equal(controller.getSnapshot("thread-1").isLoading, false);
});

test("a push notification during an update wins over the request response", async () => {
  const update = deferred<{ goal: ThreadGoal }>();
  const controller = new ThreadGoalController({
    clear: async () => ({ cleared: true }),
    get: async () => ({ goal: goal("Original") }),
    set: async () => update.promise,
  });

  await controller.load("thread-1");
  const updating = controller.updateObjective("thread-1", "Requested update");
  controller.observeNotification({
    method: "thread/goal/updated",
    params: { goal: goal("Newer notification"), threadId: "thread-1", turnId: null },
  });
  update.resolve({ goal: goal("Stale response") });
  await updating;

  assert.equal(controller.getSnapshot("thread-1").goal?.objective, "Newer notification");
  assert.equal(controller.getSnapshot("thread-1").pendingAction, null);
});

test("clear sends the exact request and converges with cleared notifications", async () => {
  const clearRequests: ThreadGoalClearParams[] = [];
  const controller = new ThreadGoalController({
    clear: async (params) => {
      clearRequests.push(params);
      return { cleared: true };
    },
    get: async () => ({ goal: goal("Original") }),
    set: async () => ({ goal: goal("unused") }),
  });

  await controller.load("thread-1");
  controller.observeNotification({ method: "thread/goal/cleared", params: { threadId: "thread-1" } });
  assert.equal(controller.getSnapshot("thread-1").goal, null);

  await controller.clear("thread-1");
  assert.deepEqual(clearRequests, [{ threadId: "thread-1" }]);
  assert.equal(controller.getSnapshot("thread-1").goal, null);
});

test("mutation errors stay visible and preserve the current goal", async () => {
  const controller = new ThreadGoalController({
    clear: async () => ({ cleared: true }),
    get: async (_params: ThreadGoalGetParams) => ({ goal: goal("Original") }),
    set: async () => {
      throw new Error("goal storage unavailable");
    },
  });

  await controller.load("thread-1");
  await assert.rejects(controller.updateObjective("thread-1", "Revised"), /goal storage unavailable/u);
  assert.equal(controller.getSnapshot("thread-1").goal?.objective, "Original");
  assert.equal(controller.getSnapshot("thread-1").error, "goal storage unavailable");
  assert.equal(controller.getSnapshot("thread-1").pendingAction, null);
});

test("dispose removes subscribers and ignores later notifications", async () => {
  const controller = new ThreadGoalController({
    clear: async () => ({ cleared: true }),
    get: async () => ({ goal: goal("Original") }),
    set: async () => ({ goal: goal("unused") }),
  });
  let notifications = 0;
  controller.subscribe("thread-1", () => { notifications += 1; });
  await controller.load("thread-1");
  assert.ok(notifications > 0);

  controller.dispose();
  const notificationsAtDispose = notifications;
  controller.observeNotification({
    method: "thread/goal/updated",
    params: { goal: goal("Ignored"), threadId: "thread-1", turnId: null },
  });
  assert.equal(notifications, notificationsAtDispose);
});
