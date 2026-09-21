/*
 * Exports:
 * - CompanionToolClient/CompanionToolTransport: injected MCP connection boundaries.
 * - connectLifecycleOwnedCompanionTools: connect without a manufactured request deadline.
 * - default OpenCodeCompanionToolsController: own catalogue, correlated calls, claim checks and connection disposal.
 */
import { randomUUID } from "node:crypto";
import path from "node:path";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  CallToolResultSchema, InitializeResultSchema, ListToolsResultSchema, LATEST_PROTOCOL_VERSION,
  type CallToolResult, type JSONRPCMessage, type RequestId, type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { ToolContext, ToolEditor } from "@opencode/plugin/promise/tool";
import resolveWorkbenchDataRoot from "workbench-shared/workbench-data-root";
import { readDaemonEndpoint } from "workbench-shared/process/workbench-daemon-endpoint";
import { OpenCodeFileClaimResultSchema } from "../opencode-workbench-rpc";

export interface CompanionToolClient {
  listTools(cursor?: string): Promise<{ tools: Tool[]; nextCursor?: string }>;
  callTool(input: { name: string; arguments?: Record<string, unknown>; _meta?: Record<string, unknown> }): Promise<CallToolResult>;
  close(): Promise<void>;
}

export interface CompanionToolTransport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  close(): Promise<void>;
  send(message: JSONRPCMessage): Promise<void>;
  setProtocolVersion(version: string): void;
  start(): Promise<void>;
  terminateSession(): Promise<void>;
}

export async function connectLifecycleOwnedCompanionTools(transport: CompanionToolTransport): Promise<CompanionToolClient> {
  let nextId = 1;
  let closed = false;
  const pending = new Map<RequestId, {
    parse(value: unknown): unknown; reject(error: Error): void; resolve(value: unknown): void;
  }>();
  const fail = (error: Error) => {
    if (closed) return;
    closed = true;
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  transport.onclose = () => fail(new Error("Workbench companion MCP transport closed."));
  transport.onerror = error => fail(error);
  transport.onmessage = message => {
    if (!("id" in message) || "method" in message) return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if ("error" in message) return request.reject(new Error(message.error.message.slice(0, 500)));
    try {
      request.resolve(request.parse(message.result));
    } catch (error) {
      request.reject(error instanceof Error ? error : new Error("Invalid Workbench MCP response."));
    }
  };
  const request = async <T>(method: string, params: Record<string, unknown>, parse: (value: unknown) => T): Promise<T> => {
    if (closed) throw new Error("Workbench companion MCP transport is closed.");
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { parse, resolve: value => resolve(value as T), reject });
      // Sending and transport callbacks can fail together. Both settle this one
      // request, never a second promise left unobserved while send is pending.
      void Promise.resolve().then(() => transport.send({ jsonrpc: "2.0", id, method, params })).catch(error => {
        pending.delete(id);
        reject(error);
      });
    });
  };
  try {
    await transport.start();
    const initialised = await request("initialize", {
      protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {},
      clientInfo: { name: "workbench-opencode", version: "1.0.0" },
    }, value => InitializeResultSchema.parse(value));
    transport.setProtocolVersion(initialised.protocolVersion);
    await transport.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  } catch (error) {
    fail(new Error("Workbench companion initialisation failed."));
    try { await transport.close(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], "Companion initialisation and cleanup failed."); }
    throw error;
  }
  return {
    listTools: cursor => request("tools/list", cursor ? { cursor } : {}, value => ListToolsResultSchema.parse(value)),
    // A progress token lets the daemon stream keepalive progress notifications, so an
    // idle HTTP response stream is not reaped by the runtime before a long wait ends.
    callTool: input => request("tools/call", {
      ...input,
      _meta: { ...input._meta, progressToken: input._meta?.progressToken ?? randomUUID() },
    }, value => CallToolResultSchema.parse(value)),
    close: async () => {
      fail(new Error("Workbench companion MCP client closed."));
      try { await transport.terminateSession(); }
      finally { await transport.close(); }
    },
  };
}

async function daemonOrigin() {
  const endpoint = await readDaemonEndpoint(path.join(resolveWorkbenchDataRoot(), "daemon", "runtime.json"));
  if (!endpoint) throw new Error("Workbench daemon is unavailable.");
  return endpoint.origin;
}

interface CompanionConnection {
  client: Promise<CompanionToolClient>;
  closing: Promise<void> | null;
}

export default class OpenCodeCompanionToolsController {
  private connection: CompanionConnection | null = null;
  private readonly lifetime = new AbortController();
  private catalogue: Tool[] = [];

  constructor(private readonly options: {
    isManagedSession(sessionID: string): Promise<boolean>;
    resolveDaemonOrigin?: () => Promise<string>;
    connectTools?: (url: string) => Promise<CompanionToolClient>;
    fetch?: typeof fetch;
  }) {}

  private origin() { return (this.options.resolveDaemonOrigin ?? daemonOrigin)(); }

  private acquire() {
    this.lifetime.signal.throwIfAborted();
    if (this.connection) return this.connection;
    const client = this.origin().then(origin => {
      this.lifetime.signal.throwIfAborted();
      const endpoint = new URL("/daemon/mcp?provider=opencode", origin);
      endpoint.searchParams.set("client", randomUUID());
      const url = endpoint.href;
      return this.options.connectTools
        ? this.options.connectTools(url)
        : connectLifecycleOwnedCompanionTools(new StreamableHTTPClientTransport(new URL(url), {
          // Resolve daemon location per request, retaining endpoint discovery across daemon restarts.
          fetch: async (input, init) => {
            const current = new URL(await this.origin());
            const target = new URL(input);
            target.protocol = current.protocol;
            target.host = current.host;
            return (this.options.fetch ?? fetch)(target, {
              ...init,
              // Session termination is cleanup, not another operation in the cancelled lifetime.
              signal: init?.method === "DELETE" ? init.signal
                : AbortSignal.any([this.lifetime.signal, ...(init?.signal ? [init.signal] : [])]),
            });
          },
        }));
    });
    return this.connection = { client, closing: null };
  }

  private close(connection: CompanionConnection) {
    if (this.connection === connection) this.connection = null;
    // A rejected acquisition owns no client; its original error is propagated by call().
    return connection.closing ??= connection.client.then(client => client.close(), () => undefined);
  }

  private async call<T>(operation: (client: CompanionToolClient) => Promise<T>) {
    const connection = this.acquire();
    try {
      const client = await connection.client;
      this.lifetime.signal.throwIfAborted();
      return await operation(client);
    } catch (error) {
      try { await this.close(connection); }
      catch (cleanup) {
        throw new AggregateError([error, cleanup], "Workbench companion request and cleanup failed.");
      }
      throw error;
    }
  }

  async load() {
    const catalogue: Tool[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await this.call(client => client.listTools(cursor));
      catalogue.push(...page.tools);
      cursor = page.nextCursor;
      if (cursor && cursors.has(cursor)) throw new Error("Workbench MCP catalogue repeated a cursor.");
      if (cursor) cursors.add(cursor);
    } while (cursor);
    this.catalogue = catalogue;
  }

  register(editor: ToolEditor) {
    for (const tool of this.catalogue) {
      editor.add({
        name: tool.name,
        description: tool.description ?? "",
        options: { namespace: "wb" },
        input: tool.inputSchema,
        output: tool.outputSchema ?? {},
        execute: (input, context) => this.execute(tool.name, input, context),
      });
    }
  }

  private async execute(name: string, input: unknown, context: ToolContext) {
    if (!await this.options.isManagedSession(context.sessionID)) {
      throw new Error("Workbench tools are unavailable outside managed Workbench sessions.");
    }
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Workbench tools require object input.");
    const result = await this.call(client => client.callTool({
      name, arguments: input as Record<string, unknown>,
      _meta: { sessionID: context.sessionID, workbenchTool: {
        childID: randomUUID(), parentID: context.id, assistantMessageID: context.messageID,
      } },
    }));
    const content = result.content.flatMap(part => {
      if (part.type === "text") return [part.text];
      if (part.type === "resource" && "text" in part.resource) return [part.resource.text];
      return [];
    }).join("\n");
    if (result.isError) throw new Error(content || "Workbench tool failed.");
    return { content, output: result.structuredContent ?? result };
  }

  async checkFiles(sessionID: string, resources: readonly string[], cwd: string) {
    const form = new URLSearchParams({
      cwd, callerHarness: "opencode",
      hookInput: JSON.stringify({ sessionID, resources }),
    });
    form.append("arg", "__hook");
    form.append("arg", "file-change-claim");
    const response = await (this.options.fetch ?? fetch)(new URL("/daemon/agent-command", await this.origin()), {
      method: "POST", body: form, signal: this.lifetime.signal,
    });
    if (!response.ok) throw new Error(`Workbench file claim check failed (${response.status}).`);
    return OpenCodeFileClaimResultSchema.parse(await response.json());
  }

  async dispose() {
    this.lifetime.abort(new Error("Workbench companion disposed."));
    const connection = this.connection;
    this.connection = null;
    if (connection) await this.close(connection);
  }
}
