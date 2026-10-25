/*
 * Exports:
 * - WorkbenchMcpScope: plain per-request client, provider and catalogue selection.
 * - WorkbenchMcpToolCall/WorkbenchMcpDetachedCall/WorkbenchMcpToolStep/WorkbenchMcpCallOutcome: step contracts between ingress and generation, for detached commands, shells and serial batch turns.
 * - WorkbenchMcpIngressCapabilities: what this ingress supports, passed to each generation's describe.
 * - WorkbenchMcpToolGeneration: the current MCP generation's short describe, call, finish and yielded-shell answer steps.
 * - linkWorkbenchMcpCallSignal: follow a call's cancellation until a yielded shell detaches from it.
 * - WorkbenchMcpProgressScheduler: the keepalive timer seam; every tool call pulses request-owned progress until it answers.
 * - sanitizeWorkbenchMcpError: bounded error text without paths or secrets.
 * - sendWorkbenchMcpJsonRpcError: write a JSON-RPC error when the response is still open.
 * - serveWorkbenchMcpHttpRequest: own one MCP HTTP request, resolving the current generation at every step.
 *
 * Long waits outlive the generation that started them. Everything they keep alive is created here, so this module
 * must stay tiny: any closure from a reloadable feature module would pin that module's whole import graph.
 */
import type http from "node:http";

import { getRequestListener } from "@hono/node-server";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema, CancelledNotificationSchema, ListToolsRequestSchema,
  type CallToolResult, type Tool,
} from "@modelcontextprotocol/sdk/types.js";

import type { WorkbenchAgentCommandRequest } from "../lib/workbench/commands/workbench-agent-command-definition";
import type { WorkbenchAgentBatchTurn, WorkbenchAgentMcpRequestRegistry } from "./workbench-agent-mcp-request-registry";
import type { WorkbenchPreparedShell, WorkbenchShellRun, WorkbenchShellRunResult } from "../providers/provider-execution";
import type { WorkbenchCommandQueueTicket } from "../exec/WorkbenchCommandCapacity";
import type { WorkbenchThreadId } from "workbench-shared/workbench/identity";

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
  /** Set by ingress that backgrounds a detached shell once its `yieldSignal` fires. */
  shellYields?: boolean;
  /** Set by ingress that waits out `batchTurn` steps; without it a generation never orders calls. */
  batchTurns?: boolean;
  /** How this call's batch turn ended, on the call the ingress repeats after waiting it out. */
  batchTurn?: WorkbenchAgentBatchTurn;
  meta: Record<string, unknown> | undefined;
  name: string;
  requestId: WorkbenchMcpRequestId;
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
  executeShell?: (run: WorkbenchShellRun, signal: AbortSignal, ticket?: WorkbenchCommandQueueTicket) => Promise<WorkbenchShellRunResult>;
  /** The registry's record of this shell's expensive-queue wait. */
  shellQueue?: WorkbenchCommandQueueTicket;
  /** Shells only: fires when the call should answer while the command runs on, which then stops following the call. */
  yieldSignal?: AbortSignal;
  unlinkCaller?: () => void;
  signal: AbortSignal;
  toolName: string;
  transcript: object | null;
  unregister: () => void;
} & (
  | { request: WorkbenchAgentCommandRequest; shell?: undefined; collect?: undefined }
  | { request?: undefined; shell: WorkbenchPreparedShell; collect?: undefined }
  /** `shell_wait`: hand over a yielded shell's result. */
  | { request?: undefined; shell?: undefined; collect: { shellId: string; threadId: WorkbenchThreadId } }
);

export type WorkbenchMcpToolStep =
  | { kind: "result"; result: CallToolResult }
  | { kind: "detached"; call: WorkbenchMcpDetachedCall }
  /** A serial call must wait for the earlier calls of its batch before anything about it is recorded. */
  | { kind: "batchTurn"; key: string; toolName: string };

/** What this ingress can do, so a newer generation offers only behaviour its ingress supports. */
export interface WorkbenchMcpIngressCapabilities {
  batchTurns?: boolean;
  shellYields?: boolean;
}

export type WorkbenchMcpCallOutcome =
  | { response: Response } | { shellResult: WorkbenchShellRunResult } | { collected: CallToolResult } | { error: unknown };

export interface WorkbenchMcpToolGeneration {
  describe(
    scope: WorkbenchMcpScope, signal: AbortSignal, ingress?: WorkbenchMcpIngressCapabilities,
  ): Promise<{ tools: Tool[] }>;
  call(scope: WorkbenchMcpScope, call: WorkbenchMcpToolCall): Promise<WorkbenchMcpToolStep>;
  finish(scope: WorkbenchMcpScope, call: WorkbenchMcpDetachedCall, outcome: WorkbenchMcpCallOutcome): Promise<CallToolResult>;
  /** The answer of a shell call whose command runs on as `shellId`. */
  yielded(scope: WorkbenchMcpScope, call: WorkbenchMcpDetachedCall, shellId: string, outputTail: string): Promise<CallToolResult>;
}

/** A signal following `caller` until unlinked, so a yielded shell outlives the call that started it. */
export function linkWorkbenchMcpCallSignal(caller: AbortSignal) {
  const link = new AbortController();
  const follow = () => link.abort(caller.reason);
  if (caller.aborted) follow();
  else caller.addEventListener("abort", follow, { once: true });
  return { signal: link.signal, unlink: () => caller.removeEventListener("abort", follow) };
}

export type WorkbenchMcpProgressScheduler = (pulse: () => Promise<void>, signal: AbortSignal) => () => void;

function scheduleWorkbenchMcpProgress(pulse: () => Promise<void>, signal: AbortSignal) {
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

function keepWorkbenchMcpCallAlive(
  sendProgress: (() => Promise<void>) | undefined, signal: AbortSignal, logError: (name: string, message: string) => void,
  schedule: WorkbenchMcpProgressScheduler = scheduleWorkbenchMcpProgress,
) {
  if (!sendProgress) return null;
  return schedule(async () => {
    try {
      await sendProgress();
    } catch (error) {
      logError("workbench-mcp-progress", sanitizeWorkbenchMcpError(error) || "Workbench MCP progress failed.");
    }
  }, signal);
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
  response.setHeader("Connection", "close");
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
  /** Test-injected keepalive scheduler; production pulses every 60s. */
  scheduleProgress?: WorkbenchMcpProgressScheduler;
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
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
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
    const description = await (await registry.awaitToolGeneration(requestAbort.signal))
      .describe(scope, requestAbort.signal, { batchTurns: true, shellYields: true });
    requestAbort.signal.throwIfAborted();
    server = new Server({ name: "wb", version: "1.0.0" }, {
      capabilities: { tools: { listChanged: true } },
    });
    server.setNotificationHandler(CancelledNotificationSchema, (notification) => {
      if (notification.params.requestId === undefined) return;
      registry.cancel(scope.clientScope, notification.params.requestId, notification.params.reason);
    });
    server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: description.tools }));
    server.setRequestHandler(CallToolRequestSchema, async (message, extra) => {
      const progressToken = extra._meta?.progressToken;
      let progress = 0;
      const signal = AbortSignal.any([requestAbort.signal, extra.signal]);
      // Any call can wait (approvals, batch turns, transition leases), and a silent one idles out at the client's timeout.
      const stopProgress = keepWorkbenchMcpCallAlive(progressToken === undefined ? undefined : async () => await extra.sendNotification({
        method: "notifications/progress",
        params: { progressToken, progress: ++progress },
      }), signal, logError, options.scheduleProgress);
      try {
        return await callTool(options, {
          arguments: message.params.arguments,
          detachableShell: true,
          shellYields: true,
          batchTurns: true,
          meta: extra._meta,
          name: message.params.name,
          requestId: extra.requestId,
          signal,
        });
      } finally {
        stopProgress?.();
      }
    });
    requestAbort.signal.throwIfAborted();
    const body = await readJsonBody(request);
    await server.connect(transport);
    const handleRequest = getRequestListener(async webRequest => {
      const result = await transport.handleRequest(webRequest, { parsedBody: body });
      // Retire completed sockets before clients can race Node's idle timeout by reusing them.
      result.headers.set("Connection", "close");
      return result;
    }, { overrideGlobalObjects: false, autoCleanupIncoming: false });
    await handleRequest(request, response);
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
  let step = await (await registry.awaitToolGeneration(call.signal)).call(scope, call);
  // The turn wait holds no generation; whichever is current when it ends takes the call from there.
  while (step.kind === "batchTurn") {
    const batchTurn = await registry.awaitBatchTurn(step.key, call.signal, step.toolName);
    step = await (await registry.awaitToolGeneration(call.signal)).call(scope, { ...call, batchTurn });
  }
  if (step.kind === "result") return step.result;
  const detached = step.call;
  let outcome: WorkbenchMcpCallOutcome | null = null;
  let yielded: { running: Promise<WorkbenchMcpCallOutcome>; shellId: string } | null = null;
  try {
    if (detached.shell) {
      const { run } = detached.shell;
      const running = settleShell(detached.executeShell
        ? detached.executeShell(run, detached.signal, detached.shellQueue)
        : registry.executeShell(run, detached.signal, detached.shellQueue), detached.signal);
      outcome = await untilYield(running, detached.yieldSignal);
      // A command stopped as it yielded has nothing to run on; its own outcome answers the call.
      if (!outcome && detached.signal.aborted) outcome = await running;
      if (!outcome) {
        detached.unlinkCaller?.();
        yielded = { running, shellId: registry.backgroundShell(scope.clientScope, call.requestId) };
      }
    } else if (detached.collect) {
      const { shellId, threadId } = detached.collect;
      outcome = { collected: await registry.awaitBackgroundShell(shellId, threadId, detached.signal) };
    } else {
      const response = detached.execute
        ? await detached.execute(detached.request, detached.signal)
        : await registry.executeCommand(detached.request, detached.signal);
      outcome = detached.signal.aborted ? { error: detached.signal.reason } : { response };
    }
  } catch (error) {
    outcome = { error };
  } finally {
    detached.unregister();
  }
  if (yielded) {
    const { running, shellId } = yielded;
    void finishYieldedShell(registry, scope, detached, running, shellId, logError);
    return await (await registry.awaitToolGeneration()).yielded(scope, detached, shellId, registry.readBackgroundShellTail(shellId));
  }
  // The generation that prepared this call may be long gone; whichever is current records and formats the outcome.
  return await (await registry.awaitToolGeneration()).finish(scope, detached, outcome!);
}

async function settleShell(running: Promise<WorkbenchShellRunResult>, signal: AbortSignal): Promise<WorkbenchMcpCallOutcome> {
  try {
    const shellResult = await running;
    return signal.aborted ? { error: signal.reason } : { shellResult };
  } catch (error) {
    return { error };
  }
}

/** The outcome if it arrives first, or null once `yieldSignal` fires. */
async function untilYield(running: Promise<WorkbenchMcpCallOutcome>, yieldSignal: AbortSignal | undefined) {
  if (!yieldSignal) return await running;
  if (yieldSignal.aborted) return null;
  let stop = () => {};
  const fired = new Promise<null>(resolve => {
    const onYield = () => resolve(null);
    yieldSignal.addEventListener("abort", onYield, { once: true });
    stop = () => yieldSignal.removeEventListener("abort", onYield);
  });
  try {
    return await Promise.race([running, fired]);
  } finally {
    stop();
  }
}

/** The yielded command's row gets its real result, and `shell_wait` can collect it. */
async function finishYieldedShell(
  registry: WorkbenchAgentMcpRequestRegistry, scope: WorkbenchMcpScope, detached: WorkbenchMcpDetachedCall,
  running: Promise<WorkbenchMcpCallOutcome>, shellId: string, logError: (name: string, message: string) => void,
) {
  const outcome = await running;
  try {
    registry.finishBackgroundShell(shellId, await (await registry.awaitToolGeneration()).finish(scope, detached, outcome));
  } catch (error) {
    logError("workbench-mcp", sanitizeWorkbenchMcpError(error) || "Yielded shell result was not recorded.");
    registry.finishBackgroundShell(shellId, { content: [{ type: "text", text: "Yielded shell result was not recorded." }], isError: true });
  }
}
