/*
 * Exports:
 * - No production exports; Node tests cover safe Codex ripgrep arguments, no-match success, real failures, and cancellation. Keywords: ripgrep, search, Codex, cancellation, test.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { JsonRpcRequest, JsonRpcResponse } from "./bridge-types";
import WorkbenchRipgrepController from "./WorkbenchRipgrepController";

function deferred<TValue>() {
  let resolve!: (value: TValue) => void;
  const promise = new Promise<TValue>((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
}

function processResponse(exitCode: number, stdout = "", stderr = ""): JsonRpcResponse {
  return { id: null, result: { exitCode, stderr, stdout } };
}

test("preserves native arguments and treats matches and no matches as success", async () => {
  const requests: JsonRpcRequest[] = [];
  const results = [
    processResponse(0, "match\n", "warning\n"),
    processResponse(1),
  ];
  const processIds = ["rg-one", "rg-two"];
  const controller = new WorkbenchRipgrepController({
    createProcessId: () => processIds.shift()!,
    requestCodex: async (request) => {
      requests.push(request);
      return results.shift()!;
    },
  });
  const input = { args: ["--no-heading", "-n", "a pattern with 'quotes'", "webapp"], cwd: "C:/workspace" };

  const matched = await controller.execute(input, new AbortController().signal);
  assert.equal(matched.status, 200);
  assert.equal(await matched.text(), "match\nwarning\n");
  const unmatched = await controller.execute(input, new AbortController().signal);
  assert.equal(unmatched.status, 200);
  assert.equal(await unmatched.text(), "");
  assert.deepEqual(requests, [
    {
      method: "command/exec",
      params: {
        command: ["rg", "--no-config", "--heading", ...input.args],
        cwd: input.cwd,
        disableTimeout: true,
        env: { RIPGREP_CONFIG_PATH: null },
        processId: "rg-one",
        sandboxPolicy: { type: "dangerFullAccess" },
      },
    },
    {
      method: "command/exec",
      params: {
        command: ["rg", "--no-config", "--heading", ...input.args],
        cwd: input.cwd,
        disableTimeout: true,
        env: { RIPGREP_CONFIG_PATH: null },
        processId: "rg-two",
        sandboxPolicy: { type: "dangerFullAccess" },
      },
    },
  ]);
});

test("rejects process-launching arguments and preserves real ripgrep failures", async () => {
  let executionCount = 0;
  const controller = new WorkbenchRipgrepController({
    createProcessId: () => "rg-failure",
    requestCodex: async () => {
      executionCount += 1;
      return processResponse(2, "", "invalid regex\n");
    },
  });

  for (const argument of ["--pre=convert", "--hostname-bin", "--hostname-bin=hostname"]) {
    const response = await controller.execute({ args: [argument, "needle"], cwd: "C:/workspace" }, new AbortController().signal);
    assert.equal(response.status, 400);
  }
  assert.equal(executionCount, 0);

  const failed = await controller.execute({ args: ["["], cwd: "C:/workspace" }, new AbortController().signal);
  assert.equal(failed.status, 400);
  assert.equal(await failed.text(), "invalid regex\n");
  assert.equal(executionCount, 1);
});

test("surfaces Codex RPC and response-shape failures", async () => {
  const responses: JsonRpcResponse[] = [
    { error: { code: -32000, message: "command unavailable" }, id: null },
    { id: null, result: { exitCode: "zero", stderr: "", stdout: "" } },
  ];
  const controller = new WorkbenchRipgrepController({
    createProcessId: () => "rg-invalid",
    requestCodex: async () => responses.shift()!,
  });

  const unavailable = await controller.execute({ args: ["needle"], cwd: "C:/workspace" }, new AbortController().signal);
  assert.equal(unavailable.status, 400);
  assert.equal(await unavailable.text(), "Ripgrep could not run: command unavailable\n");
  const invalid = await controller.execute({ args: ["needle"], cwd: "C:/workspace" }, new AbortController().signal);
  assert.equal(invalid.status, 400);
  assert.equal(await invalid.text(), "Ripgrep could not run: Codex command/exec returned an invalid ripgrep response.\n");
});

test("terminates the exact Codex process when the caller cancels", async () => {
  const execution = deferred<JsonRpcResponse>();
  const termination = deferred<JsonRpcRequest>();
  const controller = new WorkbenchRipgrepController({
    createProcessId: () => "rg-cancelled",
    requestCodex: async (request) => {
      if (request.method === "command/exec/terminate") {
        termination.resolve(request);
        return { id: null, result: {} };
      }
      return await execution.promise;
    },
  });
  const abort = new AbortController();
  const response = controller.execute({ args: ["needle"], cwd: "C:/workspace" }, abort.signal);

  abort.abort(new Error("caller stopped search"));
  assert.deepEqual(await termination.promise, {
    method: "command/exec/terminate",
    params: { processId: "rg-cancelled" },
  });
  execution.resolve(processResponse(1));
  await assert.rejects(response, /caller stopped search/u);
});

test("reports an unexpected Codex termination failure", async () => {
  const execution = deferred<JsonRpcResponse>();
  const errors: string[] = [];
  const controller = new WorkbenchRipgrepController({
    createProcessId: () => "rg-haunted",
    reportError: (message) => errors.push(message),
    requestCodex: async (request) => {
      if (request.method === "command/exec/terminate") throw new Error("terminate unavailable");
      return await execution.promise;
    },
  });
  const abort = new AbortController();
  const response = controller.execute({ args: ["needle"], cwd: "C:/workspace" }, abort.signal);

  abort.abort(new Error("caller stopped search"));
  execution.resolve(processResponse(1));
  await assert.rejects(response, /caller stopped search/u);
  assert.deepEqual(errors, ["failed to terminate Codex ripgrep process: terminate unavailable"]);
});
