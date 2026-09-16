/*
 * Exports:
 * - No production exports; Node tests cover deferred Browse result ownership, ordering, failure logging, and screenshot steering.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { ThreadPayload, WorkbenchBrowseResultEntry } from "workbench-shared/types";
import type { WorkbenchBrowseResultEvent } from "./lib/workbench/browse/browse-result-events";
import WorkbenchBrowseResultController from "./WorkbenchBrowseResultController";
type ThreadReadResponse = { thread: Pick<ThreadPayload, "turns"> };

function deferred<TValue>() {
  let resolve!: (value: TValue) => void;
  const promise = new Promise<TValue>((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
}

function createThreadResponse(
  threadId: string,
  turnId: string,
  items: ThreadReadResponse["thread"]["turns"][number]["items"] = [],
): ThreadReadResponse {
  return {
    thread: {
      turns: [{
        completedAt: null,
        durationMs: null,
        error: null,
        id: turnId,
        items,
        itemsView: "full",
        startedAt: 0,
        status: "inProgress",
      }],
    },
  };
}

function createEvent(action: string): WorkbenchBrowseResultEvent {
  return {
    action,
    actionIndex: 0,
    assetUrl: null,
    detailKind: "result",
    detailLabel: null,
    detailText: action,
    durationMs: 1,
    session: "research",
    state: "completed",
    threadId: "thread-1",
  };
}

test("expired enrichment cannot write or steer after rollback resumes the owner", async () => {
  const read = deferred<ThreadReadResponse>();
  const entered = deferred<void>();
  const writes: WorkbenchBrowseResultEntry[] = [];
  let steers = 0;
  const controller = new WorkbenchBrowseResultController({
    listHarnesses: () => ["opencode"],
    logError: () => {},
    readThread: async () => { entered.resolve(); return await read.promise; },
    recordResult: async entry => { writes.push(entry); },
    screenshot: async () => { steers++; return { kind: "steered", turnId: "turn" }; },
  });
  const capture = controller.captureOrigin("thread-1");
  const captureRejected = assert.rejects(capture, /retired/);
  const screenshot = controller.deliverScreenshot("thread-1", "data:image/png;base64,YQ==");
  const rejected = assert.rejects(screenshot, /retired/);
  await entered.promise;
  controller.expire();
  await controller.waitForIdle();
  controller.resume();
  read.resolve(createThreadResponse("thread-1", "turn"));
  await rejected;
  await captureRejected;
  controller.record(createEvent("new"), await controller.captureOrigin("thread-1"));
  await controller.waitForIdle();
  assert.deepEqual(writes.map(entry => entry.action), ["new"]);
  assert.equal(steers, 0);
});

test("expiry retains the barrier for a result write that has already started", async () => {
  const writing = deferred<void>();
  const release = deferred<void>();
  const controller = new WorkbenchBrowseResultController({
    listHarnesses: () => ["codex"],
    logError: () => {},
    readThread: async () => createThreadResponse("thread-1", "turn"),
    recordResult: async () => { writing.resolve(); await release.promise; },
    screenshot: async () => { throw new Error("Unexpected screenshot"); },
  });
  controller.record(createEvent("issued"), await controller.captureOrigin("thread-1"));
  await writing.promise;
  controller.expire();
  let idle = false;
  const waiting = controller.waitForIdle().then(() => { idle = true; });
  await Promise.resolve();
  assert.equal(idle, false);
  release.resolve();
  await waiting;
});

test("records one thread's deferred results in emission order", async () => {
  const writeGate = deferred<void>();
  const recorded: WorkbenchBrowseResultEntry[] = [];
  const controller = new WorkbenchBrowseResultController({
    listHarnesses: () => ["codex", "copilot", "opencode"],
    logError: () => undefined,
    readThread: async () => createThreadResponse("thread-1", "turn-1"),
    recordResult: async (entry) => { await writeGate.promise; recorded.push(entry); },
    screenshot: async () => { throw new Error("Unexpected screenshot"); },
  });

  const origin = await controller.captureOrigin("thread-1");
  controller.record(createEvent("first"), origin);
  controller.record(createEvent("second"), origin);
  assert.deepEqual(recorded, []);
  writeGate.resolve();
  await controller.waitForIdle();

  assert.deepEqual(recorded.map((entry) => entry.action), ["first", "second"]);
  assert.deepEqual(recorded.map((entry) => entry.turnId), ["turn-1", "turn-1"]);
});

test("attaches Browse sidecars to the active wbex MCP Browse item", async () => {
  const recorded: WorkbenchBrowseResultEntry[] = [];
  const response = createThreadResponse("thread-1", "turn-1", [{
    appContext: null,
    arguments: { commands: ["snapshot --compact"] },
    durationMs: null,
    error: null,
    id: "mcp-browse-1",
    pluginId: null,
    readOnlyHint: false,
    result: null,
    server: "wbex",
    status: "inProgress",
    tool: "browse_run",
    type: "mcpToolCall",
  }]);
  const controller = new WorkbenchBrowseResultController({
    listHarnesses: () => ["codex", "copilot", "opencode"],
    logError: () => undefined,
    readThread: async () => response,
    recordResult: async (entry) => { recorded.push(entry); },
    screenshot: async () => { throw new Error("Unexpected screenshot"); },
  });

  controller.record(createEvent("snapshot"), await controller.captureOrigin("thread-1"));
  await controller.waitForIdle();

  assert.equal(recorded[0]?.commandItemId, "mcp-browse-1");
});

test("logs background metadata failures without rejecting Browse execution", async () => {
  const errors: string[] = [];
  const controller = new WorkbenchBrowseResultController({
    listHarnesses: () => ["codex", "copilot", "opencode"],
    logError: (message) => { errors.push(message); },
    readThread: async () => { throw new Error("thread unavailable"); },
    recordResult: async () => undefined,
    screenshot: async () => { throw new Error("Unexpected screenshot"); },
  });

  controller.record(createEvent("status"), await controller.captureOrigin("thread-1"));
  await controller.waitForIdle();
  assert.deepEqual(errors, ["thread unavailable"]);
});

test("delayed results keep their originating command after a newer turn starts", async () => {
  const recorded: WorkbenchBrowseResultEntry[] = [];
  const controller = new WorkbenchBrowseResultController({
    listHarnesses: () => ["codex"],
    logError: assert.fail,
    readThread: async () => createThreadResponse("thread-1", "new-turn"),
    recordResult: async entry => { recorded.push(entry); },
    screenshot: async () => { throw new Error("Unexpected screenshot"); },
  });
  controller.record(createEvent("click"), {
    commandItemId: "original-command", harness: "codex", turnId: "original-turn",
  });
  await controller.waitForIdle();
  assert.equal(recorded[0]?.turnId, "original-turn");
  assert.equal(recorded[0]?.commandItemId, "original-command");
});

test("screenshot delivery keeps canonical turn references at the provider boundary", async () => {
  const controller = new WorkbenchBrowseResultController({
    listHarnesses: () => ["codex"],
    logError: assert.fail,
    readThread: async () => createThreadResponse("thread-1", "public-turn"),
    recordResult: async () => {},
    screenshot: async (harness, request) => {
      assert.deepEqual([harness, request.threadId, request.turnId], ["codex", "thread-1", "public-turn"]);
      return { kind: "injected", acceptedAt: 1, turnId: "public-turn" };
    },
  });
  await controller.deliverScreenshot("thread-1", "image");
});

test("resolves non-codex screenshot steering behind the thread-owned boundary", async () => {
  const steers: string[] = [];
  const controller = new WorkbenchBrowseResultController({
    listHarnesses: () => ["copilot"],
    logError: () => undefined,
    readThread: async () => createThreadResponse("thread-1", "turn-1"),
    recordResult: async () => undefined,
    screenshot: async (_harness, { threadId, turnId }) => {
      steers.push(`${threadId}:${turnId}`);
      return { kind: "steered", turnId: "turn-2" };
    },
  });

  assert.deepEqual(await controller.deliverScreenshot("thread-1", "data:image/png;base64,AA=="), { kind: "steered", turnId: "turn-2" });
  assert.deepEqual(steers, ["thread-1:turn-1"]);
});

test("provider screenshot delivery preserves passive acceptance without provider-name branching", async () => {
  const delivered: object[] = [];
  const controller = new WorkbenchBrowseResultController({
    listHarnesses: () => ["another-provider"],
    logError() {}, recordResult: async () => undefined,
    readThread: async () => createThreadResponse("thread-1", "turn-1"),
    screenshot: async (harness, request) => {
      assert.equal(harness, "another-provider");
      delivered.push(request);
      return { kind: "injected", acceptedAt: 123, turnId: "turn-1" };
    },
  });
  const url = "data:image/png;base64,AA==";
  assert.deepEqual(await controller.deliverScreenshot("thread-1", url), { kind: "injected", acceptedAt: 123, turnId: "turn-1" });
  assert.deepEqual(delivered, [{
    threadId: "thread-1", turnId: "turn-1", imageUrl: url,
  }]);
});

test("screenshot delivery never wakes stopped targets and propagates injection failure", async () => {
  let active = false;
  let injections = 0;
  const controller = new WorkbenchBrowseResultController({
    listHarnesses: () => ["codex"], logError() {}, recordResult: async () => undefined,
    readThread: async () => {
      const response = createThreadResponse("thread-1", "turn-1");
      if (!active) {
        response.thread.turns[0].status = "completed";
      }
      return response;
    },
    screenshot: async () => { injections++; throw new Error("provider rejected injection"); },
  });
  await assert.rejects(controller.deliverScreenshot("thread-1", "image"), /no active turn/);
  assert.equal(injections, 0);
  active = true;
  await assert.rejects(controller.deliverScreenshot("thread-1", "image"), /provider rejected injection/);
  assert.equal(injections, 1);
});
