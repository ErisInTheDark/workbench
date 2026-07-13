/*
 * Exports:
 * - No production exports; Node tests cover direct request adapters, concurrent Browse producers, cancellation release, session-read bypass, active-work ownership, result draining, and reload behavior. Keywords: browse, controller, direct, concurrency, cancel, sessions, result, reload, test.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { WorkbenchBrowseSessionListRequest } from "../lib/types";
import type { WorkbenchBrowseResultSink } from "../lib/workbench/browse/browse-result-events";
import WorkbenchBrowseController from "./WorkbenchBrowseController";
import WorkbenchBrowseRuntime from "../lib/workbench/browse/WorkbenchBrowseRuntime";

function deferred() {
  let resolve = () => undefined;
  const promise = new Promise<void>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function createController(
  onListSessions: (request: WorkbenchBrowseSessionListRequest) => void = () => undefined,
  onHandle: (signal: AbortSignal) => void = () => undefined,
) {
  const results: WorkbenchBrowseResultSink = {
    record: () => undefined,
    steerScreenshot: async () => "turn-1",
    waitForIdle: async () => undefined,
  };
  return new WorkbenchBrowseController(results, new WorkbenchBrowseRuntime(), {
    controlSession: async () => ({ result: null, session: null, stopped: false }),
    findStaleInactiveSessionStops: async () => [],
    handle: async (_body, signal) => {
      onHandle(signal);
      return Response.json({ ok: true });
    },
    listSessions: async (request) => {
      onListSessions(request);
      return { generatedAt: new Date(0).toISOString(), projectId: null, sessions: [] };
    },
    waitForIdle: async () => undefined,
  });
}

test("direct Browse request execution uses the same handler and cancellation signal as HTTP ingress", async () => {
  let receivedSignal: AbortSignal | null = null;
  const controller = createController(() => undefined, (signal) => { receivedSignal = signal; });
  const abortController = new AbortController();
  const response = await controller.executeBrowseRequest(Buffer.from("{}"), abortController.signal);

  assert.equal(response.status, 200);
  assert.equal(receivedSignal, abortController.signal);
  assert.deepEqual(await response.json(), { ok: true });
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
