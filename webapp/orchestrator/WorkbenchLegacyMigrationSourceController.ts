/*
 * Exports:
 * - LegacyMigrationHarnessRequest/LegacyMigrationProjectResolution/WorkbenchLegacyMigrationSourceControllerOptions: injected live-bridge and validated-project boundaries. Keywords: migration, source, capability, project.
 * - default WorkbenchLegacyMigrationSourceController: serve one bounded catalog page or one selected normalized thread snapshot without reading provider homes or Workbench sidecars. Keywords: migration, readonly, lazy, bridge.
 */
import type http from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";

import type { WorkbenchHarness } from "../lib/types";
import type { JsonRpcRequest, JsonRpcResponse } from "./bridge-types";

const MAX_BODY_BYTES = 64 * 1024;
const MAX_PAGE_SIZE = 100;
const MAX_TIMEOUT_MS = 30_000;
const MIN_TIMEOUT_MS = 1_000;
const CODEX_CURSOR_PREFIX = "legacy-codex:";
const ACTIVE_THREAD_ID = "019f6334-e16e-79c0-9638-0669cf8b7db2";

export type LegacyMigrationHarnessRequest = (harness: WorkbenchHarness, request: JsonRpcRequest) => Promise<JsonRpcResponse>;
export interface LegacyMigrationProjectResolution { cwd: string; project: { id: string } }
export interface WorkbenchLegacyMigrationSourceControllerOptions {
  allowedProjectIds: ReadonlySet<string>;
  capability: string | null;
  requestHarness: LegacyMigrationHarnessRequest;
  resolveProjectFromCwd: (cwd: string) => Promise<LegacyMigrationProjectResolution>;
}

export function readLegacyMigrationSourceConfig(projectRoot: string) {
  try {
    const value = JSON.parse(readFileSync(path.join(projectRoot, ".workbench", "runtime", "legacy-migration-source.json"), "utf8")) as unknown;
    if (!isRecord(value) || typeof value.capability !== "string" || !value.capability.trim() || !Array.isArray(value.allowedProjectIds) || !value.allowedProjectIds.every((entry) => typeof entry === "string" && entry.trim())) throw new Error("Legacy migration source config is malformed.");
    return { allowedProjectIds: new Set(value.allowedProjectIds), capability: value.capability };
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return { allowedProjectIds: new Set<string>(), capability: null };
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function requireString(value: unknown, label: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required.`);
  return value.trim();
}

function normalizePath(value: string) {
  const normalized = path.resolve(value).replace(/\\/gu, "/").replace(/\/+$/gu, "");
  return process.platform === "win32" ? normalized.toLocaleLowerCase() : normalized;
}

function exactPath(left: string, right: string) {
  return normalizePath(left) === normalizePath(right);
}

function encodeCodexCursor(archived: boolean, providerCursor: string | null) {
  return `${CODEX_CURSOR_PREFIX}${Buffer.from(JSON.stringify({ archived, providerCursor }), "utf8").toString("base64url")}`;
}

function decodeCodexCursor(cursor: string | null) {
  if (!cursor) return { archived: false, providerCursor: null };
  if (!cursor.startsWith(CODEX_CURSOR_PREFIX)) throw new Error("Catalog cursor is invalid.");
  try {
    const decoded = JSON.parse(Buffer.from(cursor.slice(CODEX_CURSOR_PREFIX.length), "base64url").toString("utf8")) as unknown;
    if (!isRecord(decoded) || typeof decoded.archived !== "boolean" || decoded.providerCursor !== null && typeof decoded.providerCursor !== "string") throw new Error("invalid");
    return { archived: decoded.archived, providerCursor: decoded.providerCursor };
  } catch {
    throw new Error("Catalog cursor is invalid.");
  }
}

async function readBody(request: http.IncomingMessage) {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_BODY_BYTES) throw new Error("Legacy migration source request is too large.");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function sendJson(response: http.ServerResponse, status: number, value: object) {
  const body = JSON.stringify(value);
  response.writeHead(status, { "Cache-Control": "no-store", "Content-Length": Buffer.byteLength(body), "Content-Type": "application/json" });
  response.end(body);
}

function readResult(response: JsonRpcResponse, method: string) {
  if (response.error) throw new Error(`${method} failed: ${response.error.message}`);
  if (!isRecord(response.result)) throw new Error(`${method} returned no normalized result.`);
  return response.result;
}

function safeSummary(value: unknown, expectedCwd: string) {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.cwd !== "string" || !exactPath(value.cwd, expectedCwd)) return null;
  return {
    cwd: expectedCwd,
    providerThreadId: value.id,
    ...(typeof value.name === "string" ? { name: value.name } : {}),
    ...(typeof value.status === "string" ? { status: value.status } : {}),
    ...(typeof value.updatedAt === "number" ? { updatedAt: value.updatedAt } : {}),
  };
}

function abortError(signal: AbortSignal) { return signal.reason instanceof Error ? signal.reason : new Error("Legacy migration source request was cancelled."); }

function raceDeadline<T>(operation: Promise<T>, timeoutMs: number, signal?: AbortSignal) {
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) return reject(abortError(signal));
    const onAbort = () => { clearTimeout(timer); reject(abortError(signal!)); };
    const timer = setTimeout(() => reject(new Error(`Legacy migration source request timed out after ${timeoutMs}ms.`)), timeoutMs);
    timer.unref();
    signal?.addEventListener("abort", onAbort, { once: true });
    void operation.then((value) => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); resolve(value); }, (error) => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); reject(error); });
  });
}

export default class WorkbenchLegacyMigrationSourceController {
  private active = false;
  constructor(private readonly options: WorkbenchLegacyMigrationSourceControllerOptions) {}

  async execute(value: unknown, signal?: AbortSignal) {
    if (this.active) throw new Error("A legacy migration source request is already active.");
    if (!this.options.capability) throw new Error("Legacy migration source is disabled.");
    this.active = true;
    try {
    const body = isRecord(value) ? value : null;
    const operation = body?.operation;
    const harness = body?.harness;
    if (operation !== "catalogPage" && operation !== "threadSnapshot") throw new Error("Legacy migration source operation is unsupported.");
    if (harness !== "codex" && harness !== "copilot" && harness !== "opencode") throw new Error("Legacy migration source harness is unsupported.");
    const cwd = requireString(body.cwd, "Legacy migration cwd");
    const projectId = requireString(body.projectId, "Legacy migration projectId");
    const timeoutMs = body.timeoutMs === undefined ? 10_000 : body.timeoutMs;
    if (!Number.isInteger(timeoutMs) || (timeoutMs as number) < MIN_TIMEOUT_MS || (timeoutMs as number) > MAX_TIMEOUT_MS) throw new Error("Legacy migration timeoutMs is out of bounds.");
    const scope = await raceDeadline(this.options.resolveProjectFromCwd(cwd), timeoutMs as number, signal);
    if (scope.project.id !== projectId || !exactPath(scope.cwd, cwd) || !this.options.allowedProjectIds.has(projectId)) throw new Error("Legacy migration scope is not allowlisted.");

    if (operation === "threadSnapshot") {
      const providerThreadId = requireString(body.providerThreadId, "Legacy migration providerThreadId");
      if (providerThreadId === ACTIVE_THREAD_ID) throw new Error("The active Workbench thread is excluded from legacy migration reads.");
      const result = readResult(await raceDeadline(this.options.requestHarness(harness, {
        id: "legacy-migration:thread-read",
        method: "thread/read",
        params: { cwd: scope.cwd, includeTurns: true, projectId, threadId: providerThreadId },
      }), timeoutMs as number, signal), "thread/read");
      const thread = isRecord(result.thread) ? result.thread : null;
      if (!thread || thread.id !== providerThreadId || typeof thread.cwd !== "string" || !exactPath(thread.cwd, scope.cwd) || !Array.isArray(thread.turns)) throw new Error("Selected provider thread snapshot escaped its validated scope or is incomplete.");
      return { harness, projectId, providerThreadId, thread };
    }

    const limit = body.limit === undefined ? 50 : body.limit;
    if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > MAX_PAGE_SIZE) throw new Error("Legacy migration catalog limit is out of bounds.");
    const cursor = body.cursor === null || body.cursor === undefined ? null : requireString(body.cursor, "Legacy migration cursor");
    const codexCursor = harness === "codex" ? decodeCodexCursor(cursor) : null;
    const result = readResult(await raceDeadline(this.options.requestHarness(harness, {
      id: "legacy-migration:catalog-page",
      method: "thread/list",
      params: {
        ...(codexCursor ? { archived: codexCursor.archived, ...(codexCursor.providerCursor ? { cursor: codexCursor.providerCursor } : {}) } : cursor ? { cursor } : {}),
        cwd: scope.cwd,
        limit,
        projectId,
      },
    }), timeoutMs as number, signal), "thread/list");
    if (!Array.isArray(result.data)) throw new Error("Provider catalog page is malformed.");
    const providerCursor = typeof result.nextCursor === "string" && result.nextCursor.trim() ? result.nextCursor.trim() : null;
    const nextCursor = codexCursor
      ? providerCursor ? encodeCodexCursor(codexCursor.archived, providerCursor) : codexCursor.archived ? null : encodeCodexCursor(true, null)
      : providerCursor;
    return {
      complete: nextCursor === null,
      cursor: nextCursor,
      harness,
      projectId,
      summaries: result.data.map((entry) => safeSummary(entry, scope.cwd)).filter((entry) => entry && entry.providerThreadId !== ACTIVE_THREAD_ID),
    };
    } finally {
      this.active = false;
    }
  }

  async handleHttpRequest(request: http.IncomingMessage, response: http.ServerResponse) {
    if (request.method !== "POST") return sendJson(response, 405, { error: "Method not allowed" });
    if (!this.options.capability || request.headers["x-workbench-migration-capability"] !== this.options.capability) return sendJson(response, 403, { error: "Legacy migration source is disabled or unauthorized." });
    const cancellation = new AbortController();
    const onAborted = () => cancellation.abort(new Error("Legacy migration source client disconnected."));
    request.once("aborted", onAborted);
    try {
      sendJson(response, 200, await this.execute(await readBody(request), cancellation.signal));
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : "Legacy migration source failed." });
    } finally {
      request.removeListener("aborted", onAborted);
    }
  }
}
