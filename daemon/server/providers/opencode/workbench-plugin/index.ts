/*
 * Exports:
 * - connectLifecycleOwnedCompanionTools: connect MCP tools without the SDK's manufactured request deadline.
 * - createLifecycleOwnedCompanionToolOwner: reuse one client and replace it only after transport failure.
 * - OpenCodeWorkbenchPluginOptions: injectable companion boundaries for focused tests.
 * - createOpenCodeWorkbenchPlugin: create the process-local OpenCode companion.
 * - default plugin: preserve ordinary OpenCode sessions while adapting managed Workbench sessions.
 */
import http from "node:http";
import path from "node:path";
import { Buffer } from "node:buffer";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  CallToolResultSchema,
  InitializeResultSchema,
  LATEST_PROTOCOL_VERSION,
  type CallToolResult,
  type JSONRPCMessage,
  type RequestId,
} from "@modelcontextprotocol/sdk/types.js";
import type { Plugin } from "@opencode/plugin/promise/plugin";
import resolveWorkbenchDataRoot from "workbench-shared/workbench-data-root";
import { readDaemonEndpoint } from "workbench-shared/process/workbench-daemon-endpoint";
import CodeModeToolContextController, {
  WORKBENCH_CODE_MODE_CONTEXT_ARGUMENT,
} from "./CodeModeToolContextController";

const WORKBENCH_PLUGIN_ID = "workbench";
const WORKBENCH_MCP_NAME = "wb";
const NATIVE_COMMAND_TOOLS = new Set(["bash", "shell"]);
const OPENCODE_HOSTED_PROVIDERS = new Set(["opencode", "opencode-go"]);

interface CompanionProxy {
  url: string;
  close: () => Promise<void>;
}

interface CompanionToolClient {
  callTool(input: {
    name: string;
    arguments?: Record<string, unknown>;
    _meta?: Record<string, unknown>;
  }): Promise<CallToolResult>;
  close(): Promise<void>;
}

interface CompanionTransport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  close(): Promise<void>;
  send(message: JSONRPCMessage): Promise<void>;
  setProtocolVersion(version: string): void;
  start(): Promise<void>;
  terminateSession(): Promise<void>;
}

export interface OpenCodeWorkbenchPluginOptions {
  connectTools?: (url: string) => Promise<CompanionToolClient>;
  createProxy?: (contexts: CodeModeToolContextController) => Promise<CompanionProxy>;
  isManagedSession?: (sessionID: string) => Promise<boolean>;
  resolveDaemonOrigin?: () => Promise<string>;
}

export async function connectLifecycleOwnedCompanionTools(
  transport: CompanionTransport,
): Promise<CompanionToolClient> {
  let nextId = 1;
  let closed = false;
  const pending = new Map<RequestId, {
    parse(value: unknown): unknown;
    reject(error: Error): void;
    resolve(value: unknown): void;
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
    if ("error" in message) {
      request.reject(new Error(message.error.message.slice(0, 500)));
      return;
    }
    try {
      request.resolve(request.parse(message.result));
    } catch (error) {
      request.reject(error instanceof Error ? error : new Error("Workbench companion returned an invalid MCP response."));
    }
  };
  const request = async <T>(
    method: string,
    params: Record<string, unknown>,
    parse: (value: unknown) => T,
  ): Promise<T> => {
    if (closed) throw new Error("Workbench companion MCP transport is closed.");
    const id = nextId++;
    const response = new Promise<T>((resolve, reject) => {
      pending.set(id, { parse, resolve: value => resolve(value as T), reject });
    });
    try {
      await transport.send({ jsonrpc: "2.0", id, method, params });
    } catch (error) {
      pending.delete(id);
      throw error;
    }
    return response;
  };

  await transport.start();
  const initialised = await request("initialize", {
    protocolVersion: LATEST_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "workbench-opencode", version: "1.0.0" },
  }, value => InitializeResultSchema.parse(value));
  transport.setProtocolVersion(initialised.protocolVersion);
  await transport.send({ jsonrpc: "2.0", method: "notifications/initialized" });

  return {
    callTool: input => request("tools/call", input, value => CallToolResultSchema.parse(value)),
    close: async () => {
      fail(new Error("Workbench companion MCP client closed."));
      try {
        await transport.terminateSession();
      } finally {
        await transport.close();
      }
    },
  };
}

async function connectCompanionTools(url: string): Promise<CompanionToolClient> {
  return connectLifecycleOwnedCompanionTools(new StreamableHTTPClientTransport(new URL(url)));
}

function adaptToolResult(result: Awaited<ReturnType<CompanionToolClient["callTool"]>>) {
  const content = result.content.flatMap(part => {
    if (part.type === "text") return [part.text];
    if (part.type === "resource" && "text" in part.resource) return [part.resource.text];
    return [];
  }).join("\n");
  if (result.isError) throw new Error(content || "Workbench tool failed.");
  return {
    content,
    output: result.structuredContent ?? result,
  };
}

export function createLifecycleOwnedCompanionToolOwner(
  connect: (url: string) => Promise<CompanionToolClient>,
  url: string,
) {
  interface Connection {
    client: Promise<CompanionToolClient>;
    closing: Promise<void> | null;
  }
  let connection: Connection | null = null;
  const acquire = () => {
    if (!connection) connection = { client: connect(url), closing: null };
    return connection;
  };
  const close = async (owned: Connection) => {
    if (connection === owned) connection = null;
    owned.closing ??= owned.client.then(client => client.close(), () => undefined);
    await owned.closing;
  };
  return {
    async call(input: Parameters<CompanionToolClient["callTool"]>[0]) {
      const owned = acquire();
      let result: CallToolResult;
      try {
        result = await (await owned.client).callTool(input);
      } catch (error) {
        try {
          await close(owned);
        } catch (closeError) {
          throw new AggregateError([error, closeError], "Workbench companion tool call and cleanup both failed.");
        }
        throw error;
      }
      return adaptToolResult(result);
    },
    async close() {
      if (connection) await close(connection);
    },
  };
}

function isWorkbenchTool(tool: string) {
  return tool === WORKBENCH_MCP_NAME || tool.startsWith(`${WORKBENCH_MCP_NAME}_`);
}

function isManagedMetadata(metadata: Record<string, unknown> | undefined) {
  const workbench = metadata?.workbench;
  return Boolean(workbench && typeof workbench === "object"
    && "managed" in workbench && workbench.managed === true);
}

function injectCodeModeToolContext(body: Buffer, contexts: CodeModeToolContextController) {
  if (!body.includes(WORKBENCH_CODE_MODE_CONTEXT_ARGUMENT)) return body;
  const parsed = JSON.parse(body.toString("utf8")) as unknown;
  const messages = Array.isArray(parsed) ? parsed : [parsed];
  for (const message of messages) {
    if (!message || typeof message !== "object" || Array.isArray(message)) continue;
    const request = message as Record<string, unknown>;
    if (request.method !== "tools/call") continue;
    const params = request.params;
    if (!params || typeof params !== "object" || Array.isArray(params)) continue;
    const values = params as Record<string, unknown>;
    const context = contexts.consume(values.arguments);
    if (!context) continue;
    const metadata = values._meta;
    values._meta = {
      ...(metadata && typeof metadata === "object" && !Array.isArray(metadata)
        ? metadata as Record<string, unknown>
        : {}),
      sessionID: context.sessionId,
    };
  }
  return Buffer.from(JSON.stringify(parsed));
}

async function createCompanionProxy(
  contexts: CodeModeToolContextController,
  resolveDaemonOrigin?: () => Promise<string>,
): Promise<CompanionProxy> {
  const server = http.createServer(async (request, response) => {
    const method = request.method;
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (!method || !["DELETE", "GET", "POST"].includes(method) || pathname !== "/mcp") {
      response.writeHead(404).end();
      return;
    }
    const abort = new AbortController();
    request.once("aborted", () => abort.abort(new Error("OpenCode closed the MCP request.")));
    response.once("close", () => {
      if (!response.writableEnded) abort.abort(new Error("OpenCode closed the MCP response."));
    });
    try {
      const body: Buffer[] = [];
      if (method === "POST") {
        for await (const chunk of request) body.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const requestBody = method === "POST"
        ? injectCodeModeToolContext(Buffer.concat(body), contexts)
        : undefined;
      const origin = resolveDaemonOrigin ? await resolveDaemonOrigin() : await (async () => {
        const dataRoot = resolveWorkbenchDataRoot();
        const endpoint = await readDaemonEndpoint(path.join(dataRoot, "daemon", "runtime.json"));
        if (!endpoint) throw new Error("Workbench daemon is unavailable.");
        return endpoint.origin;
      })();
      const headers = new Headers();
      for (const name of ["accept", "content-type", "last-event-id", "mcp-protocol-version", "mcp-session-id"]) {
        const value = request.headers[name];
        if (typeof value === "string") headers.set(name, value);
      }
      if (!headers.has("accept")) headers.set("accept", "application/json, text/event-stream");
      const upstream = await fetch(new URL("/daemon/mcp?provider=opencode", origin), {
        method,
        headers,
        ...(requestBody ? { body: new Uint8Array(requestBody) } : {}),
        signal: abort.signal,
      });
      const responseHeaders = Object.fromEntries([...upstream.headers.entries()]
        .filter(([name]) => !["connection", "content-length", "transfer-encoding"].includes(name.toLowerCase())));
      response.writeHead(upstream.status, responseHeaders);
      if (!upstream.body) response.end();
      else await pipeline(Readable.fromWeb(upstream.body), response);
    } catch (error) {
      if (response.destroyed || response.headersSent) return;
      const message = error instanceof Error ? error.message : "Unknown Workbench companion failure.";
      response.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
      response.end(`${message.slice(0, 500)}\n`);
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise<void>(resolve => server.close(() => resolve()));
    throw new Error("OpenCode Workbench companion did not bind a loopback listener.");
  }
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}

export function createOpenCodeWorkbenchPlugin(
  options: OpenCodeWorkbenchPluginOptions = {},
): Plugin {
  return {
    id: WORKBENCH_PLUGIN_ID,
    setup: async context => {
      const toolContexts = new CodeModeToolContextController();
      const proxy = await (options.createProxy ?? (contexts =>
        createCompanionProxy(contexts, options.resolveDaemonOrigin)))(toolContexts);
      const connectTools = options.connectTools ?? connectCompanionTools;
      const tools = createLifecycleOwnedCompanionToolOwner(connectTools, proxy.url);
      const isManagedSession = options.isManagedSession ?? (async sessionID =>
        isManagedMetadata((await context.session.get({ sessionID })).metadata));
      const registrations = await Promise.all([
        context.mcp.transform(editor => {
          editor.set(WORKBENCH_MCP_NAME, { type: "remote", url: proxy.url });
        }),
        context.tool.transform(editor => {
          for (const tool of editor.list()) {
            if (!isWorkbenchTool(tool.id)) continue;
            editor.update(tool.id, value => {
              value.execute = async (input, toolContext) => {
                const correlated = toolContexts.consume(input);
                return await tools.call({
                  name: tool.id.slice(`${WORKBENCH_MCP_NAME}_`.length),
                  arguments: input as Record<string, unknown>,
                  _meta: { sessionID: correlated?.sessionId ?? toolContext.sessionID },
                });
              };
            });
          }
        }),
        context.session.hook("context", async input => {
          const managed = await isManagedSession(input.sessionID);
          for (const tool of Object.keys(input.tools)) {
            if (managed ? NATIVE_COMMAND_TOOLS.has(tool) : isWorkbenchTool(tool)) {
              delete input.tools[tool];
            }
          }
        }),
        context.session.hook("http.request", input => {
          if (OPENCODE_HOSTED_PROVIDERS.has(input.model.providerID)) {
            const headers = new Headers(input.request.headers);
            headers.set("x-opencode-session", input.sessionID);
            headers.set("user-agent", `opencode/${context.app.version}`);
            input.request = new Request(input.request, { headers });
          }
        }),
        context.tool.hook("execute.before", async input => {
          const managed = await isManagedSession(input.sessionID);
          if (NATIVE_COMMAND_TOOLS.has(input.tool) && managed) {
            throw new Error(`Native OpenCode tool ${input.tool} is unavailable in a managed Workbench session.`);
          }
          if (isWorkbenchTool(input.tool) && managed) {
            toolContexts.issue(input.input, {
              callId: input.id,
              sessionId: input.sessionID,
              tool: input.tool,
            });
          }
        }),
        context.tool.hook("execute.after", input => {
          if (isWorkbenchTool(input.tool)) toolContexts.release(input.input);
        }),
      ]);
      return async () => {
        await Promise.allSettled(registrations.map(registration => registration.dispose()));
        await tools.close();
        await proxy.close();
        toolContexts.dispose();
      };
    },
  };
}

export default createOpenCodeWorkbenchPlugin();
