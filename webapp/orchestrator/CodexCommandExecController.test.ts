/* No production exports. Tests protect Codex command execution, response validation, and exact-process cancellation. */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { JsonRpcRequest, JsonRpcResponse } from "./bridge-types";
import CodexCommandExecController from "./CodexCommandExecController";

function deferred<TValue>() {
  let resolve!: (value: TValue) => void;
  const promise = new Promise<TValue>((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
}

test("adds one process identity and returns validated command output", async () => {
  const requests: JsonRpcRequest[] = [];
  const controller = new CodexCommandExecController({
    createProcessId: () => "command-one",
    requestCodex: async (request) => {
      requests.push(request);
      return { id: null, result: { exitCode: 7, stderr: "warning\n", stdout: "output\n" } };
    },
  });

  const result = await controller.execute({
    command: ["example", "argument"],
    cwd: "C:/workspace",
    timeoutMs: 1234,
  }, new AbortController().signal);

  assert.deepEqual(result, { exitCode: 7, stderr: "warning\n", stdout: "output\n" });
  assert.deepEqual(requests, [{
    method: "command/exec",
    params: {
      command: ["example", "argument"],
      cwd: "C:/workspace",
      processId: "command-one",
      timeoutMs: 1234,
    },
  }]);
});

test("surfaces RPC and response-shape failures", async () => {
  const responses: JsonRpcResponse[] = [
    { error: { code: -32000, message: "command unavailable" }, id: null },
    { id: null, result: { exitCode: "zero", stderr: "", stdout: "" } },
  ];
  const controller = new CodexCommandExecController({
    requestCodex: async () => responses.shift()!,
  });

  await assert.rejects(
    controller.execute({ command: ["example"], cwd: "C:/workspace" }, new AbortController().signal),
    /command unavailable/u,
  );
  await assert.rejects(
    controller.execute({ command: ["example"], cwd: "C:/workspace" }, new AbortController().signal),
    /invalid response/u,
  );
});

test("terminates the exact process when the caller cancels", async () => {
  const execution = deferred<JsonRpcResponse>();
  const termination = deferred<JsonRpcRequest>();
  const errors: string[] = [];
  const controller = new CodexCommandExecController({
    createProcessId: () => "command-cancelled",
    reportError: (message) => errors.push(message),
    requestCodex: async (request) => {
      if (request.method === "command/exec/terminate") {
        termination.resolve(request);
        return { id: null, result: {} };
      }
      return await execution.promise;
    },
  });
  const abort = new AbortController();
  const response = controller.execute({ command: ["example"], cwd: "C:/workspace" }, abort.signal);

  abort.abort(new Error("caller stopped command"));
  assert.deepEqual(await termination.promise, {
    method: "command/exec/terminate",
    params: { processId: "command-cancelled" },
  });
  execution.resolve({ id: null, result: { exitCode: 0, stderr: "", stdout: "" } });
  await assert.rejects(response, /caller stopped command/u);
  assert.deepEqual(errors, []);
});

test("reports unexpected termination failures without replacing cancellation", async () => {
  const execution = deferred<JsonRpcResponse>();
  const errors: string[] = [];
  const controller = new CodexCommandExecController({
    createProcessId: () => "command-haunted",
    reportError: (message) => errors.push(message),
    requestCodex: async (request) => {
      if (request.method === "command/exec/terminate") throw new Error("terminate unavailable");
      return await execution.promise;
    },
  });
  const abort = new AbortController();
  const response = controller.execute({ command: ["example"], cwd: "C:/workspace" }, abort.signal);

  abort.abort(new Error("caller stopped command"));
  execution.resolve({ id: null, result: { exitCode: 0, stderr: "", stdout: "" } });
  await assert.rejects(response, /caller stopped command/u);
  assert.deepEqual(errors, ["failed to terminate Codex command process: terminate unavailable"]);
});
