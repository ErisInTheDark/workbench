/*
 * No production exports. Tests CLI and MCP proof submissions share validation and caller identity.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { WORKBENCH_PROOF_OF_WORK_COMMANDS } from "./proof-of-work-command-definition";

test("CLI and MCP submissions dispatch the same proof", async () => {
  const command = WORKBENCH_PROOF_OF_WORK_COMMANDS[0];
  const context = { callerHarness: "codex", callerThreadId: "thread", cwd: ".", workbenchOrigin: null, workbenchRoot: false };
  const input = { proofs: { "plan.result": "checked" }, notApplicable: ["plan.failure"], defer: ["plan.verify", "plan.other"] };
  assert.deepEqual(
    await command.buildRequestFromCli([
      "--proofs-json", JSON.stringify(input.proofs), "--not-applicable", "plan.failure", "--defer", "plan.verify", "--defer", "plan.other",
    ], context),
    await command.buildRequestFromJson(input, context),
  );
  await assert.rejects(command.buildRequestFromJson({ proofs: {} }, context));
  await assert.rejects(command.buildRequestFromCli(["--defer", "plan.result", "--not-applicable", "plan.result"], context));
});
