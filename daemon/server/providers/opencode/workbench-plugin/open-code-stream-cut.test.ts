/* No production exports. Tests protect block tracking and bare-text detection on each supported model wire. */
import assert from "node:assert/strict";
import test from "node:test";
import { openCodeStreamCutTracker } from "./open-code-stream-cut";

function terminatorFrames(text: string) {
  return text.split(/\n\n/u).filter(Boolean).map(event => event.split("\n").find(line => line.startsWith("data: "))!.slice(6))
    .filter(data => data !== "[DONE]").map(data => JSON.parse(data) as Record<string, unknown>);
}

function track(first: Record<string, unknown>) {
  const tracker = openCodeStreamCutTracker(first)!;
  tracker.observe(first);
  return tracker;
}

test("anthropic thinking is open only while it is the open block, including after earlier blocks", () => {
  const tracker = track({ type: "message_start", message: { type: "message", content: [] } });
  assert.equal(tracker.wire, "anthropic-messages");
  tracker.observe({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } });
  tracker.observe({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } });
  assert.equal(tracker.reasoningOpen, true);
  tracker.observe({ type: "content_block_stop", index: 0 });
  tracker.observe({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "t", name: "x", input: {} } });
  assert.equal(tracker.reasoningOpen, false, "an open tool block must finish");
  tracker.observe({ type: "content_block_stop", index: 1 });
  tracker.observe({ type: "content_block_start", index: 2, content_block: { type: "thinking", thinking: "" } });
  assert.equal(tracker.reasoningOpen, true, "interleaved thinking after a finished tool call is open");
  const [delta, stop] = terminatorFrames(tracker.terminator());
  assert.equal((delta!.delta as { stop_reason: string }).stop_reason, "tool_use");
  assert.equal(stop!.type, "message_stop");
  tracker.observe({ type: "message_delta", delta: { stop_reason: "end_turn" } });
  assert.equal(tracker.reasoningOpen, false, "a finished response is never cut");
});

test("anthropic text blocks report their text while thinking and tool input report none", () => {
  const tracker = track({ type: "message_start", message: { type: "message", content: [] } });
  assert.equal(tracker.text({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }), "");
  assert.equal(tracker.text({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } }), "Hi");
  assert.equal(tracker.text({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } }), null);
  assert.equal(tracker.text({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"text\":\"x\"}" } }), null);
  assert.equal(tracker.text({ type: "content_block_stop", index: 0 }), null);
});

test("openai chat reasoning is open until content, tools, or a finish arrive", () => {
  const tracker = track({
    id: "chatcmpl", object: "chat.completion.chunk", model: "m", choices: [{ index: 0, delta: { role: "assistant" } }],
  });
  assert.equal(tracker.wire, "openai-chat");
  assert.equal(tracker.reasoningOpen, false, "nothing is reasoning yet");
  tracker.observe({ choices: [{ index: 0, delta: { reasoning_content: "hmm" } }] });
  assert.equal(tracker.reasoningOpen, true);
  assert.equal((terminatorFrames(tracker.terminator())[0]!.choices as Array<{ finish_reason: string }>)[0]!.finish_reason, "stop");
  tracker.observe({ choices: [{ index: 0, delta: { content: "Answer" } }] });
  assert.equal(tracker.reasoningOpen, false);
  tracker.observe({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "c", function: { name: "x", arguments: "{}" } }] } }] });
  tracker.observe({ choices: [{ index: 0, delta: { reasoning_content: "more" } }] });
  assert.equal(tracker.reasoningOpen, true);
  assert.equal((terminatorFrames(tracker.terminator())[0]!.choices as Array<{ finish_reason: string }>)[0]!.finish_reason, "tool_calls");
  tracker.observe({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
  assert.equal(tracker.reasoningOpen, false);
});

test("openai chat content is bare text but empty openers, reasoning and tool calls are not", () => {
  const tracker = track({ id: "chatcmpl", object: "chat.completion.chunk", model: "m", choices: [{ index: 0, delta: { role: "assistant" } }] });
  assert.equal(tracker.text({ choices: [{ index: 0, delta: { role: "assistant", content: "" } }] }), null);
  assert.equal(tracker.text({ choices: [{ index: 0, delta: { content: "Hi" } }] }), "Hi");
  assert.equal(tracker.text({ choices: [{ index: 0, delta: { reasoning_content: "hmm" } }] }), null);
  assert.equal(tracker.text({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "{}" } }] } }] }), null);
});

test("gemini thought parts are open until a visible part or finish arrives", () => {
  const tracker = track({ candidates: [{ content: { role: "model", parts: [{ text: "plan", thought: true }] } }] });
  assert.equal(tracker.wire, "gemini");
  assert.equal(tracker.reasoningOpen, true);
  assert.equal((terminatorFrames(tracker.terminator())[0]!.candidates as Array<{ finishReason: string }>)[0]!.finishReason, "STOP");
  tracker.observe({ candidates: [{ content: { role: "model", parts: [{ text: "Answer" }] } }] });
  assert.equal(tracker.reasoningOpen, false);
  tracker.observe({ candidates: [{ content: { role: "model", parts: [{ text: "again", thought: true }] }, finishReason: "STOP" }] });
  assert.equal(tracker.reasoningOpen, false);
});

test("gemini visible text parts are bare text but thoughts and calls are not", () => {
  const tracker = track({ candidates: [{ content: { role: "model", parts: [{ text: "plan", thought: true }] } }] });
  assert.equal(tracker.text({ candidates: [{ content: { parts: [{ text: "Hi" }] } }] }), "Hi");
  assert.equal(tracker.text({ candidates: [{ content: { parts: [{ text: "plan", thought: true }] } }] }), null);
  assert.equal(tracker.text({ candidates: [{ content: { parts: [{ functionCall: { name: "x", args: {} } }] } }] }), null);
});

test("unsupported wires are never tracked", () => {
  assert.equal(openCodeStreamCutTracker({ type: "response.created", response: { id: "resp" } }), null);
  assert.equal(openCodeStreamCutTracker({ type: "ping" }), null);
});
