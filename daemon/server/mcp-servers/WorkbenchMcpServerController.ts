/*
 * Exports:
 * - WorkbenchMcpServerOptions: database, device identity and connection factory ports.
 * - McpServerCallOutcome: agent-facing text of one forwarded call and whether it failed.
 * - default WorkbenchMcpServerController: single owner of user-added MCP servers, their allow rules, sealed credentials and live connections; answers settings reads/updates and agent tool listing/calls.
 */
import { randomUUID } from "node:crypto";
import os from "node:os";
import {
  McpServerSettingsUpdateSchema, type McpServerSettingsSnapshot, type McpServerSettingsUpdate, type McpServerSnapshot,
} from "workbench-shared/workbench/mcp/mcp-server-settings";
import {
  deleteRows, insertRow, selectRows, updateRows, upsertRow,
  type WorkbenchDatabaseMutation, type WorkbenchDatabaseQuery, type WorkbenchDatabaseRow,
} from "workbench-shared/database/workbench-database-statements";
import { mcpServerAuth, mcpServers, mcpServerTools } from "../lib/workbench/database/schema/mcp-server-schema";
import { deriveProjectStoreKey, openProjectStoreValue, sealProjectStoreValue } from "../store/project-store-crypto";
import McpServerConnection, { type McpServerConnectionPort, type McpServerEndpoint, type McpServerTool } from "./McpServerConnection";
import { formatMcpToolListing, formatMcpToolResult, type McpToolListing } from "./mcp-tool-search";

export interface WorkbenchMcpServerOptions {
  database: {
    executeTransaction(statements: readonly WorkbenchDatabaseMutation[]): Promise<{ changes: number }>;
    query<Row extends WorkbenchDatabaseRow>(statement: WorkbenchDatabaseQuery<Row>): Promise<Row[]>;
  };
  readDeviceIdentity(): Promise<string>;
  connect?: (endpoint: McpServerEndpoint) => McpServerConnectionPort;
  user?: () => string;
}

export interface McpServerCallOutcome {
  text: string;
  isError: boolean;
}

interface StoredServer {
  id: string;
  name: string;
  url: string;
  allowAll: boolean;
  allowedTools: string[];
  /** `value` is null when the credential was sealed on another device or OS user. */
  auth: { header: string; value: string | null } | null;
}

// Credentials are sealed with the project-store cipher, bound to this device, OS user, this scope and the header name.
const SECRET_SCOPE = "mcp-servers";
const UNREADABLE_CREDENTIAL = "The saved credential can't be read on this device or OS user. Set it again.";

function sanitize(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").slice(0, 300);
}

function credentialKey(serverId: string, header: string) {
  return `${serverId}\0${header.toLowerCase()}`;
}

export default class WorkbenchMcpServerController {
  #secret: Promise<Buffer> | null = null;
  readonly #connections = new Map<string, McpServerConnectionPort>();

  constructor(private readonly options: WorkbenchMcpServerOptions) {}

  async read(): Promise<McpServerSettingsSnapshot> {
    const servers = await this.#servers();
    return { servers: await Promise.all(servers.map(async (server): Promise<McpServerSnapshot> => {
      const catalog = await this.#catalog(server);
      return {
        id: server.id, name: server.name, url: server.url, allowAll: server.allowAll, allowedTools: server.allowedTools,
        auth: server.auth ? { header: server.auth.header } : null,
        catalog: catalog.status === "ready"
          ? { status: "ready", tools: catalog.tools.map(tool => ({ name: tool.name, description: tool.description })) }
          : catalog,
      };
    })) };
  }

  async update(input: McpServerSettingsUpdate): Promise<McpServerSettingsSnapshot> {
    const update = McpServerSettingsUpdateSchema.parse(input);
    const servers = await this.#servers();
    if (update.action === "add") {
      if (servers.some(server => server.name === update.name)) throw new Error(`An MCP server named ${update.name} already exists.`);
      const id = randomUUID();
      await this.options.database.executeTransaction([
        insertRow(mcpServers, { id, name: update.name, url: update.url, allow_all: 0, created_at: Date.now() }),
        ...update.auth ? [await this.#sealAuth(id, update.auth)] : [],
      ]);
      return await this.read();
    }
    const server = servers.find(candidate => candidate.id === update.id);
    if (!server) throw new Error("That MCP server no longer exists.");
    switch (update.action) {
      case "remove":
        await this.options.database.executeTransaction([deleteRows(mcpServers, { id: server.id })]);
        await this.#disconnect(server.id);
        break;
      case "setAuth":
        await this.options.database.executeTransaction([update.auth
          ? await this.#sealAuth(server.id, update.auth)
          : deleteRows(mcpServerAuth, { server_id: server.id })]);
        await this.#disconnect(server.id);
        break;
      case "setAllowAll":
        await this.options.database.executeTransaction([updateRows(mcpServers, { allow_all: update.allowAll ? 1 : 0 }, { id: server.id })]);
        break;
      case "setTools":
        await this.options.database.executeTransaction([
          deleteRows(mcpServerTools, { server_id: server.id }),
          ...[...new Set(update.tools)].map(tool => insertRow(mcpServerTools, { server_id: server.id, tool_name: tool })),
        ]);
        break;
      case "refresh":
        await this.#disconnect(server.id);
        break;
    }
    return await this.read();
  }

  /** Allowed tools across servers, or one server's; each unreachable server is reported alongside the rest. */
  async listTools(input: { server?: string; query?: string }, signal: AbortSignal) {
    const servers = (await this.#servers()).filter(server => !input.server || server.name === input.server);
    if (input.server && !servers.length) throw new Error(`No MCP server is named ${input.server}.`);
    const listings = await Promise.all(servers.map(async (server): Promise<McpToolListing> => {
      const catalog = await this.#catalog(server, signal);
      return catalog.status === "ready"
        ? { server: server.name, status: "ready", tools: catalog.tools.filter(tool => this.#allows(server, tool.name)) }
        : { server: server.name, status: "error", detail: catalog.detail };
    }));
    signal.throwIfAborted();
    return formatMcpToolListing(listings, input.query);
  }

  /** Forward one call only when the tool is both allowed and currently offered. */
  async call(input: { server: string; tool: string; arguments: Record<string, unknown> }, signal: AbortSignal): Promise<McpServerCallOutcome> {
    const server = (await this.#servers()).find(candidate => candidate.name === input.server);
    if (!server) throw new Error(`No MCP server is named ${input.server}.`);
    if (!this.#allows(server, input.tool)) throw new Error(`${input.server}/${input.tool} is not allowed. The user can allow it in Settings > Agents > MCP servers.`);
    if (server.auth && server.auth.value === null) throw new Error(UNREADABLE_CREDENTIAL);
    const connection = this.#connection(server);
    const offered = await connection.listTools(signal);
    if (!offered.some(tool => tool.name === input.tool)) throw new Error(`${input.server} does not offer a tool named ${input.tool}.`);
    const result = await connection.callTool(input.tool, input.arguments, signal);
    return { text: formatMcpToolResult(result), isError: result.isError === true };
  }

  async dispose() {
    const connections = [...this.#connections.values()];
    this.#connections.clear();
    const closed = await Promise.allSettled(connections.map(connection => connection.close()));
    const failures = closed.flatMap(result => result.status === "rejected" ? [result.reason] : []);
    if (failures.length) throw new AggregateError(failures, "MCP server connections failed to close.");
  }

  #allows(server: StoredServer, tool: string) {
    return server.allowAll || server.allowedTools.includes(tool);
  }

  async #catalog(server: StoredServer, signal?: AbortSignal): Promise<{ status: "ready"; tools: McpServerTool[] } | { status: "error"; detail: string }> {
    if (server.auth && server.auth.value === null) return { status: "error", detail: UNREADABLE_CREDENTIAL };
    try {
      return { status: "ready", tools: await this.#connection(server).listTools(signal) };
    } catch (error) {
      signal?.throwIfAborted();
      return { status: "error", detail: sanitize(error) || "The server could not be reached." };
    }
  }

  #connection(server: StoredServer) {
    let connection = this.#connections.get(server.id);
    if (!connection) {
      const endpoint = { url: server.url, headers: server.auth?.value ? { [server.auth.header]: server.auth.value } : {} };
      connection = (this.options.connect ?? (value => new McpServerConnection(value)))(endpoint);
      this.#connections.set(server.id, connection);
    }
    return connection;
  }

  async #disconnect(serverId: string) {
    const connection = this.#connections.get(serverId);
    this.#connections.delete(serverId);
    await connection?.close();
  }

  async #sealAuth(serverId: string, auth: { header: string; value: string }) {
    const sealed = sealProjectStoreValue(await this.#key(), SECRET_SCOPE, credentialKey(serverId, auth.header), auth.value);
    return upsertRow(mcpServerAuth, {
      server_id: serverId, header_name: auth.header, nonce: sealed.nonce, ciphertext: sealed.ciphertext, updated_at: Date.now(),
    }, { conflictColumns: ["server_id"], updateColumns: ["header_name", "nonce", "ciphertext", "updated_at"] });
  }

  async #servers(): Promise<StoredServer[]> {
    const [servers, tools, auth] = await Promise.all([
      this.options.database.query(selectRows(mcpServers, { orderBy: [{ column: "created_at" }] })),
      this.options.database.query(selectRows(mcpServerTools, { orderBy: [{ column: "tool_name" }] })),
      this.options.database.query(selectRows(mcpServerAuth)),
    ]);
    const key = auth.length ? await this.#key() : null;
    return servers.map(server => {
      const credential = auth.find(row => row.server_id === server.id);
      return {
        id: server.id, name: server.name, url: server.url, allowAll: server.allow_all === 1,
        allowedTools: tools.filter(row => row.server_id === server.id).map(row => row.tool_name),
        auth: credential && key ? {
          header: credential.header_name,
          value: openProjectStoreValue(key, SECRET_SCOPE, credentialKey(server.id, credential.header_name), credential),
        } : null,
      };
    });
  }

  #key() {
    this.#secret ??= this.options.readDeviceIdentity().then(deviceId => deriveProjectStoreKey({
      deviceId, user: (this.options.user ?? (() => os.userInfo().username))(), projectLocation: SECRET_SCOPE,
    })).catch(error => {
      this.#secret = null;
      throw error;
    });
    return this.#secret;
  }
}
