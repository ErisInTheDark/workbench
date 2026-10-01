/*
 * No exports. Protect scripted model-tool progress, protocol routing and disposal.
 */
import assert from "node:assert/strict";
import test from "node:test";
import FakeThreadModelServer from "./FakeThreadModelServer";

function captureRejections(context: test.TestContext) {
  const reported: string[] = [];
  context.mock.method(console, "error", (line: string) => { reported.push(line); });
  return reported;
}

test("fake Codex model emits a tool call and requires its result before advancing", async context => {
  const reported = captureRejections(context);
  const server = await FakeThreadModelServer.start();
  try {
    server.enqueue([
      { text: "before", tool: { nameSuffix: "task_get", arguments: {} } },
      { text: "after" },
    ]);
    const request = (input: object[]) => fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "fake", stream: true, tools: [{ type: "function", name: "mcp__wb__task_get" }], input }),
    });
    const first = await request([]);
    assert.equal(first.status, 200);
    const stream = await first.text();
    assert.match(stream, /response\.completed/u);
    const events = [...stream.matchAll(/^data: (.+)$/gmu)].map(match => JSON.parse(match[1]!));
    assert.equal(events.find(item => item.item?.type === "message")?.item?.phase, "commentary");
    assert.equal(events.find(item => item.type === "response.output_text.delta")?.delta, "before");
    const call = events
      .find(event => event.item?.type === "function_call");
    assert.equal(call?.item?.name, "mcp__wb__task_get");
    const missing = await request([]);
    assert.equal(missing.status, 409);
    assert.match(server.lastFailure?.message ?? "", /tool result was not observed/u);
    assert.ok(reported.some(line => /tool result was not observed/u.test(line)), "silently retried rejections must be reported");
    const next = await request([{ type: "function_call_output", call_id: call.item.call_id, output: "title" }]);
    assert.equal(next.status, 200);
    assert.match(await next.text(), /after/u);
  } finally { await server.close(); }
});

test("fake OpenCode model uses chat tool chunks and rejects unexpected requests", async context => {
  const reported = captureRejections(context);
  const server = await FakeThreadModelServer.start();
  try {
    server.enqueue([{ tool: { nameSuffix: "wb_shell", arguments: { command: "echo proof" } } }]);
    const request = () => fetch(`${server.baseUrl}/v1/chat/completions`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "fake", stream: true, tools: [{ type: "function", function: { name: "wb_shell" } }], messages: [] }),
    });
    const first = await request();
    assert.equal(first.status, 200);
    const stream = await first.text();
    assert.match(stream, /tool_calls/u);
    assert.match(stream, /wb_shell/u);
    assert.equal((await request()).status, 409);
    assert.equal(reported.length, 1);
  } finally { await server.close(); }
});

test("fake OpenCode title request does not consume the journey tool step", async () => {
  const server = await FakeThreadModelServer.start();
  try {
    server.enqueue([{ tool: { nameSuffix: "shell", arguments: { command: "echo proof" } } }]);
    const title = await fetch(`${server.baseUrl}/v1/chat/completions`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "fake", stream: true,
        messages: [{ role: "system", content: "Generate a title" }, { role: "user", content: "Scenario" }],
      }),
    });
    assert.equal(title.status, 200);
    assert.match(await title.text(), /Scenario/u);
    const journey = await fetch(`${server.baseUrl}/v1/chat/completions`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "fake", stream: true, messages: [],
        tools: [{ type: "function", function: { name: "shell" } }],
      }),
    });
    assert.equal(journey.status, 200);
    assert.match(await journey.text(), /shell/u);
  } finally { await server.close(); }
});

test("fake Codex code-mode call waits for its custom tool result", async () => {
  const server = await FakeThreadModelServer.start();
  try {
    server.enqueue([
      { tool: { nameSuffix: "exec", input: "text('proof')" } },
      { tool: { nameSuffix: "task_completed", arguments: {} } },
      { text: "finished" },
    ]);
    const request = (input: object[]) => fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-6-luna", stream: true,
        input: [{
          type: "additional_tools",
          tools: [
            { type: "namespace", name: "functions", tools: [{ type: "custom", name: "exec" }] },
            { type: "namespace", name: "mcp__wbex__", tools: [{ type: "function", name: "task_completed" }] },
          ],
        }, ...input],
      }),
    });
    const first = await request([]);
    assert.equal(first.status, 200);
    const stream = await first.text();
    const call = [...stream.matchAll(/^data: (.+)$/gmu)].map(match => JSON.parse(match[1]!))
      .find(item => item.item?.type === "custom_tool_call");
    assert.equal(call?.item?.name, "exec");
    assert.equal(call?.item?.namespace, "functions");
    assert.equal(call?.item?.input, "text('proof')");
    const next = await request([{ type: "custom_tool_call_output", call_id: call.item.call_id, output: "proof" }]);
    assert.equal(next.status, 200);
    const direct = [...(await next.text()).matchAll(/^data: (.+)$/gmu)].map(match => JSON.parse(match[1]!))
      .find(item => item.item?.type === "function_call");
    assert.equal(direct?.item?.namespace, "mcp__wbex__");
    assert.equal(direct?.item?.name, "task_completed");
    const finished = await request([{ type: "function_call_output", call_id: direct.item.call_id, output: "completed" }]);
    assert.equal(finished.status, 200);
    assert.match(await finished.text(), /finished/u);
  } finally { await server.close(); }
});

test("fake Claude Messages stream requires the matching tool result before advancing", async context => {
  const reported = captureRejections(context);
  const server = await FakeThreadModelServer.start();
  try {
    server.enqueue([
      { text: "before", tool: { nameSuffix: "shell", arguments: { command: "echo proof" } } },
      { text: "after" },
    ]);
    const request = (messages: object[]) => fetch(`${server.baseUrl}/v1/messages?beta=true`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-6", stream: true,
        tools: [{ name: "mcp__wb__shell", input_schema: { type: "object" } }],
        messages,
      }),
    });
    const first = await request([{ role: "user", content: "start" }]);
    assert.equal(first.status, 200);
    const events = [...(await first.text()).matchAll(/^data: (.+)$/gmu)]
      .map(match => JSON.parse(match[1]!));
    const start = events.find(event => event.type === "content_block_start"
      && event.content_block?.type === "tool_use");
    assert.equal(start?.content_block?.name, "mcp__wb__shell");
    assert.ok(events.some(event => event.type === "content_block_delta"
      && event.delta?.type === "input_json_delta"
      && JSON.parse(event.delta.partial_json).command === "echo proof"));
    assert.equal((await request([{ role: "user", content: "no result" }])).status, 409);
    assert.equal(reported.length, 1);
    const next = await request([{
      role: "user", content: [{
        type: "tool_result", tool_use_id: start.content_block.id, content: "proof",
      }],
    }]);
    assert.equal(next.status, 200);
    assert.match(await next.text(), /after/u);
  } finally { await server.close(); }
});
