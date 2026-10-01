/* No production exports. Tests protect which open block may be cut on each supported model wire. */
import assert from "node:assert/strict";
import test from "node:test";
import { openCodeStreamCutTracker } from "./open-code-stream-cut";

function terminatorFrames(text: string) {
  return text.split(/\n\n/u).filter(Boolean).map(event => event.split("\n").find(line => line.startsWith("data: "))!.slice(6))
    .filter(data => data !== "[DONE]").map(data => JSON.parse(data) as Record<string, unknown>);
}

test("anthropic thinking is cuttable only while it is the open block, including after earlier blocks", () => {
  const tracker = openCodeStreamCutTracker({ type: "message_start", message: { type: "message", content: [] } })!;
  assert.equal(tracker.wire, "anthropic-messages");
  tracker.observe({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } });
  tracker.observe({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } });
  assert.equal(tracker.cuttable, true);
  tracker.observe({ type: "content_block_stop", index: 0 });
  tracker.observe({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "t", name: "x", input: {} } });
  assert.equal(tracker.cuttable, false, "an open tool block must finish");
  tracker.observe({ type: "content_block_stop", index: 1 });
  tracker.observe({ type: "content_block_start", index: 2, content_block: { type: "thinking", thinking: "" } });
  assert.equal(tracker.cuttable, true, "interleaved thinking after a finished tool call is cuttable");
  const [delta, stop] = terminatorFrames(tracker.terminator());
  assert.equal((delta!.delta as { stop_reason: string }).stop_reason, "tool_use");
  assert.equal(stop!.type, "message_stop");
  tracker.observe({ type: "message_delta", delta: { stop_reason: "end_turn" } });
  assert.equal(tracker.cuttable, false, "a finished response is never cut");
});

test("openai chat reasoning is cuttable until content, tools, or a finish arrive", () => {
  const tracker = openCodeStreamCutTracker({
    id: "chatcmpl", object: "chat.completion.chunk", model: "m", choices: [{ index: 0, delta: { role: "assistant" } }],
  })!;
  assert.equal(tracker.wire, "openai-chat");
  assert.equal(tracker.cuttable, false, "nothing is reasoning yet");
  tracker.observe({ choices: [{ index: 0, delta: { reasoning_content: "hmm" } }] });
  assert.equal(tracker.cuttable, true);
  assert.equal((terminatorFrames(tracker.terminator())[0]!.choices as Array<{ finish_reason: string }>)[0]!.finish_reason, "stop");
  tracker.observe({ choices: [{ index: 0, delta: { content: "Answer" } }] });
  assert.equal(tracker.cuttable, false);
  tracker.observe({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "c", function: { name: "x", arguments: "{}" } }] } }] });
  tracker.observe({ choices: [{ index: 0, delta: { reasoning_content: "more" } }] });
  assert.equal(tracker.cuttable, true);
  assert.equal((terminatorFrames(tracker.terminator())[0]!.choices as Array<{ finish_reason: string }>)[0]!.finish_reason, "tool_calls");
  tracker.observe({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
  assert.equal(tracker.cuttable, false);
});

test("gemini thought parts are cuttable until a visible part or finish arrives", () => {
  const tracker = openCodeStreamCutTracker({ candidates: [{ content: { role: "model", parts: [{ text: "plan", thought: true }] } }] })!;
  assert.equal(tracker.wire, "gemini");
  assert.equal(tracker.cuttable, true);
  assert.equal((terminatorFrames(tracker.terminator())[0]!.candidates as Array<{ finishReason: string }>)[0]!.finishReason, "STOP");
  tracker.observe({ candidates: [{ content: { role: "model", parts: [{ text: "Answer" }] } }] });
  assert.equal(tracker.cuttable, false);
  tracker.observe({ candidates: [{ content: { role: "model", parts: [{ text: "again", thought: true }] }, finishReason: "STOP" }] });
  assert.equal(tracker.cuttable, false);
});

test("unsupported wires are never tracked", () => {
  assert.equal(openCodeStreamCutTracker({ type: "response.created", response: { id: "resp" } }), null);
  assert.equal(openCodeStreamCutTracker({ type: "ping" }), null);
});
