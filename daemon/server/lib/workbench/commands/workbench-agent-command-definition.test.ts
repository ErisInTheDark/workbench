/* No production exports. Tests protect send-time rejection of tool markup in agent-facing command input. */
import assert from "node:assert/strict";
import test from "node:test";
import { WORKBENCH_MESSAGE_COMMANDS } from "./message-command-definitions";
import type { WorkbenchAgentCommandContext } from "./workbench-agent-command-definition";

const context: WorkbenchAgentCommandContext = {
  callerHarness: "claude",
  callerThreadId: "caller",
  cwd: "/project",
  knownToolIds: new Set(["git_arc_status"]),
  workbenchOrigin: null,
  workbenchRoot: false,
};
const [messageAgent] = WORKBENCH_MESSAGE_COMMANDS;

test("agent messages naming unknown or malformed tools are rejected before any request is built", async () => {
  const input = (message: string) => ({ message, name: "larch", userVisibleSimpleVersion: "Hi." });
  await assert.rejects(messageAgent.buildRequestFromJson(input("use <tool id=\"mcp__wb__git_arc_status\" />"), context), /use "git_arc_status"/u);
  await assert.rejects(messageAgent.buildRequestFromCli(["--name", "larch", "--message", "<tool id=\"git_arc_status\">", "--user-visible-simple-version", "Hi."], context), /Malformed tool markup/u);
  const request = await messageAgent.buildRequestFromJson(input("use <tool id=\"git_arc_status\" />"), context);
  assert.equal(request.body?.message, "use <tool id=\"git_arc_status\" />");
});
