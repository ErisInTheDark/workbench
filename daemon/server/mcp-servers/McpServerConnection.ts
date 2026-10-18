/*
 * Exports:
 * - McpServerEndpoint: url and request headers of one user-added MCP server.
 * - McpServerTool: one offered tool with its input schema.
 * - McpServerConnectionPort: the catalogue/call/close surface the server controller depends on.
 * - default McpServerConnection: SDK streamable-HTTP client for one server, authenticated by a header or OAuth; caches the catalogue until the server reports a change, reconnects after transport failure and reports a needed sign-in as McpServerSignInRequiredError.
 */
import { UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { OAuthError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { McpServerSignInRequiredError } from "./McpServerOAuthProvider";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema, McpError, ToolListChangedNotificationSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export interface McpServerEndpoint {
  url: string;
  headers: Record<string, string>;
  /** OAuth sign-in for servers without a credential header; the SDK refreshes its tokens on 401. */
  authProvider?: OAuthClientProvider;
}

export interface McpServerTool {
  name: string;
  title?: string | null;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpServerConnectionPort {
  listTools(signal?: AbortSignal): Promise<McpServerTool[]>;
  /** The `serverInfo.name` the server reported when its session started. */
  serverName(): Promise<string | null>;
  callTool(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<CallToolResult>;
  close(): Promise<void>;
}

const CATALOGUE_TIMEOUT_MS = 20_000;
// Matches the direct wb tool ceiling; connection waits such as Composio's can legitimately run for minutes.
const CALL_TIMEOUT_MS = 30 * 60_000;
const MAX_CATALOGUE_PAGES = 50;

function describeFailure(error: unknown, signedIn: boolean) {
  // A failed refresh or a missing sign-in both mean the user must sign in again.
  if (signedIn && (error instanceof UnauthorizedError || error instanceof OAuthError)) return new McpServerSignInRequiredError();
  if (error instanceof StreamableHTTPError && (error.code === 401 || error.code === 403)) {
    return new Error(`The server rejected the credential (${error.code}). Check the credential header and value.`, { cause: error });
  }
  // The SDK embeds the whole response body (often an HTML page) in its message; the status says enough.
  if (error instanceof StreamableHTTPError && error.code !== undefined && error.code > 0) {
    return new Error(`The URL answered HTTP ${error.code} instead of an MCP server. Check the URL.`, { cause: error });
  }
  return error;
}

export default class McpServerConnection implements McpServerConnectionPort {
  #client: Promise<Client> | null = null;
  #tools: Promise<McpServerTool[]> | null = null;

  constructor(private readonly endpoint: McpServerEndpoint) {}

  listTools(signal?: AbortSignal) {
    const tools = this.#tools ??= this.#use(client => this.#readCatalogue(client, signal));
    // A failed or cancelled read must not stay cached for the next caller.
    tools.catch(() => { if (this.#tools === tools) this.#tools = null; });
    return tools;
  }

  serverName() {
    return this.#use(async client => client.getServerVersion()?.name?.trim() || null);
  }

  callTool(name: string, args: Record<string, unknown>, signal: AbortSignal) {
    return this.#use(async client => CallToolResultSchema.parse(await client.callTool({ name, arguments: args }, CallToolResultSchema, {
      signal, timeout: CALL_TIMEOUT_MS, resetTimeoutOnProgress: true,
    })));
  }

  async close() {
    const client = this.#client;
    this.#client = null;
    this.#tools = null;
    if (client) await client.then(value => value.close(), () => undefined);
  }

  async #readCatalogue(client: Client, signal?: AbortSignal) {
    const tools: McpServerTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_CATALOGUE_PAGES; page += 1) {
      const result = await client.listTools(cursor ? { cursor } : {}, { signal, timeout: CATALOGUE_TIMEOUT_MS });
      tools.push(...result.tools.map(tool => ({
        name: tool.name, title: tool.title ?? tool.annotations?.title ?? null, description: tool.description ?? "", inputSchema: tool.inputSchema as Record<string, unknown>,
      })));
      cursor = result.nextCursor;
      if (!cursor) return tools;
    }
    throw new Error(`The server's tool list exceeded ${MAX_CATALOGUE_PAGES} pages.`);
  }

  /** Protocol errors leave the session usable; any other failure drops it so the next use reconnects. */
  async #use<T>(operation: (client: Client) => Promise<T>) {
    const session = this.#session();
    try {
      return await operation(await session);
    } catch (error) {
      if (!(error instanceof McpError) && this.#client === session) await this.close();
      throw describeFailure(error, this.endpoint.authProvider !== undefined);
    }
  }

  #session() {
    if (this.#client) return this.#client;
    const session = this.#connect();
    const forget = () => {
      if (this.#client !== session) return;
      this.#client = null;
      this.#tools = null;
    };
    session.then(client => { client.onclose = forget; }, forget);
    return this.#client = session;
  }

  async #connect() {
    const client = new Client({ name: "workbench", version: "1.0.0" }, { capabilities: {} });
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => { this.#tools = null; });
    const transport = new StreamableHTTPClientTransport(new URL(this.endpoint.url), {
      requestInit: { headers: this.endpoint.headers },
      ...this.endpoint.authProvider ? { authProvider: this.endpoint.authProvider } : {},
    });
    try {
      await client.connect(transport, { timeout: CATALOGUE_TIMEOUT_MS });
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    }
    return client;
  }
}
