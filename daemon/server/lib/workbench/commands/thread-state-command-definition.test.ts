/*
 * No production exports. Tests CLI and MCP thread_state calls dispatch the same request.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { WORKBENCH_THREAD_STATE_COMMANDS } from "./thread-state-command-definition";

test("CLI and MCP calls dispatch the same thread state change", async () => {
  const command = WORKBENCH_THREAD_STATE_COMMANDS[0];
  const context = { callerHarness: "codex", callerThreadId: "thread", cwd: ".", workbenchOrigin: null, workbenchRoot: false };
  const input = {
    proofs: { "review.coverage": "checked" }, notApplicable: ["review.extra"],
    mode: "Review", status: "completed" as const, alwaysEditable: [],
  };
  assert.deepEqual(
    await command.buildRequestFromCli([
      "--proofs-json", JSON.stringify(input.proofs), "--not-applicable", "review.extra",
      "--mode", "Review", "--status", "completed", "--clear-always-editable",
    ], context),
    await command.buildRequestFromJson(input, context),
  );
  await assert.rejects(command.buildRequestFromCli(["--status", "done"], context));
});
