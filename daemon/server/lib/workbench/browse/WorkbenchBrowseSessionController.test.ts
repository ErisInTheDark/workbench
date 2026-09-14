/*
 * No production exports. Node tests protect bounded non-destructive Browse session observation and aggregate listing. Keywords: browse, session, status, timeout, listing, test.
 */
import assert from "node:assert/strict";
import test from "node:test";

import WorkbenchBrowseSessionController from "./WorkbenchBrowseSessionController.ts";
import type { WorkbenchBrowseSessionRecord } from "./WorkbenchBrowseSessionRegistry.ts";
import type { BrowseJsonValue } from "./actions/session-actions.ts";

const record: WorkbenchBrowseSessionRecord = {
  cwd: "C:/projects/alpha",
  inactiveSince: null,
  lastActionAt: "2026-08-15T00:00:00.000Z",
  mode: "headless",
  name: "research",
  projectId: "alpha",
  projectRootPath: "C:/projects/alpha",
  threadId: "thread-1",
};

function createHarness(inspectStatus: (session: string, timeoutMs: number, signal?: AbortSignal) => Promise<BrowseJsonValue>) {
  const inspectCalls: Array<{ session: string; timeoutMs: number }> = [];
  let commandStatusCalls = 0;
  const runtime = {
    inspectStatus: async (session: string, timeoutMs: number, signal?: AbortSignal) => {
      inspectCalls.push({ session, timeoutMs });
      return await inspectStatus(session, timeoutMs, signal);
    },
    listRuntimeSessionNames: async () => ["research"],
    readRuntimePid: async () => 777,
    resolveExecutionContext: async () => ({
      cwd: "C:/projects/alpha",
      owningRootPath: "C:/projects/alpha",
      projectId: "alpha",
      projectRootPath: "C:/projects/alpha",
      workspaceRoots: [{ id: "alpha", name: "alpha", rootPath: "C:/projects/alpha" }],
      workspaceRootPaths: ["C:/projects/alpha"],
    }),
    status: async () => {
      commandStatusCalls += 1;
      throw new Error("command-owned status must not be used for listing");
    },
    stop: async () => ({ stopped: true }),
  };
  const registry = {
    forget: async () => undefined,
    list: async () => [record],
    listByProjectId: async () => [record],
    listByThreadId: async () => [record],
    listOwnedThreadIds: async () => ["thread-1"],
    listStaleInactiveSessions: async () => [],
    markThreadActive: async () => undefined,
    markThreadInactive: async () => undefined,
    remember: async () => undefined,
  };
  const controller = new WorkbenchBrowseSessionController({
    profileStore: { forgetPersistentSession: async () => null },
    registry,
    runtime,
  });
  return {
    controller,
    get commandStatusCalls() { return commandStatusCalls; },
    inspectCalls,
  };
}

test("session listing uses observational status and clamps its probe to one second", async () => {
  const harness = createHarness(async () => ({ browserConnected: true, initialized: true, pid: 123 }));

  const response = await harness.controller.listSessions({ projectId: "alpha", timeoutMs: 5_000 });

  assert.deepEqual(harness.inspectCalls, [{ session: "research", timeoutMs: 1_000 }]);
  assert.equal(harness.commandStatusCalls, 0);
  assert.equal(response.sessions[0]?.state, "running");
});

test("session listing honors a smaller caller probe budget", async () => {
  const harness = createHarness(async () => null);

  await harness.controller.listSessions({ projectId: "alpha", timeoutMs: 250 });

  assert.deepEqual(harness.inspectCalls, [{ session: "research", timeoutMs: 250 }]);
});

test("a failed observational probe becomes one session error and preserves PID fallback", async () => {
  const harness = createHarness(async () => { throw new Error("daemon observation timed out"); });

  const response = await harness.controller.listSessions({ projectId: "alpha" });

  assert.equal(response.sessions.length, 1);
  assert.equal(response.sessions[0]?.pid, 777);
  assert.equal(response.sessions[0]?.state, "stale");
  assert.match(response.sessions[0]?.statusError ?? "", /observation timed out/u);
  assert.equal(harness.commandStatusCalls, 0);
});
