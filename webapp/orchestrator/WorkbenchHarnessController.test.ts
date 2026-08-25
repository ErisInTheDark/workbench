/*
 * Exports:
 * - No production exports; Node tests protect harness registration, routing, and recovery. Keywords: harness, controller, recovery, test.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { WorkbenchHarness } from "../lib/types";
import type { JsonRpcRequest } from "./bridge-types";
import WorkbenchHarnessController, { type WorkbenchHarnessAdapter } from "./WorkbenchHarnessController";

function createAdapter(id: WorkbenchHarness, calls: string[] = []): WorkbenchHarnessAdapter {
  return {
    browse: {
      readThread: async (threadId) => {
        calls.push(`read:${id}:${threadId}`);
        return { thread: { id: threadId, turns: [] } } as never;
      },
      steerTurn: async (threadId, turnId) => {
        calls.push(`steer:${id}:${threadId}:${turnId}`);
        return "next-turn";
      },
    },
    browser: {
      handleBrowserMessage: async (request) => { calls.push(`browser:${id}:${request.method}`); },
    },
    id,
    internal: {
      request: async (request) => {
        calls.push(`request:${id}:${request.method}`);
        return { id: request.id ?? null, result: { id } };
      },
    },
    recovery: id === "copilot" ? { kind: "none" } : {
      kind: "turn",
      observeNotification: (notification) => { calls.push(`notification:${id}:${notification.method}`); },
      observeRequest: (request) => { calls.push(`recovery:${id}:${request.method}`); },
      resumeThread: async (threadId) => { calls.push(`resume:${id}:${threadId}`); },
    },
    serverMethods: id === "codex" ? ["thread/read", "codex/only"] : ["thread/read"],
  };
}

function createController(calls: string[] = []) {
  return new WorkbenchHarnessController([
    createAdapter("codex", calls),
    createAdapter("copilot", calls),
    createAdapter("opencode", calls),
  ]);
}

test("rejects invalid duplicate registrations and requires the default Codex adapter", () => {
  assert.throws(() => new WorkbenchHarnessController([createAdapter("copilot")]), /default Codex/u);
  assert.throws(() => new WorkbenchHarnessController([createAdapter("codex"), createAdapter("codex")]), /registered more than once/u);
  const duplicateMethods = createAdapter("codex");
  duplicateMethods.serverMethods = ["thread/read", "thread/read"];
  assert.throws(() => new WorkbenchHarnessController([duplicateMethods]), /duplicate values/u);
});

test("defaults absent browser routing to Codex and rejects explicit unknown harnesses", async () => {
  const calls: string[] = [];
  const controller = createController(calls);
  await controller.handleBrowserMessage(undefined, { id: 1, method: "thread/read" }, {} as never);
  assert.deepEqual(calls, ["recovery:codex:thread/read", "browser:codex:thread/read"]);
  assert.throws(() => controller.resolveHarness("haunted"), /Unknown Workbench harness/u);
  assert.deepEqual(controller.listHarnesses(), ["codex", "copilot", "opencode"]);
});

test("dispatches internal, server, Browse, and recovery work through the registered adapter", async () => {
  const calls: string[] = [];
  const controller = createController(calls);
  const request: JsonRpcRequest = { id: 2, method: "thread/read" };
  assert.deepEqual(await controller.requestServer("opencode", request), { id: 2, result: { id: "opencode" } });
  await controller.readThread("opencode", "thread-one");
  assert.equal(await controller.steerTurn("opencode", "thread-one", "turn-one", []), "next-turn");
  controller.observeNotification("opencode", { method: "turn/started", params: {} });
  await controller.resumeThread("opencode", "thread-one");
  await assert.rejects(() => controller.resumeThread("copilot", "thread-one"), /unavailable for copilot/u);
  await assert.rejects(() => controller.requestServer("copilot", { method: "codex/only" }), /not allowed for copilot/u);
  assert.deepEqual(calls, [
    "recovery:opencode:thread/read",
    "request:opencode:thread/read",
    "read:opencode:thread-one",
    "steer:opencode:thread-one:turn-one",
    "notification:opencode:turn/started",
    "resume:opencode:thread-one",
  ]);
});
