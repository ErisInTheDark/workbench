/*
 * Exports:
 * - WorkbenchMcpScope: plain per-request client, provider and catalogue selection.
 * - WorkbenchMcpToolCall/WorkbenchMcpDetachedCall/WorkbenchMcpToolStep/WorkbenchMcpCallOutcome: step contracts between ingress and generation, for detached commands and shells.
 * - WorkbenchMcpToolGeneration: the current MCP generation's short describe, call and finish steps.
 * - scheduleWorkbenchMcpProgress: request-owned 60s progress keepalive.
 * - sanitizeWorkbenchMcpError: bounded error text without paths or secrets.
 * - sendWorkbenchMcpJsonRpcError: write a JSON-RPC error when the response is still open.
 * - serveWorkbenchMcpHttpRequest: own one MCP HTTP request, resolving the current generation at every step.
 *
 * Long waits outlive the generation that started them. Everything they keep alive is created here, so this module
 * must stay tiny: any closure from a reloadable feature module would pin that module's whole import graph.
 */
import type http from "node:http";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema, CancelledNotificationSchema, ListToolsRequestSchema,
  type CallToolResult, type Tool,
} from "@modelcontextprotocol/sdk/types.js";

import type { WorkbenchAgentCommandRequest } from "./lib/workbench/commands/workbench-agent-command-definition";
import type { WorkbenchAgentMcpRequestRegistry } from "./workbench-agent-mcp-request-registry";
import type { WorkbenchPreparedShell, WorkbenchShellRun, WorkbenchShellRunResult } from "./provider-execution";

const MAX_REQUEST_BODY_BYTES = 2 * 1024 * 1024;

type WorkbenchMcpRequestId = number | string;

export interface WorkbenchMcpScope {
  clientScope: string;
  projectLocal: boolean;
  provider: string;
  subagent: boolean;
}

export interface WorkbenchMcpToolCall {
  arguments: Record<string, unknown> | undefined;
  /** Set by ingress that runs detached shells; a generation newer than its ingress runs them inline otherwise. */
  detachableShell?: boolean;
  meta: Record<string, unknown> | undefined;
  name: string;
  requestId: WorkbenchMcpRequestId;
  sendProgress?: (progress: number) => Promise<void>;
  signal: AbortSignal;
}

/**
 * A prepared command or shell whose wait runs here, outside every reloadable generation. Plain data and registry
 * handles only. A shell call carries its prepared run in `shell`; otherwise `request` is a Workbench command.
 */
export type WorkbenchMcpDetachedCall = {
  /** Test-injected executor; production re-enters the registry's current command generation. */
  execute?: (request: WorkbenchAgentCommandRequest, signal: AbortSignal) => Promise<Response>;
  /** Test-injected shell runner; production runs through the registry's exec-node runner. */
  executeShell?: (run: WorkbenchShellRun, signal: AbortSignal) => Promise<WorkbenchShellRunResult>;
  keepalive: boolean;
  /** Test-injected keepalive scheduler; production uses `scheduleWorkbenchMcpProgress`. */
  scheduleProgress?: (pulse: () => Promise<void>, signal: AbortSignal) => () => void;
  signal: AbortSignal;
  toolName: string;
  transcript: object | null;
  unregister: () => void;
} & ({ request: WorkbenchAgentCommandRequest; shell?: undefined } | { request?: undefined; shell: WorkbenchPreparedShell });

export type WorkbenchMcpToolStep =
  | { kind: "result"; result: CallToolResult }
  | { kind: "detached"; call: WorkbenchMcpDetachedCall };

export type WorkbenchMcpCallOutcome = { response: Response } | { shellResult: WorkbenchShellRunResult } | { error: unknown };

export interface WorkbenchMcpToolGeneration {
  describe(scope: WorkbenchMcpScope, signal: AbortSignal): Promise<{ experimental: Record<string, object>; tools: Tool[] }>;
  call(scope: WorkbenchMcpScope, call: WorkbenchMcpToolCall): Promise<WorkbenchMcpToolStep>;
  finish(scope: WorkbenchMcpScope, call: WorkbenchMcpDetachedCall, outcome: WorkbenchMcpCallOutcome): Promise<CallToolResult>;
}

export function scheduleWorkbenchMcpProgress(pulse: () => Promise<void>, signal: AbortSignal) {
  let stopped = false;
  let inFlight = Promise.resolve();
  const run = () => {
    if (stopped || signal.aborted) return;
    inFlight = inFlight.then(async () => {
      if (!stopped && !signal.aborted) await pulse();
    });
  };
  run();
  const timer = setInterval(run, 60_000);
  timer.unref();
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    signal.removeEventListener("abort", stop);
  };
  signal.addEventListener("abort", stop, { once: true });
  return stop;
}

export function sanitizeWorkbenchMcpError(error: unknown) {
  const sanitized = (error instanceof Error ? error.message : String(error))
    .replace(/\b[A-Za-z]:[\\/][^\s"'<>]*/gu, "[path]")
    .replace(/(^|\s)\/(?:Users|home|private|tmp|var|etc|opt|srv|mnt)\/[^\s"'<>]*/giu, "$1[path]")
    .replace(/\b(Bearer\s+)[^\s,;]+/giu, "$1[redacted]")
    .replace(/\b(api[_-]?key|authorization|secret|token)(\s*[:=]\s*)[^\s,;]+/giu, "$1$2[redacted]")
    .replace(/\s+/gu, " ")
    .trim();
  return sanitized.length > 1000 ? `${sanitized.slice(0, 997).trimEnd()}...` : sanitized;
}

export function sendWorkbenchMcpJsonRpcError(response: http.ServerResponse, status: number, message: string) {
  if (response.destroyed || response.writableEnded) return;
  response.statusCode = status;
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message }, id: null }));
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

interface WorkbenchMcpIngressOptions {
  logError: (name: string, message: string) => void;
  registry: WorkbenchAgentMcpRequestRegistry;
  scope: WorkbenchMcpScope;
}

/** Returns once the request is accepted; the response, transport and any long wait belong to this module afterwards. */
export function serveWorkbenchMcpHttpRequest(request: http.IncomingMessage, response: http.ServerResponse, options: WorkbenchMcpIngressOptions) {
  void completeRequest(request, response, options);
}

async function completeRequest(request: http.IncomingMessage, response: http.ServerResponse, options: WorkbenchMcpIngressOptions) {
  const { logError, registry, scope } = options;
  const requestAbort = new AbortController();
  const abortDisconnectedRequest = () => {
    if (!requestAbort.signal.aborted) requestAbort.abort(new Error("Workbench MCP caller disconnected."));
  };
  let server: Server | undefined;
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
    const description = await (await registry.awaitToolGeneration(requestAbort.signal)).describe(scope, requestAbort.signal);
    requestAbort.signal.throwIfAborted();
    server = new Server({ name: "wb", version: "1.0.0" }, {
      capabilities: { experimental: description.experimental, tools: { listChanged: true } },
    });
    server.setNotificationHandler(CancelledNotificationSchema, (notification) => {
      registry.cancel(scope.clientScope, notification.params.requestId, notification.params.reason);
    });
    server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: description.tools }));
    server.setRequestHandler(CallToolRequestSchema, async (message, extra) => {
      const progressToken = extra._meta?.progressToken;
      return await callTool(options, {
        arguments: message.params.arguments,
        detachableShell: true,
        meta: extra._meta,
        name: message.params.name,
        requestId: extra.requestId,
        signal: AbortSignal.any([requestAbort.signal, extra.signal]),
        ...(progressToken === undefined ? {} : {
          sendProgress: async (progress: number) => await extra.sendNotification({
            method: "notifications/progress",
            params: { progressToken, progress },
          }),
        }),
      });
    });
    requestAbort.signal.throwIfAborted();
    const body = await readJsonBody(request);
    await server.connect(transport);
    await transport.handleRequest(request, response, body);
  } catch (error) {
    const message = sanitizeWorkbenchMcpError(error) || "Workbench MCP request failed.";
    logError("workbench-mcp", message);
    sendWorkbenchMcpJsonRpcError(response, 500, message);
  } finally {
    if (response.writableEnded || response.destroyed) close();
  }
}

async function callTool(options: WorkbenchMcpIngressOptions, call: WorkbenchMcpToolCall): Promise<CallToolResult> {
  const { logError, registry, scope } = options;
  const step = await (await registry.awaitToolGeneration(call.signal)).call(scope, call);
  if (step.kind === "result") return step.result;
  const detached = step.call;
  let progress = 0;
  const stopProgress = detached.keepalive && call.sendProgress
    ? (detached.scheduleProgress ?? scheduleWorkbenchMcpProgress)(async () => {
      try {
        await call.sendProgress!(++progress);
      } catch (error) {
        logError("workbench-mcp-progress", sanitizeWorkbenchMcpError(error) || "Workbench MCP progress failed.");
      }
    }, detached.signal)
    : null;
  let outcome: WorkbenchMcpCallOutcome;
  try {
    if (detached.shell) {
      const { run } = detached.shell;
      const shellResult = detached.executeShell
        ? await detached.executeShell(run, detached.signal)
        : await registry.executeShell(run, detached.signal);
      outcome = detached.signal.aborted ? { error: detached.signal.reason } : { shellResult };
    } else {
      const response = detached.execute
        ? await detached.execute(detached.request, detached.signal)
        : await registry.executeCommand(detached.request, detached.signal);
      outcome = detached.signal.aborted ? { error: detached.signal.reason } : { response };
    }
  } catch (error) {
    outcome = { error };
  } finally {
    stopProgress?.();
    detached.unregister();
  }
  // The generation that prepared this call may be long gone; whichever is current records and formats the outcome.
  return await (await registry.awaitToolGeneration()).finish(scope, detached, outcome);
}
