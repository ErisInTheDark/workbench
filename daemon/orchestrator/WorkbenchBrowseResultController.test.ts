/*
 * Exports:
 * - No production exports; Node tests cover deferred Browse result ownership, ordering, failure logging, and screenshot steering. Keywords: browse, result, controller, thread, test.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { ThreadReadResponse } from "workbench-shared/codex/generated/app-server/v2/ThreadReadResponse";
import type { WorkbenchBrowseResultEntry } from "workbench-shared/types";
import type { WorkbenchBrowseResultEvent } from "../lib/workbench/browse/browse-result-events";
import WorkbenchBrowseResultController from "./WorkbenchBrowseResultController";
import { createAgentScreenshotSteerText } from "workbench-shared/workbench/thread/thread-steer-markers";

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
      agentNickname: null,
      agentRole: null,
      canAcceptDirectInput: null,
      cliVersion: "test",
      createdAt: 0,
      cwd: "C:/workspace",
      ephemeral: false,
      extra: null,
      forkedFromId: null,
      gitInfo: null,
      historyMode: "legacy",
      id: threadId,
      modelProvider: "test",
      model: null,
      projectId: null,
      reasoningEffort: null,
      name: null,
      parentThreadId: null,
      path: null,
      preview: "",
      recencyAt: null,
      section: null,
      sectionEnteredAt: null,
      sessionId: "session-1",
      source: "appServer",
      status: { activeFlags: [], type: "active" },
      threadSource: null,
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
      updatedAt: 0,
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
    steerTurn: async () => { steers++; return "turn"; },
  });
  controller.record(createEvent("old"));
  const screenshot = controller.deliverScreenshot("thread-1", "data:image/png;base64,YQ==");
  const rejected = assert.rejects(screenshot, /retired/);
  await entered.promise;
  controller.expire();
  await controller.waitForIdle();
  controller.resume();
  read.resolve(createThreadResponse("thread-1", "turn"));
  await rejected;
  controller.record(createEvent("new"));
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
    steerTurn: async () => null,
  });
  controller.record(createEvent("issued"));
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
  const readGate = deferred<ThreadReadResponse>();
  const recorded: WorkbenchBrowseResultEntry[] = [];
  const controller = new WorkbenchBrowseResultController({
    listHarnesses: () => ["codex", "copilot", "opencode"],
    logError: () => undefined,
    readThread: async () => await readGate.promise,
    recordResult: async (entry) => { recorded.push(entry); },
    steerTurn: async () => null,
  });

  controller.record(createEvent("first"));
  controller.record(createEvent("second"));
  assert.deepEqual(recorded, []);
  readGate.resolve(createThreadResponse("thread-1", "turn-1"));
  await controller.waitForIdle();

  assert.deepEqual(recorded.map((entry) => entry.action), ["first", "second"]);
  assert.deepEqual(recorded.map((entry) => entry.turnId), ["turn-1", "turn-1"]);
});

test("attaches Browse sidecars to the active wb MCP Browse item", async () => {
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
    server: "wb",
    status: "inProgress",
    tool: "browse_run",
    type: "mcpToolCall",
  }]);
  const controller = new WorkbenchBrowseResultController({
    listHarnesses: () => ["codex", "copilot", "opencode"],
    logError: () => undefined,
    readThread: async () => response,
    recordResult: async (entry) => { recorded.push(entry); },
    steerTurn: async () => null,
  });

  controller.record(createEvent("snapshot"));
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
    steerTurn: async () => null,
  });

  controller.record(createEvent("status"));
  await controller.waitForIdle();
  assert.deepEqual(errors, ["thread unavailable"]);
});

test("resolves non-codex screenshot steering behind the thread-owned boundary", async () => {
  const steers: string[] = [];
  const controller = new WorkbenchBrowseResultController({
    listHarnesses: () => ["copilot"],
    logError: () => undefined,
    readThread: async () => createThreadResponse("thread-1", "turn-1"),
    recordResult: async () => undefined,
    steerTurn: async (_harness, threadId, turnId) => {
      steers.push(`${threadId}:${turnId}`);
      return "turn-2";
    },
  });

  assert.deepEqual(await controller.deliverScreenshot("thread-1", "data:image/png;base64,AA=="), { kind: "steered", turnId: "turn-2" });
  assert.deepEqual(steers, ["thread-1:turn-1"]);
});

test("codex screenshots use passive context and return queue acceptance, not a steer", async () => {
  const delivered: object[] = [];
  const controller = new WorkbenchBrowseResultController({
    listHarnesses: () => ["codex"],
    logError() {}, recordResult: async () => undefined,
    readThread: async () => createThreadResponse("thread-1", "turn-1"),
    steerTurn: async () => { throw new Error("Codex screenshot must not steer."); },
    injectToolContext: async (request) => {
      delivered.push(request);
      return { acceptedAt: 123, itemId: "image-output", turnId: "turn-1" };
    },
  });
  const url = "data:image/png;base64,AA==";
  assert.deepEqual(await controller.deliverScreenshot("thread-1", url), { kind: "injected", acceptedAt: 123, turnId: "turn-1" });
  assert.deepEqual(delivered, [{
    threadId: "thread-1", expectedTurnId: "turn-1",
    toolOutput: { name: "screenshot", namespace: "workbench", output: [
      { type: "input_text", text: createAgentScreenshotSteerText() },
      { type: "input_image", image_url: url },
    ] },
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
        response.thread.status = { type: "idle" };
        response.thread.turns[0].status = "completed";
      }
      return response;
    },
    steerTurn: async () => { throw new Error("Unexpected steer."); },
    injectToolContext: async () => { injections++; throw new Error("provider rejected injection"); },
  });
  await assert.rejects(controller.deliverScreenshot("thread-1", "image"), /no active turn/);
  assert.equal(injections, 0);
  active = true;
  await assert.rejects(controller.deliverScreenshot("thread-1", "image"), /provider rejected injection/);
  assert.equal(injections, 1);
});
