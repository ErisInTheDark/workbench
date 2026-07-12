/*
 * Exports:
 * - No production exports; Node tests cover Browse command FIFO, cancellation release, session-read bypass, producer ownership, and reload draining. Keywords: browse, controller, queue, cancel, sessions, reload, test.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { WorkbenchBrowseSessionListRequest } from "../lib/types";
import WorkbenchBrowseController from "./WorkbenchBrowseController";
import WorkbenchBrowseTranscriptAdapter from "./WorkbenchBrowseTranscriptAdapter";

function deferred() {
  let resolve = () => undefined;
  const promise = new Promise<void>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function createController(onListSessions: (request: WorkbenchBrowseSessionListRequest) => void = () => undefined) {
  const transcripts = new WorkbenchBrowseTranscriptAdapter({
    readThread: async () => { throw new Error("Unexpected transcript read."); },
    recordResult: async () => undefined,
    steerTurn: async () => null,
  });
  return new WorkbenchBrowseController(transcripts, {
    controlSession: async () => ({ result: null, session: null, stopped: false }),
    findStaleInactiveSessionStops: async () => [],
    handle: async () => Response.json({ ok: true }),
    listSessions: async (request) => {
      onListSessions(request);
      return { generatedAt: new Date(0).toISOString(), projectId: null, sessions: [] };
    },
  });
}

test("Browse command producers run in FIFO order", async () => {
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
  assert.deepEqual(events, ["first-start"]);
  firstGate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["first-start", "first-end", "second"]);
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

test("producer completion, rather than response creation, owns the FIFO", async () => {
  const controller = createController();
  const producerGate = deferred();
  let secondStarted = false;
  const streamedProducer = controller.runCommand(async () => {
    await producerGate.promise;
  });
  const second = controller.runCommand(async () => {
    secondStarted = true;
  });

  await Promise.resolve();
  assert.equal(secondStarted, false);
  producerGate.resolve();
  await Promise.all([streamedProducer, second]);
  assert.equal(secondStarted, true);
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
