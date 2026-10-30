/*
 * No production exports. Tests protect live and reread agreement on how OpenCode tool parts are recorded.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { openCodeToolKind, recordedOpenCodeToolKind, type OpenCodeToolStatus } from "./open-code-tool-kind";
import { OPENCODE_COMMENTARY_TOOL_NAME, OPENCODE_END_TURN_TOOL_NAME } from "./opencode-workbench-rpc";

const settled: OpenCodeToolStatus[] = ["completed", "error"];

test("rereads classify every part live ingest can record the way live recorded it", () => {
  for (const name of [OPENCODE_COMMENTARY_TOOL_NAME, OPENCODE_END_TURN_TOOL_NAME, "wb_shell", "edit", "mcp__other__tool"]) {
    for (const status of settled) assert.equal(recordedOpenCodeToolKind(name, status), openCodeToolKind(name), `${name} ${status}`);
  }
  // Post-rename sessions refuse the legacy name, so live records only its failure.
  assert.equal(openCodeToolKind("mcp__user__message"), "tool");
  assert.equal(recordedOpenCodeToolKind("mcp__user__message", "error"), "tool");
});

test("pre-rename legacy commentary still rereads as commentary", () => {
  assert.equal(recordedOpenCodeToolKind("mcp__user__message", "completed"), "commentary");
});
