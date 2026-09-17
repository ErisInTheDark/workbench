/*
 * Exports:
 * - No production exports; Node tests cover catalog-aware Browse project resolution, session queue isolation, observation, and recovery.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { captureTestOutput } from "../../../../../test/capture-test-output.mts";

import WorkbenchBrowseRuntime, { type WorkbenchBrowseDaemonTransport } from "./WorkbenchBrowseRuntime.ts";
import type { WorkbenchBrowseAgentCommand } from "./actions/session-actions.ts";
import type { BrowseJsonValue } from "./actions/session-actions.ts";
import {
  WorkbenchBrowseDaemonTimeoutError,
  type WorkbenchBrowseDaemonRequestWithoutId,
} from "./WorkbenchBrowseDaemonClient.ts";
import * as fixtureIdentitySchemas from "workbench-shared/workbench/identity";

function createRuntime(options: Partial<ConstructorParameters<typeof WorkbenchBrowseRuntime>[0]> = {}) {
  return new WorkbenchBrowseRuntime({
    resolveProjectById: async () => { throw new Error("Unexpected project resolution in runtime fixture"); },
    resolveProjectFromCwd: async () => { throw new Error("Unexpected cwd resolution in runtime fixture"); },
    ...options,
  });
}

function createResolvedProject(id: string) {
  const rootPath = `C:/projects/${id}`;
  return {
    id: fixtureIdentitySchemas.ProjectIdSchema.parse(id),
    kind: "git" as const,
    root: rootPath,
    rootPath,
    roots: [{ id, name: id, root: rootPath, rootPath }],
  };
}

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
  getRuntimeDirectoryPath() { return "C:\\workbench-test\\browse-driver"; }
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
  const runtime = createRuntime({
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
    projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("workbench"),
    projectRootPath: "C:/projects/workbench",
    workspaceRoots: [{ id: "workbench", name: "workbench", rootPath: "C:/projects/workbench" }],
    workspaceRootPaths: ["C:/projects/workbench"],
  });

  assert.equal(result.ok, true);
  assert.deepEqual(client.calls, ["other"]);
});

test("resolves project-ID execution contexts through the injected catalog port", async () => {
  const requestedIds: Array<string | null | undefined> = [];
  const runtime = createRuntime({
    resolveProjectById: async (projectId) => {
      requestedIds.push(projectId);
      return createResolvedProject(projectId ?? "alpha");
    },
  });

  const context = await runtime.resolveExecutionContext({ cwd: null, projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("beta") });

  assert.deepEqual(requestedIds, ["beta"]);
  assert.equal(context.projectId, "beta");
  assert.equal(context.cwd.replace(/\\/gu, "/"), "C:/projects/beta");
});

test("serializes one session while allowing unrelated sessions to proceed", async () => {
  const client = new FakeBrowseTransport();
  const runtime = createRuntime({ client, retireProcess: async () => undefined });
  const first = runtime.status("research");
  await new Promise<void>((resolve) => setImmediate(resolve));
  const second = runtime.status("research");
  const unrelated = runtime.status("other");
  await new Promise<void>((resolve) => setImmediate(resolve));

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
  const runtime = createRuntime({
    client,
    retireProcess: async (pid) => { retiredPids.push(pid); },
  });

  await assert.rejects(runtime.status("research"), /simulated deadline/u);
  assert.deepEqual(retiredPids, [123]);
  assert.deepEqual(client.cleaned, ["research"]);
  assert.deepEqual(await runtime.status("other"), { initialized: true, session: "other" });
});

test("observational status timeout does not retire its session", async () => {
  const client = new FakeBrowseTransport();
  client.firstResearch.reject(new WorkbenchBrowseDaemonTimeoutError("simulated observation deadline"));
  const retiredPids: number[] = [];
  const runtime = createRuntime({
    client,
    retireProcess: async (pid) => { retiredPids.push(pid); },
  });

  await assert.rejects(runtime.inspectStatus("research"), /observation deadline/u);

  assert.deepEqual(retiredPids, []);
  assert.deepEqual(client.cleaned, []);
});

test("queued observational timeout does not retire the active session owner", async () => {
  const client = new FakeBrowseTransport();
  const runtime = createRuntime({ client, retireProcess: async () => undefined });
  const first = runtime.status("research");
  await Promise.resolve();

  await assert.rejects(runtime.inspectStatus("research", 5), /waiting for its previous command/u);
  assert.deepEqual(client.cleaned, []);
  assert.deepEqual(client.calls, ["research"]);

  client.firstResearch.resolve({ initialized: true, session: "research" });
  await first;
});

test("aborting an observational waiter releases its queue position", async () => {
  const client = new FakeBrowseTransport();
  const runtime = createRuntime({ client, retireProcess: async () => undefined });
  const first = runtime.status("research");
  await Promise.resolve();
  const abortController = new AbortController();
  const cancelled = runtime.inspectStatus("research", 5_000, abortController.signal);
  const third = runtime.inspectStatus("research");
  abortController.abort(new Error("cancel observation"));

  await assert.rejects(cancelled, /cancel observation/u);
  client.firstResearch.resolve({ initialized: true, session: "research" });
  await first;
  assert.deepEqual(await third, { initialized: true, session: "research" });
  assert.deepEqual(client.cleaned, []);
});

test("releases a failed session queue so its next request is not stranded", async () => {
  const client = new FakeBrowseTransport();
  const runtime = createRuntime({ client, retireProcess: async () => undefined });
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
  const runtime = createRuntime({ client, retireProcess: async () => undefined });
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
  const runtime = createRuntime({ client, retireProcess: async () => undefined });
  const first = runtime.status("research");
  await Promise.resolve();

  await assert.rejects(runtime.status("research", 5), /waiting for its previous command/u);
  assert.deepEqual(client.cleaned, []);
  assert.deepEqual(client.calls, ["research"]);

  client.firstResearch.resolve({ initialized: true, session: "research" });
  await first;
});

test("run keeps its session lease through retirement while other sessions proceed", async () => {
  const client = new FakeBrowseTransport();
  client.firstResearch.reject(new WorkbenchBrowseDaemonTimeoutError("simulated deadline"));
  const retirementStarted = deferred<void>();
  const releaseRetirement = deferred<void>();
  const runtime = createRuntime({
    client,
    retireProcess: async () => {
      retirementStarted.resolve();
      await releaseRetirement.promise;
    },
  });
  const first = runtime.run({
    action: "status",
    args: [],
    commandRequest: { args: [], cwd: "/work", projectId: null, threadId: "thread", timeoutMs: 5_000 },
    rememberSession: true,
    runtimeRequest: { kind: "status", session: "research", timeoutMs: 5_000 },
    session: "research",
  }, {
    cwd: "/work",
    owningRootPath: "/work",
    projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("work"),
    projectRootPath: "/work",
    workspaceRoots: [{ id: "work", name: "work", rootPath: "/work" }],
    workspaceRootPaths: ["/work"],
  });
  await retirementStarted.promise;
  const second = runtime.status("research");
  try {
    await runtime.status("other");
    assert.deepEqual(client.calls, ["research", "other"]);
    assert.deepEqual(client.cleaned, []);
  } finally {
    releaseRetirement.resolve();
    await Promise.all([first, second]);
  }
  assert.deepEqual(client.cleaned, ["research"]);
});

test("failed retirement retains runtime records and propagates failure", async (context) => {
  const diagnostics = captureTestOutput(context, process.stderr, text => text.startsWith("[browse-retirement] "));
  context.after(() => assert.equal(diagnostics.length, 1));
  const client = new FakeBrowseTransport();
  client.firstResearch.reject(new WorkbenchBrowseDaemonTimeoutError("simulated deadline"));
  const runtime = createRuntime({
    client,
    retireProcess: async () => { throw new Error("retirement denied"); },
  });
  await assert.rejects(runtime.status("research"), /retirement denied/u);
  assert.deepEqual(client.cleaned, []);
});

test("force stop does not discard unreadable PID records", async () => {
  const client = new FakeBrowseTransport();
  client.readPid = async () => { throw new Error("pid read denied"); };
  const runtime = createRuntime({
    client,
    retireProcess: async () => { throw new Error("must not signal without a pid"); },
  });
  await assert.rejects(runtime.stop("research", { force: true }), /pid read denied/u);
  assert.deepEqual(client.cleaned, []);
});

test("a cooperative stop response still requires process retirement before record cleanup", async () => {
  const client = new FakeBrowseTransport();
  const events: string[] = [];
  client.cleanupRuntimeFiles = async () => { events.push("cleanup"); };
  const runtime = createRuntime({
    client,
    retireProcess: async () => { events.push("retired"); },
  });
  await runtime.stop("other");
  assert.deepEqual(events, ["retired", "cleanup"]);
});

test("force stop propagates retirement failure without silently retrying it", async (context) => {
  const diagnostics = captureTestOutput(context, process.stderr, text => text.startsWith("[browse-retirement] "));
  context.after(() => assert.equal(diagnostics.length, 1));
  const client = new FakeBrowseTransport();
  let attempts = 0;
  const runtime = createRuntime({
    client,
    retireProcess: async () => { attempts += 1; throw new Error("retirement denied"); },
  });
  await assert.rejects(runtime.stop("other", { force: true }), /retirement denied/u);
  assert.equal(attempts, 1);
  assert.deepEqual(client.cleaned, []);
});

test("an unresponsive recorded process retires before replacement preparation and retains records on failure", async (context) => {
  const diagnostics = captureTestOutput(context, process.stderr, text => text.startsWith("[browse-retirement] "));
  context.after(() => assert.equal(diagnostics.length, 1));
  for (const fails of [false, true]) {
    const client = new FakeBrowseTransport();
    const events: string[] = [];
    client.request = async () => { throw Object.assign(new Error("offline"), { code: "ECONNREFUSED" }); };
    client.cleanupRuntimeFiles = async () => { events.push("cleanup"); };
    const runtime = createRuntime({
      client,
      retireProcess: async () => {
        events.push("retire");
        if (fails) throw new Error("retirement denied");
      },
      profileStore: {
        resolveProfilePath: async () => {
          events.push("prepare");
          throw new Error("fixture stops before process creation");
        },
      },
    });
    const result = await runtime.run({
      action: "open",
      args: [],
      commandRequest: { args: [], cwd: "/work", projectId: null, threadId: "thread", timeoutMs: 5_000 },
      rememberSession: true,
      runtimeRequest: {
        kind: "open", session: "research", timeoutMs: 5_000, mode: "headless", persistent: false,
        params: { url: "about:blank", waitUntil: "load", timeoutMs: 5_000 },
      },
      session: "research",
    }, {
      cwd: "/work", owningRootPath: "/work", projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("work"), projectRootPath: "/work",
      workspaceRoots: [{ id: "work", name: "work", rootPath: "/work" }], workspaceRootPaths: ["/work"],
    });
    assert.equal(result.ok, false);
    assert.deepEqual(events, fails ? ["retire"] : ["retire", "cleanup", "prepare"]);
  }
});

test("cancellation during failed retirement cannot trigger another retirement attempt", async (context) => {
  const diagnostics = captureTestOutput(context, process.stderr, text => text.startsWith("[browse-retirement] "));
  context.after(() => assert.equal(diagnostics.length, 2));
  for (const route of ["stop", "run"] as const) {
    const client = new FakeBrowseTransport();
    const abort = new AbortController();
    let attempts = 0;
    const runtime = createRuntime({
      client,
      retireProcess: async () => {
        attempts += 1;
        abort.abort();
        throw new Error("retirement denied");
      },
    });
    if (route === "stop") {
      await assert.rejects(runtime.stop("other", { force: true, signal: abort.signal }), /retirement denied/u);
    } else {
      const result = await runtime.run({
        action: "stop", args: [], rememberSession: false, session: "other",
        commandRequest: { args: [], cwd: "/work", projectId: null, threadId: "thread", timeoutMs: 5_000 },
        runtimeRequest: { kind: "stop", session: "other", timeoutMs: 5_000, force: true },
      }, {
        cwd: "/work", owningRootPath: "/work", projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("work"), projectRootPath: "/work",
        workspaceRoots: [{ id: "work", name: "work", rootPath: "/work" }], workspaceRootPaths: ["/work"],
      }, abort.signal);
      assert.equal(result.ok, false);
    }
    assert.equal(attempts, 1);
    assert.deepEqual(client.cleaned, []);
  }
});
