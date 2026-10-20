/* No production exports. Tests protect when Claude's plain assistant text earns the commentary hint. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import ClaudeCommentaryNudge, { CLAUDE_COMMENTARY_HINT } from "./ClaudeCommentaryNudge";

type Block = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: object };

const assistant = (content: Block[], parent: string | null = null) => ({
  type: "assistant", parent_tool_use_id: parent, message: { content },
}) as unknown as SDKMessage;
const toolUse: Block = { type: "tool_use", id: "toolu_1", name: "mcp__wb__rg", input: {} };

test("visible plain text before a tool batch earns one hint after that batch", () => {
  const nudge = new ClaudeCommentaryNudge();
  nudge.observe(assistant([{ type: "text", text: "Let me check the cache." }, toolUse]));
  assert.equal(nudge.afterToolBatch(), CLAUDE_COMMENTARY_HINT);
  assert.equal(nudge.afterToolBatch(), null);
});

test("tool-only, blank, turn-end and subagent text earn no mid-turn hint", () => {
  const nudge = new ClaudeCommentaryNudge();
  nudge.observe(assistant([toolUse]));
  nudge.observe(assistant([{ type: "text", text: "  \n" }, toolUse]));
  nudge.observe(assistant([{ type: "text", text: "<wb:end />" }]));
  nudge.observe(assistant([{ type: "text", text: "child prose" }], "toolu_parent"));
  nudge.observe({ type: "user", parent_tool_use_id: null, message: { content: "Let me check." } } as unknown as SDKMessage);
  assert.equal(nudge.afterToolBatch(), null);
});

test("a stop after visible text hints, but only the turn-end marker or nothing stops quietly", () => {
  const nudge = new ClaudeCommentaryNudge();
  assert.equal(nudge.beforeStop("<wb:end />"), null);
  assert.equal(nudge.beforeStop(" <wb:end />\n"), null);
  assert.equal(nudge.beforeStop(""), null);
  assert.equal(nudge.beforeStop(undefined), null);
  assert.equal(nudge.beforeStop("All done!\n\n<wb:end />"), CLAUDE_COMMENTARY_HINT);
});

test("two stops in a row are never both hinted, so a model ignoring the hint still ends", () => {
  const nudge = new ClaudeCommentaryNudge();
  assert.equal(nudge.beforeStop("Done."), CLAUDE_COMMENTARY_HINT);
  assert.equal(nudge.beforeStop("Done, really."), null);
  assert.equal(nudge.beforeStop("<wb:end />"), null);
  assert.equal(nudge.beforeStop("Later prose."), CLAUDE_COMMENTARY_HINT, "a quiet stop re-arms the hint");
});

test("a stop owns the final text, so it is not hinted again after the continuation's first batch", () => {
  const nudge = new ClaudeCommentaryNudge();
  nudge.observe(assistant([{ type: "text", text: "Done." }]));
  assert.equal(nudge.beforeStop("Done."), CLAUDE_COMMENTARY_HINT);
  assert.equal(nudge.afterToolBatch(), null);
});
