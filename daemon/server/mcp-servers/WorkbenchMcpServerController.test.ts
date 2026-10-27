/*
 * No production exports. Tests protect the MCP server allow boundary (only allowed, currently offered tools are
 * forwarded), link requests and downloads limited to links the server sent, credential sealing, OAuth sign-in over real transport,
 * per-server failure isolation, settings validation, npm servers' background install, version pinning, arguments, sealed
 * environment, kept install failures and install removal, project-scoped visibility and caller identity, cli launch folders,
 * project release and reload, and approved per-turn thread servers.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";
import test from "node:test";
import Database from "better-sqlite3";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { compileWorkbenchDatabaseStatement, type WorkbenchDatabaseRow } from "workbench-shared/database/workbench-database-statements";
import { renderCreateTable } from "workbench-shared/database/schema/schema-definition";
import {
  mcpServerAuth, mcpServerCommands, mcpServerHttp, mcpServerLaunchArgs, mcpServerLaunchEnv, mcpServerOAuthClients, mcpServerOAuthPending,
  mcpServerOAuthTokens, mcpServerPackages, mcpServerProjects, mcpServers, mcpServerTools, mcpThreadServers,
} from "../lib/workbench/database/schema/mcp-server-schema";
import type { McpServerConnectionPort, McpServerEndpoint, McpServerLaunch, McpServerTool } from "./McpServerConnection";
import type { McpPackageSource, McpPackageState } from "./McpPackageInstaller";
import WorkbenchMcpServerController, { type WorkbenchMcpServerOptions } from "./WorkbenchMcpServerController";

const tool = (name: string, description = `${name} tool`): McpServerTool => ({ name, description, inputSchema: { type: "object" } });

class FakeServer {
  tools: McpServerTool[] = [];
  failure: Error | null = null;
  readonly endpoints: McpServerEndpoint[] = [];
  /** Processes started for a stdio server, as the controller launched them. */
  readonly launches: McpServerLaunch[] = [];
  readonly calls: string[] = [];
  /** The `_meta` each call carried, in call order. */
  readonly metas: (Record<string, unknown> | undefined)[] = [];
  result: CallToolResult | null = null;
  respond: ((name: string, args: Record<string, unknown>) => CallToolResult) | null = null;
  closed = 0;

  constructor(public reportedName: string | null = null) {}

  connect(endpoint: McpServerEndpoint): McpServerConnectionPort {
    this.endpoints.push(endpoint);
    return {
      listTools: async () => {
        if (this.failure) throw this.failure;
        return this.tools;
      },
      serverName: async () => {
        if (this.failure) throw this.failure;
        return this.reportedName;
      },
      callTool: async (name, args, _signal, meta): Promise<CallToolResult> => {
        this.calls.push(name);
        this.metas.push(meta);
        return this.respond?.(name, args) ?? this.result ?? { content: [{ type: "text", text: `ran ${name}` }] };
      },
      close: async () => { this.closed += 1; },
    };
  }
}

/** A stdio endpoint's port, resolving its launch on first use the way a real connection does when it connects. */
function launched(endpoint: Extract<McpServerEndpoint, { transport: "stdio" }>, servers: Record<string, FakeServer>): McpServerConnectionPort {
  const port = endpoint.launch().then(launch => {
    const server = servers[launch.command];
    if (!server) throw new Error(`No fake server for ${launch.command}`);
    server.launches.push(launch);
    return server.connect(endpoint);
  });
  return {
    listTools: async () => (await port).listTools(),
    serverName: async () => (await port).serverName(),
    callTool: async (name, args, signal, meta) => (await port).callTool(name, args, signal, meta),
    close: async () => { await (await port.catch(() => null))?.close(); },
  };
}

/** Fake HTTP servers are addressed by the first label of their URL's hostname; stdio ones by their launch command. */
function setup(servers: Record<string, FakeServer>) {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  const tables = Object.fromEntries([
    mcpServers, mcpServerHttp, mcpServerPackages, mcpServerCommands, mcpServerLaunchArgs, mcpServerLaunchEnv, mcpServerProjects,
    mcpServerTools, mcpServerAuth, mcpServerOAuthClients, mcpServerOAuthTokens, mcpServerOAuthPending, mcpThreadServers,
  ].map(table => [table.name, table] as const));
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
      if (endpoint.transport === "stdio") return launched(endpoint, servers);
      const server = servers[new URL(endpoint.url).hostname.split(".")[0]!];
      if (!server) throw new Error(`No fake server for ${endpoint.url}`);
      return server.connect(endpoint);
    },
    ...options,
  });
  return { create, database, port, close: () => database.close() };
}

/** Single-flight installs that land at 1.4.2 and launch as the fake stdio server named `local`, like McpPackageInstaller. */
class FakePackages {
  readonly installs: string[] = [];
  readonly removals: string[] = [];
  failure: Error | null = null;
  readonly #installed = new Set<string>();
  readonly #flights = new Map<string, Promise<void>>();
  readonly #failures = new Map<string, string>();
  #gate: Promise<void> | null = null;
  readonly #launchWaiters: (() => void)[] = [];

  /** Holds installs until the returned release is called. */
  hold() {
    let release!: () => void;
    this.#gate = new Promise(resolve => { release = resolve; });
    return () => { this.#gate = null; release(); };
  }

  state = (serverId: string): McpPackageState => {
    if (this.#installed.has(serverId)) return { state: "installed" };
    if (this.#flights.has(serverId)) return { state: "installing" };
    const failure = this.#failures.get(serverId);
    return failure === undefined ? { state: "missing" } : { state: "failed", detail: failure };
  };

  install = (serverId: string, source: Pick<McpPackageSource, "package" | "version">) => {
    void this.#install(serverId, source).catch(() => undefined);
  };

  /** Resolves when the next launch has joined or started its install. */
  nextLaunch() {
    return new Promise<void>(resolve => { this.#launchWaiters.push(resolve); });
  }

  launch = async (serverId: string, source: McpPackageSource) => {
    const install = this.#installed.has(serverId) ? null : this.#install(serverId, source);
    for (const resolve of this.#launchWaiters.splice(0)) resolve();
    await install;
    return { launch: { command: "local", args: [...source.args], cwd: "C:/data/mcp" }, version: "1.4.2" };
  };

  remove = async (serverId: string) => { this.removals.push(serverId); this.#installed.delete(serverId); };

  #install(serverId: string, source: Pick<McpPackageSource, "package" | "version">) {
    const running = this.#flights.get(serverId);
    if (running) return running;
    this.#failures.delete(serverId);
    this.installs.push(`${source.package}@${source.version}`);
    const gate = this.#gate;
    const flight = (async () => {
      await gate;
      if (this.failure) throw this.failure;
      this.#installed.add(serverId);
    })().catch((error: Error) => {
      this.#failures.set(serverId, error.message);
      throw error;
    }).finally(() => { this.#flights.delete(serverId); });
    this.#flights.set(serverId, flight);
    return flight;
  }
}

const signal = () => new AbortController().signal;
const headersOf = (endpoint: McpServerEndpoint | undefined) => endpoint?.transport === "http" ? endpoint.headers : null;

test("configured-only reads do not contact servers; a targeted live read checks only that server", async () => {
  const drive = new FakeServer("drive");
  const docs = new FakeServer("docs");
  const { create, close } = setup({ drive, docs });
  try {
    const owner = create();
    await owner.update({ action: "add", url: "https://drive.example/mcp" });
    await owner.update({ action: "add", url: "https://docs.example/mcp" });
    const fresh = create();
    drive.endpoints.length = 0;
    docs.endpoints.length = 0;
    const inventory = await fresh.read({ configuredOnly: true });
    assert.deepEqual(inventory.servers.map(server => server.catalog.status), ["pending", "pending"]);
    assert.equal(drive.endpoints.length + docs.endpoints.length, 0);

    const id = inventory.servers[1]!.id;
    const checked = await fresh.read({ id });
    assert.deepEqual(checked.servers.map(server => server.id), [id]);
    assert.equal(checked.servers[0]?.catalog.status, "ready");
    assert.equal(drive.endpoints.length, 0);
    assert.equal(docs.endpoints.length, 1);
  } finally { close(); }
});

test("concurrent targeted reads allocate distinct reported names across the full inventory", async () => {
  const drive = new FakeServer("shared");
  const docs = new FakeServer("shared");
  drive.failure = docs.failure = new Error("Not signed in yet");
  const { create, close } = setup({ drive, docs });
  const owner = create();
  try {
    await owner.update({ action: "add", url: "https://drive.example/mcp" });
    await owner.update({ action: "add", url: "https://docs.example/mcp" });
    const inventory = await owner.read({ configuredOnly: true });
    drive.failure = docs.failure = null;
    const checked = await Promise.all(inventory.servers.map(server => owner.read({ id: server.id })));
    const names = checked.map(snapshot => snapshot.servers[0]!.name);
    assert.equal(new Set(names).size, 2);
    assert.ok(names.every(name => name.startsWith("shared")));
    assert.deepEqual((await owner.read({ configuredOnly: true })).servers.map(server => server.name), names);
  } finally { await owner.dispose(); close(); }
});

test("only allowed tools the server currently offers are forwarded; allow-all covers tools added later", async () => {
  const drive = new FakeServer("drive");
  drive.tools = [tool("SEARCH"), tool("EXECUTE")];
  const { create, close } = setup({ drive });
  try {
    const owner = create();
    const { servers: [server] } = await owner.update({ action: "add", url: "https://drive.example/mcp" });
    const id = server!.id;
    await assert.rejects(owner.call({ server: "drive", tool: "SEARCH", arguments: {} }, null, signal()), /not enabled/u);

    await owner.update({ action: "setTools", id, tools: ["SEARCH", "GONE"] });
    assert.deepEqual(await owner.call({ server: "drive", tool: "SEARCH", arguments: { q: "x" } }, null, signal()), { text: "ran SEARCH\n", isError: false });
    await assert.rejects(owner.call({ server: "drive", tool: "EXECUTE", arguments: {} }, null, signal()), /not enabled/u);
    await assert.rejects(owner.call({ server: "drive", tool: "GONE", arguments: {} }, null, signal()), /does not offer/u);

    await owner.update({ action: "setAllowAll", id, allowAll: true });
    drive.tools = [...drive.tools, tool("LATER")];
    assert.equal((await owner.call({ server: "drive", tool: "LATER", arguments: {} }, null, signal())).isError, false);
    assert.deepEqual(drive.calls, ["SEARCH", "LATER"]);

    // Individual picks survive allow-all, so turning it off restores them.
    await owner.update({ action: "setAllowAll", id, allowAll: false });
    await assert.rejects(owner.call({ server: "drive", tool: "LATER", arguments: {} }, null, signal()), /not enabled/u);
    assert.deepEqual((await owner.read()).servers[0]?.allowedTools, ["GONE", "SEARCH"]);
  } finally { close(); }
});

test("the credential reaches the server but never the snapshot or storage in plain text, and is unusable on another device", async () => {
  const drive = new FakeServer("drive");
  drive.tools = [tool("SEARCH")];
  const { create, database, close } = setup({ drive });
  try {
    const { servers: [added] } = await create().update({ action: "add", url: "https://drive.example/mcp" });
    const snapshot = await create().update({
      action: "setAuth", id: added!.id, auth: { header: "x-consumer-api-key", value: "secret-key" },
    });
    assert.equal(JSON.stringify(snapshot).includes("secret-key"), false);
    assert.deepEqual(snapshot.servers[0]?.auth, { kind: "header", header: "x-consumer-api-key" });
    await create().read({ id: added!.id });
    assert.deepEqual(headersOf(drive.endpoints.at(-1)), { "x-consumer-api-key": "secret-key" });
    const stored = database.prepare("SELECT ciphertext FROM mcp_server_auth").get() as { ciphertext: Buffer };
    assert.equal(stored.ciphertext.toString("utf8").includes("secret-key"), false);

    await create().read();
    assert.deepEqual(headersOf(drive.endpoints.at(-1)), { "x-consumer-api-key": "secret-key" });
    const connections = drive.endpoints.length;
    const elsewhere = await create({ readDeviceIdentity: async () => "device-b" }).read();
    assert.equal(elsewhere.servers[0]?.catalog.status, "error");
    assert.equal(drive.endpoints.length, connections);
  } finally { close(); }
});

test("one unreachable server is reported without hiding the others", async () => {
  const drive = new FakeServer("drive");
  const docs = new FakeServer("docs");
  drive.failure = new Error("connect ECONNREFUSED");
  docs.tools = [tool("READ_DOC", "Read a document\nwith detail")];
  const { create, close } = setup({ drive, docs });
  try {
    const owner = create();
    await owner.update({ action: "add", url: "https://drive.example/mcp" });
    const { servers } = await owner.update({ action: "add", url: "https://docs.example/mcp" });
    await owner.update({ action: "setAllowAll", id: servers.find(server => server.name === "docs")!.id, allowAll: true });
    assert.deepEqual((await owner.read()).servers.map(server => server.catalog.status), ["error", "ready"]);
    const listing = await owner.listTools({}, null, signal());
    assert.match(listing, /^docs\/READ_DOC: Read a document$/mu);
    // Unreachable when added, so it is named after its hostname.
    assert.match(listing, /^drive\.example: unavailable \(connect ECONNREFUSED\)$/mu);
  } finally { close(); }
});

test("a query returns ranked allowed matches with input schemas; without one, every allowed tool is listed briefly", async () => {
  const docs = new FakeServer("docs");
  docs.tools = [tool("UPLOAD", "Upload a file, then search it"), tool("SEARCH_FILES", "Find files by name"), tool("HIDDEN", "Search everything")];
  const { create, close } = setup({ docs });
  try {
    const owner = create();
    const { servers: [server] } = await owner.update({ action: "add", url: "https://docs.example/mcp" });
    await owner.update({ action: "setTools", id: server!.id, tools: ["SEARCH_FILES", "UPLOAD"] });
    assert.equal(await owner.listTools({}, null, signal()), "docs/UPLOAD: Upload a file, then search it\ndocs/SEARCH_FILES: Find files by name\n");
    const matches = await owner.listTools({ query: "search" }, null, signal());
    assert.match(matches, /^docs\/SEARCH_FILES\nFind files by name\nInput: \{\}\n\ndocs\/UPLOAD\n/u);
    assert.equal(matches.includes("HIDDEN"), false);
  } finally { close(); }
});

test("an npm server is listed as installing at once; its own check waits, pins the version and takes the reported name", async () => {
  const local = new FakeServer("Azure DevOps MCP Server");
  local.tools = [tool("list_projects")];
  const packages = new FakePackages();
  const { create, close } = setup({ local });
  const owner = create({ packages });
  try {
    const release = packages.hold();
    const args = ["contoso", "--authentication", "pat"];
    const added = await owner.update({ action: "addPackage", package: "@azure-devops/mcp", args });
    // Named after its package until it reports a name, never after a hostless "URL".
    assert.deepEqual(added.servers.map(server => [server.name, server.source, server.catalog]),
      [["azure-devops-mcp", { kind: "npm", package: "@azure-devops/mcp", version: "latest", args }, { status: "installing" }]]);
    const id = added.servers[0]!.id;
    assert.deepEqual((await owner.read({ configuredOnly: true })).servers[0]?.catalog, { status: "installing" });
    assert.deepEqual((await owner.update({ action: "setAllowAll", id, allowAll: true })).servers[0]?.catalog, { status: "installing" },
      "other settings changes never wait on the install");

    const joined = packages.nextLaunch();
    const checked = owner.read({ id });
    await joined;
    release();
    const [ready] = (await checked).servers;
    assert.deepEqual([ready?.name, ready?.source, ready?.catalog.status],
      ["azure-devops-mcp-server", { kind: "npm", package: "@azure-devops/mcp", version: "1.4.2", args }, "ready"]);
    assert.deepEqual(packages.installs, ["@azure-devops/mcp@latest"]);
    assert.deepEqual(local.launches.map(launch => launch.args), [args]);
    assert.equal((await owner.call({ server: "azure-devops-mcp-server", tool: "list_projects", arguments: {} }, null, signal())).isError, false);
  } finally { await owner.dispose(); close(); }
});

test("npm arguments and sealed environment relaunch the server; neither appears in the snapshot and removal drops every row", async () => {
  const local = new FakeServer("local");
  const packages = new FakePackages();
  const { create, database, close } = setup({ local });
  const owner = create({ packages });
  const count = (table: string) => (database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
  try {
    const { servers: [added] } = await owner.update({ action: "addPackage", package: "local-server", version: "1.4.2", args: ["contoso"] });
    const id = added!.id;
    await owner.read({ id });
    await owner.updateEnv({ id, upserts: [{ key: "PERSONAL_ACCESS_TOKEN", value: "dG9rZW4=" }, { key: "ORG", value: "x" }], removals: [] });
    await owner.updateEnv({ id, upserts: [], removals: ["ORG"] });
    assert.deepEqual(await owner.readEnv({ id }), { entries: [{ key: "PERSONAL_ACCESS_TOKEN", value: "dG9rZW4=" }] });
    const stored = database.prepare("SELECT ciphertext FROM mcp_server_launch_env").get() as { ciphertext: Buffer };
    assert.equal(stored.ciphertext.toString("utf8").includes("dG9rZW4="), false);

    const snapshot = await owner.update({ action: "setArgs", id, args: ["fabrikam", "two words"] });
    assert.equal(JSON.stringify(snapshot).includes("dG9rZW4="), false);
    await owner.read({ id });
    assert.deepEqual(local.launches.at(-1), {
      command: "local", args: ["fabrikam", "two words"], cwd: "C:/data/mcp", env: { PERSONAL_ACCESS_TOKEN: "dG9rZW4=" },
    });
    const elsewhere = await create({ packages, readDeviceIdentity: async () => "device-b" }).read({ id });
    assert.match(elsewhere.servers[0]?.catalog.status === "error" ? elsewhere.servers[0].catalog.detail : "", /PERSONAL_ACCESS_TOKEN can't be read/u);
    await assert.rejects(owner.update({ action: "setAuth", id, auth: { header: "authorization", value: "Bearer t" } }), /runs locally/u);

    await owner.update({ action: "remove", id });
    assert.deepEqual(packages.removals, [id]);
    for (const table of ["mcp_servers", "mcp_server_packages", "mcp_server_launch_args", "mcp_server_launch_env"]) assert.equal(count(table), 0, table);
  } finally { await owner.dispose(); close(); }
});

test("a failed npm install keeps the server with npm's reason, unchanged by later reads, until Retry installs again", async () => {
  const local = new FakeServer("local");
  const packages = new FakePackages();
  const { create, close } = setup({ local });
  const owner = create({ packages });
  try {
    packages.failure = new Error("npm couldn't install missing@latest: code E404");
    const release = packages.hold();
    const { servers: [added] } = await owner.update({ action: "addPackage", package: "missing", args: [] });
    const id = added!.id;
    const joined = packages.nextLaunch();
    const checked = owner.read({ id });
    await joined;
    release();
    assert.deepEqual((await checked).servers[0]?.catalog, { status: "error", detail: "npm couldn't install missing@latest: code E404" });
    assert.deepEqual((await owner.read()).servers[0]?.catalog, { status: "error", detail: "npm couldn't install missing@latest: code E404" });
    assert.equal(packages.installs.length, 1);

    packages.failure = null;
    const retry = packages.hold();
    assert.deepEqual((await owner.update({ action: "refresh", id })).servers[0]?.catalog, { status: "installing" });
    const rejoined = packages.nextLaunch();
    const rechecked = owner.read({ id });
    await rejoined;
    retry();
    assert.equal((await rechecked).servers[0]?.catalog.status, "ready");
    assert.equal(packages.installs.length, 2);
    const { servers } = await owner.update({ action: "add", url: "https://local.example/mcp" });
    const remote = servers.find(server => server.source.kind === "http")!;
    await assert.rejects(owner.update({ action: "setArgs", id: remote.id, args: [] }), /remote server/u);
  } finally { await owner.dispose(); close(); }
});

test("invalid settings store nothing; removal closes the connection and drops every row", async () => {
  const drive = new FakeServer("drive");
  drive.tools = [tool("SEARCH")];
  const { create, database, close } = setup({ drive });
  try {
    const owner = create();
    await assert.rejects(owner.update({ action: "add", url: "file:///etc/passwd" }));
    assert.deepEqual((await owner.read()).servers, []);

    const { servers: [server] } = await owner.update({ action: "add", url: "https://drive.example/mcp" });
    await assert.rejects(owner.update({ action: "setAuth", id: server!.id, auth: { header: "Content-Type", value: "x" } }));
    assert.equal((await owner.read()).servers[0]?.auth, null);
    await owner.update({ action: "setAuth", id: server!.id, auth: { header: "authorization", value: "Bearer t" } });
    await owner.update({ action: "setTools", id: server!.id, tools: ["SEARCH"] });
    await owner.update({ action: "remove", id: server!.id });
    assert.equal(drive.closed > 0, true);
    for (const table of ["mcp_servers", "mcp_server_tools", "mcp_server_auth"]) {
      assert.equal((database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count, 0);
    }
  } finally { close(); }
});

test("disabled tools are hidden by default and listed in their own section only when asked", async () => {
  const docs = new FakeServer("docs");
  docs.tools = [tool("SEARCH_FILES", "Find files by name"), tool("DELETE_FILE", "Delete a file")];
  const { create, close } = setup({ docs });
  try {
    const owner = create();
    const { servers: [server] } = await owner.update({ action: "add", url: "https://docs.example/mcp" });
    await owner.update({ action: "setTools", id: server!.id, tools: ["SEARCH_FILES"] });
    assert.equal(await owner.listTools({}, null, signal()), "docs/SEARCH_FILES: Find files by name\n");
    const withDisabled = await owner.listTools({ includeDisabled: true }, null, signal());
    assert.equal(withDisabled, [
      "docs/SEARCH_FILES: Find files by name",
      "",
      "Disabled (ask the user to enable one with mcp_request):",
      "docs/DELETE_FILE: Delete a file",
      "",
    ].join("\n"));
    assert.equal(withDisabled.match(/mcp_request/gu)?.length, 1, "the enable hint appears once");
    await assert.rejects(owner.call({ server: "docs", tool: "DELETE_FILE", arguments: {} }, null, signal()), /not enabled/u);
  } finally { close(); }
});

test("an enable request asks only for offered disabled tools, and enables on the user's yes", async () => {
  const docs = new FakeServer("docs");
  docs.tools = [tool("SEARCH_FILES", "Find files"), tool("DELETE_FILE", "Delete a file")];
  const { create, close } = setup({ docs });
  try {
    const owner = create();
    const { servers: [server] } = await owner.update({ action: "add", url: "https://docs.example/mcp" });
    await owner.update({ action: "setTools", id: server!.id, tools: ["SEARCH_FILES"] });
    const asked: string[] = [];
    const answer = (enable: boolean) => async (mcpTool: { server: string; tool: string; description: string }) => {
      asked.push(`${mcpTool.server}/${mcpTool.tool}: ${mcpTool.description}`);
      return enable;
    };
    const request = (tool: string, enable = true) => owner.requestTool({ server: "docs", tool, reason: "Needed" }, null, answer(enable), signal());

    assert.match(await request("SEARCH_FILES"), /already enabled/u);
    await assert.rejects(request("NOPE"), /does not offer/u);
    assert.deepEqual(asked, [], "enabled and unoffered tools never reach the user");

    assert.match(await request("DELETE_FILE", false), /did not enable/u);
    await assert.rejects(owner.call({ server: "docs", tool: "DELETE_FILE", arguments: {} }, null, signal()), /not enabled/u);
    assert.match(await request("DELETE_FILE"), /^Enabled docs\/DELETE_FILE/u);
    assert.deepEqual(asked, ["docs/DELETE_FILE: Delete a file", "docs/DELETE_FILE: Delete a file"]);
    assert.equal((await owner.call({ server: "docs", tool: "DELETE_FILE", arguments: {} }, null, signal())).isError, false);
    assert.deepEqual((await owner.read()).servers[0]?.allowedTools, ["DELETE_FILE", "SEARCH_FILES"]);
  } finally { close(); }
});

test("a link request asks only about links the server itself sent, and tells the agent what the user decided", async () => {
  const docs = new FakeServer("docs");
  docs.tools = [tool("SEARCH")];
  const { create, close } = setup({ docs });
  const authorization = "https://accounts.example.test/auth?client=1&state=abc";
  try {
    const owner = create();
    const { servers: [server] } = await owner.update({ action: "add", url: "https://docs.example/mcp" });
    await owner.update({ action: "setTools", id: server!.id, tools: ["SEARCH"] });
    const asked: string[] = [];
    const answer = (done: boolean) => async (link: { server: string; url: string; host: string }) => {
      asked.push(`${link.server} ${link.host} ${link.url}`);
      return done;
    };
    const authorize = (url: string, done = true) => owner.authorizeLink({ server: "docs", url, reason: "Sign in to search" }, null, answer(done));

    await assert.rejects(authorize(authorization), /did not send that link/u);
    docs.result = { isError: true, content: [{ type: "text", text: JSON.stringify({ authorization_url: authorization, message: "Sign in." }) }] };
    const failed = await owner.call({ server: "docs", tool: "SEARCH", arguments: {} }, null, signal());
    assert.match(failed.text, /mcp_authorize/u);
    await assert.rejects(authorize("https://evil.example.test/login"), /did not send that link/u);
    assert.deepEqual(asked, [], "unsent links never reach the user");

    assert.match(await authorize(authorization.replace("&", "\\u0026")), /finished signing in to docs/u);
    assert.match(await authorize(authorization, false), /did not sign in/u);
    assert.deepEqual(asked, Array(2).fill(`docs accounts.example.test ${new URL(authorization).href}`));
  } finally { close(); }
});

test("downloads fetch, without asking, only links the server itself sent", async () => {
  const docs = new FakeServer("docs");
  docs.tools = [tool("EXPORT")];
  const { create, close } = setup({ docs });
  const exported = "https://files.example.test/export?sig=1&x=2";
  try {
    const fetched: string[] = [];
    const owner = create({
      downloads: { download: async (threadId, url, name) => {
        fetched.push(`${threadId} ${url} ${name}`);
        return { name: "Doc.html", path: "/cache/Doc.html", contentType: "text/html", bytes: 9 };
      } },
    });
    const { servers: [server] } = await owner.update({ action: "add", url: "https://docs.example/mcp" });
    await owner.update({ action: "setTools", id: server!.id, tools: ["EXPORT"] });

    await assert.rejects(owner.downloadLink({ threadId: "t", server: "docs", url: exported }, null, signal()), /did not send that link/u);
    docs.result = { content: [{ type: "text", text: JSON.stringify({ data: { s3url: exported } }) }] };
    const ran = await owner.call({ server: "docs", tool: "EXPORT", arguments: {} }, null, signal());
    assert.match(ran.text, /mcp_download/u, "successful replies with links point at the download tool");
    await assert.rejects(owner.downloadLink({ threadId: "t", server: "docs", url: "https://evil.example.test/x" }, null, signal()), /did not send that link/u);
    assert.deepEqual(fetched, []);

    assert.match(await owner.downloadLink({ threadId: "t", server: "docs", url: exported, name: "Doc" }, null, signal()), /Saved Doc\.html .* to \/cache\/Doc\.html/u);
    assert.deepEqual(fetched, [`t ${new URL(exported).href} Doc`]);
  } finally { close(); }
});

test("a renamed server keeps its allow rules under its new name and refuses a taken or reserved name", async () => {
  const drive = new FakeServer("drive");
  drive.tools = [tool("SEARCH")];
  const docs = new FakeServer(null);
  const { create, close } = setup({ drive, docs });
  try {
    const owner = create();
    const { servers: [server] } = await owner.update({ action: "add", url: "https://drive.example/mcp" });
    await owner.update({ action: "add", url: "https://docs.example/mcp" });
    await owner.update({ action: "setTools", id: server!.id, tools: ["SEARCH"] });
    await assert.rejects(owner.update({ action: "rename", id: server!.id, name: "docs.example" }), /already named/u);
    await assert.rejects(owner.update({ action: "rename", id: server!.id, name: "wb" }), /reserved/u);

    const renamed = await owner.update({ action: "rename", id: server!.id, name: "gdrive" });
    assert.deepEqual(renamed.servers.map(entry => entry.name).sort(), ["docs.example", "gdrive"]);
    assert.equal((await owner.call({ server: "gdrive", tool: "SEARCH", arguments: {} }, null, signal())).isError, false);
    await assert.rejects(owner.call({ server: "drive", tool: "SEARCH", arguments: {} }, null, signal()), /No MCP server is named drive/u);
  } finally { close(); }
});

test("a Composio server is unwrapped: meta tools hidden, inner tools searched, enabled and called by their own names", async () => {
  const composio = new FakeServer("composio");
  composio.tools = ["COMPOSIO_SEARCH_TOOLS", "COMPOSIO_GET_TOOL_SCHEMAS", "COMPOSIO_MULTI_EXECUTE_TOOL", "COMPOSIO_REMOTE_BASH_TOOL"].map(name => tool(name));
  const schema = { tool_slug: "GOOGLEDRIVE_DOWNLOAD_FILE", description: "Downloads a Drive file's content.", input_schema: { type: "object", properties: { fileId: { type: "string" } } } };
  const json = (value: unknown): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
  const executed: unknown[] = [];
  composio.respond = (name, args) => {
    if (name === "COMPOSIO_SEARCH_TOOLS") return json({ data: { results: [{ primary_tool_slugs: ["GOOGLEDRIVE_DOWNLOAD_FILE"] }], tool_schemas: { GOOGLEDRIVE_DOWNLOAD_FILE: { ...schema, hasFullSchema: true } } } });
    if (name === "COMPOSIO_GET_TOOL_SCHEMAS") return json({ data: { tool_schemas: Object.fromEntries((args.tool_slugs as string[]).filter(slug => slug === schema.tool_slug).map(slug => [slug, schema])) } });
    executed.push(args.tools);
    return json({ data: { results: [{ response: { successful: true, data: { exported: true } } }] } });
  };
  const { create, close } = setup({ composio });
  try {
    const owner = create();
    await owner.update({ action: "add", url: "https://composio.example/mcp" });
    const listed = await owner.listTools({ includeDisabled: true }, null, signal());
    assert.doesNotMatch(listed, /COMPOSIO_/u);
    assert.match(listed, /composio is search-based/u);
    assert.match(await owner.listTools({ query: "export a google doc", includeDisabled: true }, null, signal()), /^composio\/GOOGLEDRIVE_DOWNLOAD_FILE$/mu);

    await assert.rejects(owner.call({ server: "composio", tool: "GOOGLEDRIVE_DOWNLOAD_FILE", arguments: {} }, null, signal()), /not enabled/u);
    await assert.rejects(owner.requestTool({ server: "composio", tool: "NOPE", reason: "r" }, null, async () => true, signal()), /does not offer/u);
    assert.match(await owner.requestTool({ server: "composio", tool: "GOOGLEDRIVE_DOWNLOAD_FILE", reason: "r" }, null, async () => true, signal()), /^Enabled/u);
    const catalog = (await owner.read()).servers[0]!.catalog;
    assert.ok(catalog.status === "ready" && catalog.search === true);
    assert.deepEqual(catalog.tools.map(entry => entry.name), ["GOOGLEDRIVE_DOWNLOAD_FILE"], "settings list the enabled inner tools");

    const ran = await owner.call({ server: "composio", tool: "GOOGLEDRIVE_DOWNLOAD_FILE", arguments: { fileId: "1" } }, null, signal());
    assert.deepEqual(JSON.parse(ran.text), { successful: true, data: { exported: true } });
    assert.deepEqual(executed, [[{ tool_slug: "GOOGLEDRIVE_DOWNLOAD_FILE", arguments: { fileId: "1" } }]]);
  } finally { close(); }
});

test("servers are named after what they report, else their hostname, without colliding", async () => {
  const drive = new FakeServer("Google Drive (Composio)");
  const docs = new FakeServer(null);
  const { create, close } = setup({ drive, docs });
  try {
    const owner = create();
    await owner.update({ action: "add", url: "https://drive.example/mcp" });
    await owner.update({ action: "add", url: "https://drive.example/other" });
    const { servers } = await owner.update({ action: "add", url: "https://docs.example/mcp" });
    assert.deepEqual(servers.map(server => server.name), ["google-drive-composio", "google-drive-composio-2", "docs.example"]);
  } finally { close(); }
});

test("a hostname-named server adopts its reported name once it connects, and reported names never change", async () => {
  const drive = new FakeServer("Drive");
  drive.failure = new Error("401");
  const { create, close } = setup({ drive });
  try {
    const owner = create();
    const { servers: [added] } = await owner.update({ action: "add", url: "https://drive.example/mcp" });
    assert.equal(added?.name, "drive.example");
    drive.failure = null;
    await owner.update({ action: "refresh", id: added!.id });
    assert.equal((await owner.read()).servers[0]?.name, "drive");
    drive.reportedName = "Renamed Upstream";
    await owner.update({ action: "refresh", id: added!.id });
    assert.equal((await owner.read()).servers[0]?.name, "drive");
  } finally { close(); }
});

/** A local MCP server behind an OAuth authorization server with dynamic registration, PKCE and refresh, like Composio Connect. */
async function startOAuthServer() {
  const registrations: Record<string, unknown>[] = [];
  const codes = new Map<string, { challenge: string; clientId: string; redirectUri: string }>();
  const access = new Set<string>();
  const refresh = new Set<string>();
  const counts = { tokens: 0, refreshes: 0 };
  let base = "";
  const json = (response: http.ServerResponse, status: number, value: object) => {
    response.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(value));
  };
  const body = async (request: http.IncomingMessage) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString("utf8");
  };
  const issue = () => {
    counts.tokens += 1;
    const tokens = { access_token: `access-${counts.tokens}`, refresh_token: `refresh-${counts.tokens}` };
    access.add(tokens.access_token);
    refresh.add(tokens.refresh_token);
    return { ...tokens, token_type: "Bearer", expires_in: 3600 };
  };
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", base);
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      return json(response, 200, { resource: `${base}/mcp`, authorization_servers: [base] });
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return json(response, 200, {
        issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`,
        registration_endpoint: `${base}/register`, response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"], code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
    }
    if (url.pathname === "/register") {
      const metadata = JSON.parse(await body(request)) as Record<string, unknown>;
      registrations.push(metadata);
      return json(response, 201, { ...metadata, client_id: `client-${registrations.length}` });
    }
    if (url.pathname === "/token") {
      const form = new URLSearchParams(await body(request));
      if (form.get("grant_type") === "authorization_code") {
        const grant = codes.get(form.get("code") ?? "");
        codes.delete(form.get("code") ?? "");
        const challenge = createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url");
        if (!grant || grant.challenge !== challenge || grant.redirectUri !== form.get("redirect_uri") || grant.clientId !== form.get("client_id")) {
          return json(response, 400, { error: "invalid_grant" });
        }
        return json(response, 200, issue());
      }
      const token = form.get("refresh_token") ?? "";
      if (!refresh.delete(token)) return json(response, 400, { error: "invalid_grant" });
      counts.refreshes += 1;
      return json(response, 200, issue());
    }
    if (url.pathname === "/mcp") {
      const bearer = request.headers.authorization?.replace(/^Bearer /u, "") ?? "";
      if (!access.has(bearer)) {
        response.writeHead(401, { "WWW-Authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` }).end();
        return;
      }
      const mcp = new McpServer({ name: "Composio", version: "1.0.0" });
      mcp.registerTool("whoami", { description: "Who is signed in" }, async () => ({ content: [{ type: "text", text: bearer }] }));
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      response.on("close", () => { void transport.close(); void mcp.close(); });
      await mcp.connect(transport);
      await transport.handleRequest(request, response);
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  base = `http://127.0.0.1:${address.port}`;
  return {
    url: `${base}/mcp`, registrations, counts,
    /** Stand in for the user approving the provider's login page. */
    approve(authorizationUrl: string) {
      const params = new URL(authorizationUrl).searchParams;
      const code = `code-${codes.size + 1}-${Date.now()}`;
      codes.set(code, {
        challenge: params.get("code_challenge") ?? "", clientId: params.get("client_id") ?? "", redirectUri: params.get("redirect_uri") ?? "",
      });
      return code;
    },
    expireAccess() { access.clear(); },
    revokeRefresh() { refresh.clear(); },
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}

const REDIRECT = "http://127.0.0.1:43210/api/mcp-sign-in/daemon-a";

test("OAuth sign-in registers, exchanges a PKCE code once, refreshes silently and asks for sign-in again when refresh dies", async () => {
  const provider = await startOAuthServer();
  const { create, database, close } = setup({});
  const owner = create({ connect: undefined });
  try {
    const { servers: [added] } = await owner.update({ action: "add", url: provider.url });
    const { servers: [server] } = await owner.read({ id: added!.id });
    assert.deepEqual(server?.catalog, { status: "signInRequired" });
    assert.equal(server?.name, "127.0.0.1", "a server that needs sign-in first is named after its hostname");
    assert.equal(provider.registrations.length, 0, "background reads never register a client");

    const { authorizationUrl } = await owner.startSignIn({ id: server!.id, redirectUri: REDIRECT });
    const params = new URL(authorizationUrl).searchParams;
    assert.equal(params.get("client_id"), "client-1");
    assert.equal(params.get("redirect_uri"), REDIRECT);
    assert.equal(params.get("code_challenge_method"), "S256");
    const state = params.get("state")!;
    assert.ok(state);
    assert.deepEqual(provider.registrations[0]?.redirect_uris, [REDIRECT]);

    assert.deepEqual(await owner.finishSignIn({ state, code: provider.approve(authorizationUrl) }), { outcome: "signedIn", server: "127.0.0.1" });
    await assert.rejects(owner.finishSignIn({ state, code: "replayed" }), /expired or was already used/u);
    const signedIn = await owner.read();
    assert.equal(signedIn.servers[0]?.name, "composio", "the first successful connection adopts the reported name");
    assert.deepEqual(signedIn.servers[0]?.auth, { kind: "oauth" });
    assert.deepEqual(signedIn.servers[0]?.catalog, { status: "ready", tools: [{ name: "whoami", title: null, description: "Who is signed in" }] });
    assert.equal(/access-|refresh-/u.test(JSON.stringify(signedIn)), false);
    const stored = database.prepare("SELECT access_ciphertext FROM mcp_server_oauth_tokens").get() as { access_ciphertext: Buffer };
    assert.equal(stored.access_ciphertext.toString("utf8").includes("access-"), false);

    await owner.update({ action: "setAllowAll", id: server!.id, allowAll: true });
    provider.expireAccess();
    assert.deepEqual(await owner.call({ server: "composio", tool: "whoami", arguments: {} }, null, signal()), { text: "access-2\n", isError: false });
    assert.equal(provider.counts.refreshes, 1);

    provider.expireAccess();
    provider.revokeRefresh();
    await owner.update({ action: "refresh", id: server!.id });
    assert.deepEqual((await owner.read()).servers[0]?.catalog, { status: "signInRequired" });
    await assert.rejects(owner.call({ server: "composio", tool: "whoami", arguments: {} }, null, signal()), /needs sign-in/u);
  } finally {
    await owner.dispose();
    close();
    await provider.close();
  }
});

test("a sign-in expires, a provider refusal stores nothing, and sign-out or a header credential drops OAuth rows", async () => {
  const provider = await startOAuthServer();
  const { create, database, close } = setup({});
  let now = 1_000_000;
  const owner = create({ connect: undefined, now: () => now });
  const count = (table: string) => (database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
  try {
    const { servers: [server] } = await owner.update({ action: "add", url: provider.url });
    const id = server!.id;
    const late = await owner.startSignIn({ id, redirectUri: REDIRECT });
    now += 11 * 60_000;
    await assert.rejects(owner.finishSignIn({ state: new URL(late.authorizationUrl).searchParams.get("state")!, code: provider.approve(late.authorizationUrl) }),
      /expired/u);

    const refused = await owner.startSignIn({ id, redirectUri: REDIRECT });
    assert.deepEqual(await owner.finishSignIn({ state: new URL(refused.authorizationUrl).searchParams.get("state")!, error: "access_denied" }),
      { outcome: "failed", server: "127.0.0.1", detail: "access_denied" });
    assert.equal(count("mcp_server_oauth_tokens"), 0);

    const signIn = async () => {
      const { authorizationUrl } = await owner.startSignIn({ id, redirectUri: REDIRECT });
      await owner.finishSignIn({ state: new URL(authorizationUrl).searchParams.get("state")!, code: provider.approve(authorizationUrl) });
    };
    await signIn();
    await owner.update({ action: "signOut", id });
    assert.deepEqual([count("mcp_server_oauth_tokens"), count("mcp_server_oauth_clients"), count("mcp_server_oauth_pending")], [0, 0, 0]);
    assert.equal((await owner.read()).servers[0]?.auth, null);

    await signIn();
    await owner.update({ action: "setAuth", id, auth: { header: "x-consumer-api-key", value: "key" } });
    assert.deepEqual([count("mcp_server_oauth_tokens"), count("mcp_server_oauth_clients")], [0, 0]);
    assert.deepEqual((await owner.read()).servers[0]?.auth, { kind: "header", header: "x-consumer-api-key" });
  } finally {
    await owner.dispose();
    close();
    await provider.close();
  }
});

const settle = () => new Promise(resolve => setImmediate(resolve));
/** `project-a` and `project-a-next` are two clones of one repository; `project-b` is another repository. */
const projects: WorkbenchMcpServerOptions["resolveProject"] = async projectId => {
  const id = projectId === "alias-a" ? "project-a" : projectId;
  return { id, rootPath: `/projects/${id}`, identityKey: id.startsWith("project-a") ? "remote://host/a" : `remote://host/${id}` };
};
const inProject = (threadId: string, projectId: string) => ({ threadId, cwd: `/projects/${projectId}`, projectId });

test("a project server is seen and called only from its project's threads, which it learns; global servers never learn the caller", async () => {
  const sim = new FakeServer();
  const drive = new FakeServer("drive");
  sim.tools = [tool("step")];
  drive.tools = [tool("SEARCH")];
  const { create, close } = setup({ "sim-bin": sim, drive });
  const owner = create({ resolveProject: projects });
  const callerA = inProject("thread-a", "project-a");
  const callerB = inProject("thread-b", "project-b");
  try {
    const added = await owner.update({ action: "addCommand", command: "sim-bin", args: ["--headless"], projectId: "alias-a" });
    const simServer = added.servers.find(server => server.name === "sim-bin")!;
    assert.deepEqual([simServer.projectId, simServer.source], ["project-a", { kind: "cli", command: "sim-bin", args: ["--headless"] }]);
    await owner.update({ action: "setAllowAll", id: simServer.id, allowAll: true });
    const { servers } = await owner.update({ action: "add", url: "https://drive.example/mcp" });
    await owner.update({ action: "setAllowAll", id: servers.find(server => server.name === "drive")!.id, allowAll: true });

    assert.equal((await owner.listTools({}, callerB, signal())).includes("sim-bin"), false);
    await assert.rejects(owner.call({ server: "sim-bin", tool: "step", arguments: {} }, callerB, signal()), /No MCP server is named sim-bin/u);
    await assert.rejects(owner.call({ server: "sim-bin", tool: "step", arguments: {} }, null, signal()), /No MCP server is named sim-bin/u);

    assert.equal((await owner.call({ server: "sim-bin", tool: "step", arguments: {} }, callerA, signal())).isError, false);
    assert.deepEqual(sim.metas.at(-1), { "workbench/caller": { threadId: "thread-a", cwd: "/projects/project-a" } });
    assert.deepEqual(sim.launches.at(-1), { command: "sim-bin", args: ["--headless"], cwd: "/projects/project-a", env: {} });
    await owner.call({ server: "drive", tool: "SEARCH", arguments: {} }, callerA, signal());
    assert.equal(drive.metas.at(-1), undefined);
  } finally { await owner.dispose(); close(); }
});

test("a project server serves every clone of its repository, running one cli process from each caller's own folder", async () => {
  const sim = new FakeServer();
  sim.tools = [tool("step")];
  const { create, close } = setup({ "sim-bin": sim });
  const owner = create({ resolveProject: projects });
  const main = inProject("thread-main", "project-a");
  const next = inProject("thread-next", "project-a-next");
  try {
    const { servers: [added] } = await owner.update({ action: "addCommand", command: "sim-bin", args: [], projectId: "project-a" });
    await owner.update({ action: "setAllowAll", id: added!.id, allowAll: true });
    await owner.call({ server: "sim-bin", tool: "step", arguments: {} }, next, signal());
    await owner.call({ server: "sim-bin", tool: "step", arguments: {} }, main, signal());
    await owner.call({ server: "sim-bin", tool: "step", arguments: {} }, next, signal());
    assert.deepEqual(sim.launches.map(launch => launch.cwd), ["/projects/project-a-next", "/projects/project-a"]);
    await assert.rejects(owner.call({ server: "sim-bin", tool: "step", arguments: {} }, inProject("thread-b", "project-b"), signal()),
      /No MCP server is named sim-bin/u);

    await owner.releaseProject("project-a-next");
    await settle();
    assert.equal(sim.closed, 1, "only the released folder's process stops");
  } finally { await owner.dispose(); close(); }
});

test("a settings change answers without contacting any server", async () => {
  const drive = new FakeServer("drive");
  const { create, close } = setup({ drive });
  const owner = create();
  try {
    const { servers: [added] } = await owner.update({ action: "add", url: "https://drive.example/mcp" });
    const contacted = drive.endpoints.length;
    const changed = await owner.update({ action: "setAllowAll", id: added!.id, allowAll: true });
    assert.equal(drive.endpoints.length, contacted);
    assert.equal(changed.servers[0]?.catalog.status, "pending");
  } finally { await owner.dispose(); close(); }
});

test("releasing a project closes only its servers, and reload restarts only a server the caller sees", async () => {
  const sim = new FakeServer();
  const drive = new FakeServer();
  sim.tools = [tool("step")];
  const { create, close } = setup({ "sim-bin": sim, drive });
  const owner = create({ resolveProject: projects });
  const callerA = inProject("thread-a", "project-a");
  try {
    await owner.update({ action: "addCommand", command: "sim-bin", args: [], projectId: "project-a" });
    await owner.update({ action: "add", url: "https://drive.example/mcp" });
    await owner.read();
    owner.releaseProject("project-b");
    await settle();
    assert.deepEqual([sim.closed, drive.closed], [0, 0]);
    owner.releaseProject("project-a");
    await settle();
    assert.deepEqual([sim.closed, drive.closed], [1, 0]);

    await assert.rejects(owner.reload({ server: "sim-bin" }, inProject("thread-b", "project-b")), /No MCP server is named sim-bin/u);
    await owner.listTools({ server: "sim-bin" }, callerA, signal());
    const launches = sim.launches.length;
    assert.match(await owner.reload({ server: "sim-bin" }, callerA), /starts it again/u);
    await owner.listTools({ server: "sim-bin" }, callerA, signal());
    assert.equal(sim.launches.length, launches + 1);
  } finally { await owner.dispose(); close(); }
});

test("a thread server connects only after approval, serves only its thread with bounded responses, and is gone after its turn", async () => {
  const scratch = new FakeServer();
  const drive = new FakeServer("drive");
  scratch.tools = [tool("probe")];
  const { create, close } = setup({ scratch, drive });
  const owner = create({ resolveProject: projects });
  const caller = inProject("thread-a", "project-a");
  const url = "http://scratch.local:4100/mcp";
  try {
    await owner.update({ action: "add", url: "https://drive.example/mcp" });
    await assert.rejects(owner.connectThreadServer({ name: "drive", url }, caller, async () => true, signal()), /already available/u);

    const asked: unknown[] = [];
    assert.match(await owner.connectThreadServer({ name: "scratch", url }, caller, async context => { asked.push(context); return false; }, signal()),
      /did not connect/u);
    assert.deepEqual(asked, [{ server: "scratch", url }]);
    assert.equal(scratch.endpoints.length, 0, "nothing connects before the user approves");
    await assert.rejects(owner.call({ server: "scratch", tool: "probe", arguments: {} }, caller, signal()), /No MCP server is named scratch/u);

    assert.match(await owner.connectThreadServer({ name: "scratch", url }, caller, async () => true, signal()), /offers 1 tool/u);
    const endpoint = scratch.endpoints.at(-1);
    assert.ok(endpoint?.transport === "http" && endpoint.maxResponseBytes !== undefined && endpoint.authProvider === undefined);
    assert.equal((await owner.call({ server: "scratch", tool: "probe", arguments: {} }, caller, signal())).isError, false, "approved servers allow all tools");
    assert.equal(scratch.metas.at(-1), undefined);
    await assert.rejects(owner.call({ server: "scratch", tool: "probe", arguments: {} }, inProject("thread-b", "project-a"), signal()), /No MCP server/u);

    await owner.endTurn("thread-a");
    await settle();
    assert.equal(scratch.closed, 1);
    await assert.rejects(owner.call({ server: "scratch", tool: "probe", arguments: {} }, caller, signal()), /No MCP server is named scratch/u);
  } finally { await owner.dispose(); close(); }
});

test("a sweep forgets thread servers of threads no longer working and keeps working threads'", async () => {
  const scratch = new FakeServer();
  scratch.tools = [tool("probe")];
  const { create, close } = setup({ scratch });
  const owner = create({ resolveProject: projects });
  const url = "http://scratch.local:4100/mcp";
  const working = inProject("thread-a", "project-a");
  const ended = inProject("thread-b", "project-a");
  try {
    await owner.connectThreadServer({ name: "scratch", url }, working, async () => true, signal());
    await owner.connectThreadServer({ name: "scratch", url }, ended, async () => true, signal());
    await owner.sweepThreadServers(new Set(["thread-a"]));
    assert.match(await owner.listTools({}, working, signal()), /scratch/u);
    assert.equal((await owner.listTools({}, ended, signal())).includes("scratch"), false);
  } finally { await owner.dispose(); close(); }
});
