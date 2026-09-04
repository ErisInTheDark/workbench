/*
 * No production exports. Tests protect shadow queue coalescing, non-fatal failure reporting, relationship snapshots, and disposal. Keywords: thread state, shadow, lifecycle, test.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { WorkbenchSubagentRelationship } from "workbench-shared/types";
import type {
  WorkbenchSubagentParentSnapshot,
  WorkbenchThreadStateShadowRefresh,
  WorkbenchThreadStateShadowStatus,
} from "./database/thread-state/workbench-thread-state-shadow-types";
import WorkbenchThreadStateShadowController from "./WorkbenchThreadStateShadowController";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function status(state: WorkbenchThreadStateShadowStatus["state"] = "complete"): WorkbenchThreadStateShadowStatus {
  return {
    completedAt: state === "complete" ? 1 : null,
    errorCode: state === "failed" ? "projection-failure" : null,
    errorText: state === "failed" ? "Thread-state projection failed: unexpected projector failure." : null,
    generation: 1,
    mismatchCount: 0,
    projectedSubagentCount: 0,
    projectedThreadCount: 0,
    sourceDigest: "a".repeat(64),
    sourceProjectCount: 0,
    sourceProjectUpdatedAt: 0,
    sourceSubagentParentCount: 0,
    sourceSubagentCount: 0,
    state,
    updatedAt: 1,
  };
}

const relationship: WorkbenchSubagentRelationship = {
  createdAt: 1,
  cwd: "C:/project",
  directSubagentIndex: 0,
  harness: "codex",
  name: "child",
  parentThreadId: "parent",
  profileId: "profile",
  profileName: "Profile",
  projectId: "project",
  threadId: "child",
  title: "Child",
  updatedAt: 1,
};
const parent: WorkbenchSubagentParentSnapshot = {
  harness: "codex",
  nextDirectSubagentIndex: 1,
  parentThreadId: "parent",
  projectId: "project",
  relationships: [relationship],
};

test("start projects the complete relationship snapshot", async () => {
  const requests: WorkbenchThreadStateShadowRefresh[] = [];
  const controller = new WorkbenchThreadStateShadowController({
    database: {
      rebuildThreadStateShadow: async (request) => {
        requests.push(request);
        return status();
      },
    },
    now: () => 10,
  });
  controller.replaceSubagentParents([parent]);
  await controller.start();
  await controller.waitForIdle();
  assert.deepEqual(requests, [{ now: 10, parents: [parent] }]);
});

test("dirt arriving during a rebuild coalesces into one following generation", async () => {
  const first = deferred<WorkbenchThreadStateShadowStatus>();
  const requests: WorkbenchThreadStateShadowRefresh[] = [];
  const controller = new WorkbenchThreadStateShadowController({
    database: {
      rebuildThreadStateShadow: async (request) => {
        requests.push(request);
        return requests.length === 1 ? await first.promise : status();
      },
    },
    now: () => requests.length + 1,
  });
  const started = controller.start();
  controller.markProject("one");
  controller.markProject("two");
  controller.markGlobal("pinnedLayout");
  first.resolve(status());
  await started;
  await controller.waitForIdle();
  assert.equal(requests.length, 2);
});

test("projection failure becomes durable bounded state without rejecting lifecycle", async () => {
  const logs: string[] = [];
  const controller = new WorkbenchThreadStateShadowController({
    database: {
      rebuildThreadStateShadow: async () => status("failed"),
    },
    log: (message) => logs.push(message),
    now: () => 20,
  });
  await controller.start();
  await controller.waitForIdle();
  assert.deepEqual(logs, ["Thread-state projection failed: unexpected projector failure. Serving authority remains unchanged."]);
});

test("dispose drains the active generation and ignores later dirt", async () => {
  const first = deferred<WorkbenchThreadStateShadowStatus>();
  let rebuilds = 0;
  const controller = new WorkbenchThreadStateShadowController({
    database: {
      rebuildThreadStateShadow: async () => {
        rebuilds += 1;
        return await first.promise;
      },
    },
  });
  void controller.start();
  const disposal = controller.dispose();
  controller.markProject("late");
  first.resolve(status());
  await disposal;
  assert.equal(rebuilds, 1);
});
