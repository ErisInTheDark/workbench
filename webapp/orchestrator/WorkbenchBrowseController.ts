/*
 * Exports:
 * - default WorkbenchBrowseController: own command-producer FIFO, cancellation, session access, HTTP adaptation, and drain-safe reload state. Keywords: browse, orchestrator, controller, queue, cancel, streaming, reload.
 */
import type http from "node:http";

import type { WorkbenchBrowseSessionControlRequest, WorkbenchBrowseSessionListRequest } from "../lib/types";
import WorkbenchBrowseRequestHandler from "../lib/workbench/browse/WorkbenchBrowseRequestHandler";
import WorkbenchBrowseTranscriptAdapter from "./WorkbenchBrowseTranscriptAdapter";

const IDLE_GATE = Promise.resolve();
const SESSION_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,80}$/u;
const MAX_BROWSE_SESSION_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_BROWSE_SESSION_TIMEOUT_MS = 120_000;
type WorkbenchBrowseRequestHandlerPort = Pick<
  WorkbenchBrowseRequestHandler,
  "controlSession" | "findStaleInactiveSessionStops" | "handle" | "listSessions"
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
  return controller.signal;
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

export default class WorkbenchBrowseController {
  private acceptingCommands = true;
  private readonly requestHandler: WorkbenchBrowseRequestHandlerPort;
  private tail: Promise<void> = IDLE_GATE;

  constructor(
    transcripts: WorkbenchBrowseTranscriptAdapter,
    requestHandler: WorkbenchBrowseRequestHandlerPort = new WorkbenchBrowseRequestHandler(transcripts),
  ) {
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

  async handleBrowseHttpRequest(request: http.IncomingMessage, response: http.ServerResponse) {
    const signal = bindRequestAbort(request, response);
    const body = await readRequestBody(request);
    const upstream = await this.requestHandler.handle(
      body,
      signal,
      (task) => this.runCommand(task),
    );
    await writeResponse(response, upstream, signal);
  }

  async handleSessionsHttpRequest(request: http.IncomingMessage, response: http.ServerResponse) {
    const signal = bindRequestAbort(request, response);
    try {
      const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      if (request.method === "GET") {
        const query: WorkbenchBrowseSessionListRequest = {
          cwd: normalizeString(requestUrl.searchParams.get("cwd")) || null,
          includeRuntime: !["false", "0"].includes(normalizeString(requestUrl.searchParams.get("includeRuntime")).toLowerCase()),
          projectId: normalizeString(requestUrl.searchParams.get("projectId")) || null,
          threadId: normalizeString(requestUrl.searchParams.get("threadId")) || null,
          timeoutMs: normalizeTimeout(requestUrl.searchParams.get("timeoutMs")),
        };
        await writeResponse(response, jsonResponse(await this.listSessions(query, signal)), signal);
        return;
      }
      if (request.method === "POST") {
        const rawBody = (await readRequestBody(request)).toString("utf8");
        const value = rawBody.trim() ? JSON.parse(rawBody) as Partial<WorkbenchBrowseSessionControlRequest> : null;
        const action = value?.action === "forget" || value?.action === "stop" ? value.action : null;
        const session = typeof value?.session === "string" ? value.session.trim() : "";
        if (!action || !SESSION_NAME_PATTERN.test(session)) {
          await writeResponse(response, jsonResponse({ error: "A valid Browse session control request is required." }, 400), signal);
          return;
        }
        const payload: WorkbenchBrowseSessionControlRequest = { ...value, action, session };
        const result = await this.runCommand(() => this.requestHandler.controlSession(payload, signal));
        await writeResponse(response, jsonResponse(result), signal);
        return;
      }
      await writeResponse(response, jsonResponse({ error: "Method not allowed" }, 405), signal);
    } catch (error) {
      await writeResponse(response, jsonResponse({ error: error instanceof Error ? error.message : "Unable to manage Browse sessions." }, 400), signal);
    }
  }

  beginDrain() {
    this.acceptingCommands = false;
  }

  resume() {
    this.acceptingCommands = true;
  }

  async waitForIdle() {
    await this.tail;
  }

  async runCommand<TValue>(task: () => Promise<TValue>): Promise<TValue> {
    if (!this.acceptingCommands) throw new Error("Browse controller is draining for reload.");
    const previous = this.tail;
    let release = () => undefined;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.tail = current;
    await previous;
    try {
      return await task();
    } finally {
      release();
      if (this.tail === current) this.tail = IDLE_GATE;
    }
  }
}
