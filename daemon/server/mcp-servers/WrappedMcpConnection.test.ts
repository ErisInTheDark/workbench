/*
 * No production exports. Protects that ordinary servers pass through untouched while recognised wrappers hide their
 * meta tools and route calls through one lasting session.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServerConnectionPort, McpServerTool } from "./McpServerConnection";
import WrappedMcpConnection from "./WrappedMcpConnection";
import type { McpWrapper } from "./wrappers/mcp-wrapper";

const tool = (name: string): McpServerTool => ({ name, description: name, inputSchema: { type: "object" } });
const signal = () => new AbortController().signal;
const ran = (name: string): CallToolResult => ({ content: [{ type: "text", text: `ran ${name}` }] });

function inner(tools: McpServerTool[]) {
  const calls: string[] = [];
  const port: McpServerConnectionPort = {
    listTools: async () => tools,
    serverName: async () => null,
    callTool: async name => { calls.push(name); return ran(name); },
    close: async () => {},
  };
  return { port, calls };
}

let opened = 0;
const wrapper: McpWrapper = {
  id: "meta",
  detect: tools => tools.some(entry => entry.name === "META_EXECUTE"),
  open: raw => {
    opened += 1;
    return {
      search: async () => [tool("INNER")],
      describe: async names => names.map(tool),
      call: async (name, args, abort) => raw("META_EXECUTE", { name, args }, abort),
    };
  },
};

test("a server that is no known wrapper passes through untouched", async () => {
  const { port, calls } = inner([tool("SEARCH")]);
  const connection = new WrappedMcpConnection(port, [wrapper]);
  assert.deepEqual((await connection.listTools()).map(entry => entry.name), ["SEARCH"]);
  assert.equal(await connection.wrapped(), null);
  await connection.callTool("SEARCH", {}, signal());
  assert.deepEqual(calls, ["SEARCH"]);
});

test("a wrapper's meta tools are hidden and its inner tools are called through one session", async () => {
  opened = 0;
  const { port, calls } = inner([tool("META_EXECUTE")]);
  const connection = new WrappedMcpConnection(port, [wrapper]);
  assert.deepEqual(await connection.listTools(), []);
  assert.deepEqual((await (await connection.wrapped())!.search("x", signal())).map(entry => entry.name), ["INNER"]);
  await connection.callTool("INNER", {}, signal());
  await connection.callTool("INNER", {}, signal());
  assert.deepEqual(calls, ["META_EXECUTE", "META_EXECUTE"]);
  assert.equal(opened, 1, "catalogue re-reads keep the same session");
});
