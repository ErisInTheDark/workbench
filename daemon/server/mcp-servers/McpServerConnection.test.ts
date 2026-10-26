/*
 * No production exports. Tests protect the real streamable-HTTP edge: the credential header reaches the server,
 * calls are forwarded, recorded traffic holds the exact replies, and a refused credential is reported plainly instead of as a raw transport error;
 * and the real stdio edge: launch arguments reach the process, and a crashed process is explained by its own stderr.
 */
import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
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
    mcp.registerTool("authorize", { description: "Needs a sign-in" },
      async () => ({ content: [{ type: "text", text: "Click the link." }], _meta: { authorization_url: "https://example.test/authorize" }, isError: true }));
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
  const connection = new McpServerConnection({ transport: "http", url: server.url, headers: { "x-consumer-api-key": KEY } });
  try {
    const tools = await connection.listTools();
    assert.deepEqual(tools.map(tool => tool.name), ["echo", "authorize"]);
    assert.equal(tools[0]!.description, "Echo text\nback");
    assert.equal((tools[0]!.inputSchema.properties as Record<string, unknown>).text !== undefined, true);
    const result = await connection.callTool("echo", { text: "hi" }, new AbortController().signal);
    assert.deepEqual(result.content, [{ type: "text", text: "echo: hi" }]);
  } finally {
    await connection.close();
    await server.close();
  }
});

test("recorded traffic keeps the exact server replies, including fields the result text never shows", async () => {
  const server = await startServer();
  const frames: { direction: "in" | "out"; label: string; payload: string }[] = [];
  const connection = new McpServerConnection({ transport: "http", url: server.url, headers: { "x-consumer-api-key": KEY }, record: frame => frames.push(frame) });
  try {
    await connection.callTool("authorize", {}, new AbortController().signal);
    assert.ok(frames.some(frame => frame.direction === "out" && frame.label === "initialize"));
    assert.ok(frames.some(frame => frame.direction === "in" && frame.label === "result" && frame.payload.includes("\"serverInfo\"")));
    assert.ok(frames.some(frame => frame.direction === "out" && frame.label === "tools/call" && frame.payload.includes("\"authorize\"")));
    const reply = frames.find(frame => frame.direction === "in" && frame.payload.includes("authorization_url"));
    assert.equal(JSON.parse(reply!.payload).result._meta.authorization_url, "https://example.test/authorize");
  } finally {
    await connection.close();
    await server.close();
  }
});

/** A stateless server whose tool list can change between requests; `promise` decides whether it declares `tools.listChanged`. */
async function startChangingServer(promise: boolean) {
  const names = ["first"];
  const server = http.createServer((request, response) => {
    const mcp = new Server({ name: "changing", version: "1.0.0" }, { capabilities: { tools: promise ? { listChanged: true } : {} } });
    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: names.map(name => ({ name, description: name, inputSchema: { type: "object" as const } })),
    }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    response.on("close", () => { void transport.close(); void mcp.close(); });
    void mcp.connect(transport).then(() => transport.handleRequest(request, response));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    names,
    url: `http://127.0.0.1:${address.port}/mcp`,
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}

test("a server that never promises change notifications has its tool list re-read once it is 30 seconds old", async () => {
  const server = await startChangingServer(false);
  let now = 0;
  const connection = new McpServerConnection({ transport: "http", url: server.url, headers: {} }, { now: () => now });
  try {
    assert.deepEqual((await connection.listTools()).map(tool => tool.name), ["first"]);
    server.names.push("added");
    now = 29_999;
    assert.deepEqual((await connection.listTools()).map(tool => tool.name), ["first"], "a burst of uses shares one read");
    now = 30_000;
    assert.deepEqual((await connection.listTools()).map(tool => tool.name), ["first", "added"]);
  } finally {
    await connection.close();
    await server.close();
  }
});

test("a server that promises change notifications keeps its tool list until it reports a change", async () => {
  const server = await startChangingServer(true);
  let now = 0;
  const connection = new McpServerConnection({ transport: "http", url: server.url, headers: {} }, { now: () => now });
  try {
    await connection.listTools();
    server.names.push("added");
    now = 10 * 60_000;
    assert.deepEqual((await connection.listTools()).map(tool => tool.name), ["first"]);
  } finally {
    await connection.close();
    await server.close();
  }
});

test("a URL that is not an MCP server reports its HTTP status, not its page body", async () => {
  const server = http.createServer((_request, response) => {
    response.writeHead(404, { "Content-Type": "text/html" }).end("<!doctype html><title>Example Domain</title>");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const connection = new McpServerConnection({ transport: "http", url: `http://127.0.0.1:${address.port}/mcp`, headers: {} });
  try {
    await assert.rejects(connection.listTools(), (error: Error) =>
      /answered HTTP 404/u.test(error.message) && !error.message.includes("<"));
  } finally {
    await connection.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

/** A local stdio server run by this Node, the way an installed package's bin is; it echoes the arguments it was launched with. */
function stdioServer(script: string, args: string[] = []) {
  const sdk = (entry: string) => JSON.stringify(require.resolve(`@modelcontextprotocol/sdk/${entry}`));
  const source = `
    const { McpServer } = require(${sdk("server/mcp.js")});
    const { StdioServerTransport } = require(${sdk("server/stdio.js")});
    ${script}`;
  return new McpServerConnection({
    transport: "stdio", launch: async () => ({ command: process.execPath, args: ["-e", source, "--", ...args], cwd: process.cwd() }),
  });
}

test("a stdio server receives its launch arguments and serves catalogue reads and calls", async () => {
  const connection = stdioServer(`
    const mcp = new McpServer({ name: "local", version: "1.0.0" });
    mcp.registerTool("argv", { description: "Launch arguments" },
      async () => ({ content: [{ type: "text", text: JSON.stringify(process.argv.slice(1)) }] }));
    void mcp.connect(new StdioServerTransport());`, ["contoso", "two words"]);
  try {
    assert.equal(await connection.serverName(), "local");
    assert.deepEqual((await connection.listTools()).map(tool => tool.name), ["argv"]);
    const result = await connection.callTool("argv", {}, new AbortController().signal);
    assert.deepEqual(result.content, [{ type: "text", text: JSON.stringify(["contoso", "two words"]) }]);
  } finally {
    await connection.close();
  }
});

test("a stdio server that exits is reported by what it printed to stderr", async () => {
  const connection = stdioServer(`console.error("Error: organization 'nope' was not found"); process.exit(1);`);
  try {
    await assert.rejects(connection.listTools(), /The server stopped: Error: organization 'nope' was not found/u);
  } finally {
    await connection.close();
  }
});

test("a refused credential is reported as such, and a failed connection is not reused", async () => {
  const server = await startServer();
  const connection = new McpServerConnection({ transport: "http", url: server.url, headers: { "x-consumer-api-key": "rotated" } });
  try {
    await assert.rejects(connection.listTools(), /rejected the credential \(401\)/u);
    server.accepted.key = "rotated";
    assert.deepEqual((await connection.listTools()).map(tool => tool.name), ["echo", "authorize"]);
  } finally {
    await connection.close();
    await server.close();
  }
});
