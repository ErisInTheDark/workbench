/*
 * Exports:
 * - default WorkbenchAgentCommandController: parse native-shell wb argv, directly dispatch Browse and subagent requests, adapt output, and stream native responses. Keywords: workbench, agent, command, shell, orchestrator, transport, subagent.
 */
import { randomUUID } from "node:crypto";
import type http from "node:http";

import {
  parseWorkbenchAgentCliCommand,
  type WorkbenchAgentCliRequest,
} from "../lib/workbench/cli/workbench-agent-cli-commands";
import { adaptWorkbenchAgentCliResponse } from "../lib/workbench/cli/workbench-agent-cli-responses";
import type { JsonRpcRequest, JsonRpcResponse } from "./bridge-types";

const MAX_REQUEST_BODY_BYTES = 2 * 1024 * 1024;
const RELOAD_POLL_INTERVAL_MS = 250;
const RELOAD_TIMEOUT_MS = 60_000;

interface WorkbenchAgentDirectPort {
  executeBrowseRequest(body: Buffer, signal: AbortSignal): Promise<Response>;
  executeSessionRequest(request: { body: Buffer; method: string; url: string }, signal: AbortSignal): Promise<Response>;
  requestSubagent?: (message: JsonRpcRequest) => Promise<JsonRpcResponse>;
}

const UNCONFIGURED_DIRECT_PORT: WorkbenchAgentDirectPort = {
  executeBrowseRequest: async () => { throw new Error("Direct Browse dispatch is not configured."); },
  executeSessionRequest: async () => { throw new Error("Direct Browse session dispatch is not configured."); },
};

const SUBAGENT_ACTION_METHODS = {
  create: "workbench/subagent/create",
  list: "workbench/subagent/list",
  message: "workbench/subagent/message",
  profiles: "workbench/subagent/profiles",
  settle: "workbench/subagent/settle",
  stop: "workbench/subagent/stop",
} as const;

async function readBody(request: http.IncomingMessage) {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > MAX_REQUEST_BODY_BYTES) throw new Error("Workbench agent command request is too large.");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function sendText(response: http.ServerResponse, status: number, text: string) {
  if (response.destroyed || response.writableEnded) return;
  response.statusCode = status;
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "text/plain; charset=utf-8");
  response.end(text);
}

function bindRequestAbort(request: http.IncomingMessage, response: http.ServerResponse) {
  const controller = new AbortController();
  const abort = () => controller.abort(new Error("Workbench agent command client disconnected."));
  request.once("aborted", abort);
  response.once("close", () => {
    if (!response.writableEnded) abort();
  });
  return controller.signal;
}

function waitForDelay(ms: number, signal: AbortSignal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<void>((resolve, reject) => {
    const finish = (operation: () => void) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      operation();
    };
    const abort = () => finish(() => reject(signal.reason));
    const timer = setTimeout(() => finish(resolve), ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

async function writeNativeResponse(response: http.ServerResponse, upstream: Response, signal: AbortSignal) {
  response.statusCode = upstream.status;
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", upstream.headers.get("content-type") ?? "text/plain; charset=utf-8");
  if (!upstream.body) {
    response.end();
    return;
  }
  const reader = upstream.body.getReader();
  const abort = () => void reader.cancel(signal.reason).catch(() => undefined);
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (!signal.aborted) {
      const chunk = await reader.read();
      if (chunk.done) break;
      response.write(Buffer.from(chunk.value));
    }
    if (!response.destroyed && !response.writableEnded) response.end();
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}

function isLoopbackAddress(address: string | undefined) {
  if (!address) return false;
  const normalized = address.toLowerCase().split("%")[0];
  return normalized === "::1"
    || normalized === "127.0.0.1"
    || normalized.startsWith("127.")
    || normalized.startsWith("::ffff:127.");
}

export default class WorkbenchAgentCommandController {
  constructor(
    private readonly nextOrigin: string,
    private readonly orchestratorOrigin: string,
    private readonly direct: WorkbenchAgentDirectPort = UNCONFIGURED_DIRECT_PORT,
    private readonly fetchRequest: typeof fetch = fetch,
  ) {}

  async handleHttpRequest(request: http.IncomingMessage, response: http.ServerResponse) {
    const signal = bindRequestAbort(request, response);
    try {
      if (!isLoopbackAddress(request.socket.remoteAddress)) {
        sendText(response, 403, "Workbench agent commands are available only over loopback.\n");
        return;
      }
      const form = new URLSearchParams(await readBody(request));
      const argv = form.getAll("arg");
      const cwd = form.get("cwd")?.trim() || "";
      const callerThreadId = form.get("callerThreadId")?.trim() || null;
      const workbenchOrigin = form.get("workbenchOrigin")?.trim() || this.orchestratorOrigin;
      if (!cwd || argv.length > 256 || argv.some((arg) => arg.length > 65_536 || arg.includes("\0"))) {
        sendText(response, 400, "A valid Workbench agent command request is required.\n");
        return;
      }
      const parsed = await parseWorkbenchAgentCliCommand(argv, {
        callerThreadId,
        cwd,
        workbenchOrigin,
      });
      if (parsed.kind === "help") {
        sendText(response, 200, parsed.help);
        return;
      }
      if (parsed.kind === "error") {
        sendText(response, 400, `${parsed.error}\n`);
        return;
      }
      const upstream = parsed.request.waitForReload
        ? await this.runReloadRequest(parsed.request, signal)
        : await this.dispatchRequest(parsed.request, signal);
      const streamsNative = upstream.ok && (
        parsed.request.responseKind === "native"
        || upstream.headers.get("content-type")?.includes("application/x-ndjson")
      );
      if (streamsNative) {
        await writeNativeResponse(response, upstream, signal);
        return;
      }
      const text = await upstream.text();
      const adapted = adaptWorkbenchAgentCliResponse({ httpOk: upstream.ok, request: parsed.request, text });
      sendText(response, adapted.exitCode === 0 ? 200 : 400, adapted.exitCode === 0 ? adapted.stdout : adapted.stderr);
    } catch (error) {
      if (signal.aborted) return;
      sendText(response, 500, `${error instanceof Error ? error.message : String(error)}\n`);
    }
  }

  private buildRequestInit(request: WorkbenchAgentCliRequest, signal: AbortSignal): RequestInit {
    return {
      cache: "no-store",
      method: request.method,
      redirect: "error",
      signal,
      ...(request.body ? {
        body: JSON.stringify(request.body),
        headers: { "Content-Type": "application/json" },
      } : {}),
    };
  }

  private async dispatchRequest(request: WorkbenchAgentCliRequest, signal: AbortSignal) {
    const body = Buffer.from(request.body ? JSON.stringify(request.body) : "");
    if (request.path === "/api/subagents" && request.body) {
      return await this.dispatchSubagentRequest(request.body, signal);
    }
    if ((request.path === "/api/thread-status" || request.path === "/api/thread-title") && request.body) {
      return await this.dispatchManagedThreadRequest(request.path, request.body, signal);
    }
    if (request.path.startsWith("/api/browse/sessions")) {
      return await this.direct.executeSessionRequest({ body, method: request.method, url: request.path }, signal);
    }
    if (request.path.startsWith("/api/browse")) {
      return await this.direct.executeBrowseRequest(body, signal);
    }
    return await this.fetchRequest(this.resolveUrl(request.path), this.buildRequestInit(request, signal));
  }

  private async dispatchManagedThreadRequest(pathname: string, body: Record<string, unknown>, signal: AbortSignal) {
    if (!this.direct.requestSubagent) throw new Error("Direct managed-thread dispatch is not configured.");
    if (signal.aborted) throw signal.reason;
    const response = await this.direct.requestSubagent({
      id: 0,
      method: pathname === "/api/thread-status" ? "workbench/thread/status" : "workbench/thread/title",
      params: body,
    });
    if (response.error) return Response.json({ error: response.error.message }, { status: 400 });
    return Response.json(response.result ?? {});
  }

  private async dispatchSubagentRequest(body: Record<string, unknown>, signal: AbortSignal) {
    const requestSubagent = this.direct.requestSubagent;
    if (!requestSubagent) {
      throw new Error("Direct subagent dispatch is not configured.");
    }
    if (signal.aborted) {
      throw signal.reason;
    }

    const action = typeof body.action === "string" ? body.action : "";
    if (action !== "wait") {
      const method = SUBAGENT_ACTION_METHODS[action as keyof typeof SUBAGENT_ACTION_METHODS];
      if (!method) {
        return Response.json({ error: "Unsupported Workbench subagent action." }, { status: 400 });
      }
      const response = await requestSubagent({ id: 0, method, params: body });
      if (response.error) {
        return Response.json({ error: response.error.message }, { status: 400 });
      }
      return Response.json(response.result ?? {});
    }

    const waitId = randomUUID();
    const cancel = () => {
      void requestSubagent({
        id: 0,
        method: "workbench/subagent/waitCancel",
        params: { waitId },
      }).catch(() => undefined);
    };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      const response = await requestSubagent({
        id: 0,
        method: "workbench/subagent/wait",
        params: { ...body, waitId },
      });
      if (response.error) {
        return Response.json({ error: response.error.message }, { status: 400 });
      }
      const result = response.result && typeof response.result === "object"
        ? response.result as { output?: unknown }
        : null;
      if (typeof result?.output !== "string") {
        return Response.json({ error: "Workbench subagent wait returned no output." }, { status: 400 });
      }
      return new Response(result.output, {
        headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" },
      });
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  }

  private resolveUrl(requestPath: string) {
    if (requestPath.startsWith("/api/orchestrator/reload")) {
      return new URL(requestPath.replace("/api/orchestrator/reload", "/orchestrator/reload"), this.orchestratorOrigin);
    }
    return new URL(requestPath, this.nextOrigin);
  }

  private async runReloadRequest(request: WorkbenchAgentCliRequest, signal: AbortSignal) {
    let response = await this.fetchRequest(this.resolveUrl(request.path), this.buildRequestInit(request, signal));
    if (!response.ok) return response;
    let text = await response.text();
    let state = readReloadState(text);
    const deadline = Date.now() + RELOAD_TIMEOUT_MS;
    while (state === "running" && Date.now() < deadline) {
      await waitForDelay(RELOAD_POLL_INTERVAL_MS, signal);
      try {
        response = await this.fetchRequest(this.resolveUrl(request.path), { cache: "no-store", method: "GET", redirect: "error", signal });
      } catch (error) {
        if (signal.aborted) throw error;
        continue;
      }
      if (!response.ok) continue;
      text = await response.text();
      state = readReloadState(text);
    }
    if (state === "running") {
      return new Response(JSON.stringify({ error: `Workbench orchestrator reload did not settle within ${RELOAD_TIMEOUT_MS}ms.` }), { status: 504 });
    }
    return new Response(text, { headers: response.headers, status: response.status });
  }
}

function readReloadState(text: string) {
  try {
    const parsed = JSON.parse(text) as { state?: string };
    return parsed.state === "running" || parsed.state === "succeeded" || parsed.state === "failed" ? parsed.state : null;
  } catch {
    return null;
  }
}

function parseRecord(text: string) {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function readRecordString(record: Record<string, unknown> | null, key: string) {
  const value = record?.[key];
  return typeof value === "string" ? value : "";
}
