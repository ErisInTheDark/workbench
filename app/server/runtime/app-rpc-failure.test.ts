/*
 * Exports: none. Behaviour tests for the failure a browser receives, including errors from another reload generation.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { WORKSPACE_COMMAND_NOT_SENT, WORKSPACE_COMMAND_UNCERTAIN } from "workbench-shared/workbench/workspace/workspace-commands";
import { readAppRpcFailure } from "./app-rpc-failure.ts";

class OtherGenerationInterruptedError extends Error {
  override readonly name = "WorkbenchRpcRequestInterruptedError";
  constructor(readonly dispatched: boolean) { super("interrupted"); }
}

class OtherGenerationDaemonError extends Error {
  override readonly name = "WorkbenchDaemonRequestError";
  constructor(readonly code: number, readonly data: object | null) { super("daemon failure"); }
}

test("errors from another reload generation keep their dispatch outcome, code and data", () => {
  assert.deepEqual(readAppRpcFailure(new OtherGenerationInterruptedError(false)), { code: WORKSPACE_COMMAND_NOT_SENT });
  assert.deepEqual(readAppRpcFailure(new OtherGenerationInterruptedError(true)), { code: WORKSPACE_COMMAND_UNCERTAIN });
  assert.deepEqual(readAppRpcFailure(new OtherGenerationDaemonError(-32042, { reason: "busy" })), { code: -32042, data: { reason: "busy" } });
});

test("other failures use the generic code", () => {
  assert.deepEqual(readAppRpcFailure(new Error("unexpected")), { code: -32000 });
});
