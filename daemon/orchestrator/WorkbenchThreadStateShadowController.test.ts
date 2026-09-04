/*
 * No production exports. Tests protect shadow queue coalescing, non-fatal failure reporting, relationship snapshots, and disposal. Keywords: thread state, shadow, lifecycle, test.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { WorkbenchSubagentRelationship } from "workbench-shared/types";
import type {
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
    errorText: state === "failed" ? "Thread-state shadow rebuild failed: projection or constraint failure." : null,
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

test("start projects the complete relationship snapshot", async () => {
  const requests: WorkbenchThreadStateShadowRefresh[] = [];
  const controller = new WorkbenchThreadStateShadowController({
    database: {
      rebuildThreadStateShadow: async (request) => {
        requests.push(request);
        return status();
      },
      recordThreadStateShadowFailure: async () => status("failed"),
    },
    now: () => 10,
  });
  controller.replaceRelationships([relationship]);
  await controller.start();
  await controller.waitForIdle();
  assert.deepEqual(requests, [{ now: 10, relationships: [relationship] }]);
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
      recordThreadStateShadowFailure: async () => status("failed"),
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
  const failures: WorkbenchThreadStateShadowRefresh[] = [];
  const logs: string[] = [];
  const controller = new WorkbenchThreadStateShadowController({
    database: {
      rebuildThreadStateShadow: async () => {
        throw new Error("private source value");
      },
      recordThreadStateShadowFailure: async (request) => {
        failures.push(request);
        return status("failed");
      },
    },
    log: (message) => logs.push(message),
    now: () => 20,
  });
  await controller.start();
  await controller.waitForIdle();
  assert.deepEqual(failures, [{ now: 20, relationships: [] }]);
  assert.deepEqual(logs, ["Thread-state shadow projection failed; serving authority remains unchanged."]);
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
      recordThreadStateShadowFailure: async () => status("failed"),
    },
  });
  void controller.start();
  const disposal = controller.dispose();
  controller.markProject("late");
  first.resolve(status());
  await disposal;
  assert.equal(rebuilds, 1);
});
