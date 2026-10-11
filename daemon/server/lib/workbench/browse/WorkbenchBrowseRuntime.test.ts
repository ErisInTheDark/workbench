/*
 * Exports:
 * - No production exports; Node tests cover Browse project resolution, queue leases, observation, and retirement.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { captureTestOutput } from "../../../../../test/capture-test-output.mts";
import * as fixtureIdentitySchemas from "workbench-shared/workbench/identity";
import type { BrowseJsonValue, WorkbenchBrowseAgentCommand } from "./actions/session-actions.ts";
import {
  WorkbenchBrowseDaemonTimeoutError,
  type WorkbenchBrowseDaemonRequestWithoutId,
} from "./WorkbenchBrowseDaemonClient.ts";
import WorkbenchBrowseRuntime, {
  prepareWorkbenchBrowseDaemonProcess,
  type WorkbenchBrowseCallerWaiter,
  type WorkbenchBrowseDaemonTransport,
  type WorkbenchBrowseExecutionContext,
} from "./WorkbenchBrowseRuntime.ts";

test("lowers the Browse daemon before detaching its future Chromium tree", () => {
  const events: string[] = [];
  const child = {
    pid: 42,
    unref: () => { events.push("unref"); },
  };
  prepareWorkbenchBrowseDaemonProcess(child as never, () => { events.push("priority"); });
  assert.deepEqual(events, ["priority", "unref"]);
});

function deferred<TValue>() {
  let reject!: (error: Error) => void;
  let resolve!: (value: TValue) => void;
  const promise = new Promise<TValue>((resolvePromise, rejectPromise) => {
    reject = rejectPromise;
    resolve = resolvePromise;
  });
  return { promise, reject, resolve };
}

class ControlledCallerWait {
  timeoutNextCompletion = false;

  readonly wait: WorkbenchBrowseCallerWaiter = async (completion, { message, signal }) => {
    if (signal?.aborted) throw signal.reason;
    if (this.timeoutNextCompletion && !message.includes("previous command")) {
      this.timeoutNextCompletion = false;
      throw new WorkbenchBrowseDaemonTimeoutError(message);
    }
    return await completion;
  };
}

class FakeBrowseTransport implements WorkbenchBrowseDaemonTransport {
  readonly calls: Array<{ command?: string; session: string; type: string }> = [];
  readonly cleaned: string[] = [];
  readonly blockedMutation = deferred<BrowseJsonValue>();
  blockNextMutation = false;
  failNextMutation = false;

  async cleanupRuntimeFiles(session: string) { this.cleaned.push(session); }
  getRuntimeDirectoryPath() { return "C:\\workbench-test\\browse-driver"; }
  async initialize() {}
  async listRuntimeSessionNames() { return []; }
  async readPid() { return 123; }
  async request(session: string, request: WorkbenchBrowseDaemonRequestWithoutId) {
    this.calls.push({
      ...("command" in request ? { command: request.command } : {}),
      session,
      type: request.type,
    });
    if (request.type === "command" && this.blockNextMutation && request.command !== "screenshot") {
      this.blockNextMutation = false;
      return await this.blockedMutation.promise;
    }
    if (request.type === "command" && this.failNextMutation && request.command !== "screenshot") {
      this.failNextMutation = false;
      throw new Error("mutation failed");
    }
    return request.type === "status"
      ? { initialized: true, session }
      : { command: "command" in request ? request.command : request.type, session };
  }
}

const execution: WorkbenchBrowseExecutionContext = {
  cwd: "C:/projects/workbench",
  owningRootPath: "C:/projects/workbench",
  projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("workbench"),
  projectRootPath: "C:/projects/workbench",
  workspaceRoots: [{ id: "workbench", name: "workbench", rootPath: "C:/projects/workbench" }],
  workspaceRootPaths: ["C:/projects/workbench"],
};

function command(session: string, browserCommand = "click"): WorkbenchBrowseAgentCommand {
  return {
    action: browserCommand === "screenshot" ? "screenshot" : "click",
    args: [],
    commandRequest: { args: [], cwd: execution.cwd, projectId: null, threadId: "thread", timeoutMs: 5_000 },
    rememberSession: false,
    runtimeRequest: {
      command: browserCommand,
      kind: "command",
      mode: null,
      params: {},
      persistent: false,
      session,
      timeoutMs: 5_000,
    },
    session,
  };
}

function openCommand(session: string): WorkbenchBrowseAgentCommand {
  return {
    action: "open",
    args: [],
    commandRequest: { args: [], cwd: execution.cwd, projectId: null, threadId: "thread", timeoutMs: 5_000 },
    rememberSession: true,
    runtimeRequest: {
      kind: "open",
      mode: "headless",
      params: { timeoutMs: 5_000, url: "about:blank", waitUntil: "load" },
      persistent: false,
      session,
      timeoutMs: 5_000,
    },
    session,
  };
}

function createRuntime(options: Partial<ConstructorParameters<typeof WorkbenchBrowseRuntime>[0]> = {}) {
  return new WorkbenchBrowseRuntime({
    resolveProjectById: async () => { throw new Error("Unexpected project resolution"); },
    resolveProjectFromCwd: async () => { throw new Error("Unexpected cwd resolution"); },
    ...options,
  });
}

test("resolves project-ID execution contexts through the injected catalogue", async () => {
  const requestedIds: Array<string | null | undefined> = [];
  const runtime = createRuntime({
    resolveProjectById: async (projectId) => {
      requestedIds.push(projectId);
      const id = fixtureIdentitySchemas.ProjectIdSchema.parse(projectId ?? "alpha");
      const root = `C:/projects/${id}`;
      return { id, kind: "git", root, rootPath: root, roots: [{ id, name: id, root, rootPath: root }] };
    },
  });

  const context = await runtime.resolveExecutionContext({
    cwd: null,
    projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("beta"),
  });

  assert.deepEqual(requestedIds, ["beta"]);
  assert.equal(context.projectId, "beta");
  assert.equal(context.cwd.replace(/\\/gu, "/"), "C:/projects/beta");
});

test("caller timeout preserves the underlying mutation and its exclusive queue lease", async () => {
  const client = new FakeBrowseTransport();
  const caller = new ControlledCallerWait();
  const runtime = createRuntime({ client, waitForCaller: caller.wait });
  client.blockNextMutation = true;
  caller.timeoutNextCompletion = true;

  const first = await runtime.run(command("research"), execution);
  assert.equal(first.ok, false);
  assert.equal(first.timedOut, true);

  const second = runtime.run(command("research"), execution);
  const unrelated = runtime.run(command("other"), execution);
  assert.equal((await unrelated).ok, true);
  assert.deepEqual(client.calls.filter((call) => call.type === "command"), [
    { command: "click", session: "research", type: "command" },
    { command: "click", session: "other", type: "command" },
  ]);

  client.blockedMutation.resolve({ clicked: true });
  assert.equal((await second).ok, true);
  assert.deepEqual(client.calls.filter((call) => call.type === "command"), [
    { command: "click", session: "research", type: "command" },
    { command: "click", session: "other", type: "command" },
    { command: "click", session: "research", type: "command" },
  ]);
  assert.deepEqual(client.cleaned, []);
});

test("failed and cancelled queued mutations release their queue positions", async () => {
  const client = new FakeBrowseTransport();
  const runtime = createRuntime({ client });
  client.failNextMutation = true;
  const failed = runtime.run(command("research"), execution);
  const afterFailure = runtime.run(command("research"), execution);
  assert.equal((await failed).ok, false);
  assert.equal((await afterFailure).ok, true);

  client.blockNextMutation = true;
  const active = runtime.run(command("research"), execution);
  await new Promise(setImmediate);
  const abort = new AbortController();
  const cancelled = runtime.run(command("research"), execution, abort.signal);
  const afterCancellation = runtime.run(command("research"), execution);
  abort.abort(new Error("cancel queued mutation"));
  assert.match((await cancelled).error ?? "", /cancel queued mutation/u);
  client.blockedMutation.resolve({ clicked: true });
  assert.equal((await active).ok, true);
  assert.equal((await afterCancellation).ok, true);
  assert.equal(client.calls.filter((call) => call.command === "click").length, 4);
});

test("status and screenshot observe a session while its mutation is still running", async () => {
  const client = new FakeBrowseTransport();
  const caller = new ControlledCallerWait();
  const runtime = createRuntime({ client, waitForCaller: caller.wait });
  client.blockNextMutation = true;
  caller.timeoutNextCompletion = true;
  await runtime.run(command("research"), execution);

  assert.deepEqual(await runtime.status("research"), { initialized: true, session: "research" });
  const screenshot = await runtime.run(command("research", "screenshot"), execution);
  assert.equal(screenshot.ok, true);
  assert.ok(client.calls.some((call) => call.command === "screenshot"));
  client.blockedMutation.resolve({ clicked: true });
});

test("force stop retires immediately without waiting for a stuck mutation", async () => {
  const client = new FakeBrowseTransport();
  const caller = new ControlledCallerWait();
  const retired: number[] = [];
  const runtime = createRuntime({
    client,
    retireProcess: async (pid) => { retired.push(pid); },
    waitForCaller: caller.wait,
  });
  client.blockNextMutation = true;
  caller.timeoutNextCompletion = true;
  await runtime.run(command("research"), execution);

  assert.deepEqual(await runtime.stop("research", { force: true }), { stopped: true });
  assert.deepEqual(retired, [123]);
  assert.deepEqual(client.cleaned, ["research"]);
  client.blockedMutation.resolve({ clicked: true });
});

test("ordinary observation timeout never retires the session", async () => {
  const client = new FakeBrowseTransport();
  const caller = new ControlledCallerWait();
  const runtime = createRuntime({ client, waitForCaller: caller.wait });
  caller.timeoutNextCompletion = true;

  await assert.rejects(runtime.status("research"), WorkbenchBrowseDaemonTimeoutError);
  assert.deepEqual(client.cleaned, []);
});

test("force stop preserves runtime records when retirement fails", async (context) => {
  const diagnostics = captureTestOutput(context, process.stderr, (text) => text.startsWith("[browse-retirement] "));
  context.after(() => assert.equal(diagnostics.length, 1));
  const client = new FakeBrowseTransport();
  const runtime = createRuntime({
    client,
    retireProcess: async () => { throw new Error("retirement denied"); },
  });

  await assert.rejects(runtime.stop("research", { force: true }), /retirement denied/u);
  assert.deepEqual(client.cleaned, []);
});

test("force stop preserves unreadable PID records", async () => {
  const client = new FakeBrowseTransport();
  client.readPid = async () => { throw new Error("pid read denied"); };
  const runtime = createRuntime({
    client,
    retireProcess: async () => { throw new Error("must not retire without a pid"); },
  });
  await assert.rejects(runtime.stop("research", { force: true }), /pid read denied/u);
  assert.deepEqual(client.cleaned, []);
});

test("cooperative stop retires the process before cleaning runtime records", async () => {
  const events: string[] = [];
  const client = new FakeBrowseTransport();
  client.cleanupRuntimeFiles = async () => { events.push("cleanup"); };
  const runtime = createRuntime({
    client,
    retireProcess: async () => { events.push("retire"); },
  });
  await runtime.stop("research");
  assert.deepEqual(events, ["retire", "cleanup"]);
});

test("stale process retirement completes before replacement preparation", async (context) => {
  const diagnostics = captureTestOutput(context, process.stderr, (text) => text.startsWith("[browse-retirement] "));
  context.after(() => assert.equal(diagnostics.length, 1));
  for (const retirementFails of [false, true]) {
    const events: string[] = [];
    const client = new FakeBrowseTransport();
    client.request = async () => { throw Object.assign(new Error("offline"), { code: "ECONNREFUSED" }); };
    client.cleanupRuntimeFiles = async () => { events.push("cleanup"); };
    const runtime = createRuntime({
      client,
      profileStore: {
        resolveProfilePath: async () => {
          events.push("prepare");
          throw new Error("fixture stops before process creation");
        },
      },
      retireProcess: async () => {
        events.push("retire");
        if (retirementFails) throw new Error("retirement denied");
      },
    });
    const result = await runtime.run(openCommand("research"), execution);
    assert.equal(result.ok, false);
    assert.deepEqual(events, retirementFails ? ["retire"] : ["retire", "cleanup", "prepare"]);
  }
});
