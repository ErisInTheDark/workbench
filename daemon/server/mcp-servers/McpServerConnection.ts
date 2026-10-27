/*
 * Exports:
 * - McpServerTrafficFrame: one recorded JSON-RPC message exchanged with a server.
 * - McpServerLaunch: command, arguments, directory and extra environment of a local stdio server process.
 * - McpServerEndpoint: one user-added MCP server's HTTP url and auth, or stdio launch, plus an optional traffic recorder.
 * - McpServerTool: one offered tool with its input schema.
 * - McpServerConnectionPort: the catalogue/call/close surface the server controller depends on.
 * - boundedFetch: `fetch` whose response bodies fail past a byte limit.
 * - stderrReason: the reason a stopped local server gave on stderr, reading JSON log records and skipping stack frames.
 * - default McpServerConnection: SDK client for one server over streamable HTTP (authenticated by a header or OAuth) or a stdio child process whose stderr explains its failures; caches the catalogue until the server reports a change (or for 30 s when it never promised to), reconnects after transport failure and reports a needed sign-in as McpServerSignInRequiredError.
 */
import { UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { OAuthError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { McpServerSignInRequiredError } from "./McpServerOAuthProvider";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpWrapperSession } from "./wrappers/mcp-wrapper";
import {
  CallToolResultSchema, ErrorCode, McpError, ToolListChangedNotificationSchema,
  type CallToolResult, type JSONRPCMessage, type MessageExtraInfo,
} from "@modelcontextprotocol/sdk/types.js";

export interface McpServerTrafficFrame {
  direction: "in" | "out";
  /** The request or notification method, or `result`/`error` for replies. */
  label: string;
  /** The exact JSON-RPC body; credentials travel in HTTP headers and never appear here. */
  payload: string;
}

/** A local server process, spoken to over its stdin and stdout. */
export interface McpServerLaunch {
  command: string;
  args: string[];
  cwd: string;
  /** Added to the SDK's safe inherited environment. */
  env?: Record<string, string>;
}

export type McpServerEndpoint = {
  /** Receives every JSON-RPC message exchanged with the server, for `wb debug mcp`. */
  record?: (frame: McpServerTrafficFrame) => void;
} & ({
  transport: "http";
  url: string;
  headers: Record<string, string>;
  /** OAuth sign-in for servers without a credential header; the SDK refreshes its tokens on 401. */
  authProvider?: OAuthClientProvider;
  /** Fails any one HTTP response body larger than this, so an untrusted server cannot flood the daemon. */
  maxResponseBytes?: number;
} | {
  transport: "stdio";
  /** Resolved at each (re)connect, so a missing install can be restored first. */
  launch: () => Promise<McpServerLaunch>;
});

export interface McpServerTool {
  name: string;
  title?: string | null;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpServerConnectionPort {
  /** Tools the server lists directly; a search-based (wrapped) server lists none and answers `wrapped` instead. */
  listTools(signal?: AbortSignal): Promise<McpServerTool[]>;
  /** The inner-tool session when the server is a known meta-tool wrapper; null when it offers its tools directly. */
  wrapped?(signal?: AbortSignal): Promise<McpWrapperSession | null>;
  /** The `serverInfo.name` the server reported when its session started. */
  serverName(): Promise<string | null>;
  /** `meta` travels as the request's `_meta`, such as the calling thread a project-scoped server needs. */
  callTool(name: string, args: Record<string, unknown>, signal: AbortSignal, meta?: Record<string, unknown>): Promise<CallToolResult>;
  close(): Promise<void>;
}

const CATALOGUE_TIMEOUT_MS = 20_000;
// Matches the direct wb tool ceiling; connection waits such as Composio's can legitimately run for minutes.
const CALL_TIMEOUT_MS = 30 * 60_000;
const MAX_CATALOGUE_PAGES = 50;
// Long enough that one agent burst (search, request, call) shares a read; short enough that toolbox edits show up.
const UNPROMISED_CATALOGUE_MAX_AGE_MS = 30_000;

function trafficLabel(message: JSONRPCMessage) {
  if ("method" in message) return message.method;
  return "error" in message ? "error" : "result";
}

/** Taps both directions; `onmessage` is intercepted by accessor because the client assigns it during `connect`, before `initialize` answers. */
function recordTraffic(transport: Transport, record: (frame: McpServerTrafficFrame) => void) {
  const send = transport.send.bind(transport);
  transport.send = (message, options) => {
    record({ direction: "out", label: trafficLabel(message), payload: JSON.stringify(message) });
    return send(message, options);
  };
  let receive: Transport["onmessage"];
  Object.defineProperty(transport, "onmessage", {
    configurable: true,
    get: () => receive && ((message: JSONRPCMessage, extra?: MessageExtraInfo) => {
      record({ direction: "in", label: trafficLabel(message), payload: JSON.stringify(message) });
      receive!(message, extra);
    }),
    set: (handler: Transport["onmessage"]) => { receive = handler; },
  });
}

/**
 * `fetch` whose response bodies error once they pass `limit` bytes, calling `overflowed` with that error; streamed (SSE) bodies
 * count across the whole stream.
 */
export function boundedFetch(limit: number, overflowed: (error: Error) => void, base: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const response = await base(input, init);
    if (!response.body) return response;
    let received = 0;
    const counted = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        received += chunk.byteLength;
        if (received > limit) {
          const size = limit >= 1_048_576 ? `${Math.round(limit / 1_048_576)} MiB` : `${limit} bytes`;
          const error = new Error(`The server sent more than ${size} in one response.`);
          controller.error(error);
          overflowed(error);
        }
        else controller.enqueue(chunk);
      },
    }));
    return new Response(counted, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}

const STDERR_TAIL = 16 * 1024;

/** A JSON log record's message (first line) and whether it is an error, as winston/pino-style loggers write them. */
function logRecord(line: string): { text: string; error: boolean } | null {
  if (!line.startsWith("{")) return null;
  try {
    const record = JSON.parse(line) as { message?: unknown; msg?: unknown; level?: unknown };
    const message = typeof record.message === "string" ? record.message : typeof record.msg === "string" ? record.msg : null;
    if (message === null) return null;
    // pino writes numeric levels; 50 and up are error and fatal.
    const error = typeof record.level === "number" ? record.level >= 50 : /^(error|fatal|crit)/iu.test(String(record.level ?? ""));
    return { text: message.split(/\r?\n/u)[0]!.trim(), error };
  } catch {
    return null;
  }
}

/**
 * What a stopped local server said about why: its last error log record when it logs JSON, else its last lines without stack frames
 * or Node's version footer. A tail that filled up starts mid-line, so that first line is dropped.
 */
export function stderrReason(stderr: string, truncated: boolean) {
  const lines = stderr.split(/\r?\n/u).slice(truncated ? 1 : 0).map(line => line.trim())
    .filter(line => line && !/^at\s/u.test(line) && !/^Node\.js v\d/u.test(line) && line !== "^");
  const said = lines.map(line => logRecord(line) ?? { text: line, error: false });
  const error = said.findLast(entry => entry.error);
  return (error ? error.text : said.slice(-3).map(entry => entry.text).join(" ")).slice(-240);
}

function describeFailure(error: unknown, signedIn: boolean, stderr: { text: string; truncated: boolean }) {
  // A local server explains its own failures on stderr; the transport only says the pipe closed.
  const said = stderrReason(stderr.text, stderr.truncated);
  if (said && error instanceof McpError && error.code === ErrorCode.ConnectionClosed) {
    return new Error(`The server stopped: ${said}`, { cause: error });
  }
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
  /** Recent stderr of the current local server process, and whether older output was dropped; empty for HTTP servers. */
  #stderr = { text: "", truncated: false };
  /** When the cached list was read from a server that never promised change notifications; null while it may be kept. */
  #toolsReadAt: number | null = null;
  /** Why the session was last closed for an oversized response; it explains the failures that close caused. */
  #overflow: Error | null = null;

  constructor(private readonly endpoint: McpServerEndpoint, private readonly options: { now?: () => number } = {}) {}

  listTools(signal?: AbortSignal) {
    if (this.#tools && this.#toolsReadAt !== null && this.#now() - this.#toolsReadAt >= UNPROMISED_CATALOGUE_MAX_AGE_MS) {
      this.#tools = null;
      // Cleared so callers arriving while the re-read is in flight share it instead of starting another.
      this.#toolsReadAt = null;
    }
    const tools = this.#tools ??= this.#use(async client => {
      const read = await this.#readCatalogue(client, signal);
      // Only a server that promises `tools/list_changed` may keep its list until it reports a change.
      if (this.#tools === tools) this.#toolsReadAt = client.getServerCapabilities()?.tools?.listChanged === true ? null : this.#now();
      return read;
    });
    // A failed or cancelled read must not stay cached for the next caller.
    tools.catch(() => { if (this.#tools === tools) this.#tools = null; });
    return tools;
  }

  #now() { return (this.options.now ?? Date.now)(); }

  serverName() {
    return this.#use(async client => client.getServerVersion()?.name?.trim() || null);
  }

  callTool(name: string, args: Record<string, unknown>, signal: AbortSignal, meta?: Record<string, unknown>) {
    const params = { name, arguments: args, ...meta ? { _meta: meta } : {} };
    return this.#use(async client => CallToolResultSchema.parse(await client.callTool(params, CallToolResultSchema, {
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
      const overflow = this.#overflow;
      this.#overflow = null;
      if (overflow) throw overflow;
      throw describeFailure(error, this.endpoint.transport === "http" && this.endpoint.authProvider !== undefined, this.#stderr);
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
    const transport = await this.#transport();
    if (this.endpoint.record) recordTraffic(transport, this.endpoint.record);
    try {
      await client.connect(transport, { timeout: CATALOGUE_TIMEOUT_MS });
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    }
    return client;
  }

  async #transport(): Promise<Transport> {
    const endpoint = this.endpoint;
    if (endpoint.transport === "http") {
      const transport: StreamableHTTPClientTransport = new StreamableHTTPClientTransport(new URL(endpoint.url), {
        requestInit: { headers: endpoint.headers },
        ...endpoint.authProvider ? { authProvider: endpoint.authProvider } : {},
        // A failed stream alone leaves its pending requests waiting out their timeouts; closing the transport rejects them now.
        ...endpoint.maxResponseBytes === undefined ? {} : {
          fetch: boundedFetch(endpoint.maxResponseBytes, error => {
            this.#overflow = error;
            void transport.close();
          }),
        },
      });
      return transport;
    }
    const launch = await endpoint.launch();
    this.#stderr = { text: "", truncated: false };
    const transport = new StdioClientTransport({ ...launch, stderr: "pipe" });
    transport.stderr?.on("data", (chunk: Buffer) => {
      const text = this.#stderr.text + chunk.toString("utf8");
      this.#stderr = { text: text.slice(-STDERR_TAIL), truncated: this.#stderr.truncated || text.length > STDERR_TAIL };
    });
    return transport;
  }
}
