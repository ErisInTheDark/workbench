/* No production exports. Protect parity between CLI and MCP markup checks. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { WORKBENCH_VIS_COMMANDS } from "./vis-command-definitions";

test("vis markup test sends the same request from CLI and MCP", async () => {
  const command = WORKBENCH_VIS_COMMANDS.find(entry => entry.words.join(" ") === "vis test");
  assert.ok(command);
  const context = { callerHarness: "codex", callerThreadId: "thread", cwd: ".", knownToolIds: new Set<string>(), workbenchOrigin: null, workbenchRoot: false };
  const markup = '<TrelloCard labels={[1, 3]} content="hello" />';
  assert.deepEqual(
    await command.buildRequestFromCli(["--markup", markup], context),
    await command.buildRequestFromJson({ markup }, context),
  );
  await assert.rejects(command.buildRequestFromJson({ markup: "" }, context));
});
