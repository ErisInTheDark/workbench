/*
 * No production exports. Tests CLI and MCP proof submissions share validation.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { WORKBENCH_PROOF_OF_WORK_COMMANDS } from "./proof-of-work-command-definition";

test("CLI and MCP submissions dispatch the same proof", async () => {
  const command = WORKBENCH_PROOF_OF_WORK_COMMANDS[0];
  const context = { callerHarness: "codex", callerThreadId: "thread", cwd: ".", workbenchOrigin: null, workbenchRoot: false };
  const input = { proofs: { "plan.result": "checked", "plan.failure": "not applicable" } };
  assert.deepEqual(
    await command.buildRequestFromCli(["--proofs-json", JSON.stringify(input.proofs)], context),
    await command.buildRequestFromJson(input, context),
  );
  await assert.rejects(command.buildRequestFromJson({ proofs: {} }, context));
});
