/*
 * No production exports. Tests protect the real streamable-HTTP edge: the credential header reaches the server,
 * calls are forwarded, and a refused credential is reported plainly instead of as a raw transport error.
 */
import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import McpServerConnection from "./McpServerConnection";

const KEY = "consumer-key";

/** A stateless MCP server that requires `x-consumer-api-key`, like Composio Connect. */
async function startServer() {
  const accepted = { key: KEY };
  const server = http.createServer((request, response) => {
    if (request.headers["x-consumer-api-key"] !== accepted.key) {
      response.writeHead(401).end("unauthorized");
      return;
    }
    const mcp = new McpServer({ name: "fake", version: "1.0.0" });
    mcp.registerTool("echo", { description: "Echo text\nback", inputSchema: { text: z.string() } },
      async ({ text }) => ({ content: [{ type: "text", text: `echo: ${text}` }] }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    response.on("close", () => { void transport.close(); void mcp.close(); });
    void mcp.connect(transport).then(() => transport.handleRequest(request, response));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    accepted,
    url: `http://127.0.0.1:${address.port}/mcp`,
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}

test("the credential header authenticates catalogue reads and forwarded calls", async () => {
  const server = await startServer();
  const connection = new McpServerConnection({ url: server.url, headers: { "x-consumer-api-key": KEY } });
  try {
    const tools = await connection.listTools();
    assert.deepEqual(tools.map(tool => [tool.name, tool.description]), [["echo", "Echo text\nback"]]);
    assert.equal((tools[0]!.inputSchema.properties as Record<string, unknown>).text !== undefined, true);
    const result = await connection.callTool("echo", { text: "hi" }, new AbortController().signal);
    assert.deepEqual(result.content, [{ type: "text", text: "echo: hi" }]);
  } finally {
    await connection.close();
    await server.close();
  }
});

test("a refused credential is reported as such, and a failed connection is not reused", async () => {
  const server = await startServer();
  const connection = new McpServerConnection({ url: server.url, headers: { "x-consumer-api-key": "rotated" } });
  try {
    await assert.rejects(connection.listTools(), /rejected the credential \(401\)/u);
    server.accepted.key = "rotated";
    assert.deepEqual((await connection.listTools()).map(tool => tool.name), ["echo"]);
  } finally {
    await connection.close();
    await server.close();
  }
});
