/*
 * Exports:
 * - default WorkbenchBrowseController: own command tracking, cancellation, session access, HTTP adaptation, result draining and reload state.
 * - WorkbenchBrowseIdentityPort: map declared public targets and native session results without touching browser payloads.
 */
import type http from "node:http";
import type { NativeThreadId, ProjectId, WorkbenchThreadId } from "workbench-shared/workbench/identity";

import type { WorkbenchBrowseSessionControlRequest, WorkbenchBrowseSessionListRequest } from "workbench-shared/types";
import WorkbenchBrowseRequestHandler from "../lib/workbench/browse/WorkbenchBrowseRequestHandler";
import type { WorkbenchBrowseResultSink } from "../lib/workbench/browse/browse-result-events";
import WorkbenchBrowseRuntime from "../lib/workbench/browse/WorkbenchBrowseRuntime";

export interface WorkbenchBrowseIdentityPort {
  nativeTarget(request: { threadId: string; cwd?: string | null; projectId?: string | null }): Promise<{
    threadId: NativeThreadId; cwd?: string | null; projectId?: ProjectId | null;
  }>;
  publicThreadId(threadId: string, projectId?: string | null): Promise<WorkbenchThreadId>;
}

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
  if (signal.aborted || response.writableEnded || response.destroyed) return;
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
      if (done || signal.aborted) break;
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
  private generation = new AbortController();
  private readonly activeCommands = new Set<Promise<void>>();
  private readonly activeHttpRequests = new Map<AbortController, Promise<void>>();
  private readonly requestHandler: WorkbenchBrowseRequestHandlerPort;
  private readonly results: WorkbenchBrowseResultSink & { expire?(): void; resume?(): void };

  constructor(
    results: WorkbenchBrowseResultSink & { expire?(): void; resume?(): void },
    runtime: WorkbenchBrowseRuntime = new WorkbenchBrowseRuntime(),
    requestHandler: WorkbenchBrowseRequestHandlerPort = new WorkbenchBrowseRequestHandler(results, runtime),
    private readonly identity?: WorkbenchBrowseIdentityPort,
  ) {
    this.results = results;
    this.requestHandler = requestHandler;
  }

  async cleanupStaleInactiveSessions(options: Parameters<WorkbenchBrowseRequestHandler["findStaleInactiveSessionStops"]>[0]) {
    const signal = this.generation.signal;
    const stopRequests = await this.requestHandler.findStaleInactiveSessionStops(options);
    signal.throwIfAborted();
    for (const stopRequest of stopRequests) {
      signal.throwIfAborted();
      await this.runCommand(ownedSignal => this.requestHandler.controlSession(stopRequest, ownedSignal), signal);
    }
  }

  async listSessions(request: WorkbenchBrowseSessionListRequest, signal?: AbortSignal) {
    return await this.runCommand(async ownedSignal => {
      const native = await this.nativeTarget(request);
      ownedSignal.throwIfAborted();
      const result = await this.requestHandler.listSessions(native, ownedSignal);
      ownedSignal.throwIfAborted();
      if (!this.identity) return result;
      return { ...result, sessions: await Promise.all(result.sessions.map((session) => this.publicSession(session))) };
    }, signal);
  }

  async controlSession(request: WorkbenchBrowseSessionControlRequest, signal?: AbortSignal) {
    return await this.runCommand(async ownedSignal => {
      const native = await this.nativeTarget(request);
      ownedSignal.throwIfAborted();
      const result = await this.requestHandler.controlSession(native, ownedSignal);
      ownedSignal.throwIfAborted();
      return { ...result, session: result.session ? await this.publicSession(result.session) : null };
    }, signal);
  }

  async executeBrowseRequest(body: Buffer, signal: AbortSignal) {
    return await this.runCommand(ownedSignal => this.prepareBrowseRequest(body, ownedSignal), signal);
  }

  private async prepareBrowseRequest(body: Buffer, signal: AbortSignal) {
    if (this.identity) {
      let value: unknown;
      try { value = JSON.parse(body.toString("utf8")); }
      catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        return jsonResponse({ error: "A valid Browse request is required." }, 400);
      }
      const target = async (input: unknown) => {
        if (!input || typeof input !== "object" || Array.isArray(input)) return input;
        return await this.nativeTarget(input as Record<string, unknown>);
      };
      if (Array.isArray(value)) value = await Promise.all(value.map(target));
      else if (value && typeof value === "object") {
        const request = value as Record<string, unknown>;
        value = Array.isArray(request.actions)
          ? { ...request, actions: await Promise.all(request.actions.map(target)) }
          : await target(request);
      }
      body = Buffer.from(JSON.stringify(value));
    }
    signal.throwIfAborted();
    return await this.requestHandler.handle(
      body,
      signal,
      (task) => this.runCommand(task, signal),
    );
  }

  private async nativeTarget<T extends object>(request: T): Promise<T> {
    if (!this.identity || !("threadId" in request) || typeof request.threadId !== "string") return request;
    const input = request as T & { threadId: string; cwd?: string | null; projectId?: string | null };
    const target = await this.identity.nativeTarget({
      threadId: input.threadId,
      ...(typeof input.cwd === "string" ? { cwd: input.cwd } : {}),
      ...(typeof input.projectId === "string" ? { projectId: input.projectId } : {}),
    });
    return { ...request, ...target };
  }

  private async publicSession<T extends { threadId: string | null; projectId: string | null }>(session: T): Promise<T> {
    if (!session.threadId || !this.identity) return session;
    return { ...session, threadId: await this.identity.publicThreadId(session.threadId, session.projectId) };
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
        const result = await this.controlSession(payload, signal);
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
    if (this.generation.signal.aborted) this.generation = new AbortController();
    this.results.resume?.();
    this.acceptingCommands = true;
  }

  expire() {
    this.beginDrain();
    this.generation.abort(new Error("Browse work was cancelled by a user-authorized reload."));
    this.results.expire?.();
  }

  async waitForIdle() {
    await Promise.allSettled([
      ...this.activeCommands,
      ...[...this.activeHttpRequests].filter(([controller]) => !controller.signal.aborted).map(([, completion]) => completion),
    ]);
    await this.requestHandler.waitForIdle();
    await this.results.waitForIdle();
  }

  async runCommand<TValue>(task: (signal: AbortSignal) => Promise<TValue>, callerSignal?: AbortSignal): Promise<TValue> {
    if (!this.acceptingCommands) throw new Error("Browse controller is draining for reload.");
    const signal = callerSignal ? AbortSignal.any([callerSignal, this.generation.signal]) : this.generation.signal;
    signal.throwIfAborted();
    let release = () => undefined;
    const active = new Promise<void>((resolve) => { release = resolve; });
    this.activeCommands.add(active);
    let onAbort!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      const work = Promise.resolve().then(() => {
        signal.throwIfAborted();
        return task(signal);
      }).catch((error: unknown) => {
        if (signal.aborted && error !== signal.reason) {
          console.warn(`[browse] retired command failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 500)}`);
        }
        throw error;
      });
      return await Promise.race([work, cancelled]);
    } finally {
      signal.removeEventListener("abort", onAbort);
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
    const cancelled = () => sendHttpError(response, controller.signal.reason);
    controller.signal.addEventListener("abort", cancelled, { once: true });
    const completion = operation(controller.signal)
      .catch((error: unknown) => { sendHttpError(response, error); })
      .finally(() => {
        controller.signal.removeEventListener("abort", cancelled);
        this.activeHttpRequests.delete(controller);
      });
    this.activeHttpRequests.set(controller, completion);
    void completion;
  }
}
