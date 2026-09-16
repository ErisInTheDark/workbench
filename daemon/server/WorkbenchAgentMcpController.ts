/*
 * Exports:
 * - WorkbenchAgentMcpControllerOptions: inject trusted identity resolution, cancellation, and command execution ports.
 * - default WorkbenchAgentMcpController: serve typed wb tools with caller identity and generation-scoped cancellation.
 */
import type http from "node:http";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createGitArcFailureFromError, formatGitArcFailureReceipt } from "workbench-shared/workbench/git/git-arc-failures";
import { ProviderToolMetadataSchema, type WorkbenchProviderTools } from "workbench-shared/workbench/provider/provider-execution";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CancelledNotificationSchema } from "@modelcontextprotocol/sdk/types.js";

import { adaptWorkbenchAgentCliResponse } from "./lib/workbench/cli/workbench-agent-cli-responses";
import type { DaemonReloadScopeDescriptor } from "workbench-shared/workbench/daemon-reload";
import { listWorkbenchAgentCommands } from "./lib/workbench/commands/workbench-agent-command-registry";
import {
  getWorkbenchAgentCommandToolName,
  type WorkbenchAgentCommandDefinition,
  type WorkbenchAgentCommandRequest,
} from "./lib/workbench/commands/workbench-agent-command-definition";
import {
  getWorkbenchShellAggregatedOutput,
  WORKBENCH_SHELL_MCP_TOOL_NAME,
  WorkbenchShellInputSchema,
  WorkbenchShellResultSchema,
} from "workbench-shared/workbench/commands/workbench-shell-command";
import { logError } from "./process-helpers";
import {
  getProcessWorkbenchAgentMcpRequestRegistry,
  isWorkbenchAgentMcpSteerInterruption,
  type WorkbenchAgentMcpRequestRegistry,
} from "./workbench-agent-mcp-request-registry";

const MAX_REQUEST_BODY_BYTES = 2 * 1024 * 1024;
const LEGACY_MCP_CLIENT_SCOPE = "legacy";
const MCP_CLIENT_SCOPE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
type WorkbenchAgentMcpRequestId = number | string;

export interface WorkbenchAgentMcpControllerOptions {
  tools: (provider: string) => WorkbenchProviderTools;
  executeCommand: (request: WorkbenchAgentCommandRequest, signal: AbortSignal) => Promise<Response>;
  getReloadScopeCatalog?: () => readonly DaemonReloadScopeDescriptor[];
  lifecycleLogError?: (name: string, message: string) => void;
  daemonOrigin: string;
  requestRegistry?: WorkbenchAgentMcpRequestRegistry;
  runLoggedCommand?: <TValue>(
    label: string,
    signal: AbortSignal,
    operation: () => Promise<TValue>,
    succeeded?: (value: TValue) => boolean,
  ) => Promise<TValue>;
}

function isLoopbackAddress(address: string | undefined) {
  if (!address) return false;
  const normalized = address.toLowerCase().split("%")[0];
  return normalized === "::1" || normalized === "127.0.0.1" || normalized.startsWith("127.") || normalized.startsWith("::ffff:127.");
}

async function readJsonBody(request: http.IncomingMessage) {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > MAX_REQUEST_BODY_BYTES) throw new Error("Workbench MCP request is too large.");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as object;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function sanitizeError(error: unknown) {
  const sanitized = errorMessage(error)
    .replace(/\b[A-Za-z]:[\\/][^\s"'<>]*/gu, "[path]")
    .replace(/(^|\s)\/(?:Users|home|private|tmp|var|etc|opt|srv|mnt)\/[^\s"'<>]*/giu, "$1[path]")
    .replace(/\b(Bearer\s+)[^\s,;]+/giu, "$1[redacted]")
    .replace(/\b(api[_-]?key|authorization|secret|token)(\s*[:=]\s*)[^\s,;]+/giu, "$1$2[redacted]")
    .replace(/\s+/gu, " ")
    .trim();
  return sanitized.length > 1000 ? `${sanitized.slice(0, 997).trimEnd()}...` : sanitized;
}

function sendJsonRpcError(response: http.ServerResponse, status: number, message: string) {
  if (response.destroyed || response.writableEnded) return;
  response.statusCode = status;
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message }, id: null }));
}

function readClientScope(url: URL) {
  const value = url.searchParams.get("client")?.trim();
  if (!value) return LEGACY_MCP_CLIENT_SCOPE;
  if (!MCP_CLIENT_SCOPE_PATTERN.test(value)) throw new Error("Workbench MCP client scope is invalid.");
  return value.toLowerCase();
}

export default class WorkbenchAgentMcpController {
  private readonly executeCommand: WorkbenchAgentMcpControllerOptions["executeCommand"];
  private readonly getReloadScopeCatalog: NonNullable<WorkbenchAgentMcpControllerOptions["getReloadScopeCatalog"]>;
  private readonly lifecycleLogError: NonNullable<WorkbenchAgentMcpControllerOptions["lifecycleLogError"]>;
  private readonly daemonOrigin: string;
  private readonly requestRegistry: WorkbenchAgentMcpRequestRegistry;
  private readonly tools: WorkbenchAgentMcpControllerOptions["tools"];
  private readonly runLoggedCommand: NonNullable<WorkbenchAgentMcpControllerOptions["runLoggedCommand"]>;
  private readonly runtimeOwner = {};

  constructor({
    executeCommand,
    getReloadScopeCatalog = () => [],
    lifecycleLogError = logError,
    daemonOrigin,
    tools,
    requestRegistry = getProcessWorkbenchAgentMcpRequestRegistry(),
    runLoggedCommand = async (_label, _signal, operation) => await operation(),
  }: WorkbenchAgentMcpControllerOptions) {
    this.executeCommand = executeCommand;
    this.getReloadScopeCatalog = getReloadScopeCatalog;
    this.lifecycleLogError = lifecycleLogError;
    this.daemonOrigin = daemonOrigin;
    this.requestRegistry = requestRegistry;
    this.tools = tools;
    this.runLoggedCommand = runLoggedCommand;
  }

  beginRuntimeDrain() {
    return this.requestRegistry.beginRuntimeDrain(
      this.runtimeOwner,
      "immediate",
      "Workbench MCP tool call was cancelled because its runtime generation is reloading.",
    );
  }

  expireRuntimeDrain() {
    return this.requestRegistry.beginRuntimeDrain(
      this.runtimeOwner,
      "deadline",
      "Workbench MCP tool call exceeded the runtime-drain deadline.",
    );
  }

  listRuntimeDrainPending() {
    return this.requestRegistry.listRuntimeDrainPending(this.runtimeOwner);
  }

  releaseRuntimeOwner() {
    this.requestRegistry.releaseRuntimeOwner(this.runtimeOwner);
  }

  async handleHttpRequest(request: http.IncomingMessage, response: http.ServerResponse) {
    if (!isLoopbackAddress(request.socket.remoteAddress)) {
      sendJsonRpcError(response, 403, "Workbench MCP is available only over loopback.");
      return;
    }
    if (request.method !== "POST") {
      sendJsonRpcError(response, 405, "Method not allowed.");
      return;
    }

    // The accepted HTTP request owns its response and transport after the reloadable feature lease returns.
    const url = new URL(request.url ?? "/", "http://localhost");
    let clientScope: string;
    let tools: WorkbenchProviderTools;
    try {
      clientScope = readClientScope(url);
      const provider = url.searchParams.get("provider");
      if (!provider) throw new Error("Workbench MCP requires a provider selector.");
      tools = this.tools(provider);
    } catch (error) {
      sendJsonRpcError(response, 400, sanitizeError(error) || "Workbench MCP client scope is invalid.");
      return;
    }
    void this.completeRequest(request, response, clientScope, url.searchParams.get("project-local") === "true", tools);
  }

  private async completeRequest(request: http.IncomingMessage, response: http.ServerResponse, clientScope: string, projectLocal: boolean, tools: WorkbenchProviderTools) {
    const requestAbort = new AbortController();
    const abortDisconnectedRequest = () => {
      if (!requestAbort.signal.aborted) requestAbort.abort(new Error("Workbench MCP caller disconnected."));
    };
    let server: McpServer | undefined;
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      void transport.close().catch(() => undefined);
      if (server) void server.close().catch(() => undefined);
    };
    request.once("aborted", abortDisconnectedRequest);
    response.once("close", () => {
      if (!response.writableEnded) abortDisconnectedRequest();
      close();
    });
    try {
      server = await this.createServer(requestAbort.signal, clientScope, projectLocal, tools);
      requestAbort.signal.throwIfAborted();
      const body = await readJsonBody(request);
      await server.connect(transport);
      await transport.handleRequest(request, response, body);
    } catch (error) {
      const message = sanitizeError(error) || "Workbench MCP request failed.";
      this.lifecycleLogError("workbench-mcp", message);
      sendJsonRpcError(response, 500, message);
    } finally {
      if (response.writableEnded || response.destroyed) close();
    }
  }

  private async createServer(requestSignal: AbortSignal, clientScope: string, projectLocal: boolean, tools: WorkbenchProviderTools) {
    const description = await tools.describe();
    requestSignal.throwIfAborted();
    const server = new McpServer({ name: "wb", version: "1.0.0" }, {
      capabilities: { experimental: description.experimental },
    });
    server.server.setNotificationHandler(CancelledNotificationSchema, (notification) => {
      this.requestRegistry.cancel(clientScope, notification.params.requestId, notification.params.reason);
    });
    const names = new Set<string>();
    names.add(WORKBENCH_SHELL_MCP_TOOL_NAME);
    server.registerTool(WORKBENCH_SHELL_MCP_TOOL_NAME, {
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
        readOnlyHint: false,
      },
      description: description.shellDescription,
      inputSchema: WorkbenchShellInputSchema,
      outputSchema: WorkbenchShellResultSchema,
    }, async (input, extra) => await this.callShell(
      input as object,
      extra._meta,
      clientScope,
      extra.requestId,
      AbortSignal.any([requestSignal, extra.signal]),
      tools,
    ));
    for (const definition of listWorkbenchAgentCommands(this.getReloadScopeCatalog(), "agent")) {
      if (definition.hideFromMcp || (definition.managedThreadRootOnly && !projectLocal)) continue;
      const name = getWorkbenchAgentCommandToolName(definition);
      if (names.has(name)) throw new Error(`Duplicate Workbench MCP tool name: ${name}`);
      names.add(name);
      server.registerTool(name, {
        annotations: {
          destructiveHint: definition.effects.destructive ?? false,
          idempotentHint: definition.effects.idempotent ?? false,
          openWorldHint: definition.effects.openWorld ?? false,
          readOnlyHint: definition.effects.readOnly ?? false,
        },
        description: `${definition.description}\n\nCLI equivalent: ${definition.usage}`,
        inputSchema: definition.inputSchema,
      }, async (input, extra) => await this.callTool(
        definition,
        input as object,
        extra._meta,
        clientScope,
        extra.requestId,
        AbortSignal.any([requestSignal, extra.signal]),
        tools,
      ));
    }
    return server;
  }

  private async callShell(
    input: object,
    meta: Record<string, unknown> | undefined,
    clientScope: string,
    requestId: WorkbenchAgentMcpRequestId,
    signal: AbortSignal,
    tools: WorkbenchProviderTools,
  ) {
    let unregister: (() => void) | null = null;
    try {
      const registration = this.requestRegistry.register(clientScope, requestId, {
        owner: this.runtimeOwner,
        policy: undefined,
        steerInterruptible: false,
        toolName: "shell",
      });
      unregister = registration.unregister;
      signal = AbortSignal.any([signal, registration.signal]);
      const result = await this.runLoggedCommand(
        "wb shell",
        signal,
        async () => {
          return await tools.shell(WorkbenchShellInputSchema.parse(input), ProviderToolMetadataSchema.parse(meta ?? {}), signal);
        },
        (value) => value.exitCode === 0,
      );
      if (signal.aborted) throw signal.reason;
      const output = getWorkbenchShellAggregatedOutput(result);
      return {
        content: [{ type: "text" as const, text: `Exit code: ${result.exitCode}\nOutput:\n${output}` }],
        isError: false,
        structuredContent: result,
      };
    } catch (error) {
      const message = sanitizeError(error) || "Workbench shell tool call failed.";
      if (!signal.aborted || error !== signal.reason) this.lifecycleLogError("workbench-mcp", message);
      return { content: [{ type: "text" as const, text: `Workbench shell failed: ${message}` }], isError: true };
    } finally {
      unregister?.();
    }
  }

  private async callTool(
    definition: WorkbenchAgentCommandDefinition,
    input: object,
    meta: Record<string, unknown> | undefined,
    clientScope: string,
    requestId: WorkbenchAgentMcpRequestId,
    signal: AbortSignal,
    tools: WorkbenchProviderTools,
  ) {
    let unregister: (() => void) | null = null;
    try {
      const toolName = getWorkbenchAgentCommandToolName(definition);
      const registration = this.requestRegistry.register(clientScope, requestId, {
        owner: this.runtimeOwner,
        policy: definition.mcpRuntimeDrainPolicy,
        steerInterruptible: definition.mcpSteerInterruptible,
        toolName,
      });
      unregister = registration.unregister;
      signal = AbortSignal.any([signal, registration.signal]);
      const caller = await tools.caller(ProviderToolMetadataSchema.parse(meta ?? {}), signal);
      if (signal.aborted) throw signal.reason;
      registration.setWorkbenchThreadId(caller.threadId);
      const request = await definition.buildRequestFromJson(input, {
        callerHarness: caller.harness,
        callerThreadId: caller.threadId,
        cwd: caller.cwd,
        workbenchOrigin: this.daemonOrigin,
      });
      if (
        request.waitForReload
        || definition.mcpRuntimeDrainPolicy === "preserve-across-reload"
      ) {
        registration.markDrainIndependent();
      }
      const upstream = await this.executeCommand(request, signal);
      if (signal.aborted) throw signal.reason;
      const text = await upstream.text();
      const adapted = adaptWorkbenchAgentCliResponse({ httpOk: upstream.ok, request, text });
      const success = adapted.exitCode === 0;
      return {
        content: [{ type: "text" as const, text: success ? adapted.stdout : adapted.stderr }],
        isError: !success,
      };
    } catch (error) {
      if (isWorkbenchAgentMcpSteerInterruption(error)) {
        return { content: [], isError: true };
      }
      const message = sanitizeError(error) || "Workbench MCP tool call failed.";
      if (!signal.aborted || error !== signal.reason) this.lifecycleLogError("workbench-mcp", message);
      if (definition.words[0] === "git" && (definition.words[1] === "arc" || definition.words[1] === "plan")) {
        return { content: [{ type: "text" as const, text: formatGitArcFailureReceipt(createGitArcFailureFromError("unknown", error)) }], isError: true };
      }
      return { content: [{ type: "text" as const, text: `Workbench tool call failed: ${message}` }], isError: true };
    } finally {
      unregister?.();
    }
  }
}
