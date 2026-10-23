/* No production exports. Tests protect that every command's input lists as a real MCP object schema. */
import assert from "node:assert/strict";
import test from "node:test";

import { normalizeObjectSchema } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { listWorkbenchAgentCommands } from "./workbench-agent-command-registry";

test("every command input reduces to an object schema, so no tool silently lists as taking no arguments", () => {
  const unlisted = listWorkbenchAgentCommands([], "agent", { virtualRepos: true })
    .filter(command => !normalizeObjectSchema(command.inputSchema))
    .map(command => command.words.join(" "));
  assert.deepEqual(unlisted, []);
});
