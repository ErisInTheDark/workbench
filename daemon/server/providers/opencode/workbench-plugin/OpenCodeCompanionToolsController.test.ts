/* No production exports. Tests protect exact child capture and MCP connection ownership. */
import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import type { Info, ToolContext, ToolEditor } from "@opencode/plugin/promise/tool";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import OpenCodeCompanionToolsController, { connectLifecycleOwnedCompanionTools, type CompanionToolClient } from "./OpenCodeCompanionToolsController";
import WorkbenchAgentMcpController from "../../../WorkbenchAgentMcpController";
import { WorkbenchAgentMcpRequestRegistry } from "../../../workbench-agent-mcp-request-registry";
import OpenCodeToolsController from "../OpenCodeToolsController";
import { WorkbenchItemIdSchema, WorkbenchThreadIdSchema, WorkbenchTurnIdSchema } from "workbench-shared/workbench/identity";
import type { ProviderToolResult, WorkbenchToolTranscriptReference } from "workbench-shared/workbench/provider/provider-execution";

const catalogue = [{ name: "rg", inputSchema: { type: "object" as const, properties: { args: { type: "array", items: { type: "string" } } } } }];
const context = (sessionID = "managed", id = "parent") => ({ sessionID, id, messageID: "assistant" }) as ToolContext;

async function setup(connectTools: () => Promise<CompanionToolClient>) {
  const owner = new OpenCodeCompanionToolsController({
    connectTools, resolveDaemonOrigin: async () => "http://127.0.0.1:43001",
    isManagedSession: async session => session === "managed",
  });
  await owner.load();
  const tools: Info[] = [];
  owner.register({ add: tool => { tools.push(tool); } } as ToolEditor);
  return { owner, tool: tools[0]! };
}

test("decoded identical inputs retain separate child identities and exact native parents", async () => {
  const calls: Parameters<CompanionToolClient["callTool"]>[0][] = [];
  const result = { content: [{ type: "text" as const, text: "whole result" }, { type: "image" as const, data: "AA==", mimeType: "image/png" }],
    structuredContent: { matches: [1, 2] }, _meta: { retained: true } };
  const { owner, tool } = await setup(async () => ({
    listTools: async () => ({ tools: catalogue }), close: async () => undefined,
    callTool: async input => { calls.push(input); return result; },
  }));
  try {
    const input = { args: ["needle"] };
    const outputs = await Promise.all([
      tool.execute(structuredClone(input), context()), tool.execute(structuredClone(input), context()),
      tool.execute(structuredClone(input), context("managed", "other-parent")),
    ]);
    assert.deepEqual(calls.map(call => call.arguments), [input, input, input]);
    const identities = calls.map(call => call._meta!.workbenchTool as { childID: string; parentID: string; assistantMessageID: string });
    assert.equal(new Set(identities.map(identity => identity.childID)).size, 3);
    assert.deepEqual(identities.map(identity => identity.parentID), ["parent", "parent", "other-parent"]);
    assert.ok(identities.every(identity => identity.assistantMessageID === "assistant"));
    assert.ok(calls.every(call => call._meta!.sessionID === "managed"));
    assert.deepEqual(outputs.map(output => output.output), [result.structuredContent, result.structuredContent, result.structuredContent]);
    await assert.rejects(tool.execute(input, context("ordinary")), /outside managed/);
    assert.equal(calls.length, 3);
  } finally { await owner.dispose(); }
});

test("a failed transport is replaced for the next call without replaying the failed mutation", async () => {
  const calls: number[] = [];
  const closes: number[] = [];
  let connections = 0;
  const { owner, tool } = await setup(async () => {
    const connection = ++connections;
    return {
      listTools: async () => ({ tools: catalogue }),
      callTool: async () => {
        calls.push(connection);
        if (connection === 1) throw new Error("transport failed");
        return { content: [{ type: "text", text: "recovered" }] };
      },
      close: async () => { closes.push(connection); },
    };
  });
  await assert.rejects(tool.execute({}, context()), /transport failed/);
  assert.equal((await tool.execute({}, context())).content, "recovered");
  await owner.dispose();
  assert.deepEqual(calls, [1, 2]);
  assert.deepEqual(closes, [1, 2]);
});

test("MCP returned errors do not discard a healthy connection", async () => {
  let connections = 0;
  const { owner, tool } = await setup(async () => {
    connections++;
    return { listTools: async () => ({ tools: catalogue }), close: async () => undefined,
      callTool: async () => ({ content: [{ type: "text", text: "claim required" }], isError: true }) };
  });
  await assert.rejects(tool.execute({}, context()), /claim required/);
  await assert.rejects(tool.execute({}, context()), /claim required/);
  assert.equal(connections, 1);
  await owner.dispose();
});

test("MCP requests remain pending until a response or lifecycle closure", async () => {
  const sent: JSONRPCMessage[] = [];
  let onmessage: ((message: JSONRPCMessage) => void) | undefined;
  const client = await connectLifecycleOwnedCompanionTools({
    close: async () => undefined,
    send: async message => {
      sent.push(message);
      if ("method" in message && message.method === "initialize" && "id" in message) {
        queueMicrotask(() => onmessage?.({ jsonrpc: "2.0", id: message.id, result: {
          protocolVersion: "2025-11-25", capabilities: {}, serverInfo: { name: "test", version: "1" },
        } }));
      }
    },
    setProtocolVersion: () => undefined, start: async () => undefined, terminateSession: async () => undefined,
    set onmessage(listener) { onmessage = listener; },
  });
  const pending = client.callTool({ name: "request_user_input", arguments: {} });
  let settled = false;
  void pending.then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  const call = sent.find(message => "method" in message && message.method === "tools/call");
  assert.ok(call && "id" in call);
  onmessage?.({ jsonrpc: "2.0", id: call.id, result: { content: [{ type: "text", text: "answered" }] } });
  assert.equal((await pending).content[0]?.type, "text");
  const interrupted = client.callTool({ name: "request_user_input", arguments: {} });
  const rejection = assert.rejects(interrupted, /client closed/);
  await client.close();
  await rejection;
});

test("companion tool calls request progress so long waits stay alive", async () => {
  const sent: JSONRPCMessage[] = [];
  let onmessage: ((message: JSONRPCMessage) => void) | undefined;
  const client = await connectLifecycleOwnedCompanionTools({
    close: async () => undefined,
    send: async message => {
      sent.push(message);
      if ("method" in message && message.method === "initialize" && "id" in message) {
        queueMicrotask(() => onmessage?.({ jsonrpc: "2.0", id: message.id, result: {
          protocolVersion: "2025-11-25", capabilities: {}, serverInfo: { name: "test", version: "1" },
        } }));
      }
    },
    setProtocolVersion: () => undefined, start: async () => undefined, terminateSession: async () => undefined,
    set onmessage(listener) { onmessage = listener; },
  });
  const calls = [
    client.callTool({ name: "request_user_input", arguments: {} }),
    client.callTool({ name: "request_user_input", arguments: {} }),
  ];
  await Promise.resolve();
  const tokens = sent
    .filter(message => "method" in message && message.method === "tools/call")
    .map(frame => (frame as { params?: { _meta?: { progressToken?: unknown } } }).params?._meta?.progressToken);
  assert.equal(tokens.length, 2);
  assert.ok(tokens.every(token => typeof token === "string" && token.length > 0), "every call needs a progress token");
  assert.equal(new Set(tokens).size, 2, "each call needs its own progress token");
  await client.close();
  await Promise.allSettled(calls);
});

test("a send failure and transport error reject the same owned request", async () => {
  let onmessage: ((message: JSONRPCMessage) => void) | undefined;
  let onerror: ((error: Error) => void) | undefined;
  const client = await connectLifecycleOwnedCompanionTools({
    close: async () => undefined, start: async () => undefined,
    terminateSession: async () => undefined, setProtocolVersion: () => undefined,
    set onmessage(listener) { onmessage = listener; },
    set onerror(listener) { onerror = listener; },
    send: async message => {
      if (!("method" in message) || !("id" in message)) return;
      if (message.method === "initialize") {
        onmessage?.({ jsonrpc: "2.0", id: message.id, result: {
          protocolVersion: "2025-11-25", capabilities: {}, serverInfo: { name: "test", version: "1" },
        } });
      } else {
        onerror?.(new Error("connection lost"));
        throw new Error("connection lost");
      }
    },
  });
  await assert.rejects(client.callTool({ name: "rg" }), /connection lost/);
  await client.close();
});

test("companion catalogue and decoded calls cross real MCP transport with full correlated capture", async () => {
  const starts: WorkbenchToolTranscriptReference[] = [];
  const results: ProviderToolResult[] = [];
  const threadId = WorkbenchThreadIdSchema.parse("00000000-0000-4000-8000-000000000001");
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let executions = 0;
  const unused = async (): Promise<never> => { throw new Error("unexpected execution"); };
  const tools = new OpenCodeToolsController({
    resolveCaller: async session => {
      assert.equal(session, "managed");
      return { harness: "opencode", threadId, cwd: "C:/workspace" };
    },
    execute: unused, executeReadOnly: unused,
    transcript: {
      start: async (input, identity, caller) => {
        const reference = { threadId: caller.threadId, turnId: WorkbenchTurnIdSchema.parse("original-turn"), itemId: WorkbenchItemIdSchema.parse(identity.childID),
          sourceId: identity.childID, parentId: identity.parentID, tool: input.tool,
          arguments: input.arguments, startedAt: 1 };
        starts.push(reference);
        return reference;
      },
      finish: async (reference, result) => {
        assert.ok(starts.includes(reference));
        results.push(result);
      },
    },
  });
  const controller = new WorkbenchAgentMcpController({
    tools: () => tools, daemonOrigin: "http://127.0.0.1",
    requestRegistry: new WorkbenchAgentMcpRequestRegistry(),
    executeCommand: async () => {
      if (++executions === 1) { entered.resolve(); await release.promise; }
      return Response.json({ title: "captured task" });
    },
  });
  const server = http.createServer((request, response) => { void controller.handleHttpRequest(request, response); });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const createOwner = () => new OpenCodeCompanionToolsController({
    resolveDaemonOrigin: async () => `http://127.0.0.1:${address.port}`,
    isManagedSession: async id => id === "managed",
  });
  const owner = createOwner();
  const other = createOwner();
  try {
    const registered = await Promise.all([owner, other].map(async connection => {
      await connection.load();
      const catalogue: Info[] = [];
      connection.register({ add: tool => { catalogue.push(tool); } } as ToolEditor);
      const tool = catalogue.find(tool => tool.name === "task_get");
      assert.ok(tool);
      return tool;
    }));
    const first = registered[0]!.execute({}, context());
    await entered.promise;
    const second = registered[1]!.execute({}, context("managed", "other")).finally(() => release.resolve());
    const outputs = await Promise.all([first, second]);
    assert.deepEqual(starts.map(start => start.parentId).sort(), ["other", "parent"]);
    assert.equal(new Set(starts.map(start => start.sourceId)).size, 2);
    assert.equal(results.length, 2);
    assert.ok(results.every(result => result.content.some(part => part && typeof part === "object" && !Array.isArray(part)
      && part.type === "text" && typeof part.text === "string" && part.text.includes("captured task"))));
    assert.ok(outputs.every(output => typeof output.content === "string" && output.content.includes("captured task")));
  } finally {
    release.resolve();
    await Promise.all([owner.dispose(), other.dispose()]);
    controller.releaseRuntimeOwner();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
