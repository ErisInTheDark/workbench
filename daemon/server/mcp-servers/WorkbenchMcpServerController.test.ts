/*
 * No production exports. Tests protect the MCP server allow boundary (only allowed, currently offered tools are
 * forwarded), credential sealing, per-server failure isolation and settings validation.
 */
import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { compileWorkbenchDatabaseStatement, type WorkbenchDatabaseRow } from "workbench-shared/database/workbench-database-statements";
import { renderCreateTable } from "workbench-shared/database/schema/schema-definition";
import { mcpServerAuth, mcpServers, mcpServerTools } from "../lib/workbench/database/schema/mcp-server-schema";
import type { McpServerConnectionPort, McpServerEndpoint, McpServerTool } from "./McpServerConnection";
import WorkbenchMcpServerController, { type WorkbenchMcpServerOptions } from "./WorkbenchMcpServerController";

const tool = (name: string, description = `${name} tool`): McpServerTool => ({ name, description, inputSchema: { type: "object" } });

class FakeServer {
  tools: McpServerTool[] = [];
  failure: Error | null = null;
  readonly endpoints: McpServerEndpoint[] = [];
  readonly calls: string[] = [];
  closed = 0;

  connect(endpoint: McpServerEndpoint): McpServerConnectionPort {
    this.endpoints.push(endpoint);
    return {
      listTools: async () => {
        if (this.failure) throw this.failure;
        return this.tools;
      },
      callTool: async (name): Promise<CallToolResult> => {
        this.calls.push(name);
        return { content: [{ type: "text", text: `ran ${name}` }] };
      },
      close: async () => { this.closed += 1; },
    };
  }
}

/** Fake servers are addressed by the first label of their URL's hostname. */
function setup(servers: Record<string, FakeServer>) {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  const tables = { [mcpServers.name]: mcpServers, [mcpServerTools.name]: mcpServerTools, [mcpServerAuth.name]: mcpServerAuth };
  for (const table of Object.values(tables)) database.exec(renderCreateTable(table));
  const port: WorkbenchMcpServerOptions["database"] = {
    query: async <Row extends WorkbenchDatabaseRow>(query: Parameters<WorkbenchMcpServerOptions["database"]["query"]>[0]) => {
      const compiled = compileWorkbenchDatabaseStatement(tables, query);
      return database.prepare(compiled.sql).all(...compiled.parameters) as Row[];
    },
    executeTransaction: async statements => database.transaction(() => {
      let changes = 0;
      for (const statement of statements) {
        const compiled = compileWorkbenchDatabaseStatement(tables, statement);
        changes += database.prepare(compiled.sql).run(...compiled.parameters).changes;
      }
      return { changes };
    })(),
  };
  const create = (options: Partial<WorkbenchMcpServerOptions> = {}) => new WorkbenchMcpServerController({
    database: port, readDeviceIdentity: async () => "device-a", user: () => "chiri",
    connect: endpoint => {
      const server = servers[new URL(endpoint.url).hostname.split(".")[0]!];
      if (!server) throw new Error(`No fake server for ${endpoint.url}`);
      return server.connect(endpoint);
    },
    ...options,
  });
  return { create, database, close: () => database.close() };
}

const signal = () => new AbortController().signal;

test("only allowed tools the server currently offers are forwarded; allow-all covers tools added later", async () => {
  const drive = new FakeServer();
  drive.tools = [tool("SEARCH"), tool("EXECUTE")];
  const { create, close } = setup({ drive });
  try {
    const owner = create();
    const { servers: [server] } = await owner.update({ action: "add", name: "drive", url: "https://drive.example/mcp" });
    const id = server!.id;
    await assert.rejects(owner.call({ server: "drive", tool: "SEARCH", arguments: {} }, signal()), /not allowed/u);

    await owner.update({ action: "setTools", id, tools: ["SEARCH", "GONE"] });
    assert.deepEqual(await owner.call({ server: "drive", tool: "SEARCH", arguments: { q: "x" } }, signal()), { text: "ran SEARCH\n", isError: false });
    await assert.rejects(owner.call({ server: "drive", tool: "EXECUTE", arguments: {} }, signal()), /not allowed/u);
    await assert.rejects(owner.call({ server: "drive", tool: "GONE", arguments: {} }, signal()), /does not offer/u);

    await owner.update({ action: "setAllowAll", id, allowAll: true });
    drive.tools = [...drive.tools, tool("LATER")];
    assert.equal((await owner.call({ server: "drive", tool: "LATER", arguments: {} }, signal())).isError, false);
    assert.deepEqual(drive.calls, ["SEARCH", "LATER"]);

    // Individual picks survive allow-all, so turning it off restores them.
    await owner.update({ action: "setAllowAll", id, allowAll: false });
    await assert.rejects(owner.call({ server: "drive", tool: "LATER", arguments: {} }, signal()), /not allowed/u);
    assert.deepEqual((await owner.read()).servers[0]?.allowedTools, ["GONE", "SEARCH"]);
  } finally { close(); }
});

test("the credential reaches the server but never the snapshot or storage in plain text, and is unusable on another device", async () => {
  const drive = new FakeServer();
  drive.tools = [tool("SEARCH")];
  const { create, database, close } = setup({ drive });
  try {
    const snapshot = await create().update({
      action: "add", name: "drive", url: "https://drive.example/mcp", auth: { header: "x-consumer-api-key", value: "secret-key" },
    });
    assert.equal(JSON.stringify(snapshot).includes("secret-key"), false);
    assert.deepEqual(snapshot.servers[0]?.auth, { header: "x-consumer-api-key" });
    assert.deepEqual(drive.endpoints.at(-1)?.headers, { "x-consumer-api-key": "secret-key" });
    const stored = database.prepare("SELECT ciphertext FROM mcp_server_auth").get() as { ciphertext: Buffer };
    assert.equal(stored.ciphertext.toString("utf8").includes("secret-key"), false);

    await create().read();
    assert.deepEqual(drive.endpoints.at(-1)?.headers, { "x-consumer-api-key": "secret-key" });
    const connections = drive.endpoints.length;
    const elsewhere = await create({ readDeviceIdentity: async () => "device-b" }).read();
    assert.equal(elsewhere.servers[0]?.catalog.status, "error");
    assert.equal(drive.endpoints.length, connections);
  } finally { close(); }
});

test("one unreachable server is reported without hiding the others", async () => {
  const drive = new FakeServer();
  const docs = new FakeServer();
  drive.failure = new Error("connect ECONNREFUSED");
  docs.tools = [tool("READ_DOC", "Read a document\nwith detail")];
  const { create, close } = setup({ drive, docs });
  try {
    const owner = create();
    await owner.update({ action: "add", name: "drive", url: "https://drive.example/mcp" });
    const { servers } = await owner.update({ action: "add", name: "docs", url: "https://docs.example/mcp" });
    await owner.update({ action: "setAllowAll", id: servers.find(server => server.name === "docs")!.id, allowAll: true });
    assert.deepEqual((await owner.read()).servers.map(server => server.catalog.status), ["error", "ready"]);
    const listing = await owner.listTools({}, signal());
    assert.match(listing, /^docs\/READ_DOC: Read a document$/mu);
    assert.match(listing, /^drive: unavailable \(connect ECONNREFUSED\)$/mu);
  } finally { close(); }
});

test("a query returns ranked allowed matches with input schemas; without one, every allowed tool is listed briefly", async () => {
  const docs = new FakeServer();
  docs.tools = [tool("UPLOAD", "Upload a file, then search it"), tool("SEARCH_FILES", "Find files by name"), tool("HIDDEN", "Search everything")];
  const { create, close } = setup({ docs });
  try {
    const owner = create();
    const { servers: [server] } = await owner.update({ action: "add", name: "docs", url: "https://docs.example/mcp" });
    await owner.update({ action: "setTools", id: server!.id, tools: ["SEARCH_FILES", "UPLOAD"] });
    assert.equal(await owner.listTools({}, signal()), "docs/UPLOAD: Upload a file, then search it\ndocs/SEARCH_FILES: Find files by name\n");
    const matches = await owner.listTools({ query: "search" }, signal());
    assert.match(matches, /^docs\/SEARCH_FILES\nFind files by name\nInput schema: \{"type":"object"\}\n\ndocs\/UPLOAD\n/u);
    assert.equal(matches.includes("HIDDEN"), false);
  } finally { close(); }
});

test("invalid settings store nothing; removal closes the connection and drops every row", async () => {
  const drive = new FakeServer();
  drive.tools = [tool("SEARCH")];
  const { create, database, close } = setup({ drive });
  try {
    const owner = create();
    await assert.rejects(owner.update({ action: "add", name: "Drive!", url: "https://drive.example/mcp" }));
    await assert.rejects(owner.update({ action: "add", name: "drive", url: "file:///etc/passwd" }));
    await assert.rejects(owner.update({
      action: "add", name: "drive", url: "https://drive.example/mcp", auth: { header: "Content-Type", value: "x" },
    }));
    assert.deepEqual((await owner.read()).servers, []);

    const { servers: [server] } = await owner.update({
      action: "add", name: "drive", url: "https://drive.example/mcp", auth: { header: "authorization", value: "Bearer t" },
    });
    await assert.rejects(owner.update({ action: "add", name: "drive", url: "https://drive.example/other" }), /already exists/u);
    await owner.update({ action: "setTools", id: server!.id, tools: ["SEARCH"] });
    await owner.update({ action: "remove", id: server!.id });
    assert.equal(drive.closed, 1);
    for (const table of ["mcp_servers", "mcp_server_tools", "mcp_server_auth"]) {
      assert.equal((database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count, 0);
    }
  } finally { close(); }
});
