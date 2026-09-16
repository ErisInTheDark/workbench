/*
 * Exports:
 * - No production exports; Node tests protect project switching, stale reads, mutations, polling, and disposal.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { WorkbenchBrowseSessionSummary } from "workbench-shared/types";
import WorkbenchBrowseSessionController from "./WorkbenchBrowseSessionController.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function session(name: string): WorkbenchBrowseSessionSummary {
  return {
    browserConnected: null,
    cwd: null,
    inactiveSince: null,
    initialized: null,
    lastActionAt: null,
    mode: null,
    name,
    pid: null,
    projectId: null,
    projectRootPath: null,
    source: "registry",
    state: "stopped",
    statusError: null,
    threadId: null,
  };
}

test("project changes clear old sessions and reject the stale read", async () => {
  const reads = [deferred<readonly WorkbenchBrowseSessionSummary[]>(), deferred<readonly WorkbenchBrowseSessionSummary[]>()];
  let readCount = 0;
  const controller = new WorkbenchBrowseSessionController({
    mutate: async () => ({}),
    read: async () => reads[readCount++]!.promise,
    scheduleRepeat: () => () => undefined,
  });

  controller.selectProject("first");
  controller.selectProject("second");
  reads[0]!.resolve([session("stale")]);
  reads[1]!.resolve([session("current")]);
  await Promise.all(reads.map(read => read.promise));
  await Promise.resolve();

  assert.equal(controller.getSnapshot().projectId, "second");
  assert.deepEqual(controller.getSnapshot().sessions.map(value => value.name), ["current"]);
});

test("mutations refresh the selected project and preserve force intent", async () => {
  const mutations: Array<{ action: string; force: boolean; projectId: string; session: string }> = [];
  let reads = 0;
  const controller = new WorkbenchBrowseSessionController({
    mutate: async (action, input) => {
      mutations.push({ action, ...input });
      return {};
    },
    read: async () => [session(`read-${++reads}`)],
    scheduleRepeat: () => () => undefined,
  });
  controller.selectProject("project");
  await controller.refreshSessions();

  await controller.update(session("target"), "stop", { force: true });

  assert.deepEqual(mutations, [{
    action: "stop",
    force: true,
    projectId: "project",
    session: "target",
  }]);
  assert.equal(controller.getSnapshot().sessions[0]?.name, "read-2");
});

test("repeat scheduling and disposal have one lifecycle owner", () => {
  let repeat: (() => void) | null = null;
  let stopped = 0;
  const controller = new WorkbenchBrowseSessionController({
    mutate: async () => ({}),
    read: async () => [],
    scheduleRepeat: (callback) => {
      repeat = callback;
      return () => {
        stopped += 1;
      };
    },
  });

  controller.selectProject("project");
  assert.equal(typeof repeat, "function");
  controller.dispose();
  assert.equal(stopped, 1);
});
