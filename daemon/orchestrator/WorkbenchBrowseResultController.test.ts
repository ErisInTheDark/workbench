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

test("resolves explicit screenshot steering behind the thread-owned boundary", async () => {
  const steers: string[] = [];
  const controller = new WorkbenchBrowseResultController({
    listHarnesses: () => ["codex", "copilot", "opencode"],
    logError: () => undefined,
    readThread: async () => createThreadResponse("thread-1", "turn-1"),
    recordResult: async () => undefined,
    steerTurn: async (_harness, threadId, turnId) => {
      steers.push(`${threadId}:${turnId}`);
      return "turn-2";
    },
  });

  assert.equal(await controller.steerScreenshot("thread-1", "data:image/png;base64,AA=="), "turn-2");
  assert.deepEqual(steers, ["thread-1:turn-1"]);
});
