/*
 * Exports:
 * - default WorkbenchBrowseController: own command tracking, cancellation, session access, HTTP adaptation, result-drain coordination, and reload state. Keywords: browse, orchestrator, controller, cancel, streaming, result, reload.
 */
import type http from "node:http";

import type { WorkbenchBrowseSessionControlRequest, WorkbenchBrowseSessionListRequest } from "../lib/types";
import WorkbenchBrowseRequestHandler from "../lib/workbench/browse/WorkbenchBrowseRequestHandler";
import type { WorkbenchBrowseResultSink } from "../lib/workbench/browse/browse-result-events";
import WorkbenchBrowseRuntime from "../lib/workbench/browse/WorkbenchBrowseRuntime";

const SESSION_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,80}$/u;
const MAX_BROWSE_SESSION_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_BROWSE_SESSION_TIMEOUT_MS = 120_000;
type WorkbenchBrowseRequestHandlerPort = Pick<
  WorkbenchBrowseRequestHandler,
  "controlSession" | "findStaleInactiveSessionStops" | "handle" | "listSessions" | "waitForIdle"
>;

function normalizeString(value: string | null) {
  return value?.trim() ?? "";
}

function normalizeTimeout(value: string | null) {
  const numericValue = Number.parseInt(value ?? "", 10);
  return Number.isFinite(numericValue) && numericValue > 0
    ? Math.min(numericValue, MAX_BROWSE_SESSION_TIMEOUT_MS)
    : DEFAULT_BROWSE_SESSION_TIMEOUT_MS;
}

async function readRequestBody(request: http.IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function bindRequestAbort(request: http.IncomingMessage, response: http.ServerResponse) {
  const controller = new AbortController();
  const abort = () => controller.abort(new Error("Browse client disconnected."));
  request.once("aborted", abort);
  response.once("close", () => {
    if (!response.writableEnded) abort();
  });
  return controller;
}

function waitForResponseDrain(response: http.ServerResponse, signal: AbortSignal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const finish = () => {
      response.off("close", finish);
      response.off("drain", finish);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    response.once("close", finish);
    response.once("drain", finish);
    signal.addEventListener("abort", finish, { once: true });
  });
}

async function writeResponse(response: http.ServerResponse, upstream: Response, signal: AbortSignal) {
  response.statusCode = upstream.status;
  for (const [name, value] of upstream.headers) response.setHeader(name, value);
  if (!upstream.body) {
    response.end();
    return;
  }
  const reader = upstream.body.getReader();
  const abort = () => void reader.cancel(signal.reason).catch(() => undefined);
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!response.write(Buffer.from(value))) {
        await waitForResponseDrain(response, signal);
      }
    }
    if (!response.writableEnded) response.end();
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}

function jsonResponse(payload: object, status = 200) {
  return Response.json(payload, { headers: { "Cache-Control": "no-store" }, status });
}

function sendHttpError(response: http.ServerResponse, error: unknown) {
  if (response.destroyed || response.writableEnded) return;
  if (response.headersSent) {
    response.end();
    return;
  }
  response.statusCode = 500;
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify({ error: error instanceof Error ? error.message : "Browse request failed." }));
}

export default class WorkbenchBrowseController {
  private acceptingCommands = true;
  private readonly activeCommands = new Set<Promise<void>>();
  private readonly activeHttpRequests = new Map<AbortController, Promise<void>>();
  private readonly requestHandler: WorkbenchBrowseRequestHandlerPort;
  private readonly results: WorkbenchBrowseResultSink;

  constructor(
    results: WorkbenchBrowseResultSink,
    runtime: WorkbenchBrowseRuntime = new WorkbenchBrowseRuntime(),
    requestHandler: WorkbenchBrowseRequestHandlerPort = new WorkbenchBrowseRequestHandler(results, runtime),
  ) {
    this.results = results;
    this.requestHandler = requestHandler;
  }

  async cleanupStaleInactiveSessions(options: Parameters<WorkbenchBrowseRequestHandler["findStaleInactiveSessionStops"]>[0]) {
    const stopRequests = await this.requestHandler.findStaleInactiveSessionStops(options);
    for (const stopRequest of stopRequests) {
      await this.runCommand(() => this.requestHandler.controlSession(stopRequest));
    }
  }

  async listSessions(request: WorkbenchBrowseSessionListRequest, signal?: AbortSignal) {
    return await this.requestHandler.listSessions(request, signal);
  }

  async executeBrowseRequest(body: Buffer, signal: AbortSignal) {
    return await this.requestHandler.handle(
      body,
      signal,
      (task) => this.runCommand(task),
    );
  }

  async executeSessionRequest({
    body,
    method,
    url,
  }: {
    body: Buffer;
    method: string;
    url: string;
  }, signal: AbortSignal) {
    try {
      const requestUrl = new URL(url, "http://localhost");
      if (method === "GET") {
        const query: WorkbenchBrowseSessionListRequest = {
          cwd: normalizeString(requestUrl.searchParams.get("cwd")) || null,
          includeRuntime: !["false", "0"].includes(normalizeString(requestUrl.searchParams.get("includeRuntime")).toLowerCase()),
          projectId: normalizeString(requestUrl.searchParams.get("projectId")) || null,
          threadId: normalizeString(requestUrl.searchParams.get("threadId")) || null,
          timeoutMs: normalizeTimeout(requestUrl.searchParams.get("timeoutMs")),
        };
        return jsonResponse(await this.listSessions(query, signal));
      }
      if (method === "POST") {
        const rawBody = body.toString("utf8");
        const value = rawBody.trim() ? JSON.parse(rawBody) as Partial<WorkbenchBrowseSessionControlRequest> : null;
        const action = value?.action === "forget" || value?.action === "stop" ? value.action : null;
        const session = typeof value?.session === "string" ? value.session.trim() : "";
        if (!action || !SESSION_NAME_PATTERN.test(session)) {
          return jsonResponse({ error: "A valid Browse session control request is required." }, 400);
        }
        const payload: WorkbenchBrowseSessionControlRequest = { ...value, action, session };
        const result = await this.runCommand(() => this.requestHandler.controlSession(payload, signal));
        return jsonResponse(result);
      }
      return jsonResponse({ error: "Method not allowed" }, 405);
    } catch (error) {
      return jsonResponse({ error: error instanceof Error ? error.message : "Unable to manage Browse sessions." }, 400);
    }
  }

  async handleBrowseHttpRequest(request: http.IncomingMessage, response: http.ServerResponse) {
    this.admitHttpRequest(request, response, async (signal) => {
      const body = await readRequestBody(request);
      const upstream = await this.executeBrowseRequest(body, signal);
      await writeResponse(response, upstream, signal);
    });
  }

  async handleSessionsHttpRequest(request: http.IncomingMessage, response: http.ServerResponse) {
    this.admitHttpRequest(request, response, async (signal) => {
      const body = request.method === "POST" ? await readRequestBody(request) : Buffer.alloc(0);
      const upstream = await this.executeSessionRequest({
        body,
        method: request.method ?? "",
        url: request.url ?? "/",
      }, signal);
      await writeResponse(response, upstream, signal);
    });
  }

  beginDrain() {
    this.acceptingCommands = false;
    for (const controller of this.activeHttpRequests.keys()) {
      controller.abort(new Error("Browse request was cancelled by a user-authorized reload."));
    }
  }

  resume() {
    this.acceptingCommands = true;
  }

  async waitForIdle() {
    await Promise.allSettled([
      ...this.activeCommands,
      ...this.activeHttpRequests.values(),
    ]);
    await this.requestHandler.waitForIdle();
    await this.results.waitForIdle();
  }

  async runCommand<TValue>(task: () => Promise<TValue>): Promise<TValue> {
    if (!this.acceptingCommands) throw new Error("Browse controller is draining for reload.");
    let release = () => undefined;
    const active = new Promise<void>((resolve) => { release = resolve; });
    this.activeCommands.add(active);
    try {
      return await task();
    } finally {
      release();
      this.activeCommands.delete(active);
    }
  }

  private admitHttpRequest(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    operation: (signal: AbortSignal) => Promise<void>,
  ) {
    if (!this.acceptingCommands) {
      sendHttpError(response, new Error("Browse controller is draining for reload."));
      return;
    }
    const controller = bindRequestAbort(request, response);
    const completion = operation(controller.signal)
      .catch((error: unknown) => { sendHttpError(response, error); })
      .finally(() => { this.activeHttpRequests.delete(controller); });
    this.activeHttpRequests.set(controller, completion);
    void completion;
  }
}
