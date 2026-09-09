/*
 * Exports:
 * - No production exports; Node tests cover direct request adapters, concurrent Browse producers, cancellation release, session-read bypass, active-work ownership, result draining, and reload behavior. Keywords: browse, controller, direct, concurrency, cancel, sessions, result, reload, test.
 */
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import type { WorkbenchBrowseSessionListRequest, WorkbenchBrowseSessionSummary } from "workbench-shared/types";
import type { WorkbenchBrowseResultSink } from "../lib/workbench/browse/browse-result-events";
import WorkbenchBrowseController from "./WorkbenchBrowseController";
import WorkbenchBrowseRuntime from "../lib/workbench/browse/WorkbenchBrowseRuntime";
import WorkbenchBrowseRequestHandler from "../lib/workbench/browse/WorkbenchBrowseRequestHandler";

function deferred() {
  let resolve = () => undefined;
  const promise = new Promise<void>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function createController(
  onListSessions: (request: WorkbenchBrowseSessionListRequest) => void = () => undefined,
  onHandle: (signal: AbortSignal) => Promise<void> | void = () => undefined,
) {
  const results: WorkbenchBrowseResultSink = {
    record: () => undefined,
    deliverScreenshot: async () => ({ kind: "steered", turnId: "turn-1" }),
    waitForIdle: async () => undefined,
  };
  return new WorkbenchBrowseController(results, new WorkbenchBrowseRuntime(), {
    controlSession: async () => ({ result: null, session: null, stopped: false }),
    findStaleInactiveSessionStops: async () => [],
    handle: async (_body, signal) => {
      await onHandle(signal);
      return Response.json({ ok: true });
    },
    listSessions: async (request) => {
      onListSessions(request);
      return { generatedAt: new Date(0).toISOString(), projectId: null, sessions: [] };
    },
    waitForIdle: async () => undefined,
  });
}

test("expired identity lookup cannot launch work after rollback resumes admission", async () => {
  const entered = deferred();
  const release = deferred();
  let executions = 0;
  const controller = new WorkbenchBrowseController({
    record() {}, deliverScreenshot: async () => ({ kind: "steered", turnId: "turn" }), waitForIdle: async () => {},
  }, new WorkbenchBrowseRuntime(), {
    handle: async () => { executions++; return Response.json({ ok: true }); },
    listSessions: async () => ({ generatedAt: "", projectId: null, sessions: [] }),
    controlSession: async () => ({ result: null, session: null, stopped: false }),
    findStaleInactiveSessionStops: async () => [], waitForIdle: async () => {},
  }, {
    nativeTarget: async () => { entered.resolve(); await release.promise; return { threadId: "native" }; },
    publicThreadId: async () => "public",
  });
  const command = controller.executeBrowseRequest(Buffer.from('{"threadId":"public"}'), new AbortController().signal);
  const rejected = assert.rejects(command, /reload/);
  await entered.promise;
  controller.expire();
  await controller.waitForIdle();
  controller.resume();
  release.resolve();
  await rejected;
  await controller.executeBrowseRequest(Buffer.from("{}"), new AbortController().signal);
  assert.equal(executions, 1);
});

test("a late screenshot cannot resolve asset identity or publish a result after cancellation", async () => {
  const entered = deferred();
  const release = deferred();
  let publications = 0;
  let identityReads = 0;
  const runtime = {
    resolveExecutionContext: async () => ({}),
    run: async () => {
      entered.resolve();
      await release.promise;
      return { ok: true, exitCode: 0, durationMs: 1, stderr: "", stdout: JSON.stringify({ base64: "YQ==", mimeType: "image/png" }) };
    },
  } as unknown as WorkbenchBrowseRuntime;
  const handler = new WorkbenchBrowseRequestHandler({
    record() { publications++; },
    deliverScreenshot: async () => { publications++; return { kind: "steered", turnId: "turn" }; },
    waitForIdle: async () => {},
  }, runtime, async () => { identityReads++; throw new Error("retired screenshot reached asset identity"); });
  const cancellation = new AbortController();
  const request = handler.handle(Buffer.from(JSON.stringify({ action: "screenshot", threadId: "thread", session: "default", cwd: "C:/repo" })),
    cancellation.signal, async task => await task());
  await entered.promise;
  cancellation.abort(new Error("reload"));
  release.resolve();
  const response = await request;
  assert.equal(response.status, 400);
  assert.equal(identityReads, 0);
  assert.equal(publications, 0);
});

test("direct Browse request execution uses the same handler and cancellation signal as HTTP ingress", async () => {
  let receivedSignal: AbortSignal | null = null;
  const controller = createController(() => undefined, (signal) => { receivedSignal = signal; });
  const abortController = new AbortController();
  const response = await controller.executeBrowseRequest(Buffer.from("{}"), abortController.signal);

  assert.equal(response.status, 200);
  assert.ok(receivedSignal);
  const cancelled = new Error("caller cancelled");
  abortController.abort(cancelled);
  assert.equal(receivedSignal.aborted, true);
  assert.equal(receivedSignal.reason, cancelled);
  assert.deepEqual(await response.json(), { ok: true });
});

test("Browse translates only declared targets and returns public session identities", async () => {
  const received: object[] = [];
  const session = { name: "default", threadId: "native", projectId: "project" } as WorkbenchBrowseSessionSummary;
  const identity = {
    nativeTarget: async (request: { threadId: string; cwd?: string | null; projectId?: string | null }) => {
      assert.equal(request.threadId, "public");
      return { ...request, threadId: "native" };
    },
    publicThreadId: async (threadId: string) => {
      assert.equal(threadId, "native");
      return "public";
    },
  };
  const controller = new WorkbenchBrowseController({
    record() {}, deliverScreenshot: async () => ({ kind: "steered", turnId: "turn" }), waitForIdle: async () => {},
  }, new WorkbenchBrowseRuntime(), {
    handle: async (body) => { received.push(JSON.parse(body.toString())); return Response.json({ ok: true }); },
    listSessions: async (request) => { received.push(request); return { generatedAt: "", projectId: "project", sessions: [session] }; },
    controlSession: async (request) => { received.push(request); return { result: null, session, stopped: true }; },
    findStaleInactiveSessionStops: async () => [], waitForIdle: async () => {},
  }, identity);
  const signal = new AbortController().signal;
  const action = { action: "evaluate", threadId: "public", cwd: "C:/repo", expression: '({threadId:"public"})' };
  const response = await controller.executeBrowseRequest(Buffer.from(JSON.stringify({ actions: [action] })), signal);
  assert.equal(response.status, 200);
  assert.deepEqual(received[0], { actions: [{ ...action, threadId: "native" }] });
  const list = await controller.listSessions({ threadId: "public", cwd: "C:/repo" }, signal);
  assert.equal(list.sessions[0]!.threadId, "public");
  const stopped = await controller.controlSession({ action: "stop", threadId: "public", session: "default", cwd: "C:/repo" }, signal);
  assert.equal(stopped.session?.threadId, "public");
  assert.equal((received[1] as { threadId: string }).threadId, "native");
  assert.equal((received[2] as { threadId: string }).threadId, "native");
});

test("direct session request execution preserves query adaptation", async () => {
  let receivedRequest: WorkbenchBrowseSessionListRequest | null = null;
  const controller = createController((request) => { receivedRequest = request; });
  const response = await controller.executeSessionRequest({
    body: Buffer.alloc(0),
    method: "GET",
    url: "/api/browse/sessions?cwd=C%3A%5Cprojects%5Cworkbench&includeRuntime=false&threadId=thread-1",
  }, new AbortController().signal);

  assert.equal(response.status, 200);
  assert.equal(receivedRequest?.cwd, "C:\\projects\\workbench");
  assert.equal(receivedRequest?.includeRuntime, false);
  assert.equal(receivedRequest?.threadId, "thread-1");
});

test("Browse reload waits for admitted identity lookups and rejects later commands", async () => {
  for (const operation of ["browse", "sessions"] as const) {
    const entered = deferred();
    const gate = deferred();
    let settled = false;
    const controller = new WorkbenchBrowseController({
      record() {}, deliverScreenshot: async () => ({ kind: "steered", turnId: "turn" }), waitForIdle: async () => {},
    }, new WorkbenchBrowseRuntime(), {
      handle: async () => Response.json({ ok: true }),
      listSessions: async () => ({ generatedAt: "", projectId: null, sessions: [] }),
      controlSession: async () => ({ result: null, session: null, stopped: false }),
      findStaleInactiveSessionStops: async () => [], waitForIdle: async () => {},
    }, {
      nativeTarget: async () => { entered.resolve(); await gate.promise; return { threadId: "native" }; },
      publicThreadId: async () => "public",
    });
    const active = operation === "browse"
      ? controller.executeBrowseRequest(Buffer.from('{"threadId":"public"}'), new AbortController().signal)
      : controller.listSessions({ threadId: "public" });
    await entered.promise;
    controller.beginDrain();
    const drained = controller.waitForIdle().then(() => { settled = true; });
    await Promise.resolve();
    assert.equal(settled, false);
    await assert.rejects(controller.listSessions({ threadId: "public" }), /draining/u);
    gate.resolve();
    await active;
    await drained;
    assert.equal(settled, true);
  }
});

test("HTTP admission releases the graph handler and reload drain cancels its request owner", async () => {
  const requestStarted = deferred();
  const requestCancelled = deferred();
  let receivedSignal: AbortSignal | null = null;
  const controller = createController(() => undefined, async (signal) => {
    receivedSignal = signal;
    requestStarted.resolve();
    await new Promise<void>((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        requestCancelled.resolve();
        reject(signal.reason);
      }, { once: true });
    });
  });
  const admitted = deferred();
  const server = http.createServer((request, response) => {
    void controller.handleBrowseHttpRequest(request, response).finally(admitted.resolve);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  try {
    const client = fetch(`http://127.0.0.1:${address.port}/orchestrator/browse`, {
      body: "{}",
      method: "POST",
    });
    await requestStarted.promise;
    await admitted.promise;

    controller.beginDrain();
    await requestCancelled.promise;
    await controller.waitForIdle();
    assert.equal(receivedSignal?.aborted, true);
    assert.equal((await client).ok, false);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("independent Browse command producers can run concurrently", async () => {
  const controller = createController();
  const firstGate = deferred();
  const events: string[] = [];
  const first = controller.runCommand(async () => {
    events.push("first-start");
    await firstGate.promise;
    events.push("first-end");
  });
  const second = controller.runCommand(async () => {
    events.push("second");
  });

  await Promise.resolve();
  assert.deepEqual(events, ["first-start", "second"]);
  firstGate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["first-start", "second", "first-end"]);
});

test("a failed command releases the next producer", async () => {
  const controller = createController();
  const failure = controller.runCommand(async () => {
    throw new Error("expected failure");
  });
  const next = controller.runCommand(async () => "released");

  await assert.rejects(failure, /expected failure/u);
  assert.equal(await next, "released");
});

test("an aborted producer releases the command FIFO", async () => {
  const controller = createController();
  const abortController = new AbortController();
  const aborted = controller.runCommand(async () => await new Promise<never>((_resolve, reject) => {
    abortController.signal.addEventListener("abort", () => reject(abortController.signal.reason), { once: true });
  }));
  const next = controller.runCommand(async () => "released-after-abort");

  await Promise.resolve();
  abortController.abort(new Error("expected abort"));
  await assert.rejects(aborted, /expected abort/u);
  assert.equal(await next, "released-after-abort");
});

test("session reads bypass a blocked command producer", async () => {
  let listed = false;
  const controller = createController(() => { listed = true; });
  const producerGate = deferred();
  const producer = controller.runCommand(async () => await producerGate.promise);

  await Promise.resolve();
  const result = await controller.listSessions({ includeRuntime: false });
  assert.equal(listed, true);
  assert.deepEqual(result.sessions, []);
  producerGate.resolve();
  await producer;
});

test("producer completion owns reload drain tracking", async () => {
  const controller = createController();
  const producerGate = deferred();
  const streamedProducer = controller.runCommand(async () => {
    await producerGate.promise;
  });
  controller.beginDrain();

  await Promise.resolve();
  const idle = controller.waitForIdle();
  let idleSettled = false;
  void idle.then(() => { idleSettled = true; });
  await Promise.resolve();
  assert.equal(idleSettled, false);
  producerGate.resolve();
  await Promise.all([streamedProducer, idle]);
  assert.equal(idleSettled, true);
});

test("draining rejects new commands and resume preserves the controller", async () => {
  const controller = createController();
  const activeGate = deferred();
  const active = controller.runCommand(async () => await activeGate.promise);
  controller.beginDrain();

  await assert.rejects(controller.runCommand(async () => undefined), /draining for reload/u);
  activeGate.resolve();
  await controller.waitForIdle();
  await active;

  controller.resume();
  assert.equal(await controller.runCommand(async () => "same-controller"), "same-controller");
});
