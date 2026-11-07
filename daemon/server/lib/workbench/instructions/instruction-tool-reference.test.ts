/* No production exports. Tests protect each provider's tool reference route and agent message rendering into it. */
import assert from "node:assert/strict";
import test from "node:test";
import {
  renderWorkbenchToolReferences,
  resolveWorkbenchToolReference,
  type WorkbenchInstructionTool,
} from "./instruction-tool-reference";

const catalogue: WorkbenchInstructionTool[] = [
  { id: "rg", codeModeEligible: true },
  { id: "git_arc_release", codeModeEligible: false },
  { id: "mcp_call", codeModeEligible: true },
  { id: "git_arc_edit_start", codeModeEligible: false, deferred: true },
  { id: "debug_socket", codeModeEligible: false, deferred: true, cliCommand: "wb debug socket" },
];

test("registered tool references follow each provider's real MCP route", () => {
  assert.deepEqual(resolveWorkbenchToolReference("rg", "codex", catalogue), { name: "tools.mcp__wb__rg", invocation: "call" });
  assert.deepEqual(resolveWorkbenchToolReference("git_arc_release", "codex", catalogue), { name: "tools.mcp__wbex__git_arc_release", invocation: "call" });
  assert.deepEqual(resolveWorkbenchToolReference("rg", "opencode", catalogue), { name: "tools.wb.rg", invocation: "call" });
  assert.deepEqual(resolveWorkbenchToolReference("git_arc_release", "opencode", catalogue), { name: "wbex_git_arc_release", invocation: "tool" });
  assert.deepEqual(resolveWorkbenchToolReference("rg", "claude", catalogue), { name: "mcp__wb__rg", invocation: "tool" });
  assert.equal(resolveWorkbenchToolReference("git_arc_edit_start", "claude", catalogue), null);
  assert.equal(resolveWorkbenchToolReference("not_a_tool", "codex", catalogue), null);
});

test("agent message references render as the recipient's own call, with args", () => {
  const text = "<tool id=\"rg\" args='{\"args\":[\"x\"]}' /> and <tool id=\"git_arc_release\" />";
  assert.equal(renderWorkbenchToolReferences(text, "claude", catalogue), "`mcp__wb__rg` with `{\"args\":[\"x\"]}` and `mcp__wb__git_arc_release`");
  assert.equal(renderWorkbenchToolReferences(text, "codex", catalogue), "`tools.mcp__wb__rg({\"args\":[\"x\"]})` and `tools.mcp__wbex__git_arc_release`");
  assert.equal(renderWorkbenchToolReferences(text, "opencode", catalogue), "`tools.wb.rg({\"args\":[\"x\"]})` and `wbex_git_arc_release`");
});

test("deferred tools render through mcp_call and CLI-only tools as their wb command", () => {
  assert.equal(
    renderWorkbenchToolReferences("<tool id=\"git_arc_edit_start\" args='{\"paths\":[\"a\"]}' />", "opencode", catalogue),
    "`tools.wb.mcp_call({\"server\":\"wb\",\"tool\":\"git_arc_edit_start\",\"arguments\":{\"paths\":[\"a\"]}})`",
  );
  assert.equal(
    renderWorkbenchToolReferences("<tool id=\"git_arc_edit_start\" />", "claude", catalogue),
    "`mcp__wb__mcp_call` with `{\"server\":\"wb\",\"tool\":\"git_arc_edit_start\"}`",
  );
  assert.equal(renderWorkbenchToolReferences("<tool id=\"debug_socket\" />", "codex", catalogue), "`wb debug socket`");
});

test("tools the recipient cannot see stay named, and examples stay literal", () => {
  assert.equal(renderWorkbenchToolReferences("<tool id=\"subagent_create\" />", "claude", catalogue), "`subagent_create` (unavailable to you)");
  assert.equal(
    renderWorkbenchToolReferences("<tool id=\"git_arc_edit_start\" />", "claude", catalogue.filter(tool => tool.id !== "mcp_call")),
    "`git_arc_edit_start` (unavailable to you)",
  );
  assert.equal(renderWorkbenchToolReferences("`<tool id=\"rg\" />`", "claude", catalogue), "`<tool id=\"rg\" />`");
});
