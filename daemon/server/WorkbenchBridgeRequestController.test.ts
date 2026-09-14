/*
 * Exports:
 * - No production exports; Node tests cover server bridge HTTP allowlisting, harness routing, malformed input, and response adaptation.
 */
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";

import type { JsonRpcRequest, JsonRpcResponse } from "./bridge-types";
import WorkbenchBridgeRequestController from "./WorkbenchBridgeRequestController";

function createRequest(body: object) {
  return Readable.from([JSON.stringify(body)]);
}

async function captureResponse(
  controller: WorkbenchBridgeRequestController,
  body: object,
) {
  let responseBody = "";
  let statusCode = 0;
  const response = {
    end(value = "") { responseBody += String(value); },
    writeHead(value: number) { statusCode = value; },
  };
  await controller.handleHttpRequest(createRequest(body) as never, response as never);
  return { body: JSON.parse(responseBody) as Record<string, unknown>, statusCode };
}

function createController(
  requestServer: (harness: unknown, request: JsonRpcRequest) => Promise<JsonRpcResponse>,
) {
  return new WorkbenchBridgeRequestController({ harnesses: { requestServer } });
}

test("routes an allowlisted method to its live harness dispatcher", async () => {
  const calls: Array<{ harness: unknown; request: JsonRpcRequest }> = [];
  const controller = createController(async (harness, request) => {
    calls.push({ harness, request });
    return { id: request.id ?? null, result: { ok: true } };
  });
  const response = await captureResponse(controller, {
    harness: "opencode",
    request: { method: "thread/name/set", params: { name: "Sparkles", threadId: "thread-1" } },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { result: { ok: true } });
  assert.equal(calls[0]?.harness, "opencode");
  assert.equal(calls[0]?.request.method, "thread/name/set");
  assert.equal(calls[0]?.request.id, 0);
});

test("rejects a valid method on a disallowed harness", async () => {
  const controller = createController(async (harness) => {
    throw new Error(`Workbench bridge method workbench/subagent/list is not allowed for ${String(harness)}.`);
  });
  const response = await captureResponse(controller, {
    harness: "copilot",
    request: { method: "workbench/subagent/list", params: {} },
  });
  assert.equal(response.statusCode, 400);
  assert.match(String(response.body.error), /not allowed for copilot/u);
});

test("rejects malformed and unlisted requests before dispatch", async () => {
  let calls = 0;
  const controller = createController(async (_harness, request) => {
    if (request.method === "account/read") {
      throw new Error("Workbench bridge method account/read is not allowed for codex.");
    }
    calls += 1;
    return { id: 0, result: {} };
  });
  const malformed = await captureResponse(controller, { harness: "codex", request: {} });
  const unlisted = await captureResponse(controller, { harness: "codex", request: { method: "account/read" } });
  assert.equal(malformed.statusCode, 400);
  assert.equal(unlisted.statusCode, 400);
  assert.equal(calls, 0);
});

test("adapts bridge errors without exposing a successful result", async () => {
  const controller = createController(async () => ({
    error: { code: -32000, message: "simulated bridge failure" },
    id: 0,
  }));
  const response = await captureResponse(controller, {
    harness: "codex",
    request: { method: "thread/context/read", params: { threadId: "thread-1" } },
  });
  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.body, { code: -32000, error: "simulated bridge failure" });
});
