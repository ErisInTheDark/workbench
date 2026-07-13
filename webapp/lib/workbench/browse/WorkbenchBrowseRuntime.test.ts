/*
 * Exports:
 * - No production exports; Node tests cover warm Browse runtime project-context reuse, session queue isolation, and recovery. Keywords: browse, runtime, project, fifo, session, timeout, test.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import WorkbenchBrowseRuntime, { type WorkbenchBrowseDaemonTransport } from "./WorkbenchBrowseRuntime.ts";
import type { WorkbenchBrowseAgentCommand } from "./actions/session-actions.ts";
import type { BrowseJsonValue } from "./actions/session-actions.ts";
import {
  WorkbenchBrowseDaemonTimeoutError,
  type WorkbenchBrowseDaemonRequestWithoutId,
} from "./WorkbenchBrowseDaemonClient.ts";

function deferred<TValue>() {
  let reject!: (error: Error) => void;
  let resolve!: (value: TValue) => void;
  const promise = new Promise<TValue>((resolvePromise, rejectPromise) => {
    reject = rejectPromise;
    resolve = resolvePromise;
  });
  return { promise, reject, resolve };
}

class FakeBrowseTransport implements WorkbenchBrowseDaemonTransport {
  readonly cleaned: string[] = [];
  readonly calls: string[] = [];
  readonly firstResearch = deferred<BrowseJsonValue>();
  private researchRequests = 0;

  async cleanupRuntimeFiles(session: string) { this.cleaned.push(session); }
  async initialize() {}
  async listRuntimeSessionNames() { return []; }
  async readPid() { return 123; }

  async request(
    session: string,
    _request: WorkbenchBrowseDaemonRequestWithoutId,
    _timeoutMs: number,
    _signal?: AbortSignal,
  ) {
    this.calls.push(session);
    if (session === "research" && this.researchRequests++ === 0) return await this.firstResearch.promise;
    return { initialized: true, session };
  }
}

test("executes with a supplied project context without resolving the project again", async () => {
  const client = new FakeBrowseTransport();
  const runtime = new WorkbenchBrowseRuntime({
    client,
    retireProcess: async () => undefined,
    resolveProjectFromCwd: async () => { throw new Error("unexpected project resolution"); },
  });
  const command: WorkbenchBrowseAgentCommand = {
    action: "status",
    args: ["status", "--session", "other"],
    commandRequest: {
      args: ["status", "--session", "other"],
      cwd: "C:/projects/workbench",
      projectId: null,
      threadId: "thread-1",
      timeoutMs: 5_000,
    },
    rememberSession: true,
    runtimeRequest: { kind: "status", session: "other", timeoutMs: 5_000 },
    session: "other",
  };
  const result = await runtime.run(command, {
    cwd: "C:/projects/workbench",
    owningRootPath: "C:/projects/workbench",
    projectId: "workbench",
    projectRootPath: "C:/projects/workbench",
    workspaceRoots: [{ id: "workbench", name: "workbench", rootPath: "C:/projects/workbench" }],
    workspaceRootPaths: ["C:/projects/workbench"],
  });

  assert.equal(result.ok, true);
  assert.deepEqual(client.calls, ["other"]);
});

test("serializes one session while allowing unrelated sessions to proceed", async () => {
  const client = new FakeBrowseTransport();
  const runtime = new WorkbenchBrowseRuntime({ client, retireProcess: async () => undefined });
  const first = runtime.status("research");
  await Promise.resolve();
  const second = runtime.status("research");
  const unrelated = runtime.status("other");
  await Promise.resolve();

  assert.deepEqual(client.calls, ["research", "other"]);
  assert.deepEqual(await unrelated, { initialized: true, session: "other" });
  client.firstResearch.resolve({ initialized: true, session: "research" });
  assert.deepEqual(await first, { initialized: true, session: "research" });
  assert.deepEqual(await second, { initialized: true, session: "research" });
  assert.deepEqual(client.calls, ["research", "other", "research"]);
});

test("retires only the session whose runtime-owned status deadline expires", async () => {
  const client = new FakeBrowseTransport();
  client.firstResearch.reject(new WorkbenchBrowseDaemonTimeoutError("simulated deadline"));
  const retiredPids: number[] = [];
  const runtime = new WorkbenchBrowseRuntime({
    client,
    retireProcess: async (pid) => { retiredPids.push(pid); },
  });

  await assert.rejects(runtime.status("research"), /simulated deadline/u);
  assert.deepEqual(retiredPids, [123]);
  assert.deepEqual(client.cleaned, ["research"]);
  assert.deepEqual(await runtime.status("other"), { initialized: true, session: "other" });
});

test("releases a failed session queue so its next request is not stranded", async () => {
  const client = new FakeBrowseTransport();
  const runtime = new WorkbenchBrowseRuntime({ client, retireProcess: async () => undefined });
  const first = runtime.status("research");
  await Promise.resolve();
  const second = runtime.status("research");
  client.firstResearch.reject(new Error("simulated timeout"));

  await assert.rejects(first, /simulated timeout/u);
  assert.deepEqual(await second, { initialized: true, session: "research" });
  assert.deepEqual(client.calls, ["research", "research"]);
});

test("aborting a queued waiter does not retire or bypass the active session owner", async () => {
  const client = new FakeBrowseTransport();
  const runtime = new WorkbenchBrowseRuntime({ client, retireProcess: async () => undefined });
  const first = runtime.status("research");
  await Promise.resolve();

  const abortController = new AbortController();
  const cancelled = runtime.status("research", 5_000, abortController.signal);
  const third = runtime.status("research");
  abortController.abort(new Error("cancel queued waiter"));

  await assert.rejects(cancelled, /cancel queued waiter/u);
  assert.deepEqual(client.cleaned, []);
  assert.deepEqual(client.calls, ["research"]);

  client.firstResearch.resolve({ initialized: true, session: "research" });
  assert.deepEqual(await first, { initialized: true, session: "research" });
  assert.deepEqual(await third, { initialized: true, session: "research" });
  assert.deepEqual(client.calls, ["research", "research"]);
});

test("a queued waiter observes its deadline without retiring the active owner", async () => {
  const client = new FakeBrowseTransport();
  const runtime = new WorkbenchBrowseRuntime({ client, retireProcess: async () => undefined });
  const first = runtime.status("research");
  await Promise.resolve();

  await assert.rejects(runtime.status("research", 5), /waiting for its previous command/u);
  assert.deepEqual(client.cleaned, []);
  assert.deepEqual(client.calls, ["research"]);

  client.firstResearch.resolve({ initialized: true, session: "research" });
  await first;
});
