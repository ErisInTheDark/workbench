/* No production exports. Tests protect wire/native identity and authoritative argument replacement. */
import assert from "node:assert/strict";
import test from "node:test";
import OpenCodeToolStream, { type OpenCodeWireToolInput } from "./open-code-tool-stream";

test("joins Responses item ids to native call ids and keeps concurrent arguments separate", () => {
  const events: OpenCodeWireToolInput[] = [];
  const stream = new OpenCodeToolStream(input => events.push(input));
  for (const [id, call_id] of [["item-a", "call-a"], ["item-b", "call-b"]]) {
    stream.accept({ type: "response.output_item.added", item: { type: "function_call", id, call_id, name: "patch", arguments: "" } });
  }
  stream.accept({ type: "response.function_call_arguments.delta", item_id: "item-b", delta: "b" });
  stream.accept({ type: "response.function_call_arguments.delta", item_id: "item-a", delta: "a" });
  stream.accept({ type: "response.function_call_arguments.done", item_id: "item-a", arguments: "a" });
  stream.accept({ type: "response.function_call_arguments.done", item_id: "item-b", arguments: "replacement" });
  assert.deepEqual(events, [
    { kind: "start", id: "call-a", tool: "patch" }, { kind: "start", id: "call-b", tool: "patch" },
    { kind: "delta", id: "call-b", text: "b" }, { kind: "delta", id: "call-a", text: "a" },
    { kind: "replace", id: "call-b", text: "replacement" },
  ]);
});

test("buffers Chat arguments until the native id and tool name are available", () => {
  const events: OpenCodeWireToolInput[] = [];
  const stream = new OpenCodeToolStream(input => events.push(input));
  const chunk = (call: object) => ({ choices: [{ index: 0, delta: { tool_calls: [call] } }] });
  stream.accept(chunk({ index: 0, id: "native", function: { arguments: '{"path":' } }));
  assert.deepEqual(events, []);
  stream.accept(chunk({ index: 0, function: { name: "write", arguments: '"a"}' } }));
  assert.deepEqual(events, [
    { kind: "start", id: "native", tool: "write" },
    { kind: "delta", id: "native", text: '{"path":' },
    { kind: "delta", id: "native", text: '"a"}' },
  ]);
});
