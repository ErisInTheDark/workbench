/*
 * Exports:
 * - LegacyMigrationHarnessRequest/LegacyMigrationProjectResolution/WorkbenchLegacyMigrationSourceControllerOptions: injected live-bridge and validated-project boundaries. Keywords: migration, source, capability, project.
 * - LegacyMigrationSnapshotError: safe typed selected-thread failure with exact durable import identity. Keywords: migration, diagnostics, terminal, identity.
 * - default WorkbenchLegacyMigrationSourceController: serve one bounded catalog page or one selected normalized thread snapshot, owning Codex unloaded-session resume. Keywords: migration, readonly, lazy, resume, bridge.
 */
import type http from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";

import type { WorkbenchHarness } from "../lib/types";
import type { JsonRpcRequest, JsonRpcResponse } from "./bridge-types";

const MAX_BODY_BYTES = 64 * 1024;
const MAX_PAGE_SIZE = 100;
const MAX_PROVIDER_REASON_LENGTH = 240;
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

type SnapshotCause = "identityMismatch" | "providerMissing" | "providerReadFailed" | "providerResumeFailed" | "scopeNotAllowlisted";
type SafeProviderReason = { code: number; message: string };
type SnapshotContext = { bindingState: string; correlationId: string; harness: WorkbenchHarness; providerReason?: SafeProviderReason; providerThreadId: string; sourceKind: string; workbenchThreadId: string };

export class LegacyMigrationSnapshotError extends Error {
  constructor(readonly causeCode: SnapshotCause, readonly context: SnapshotContext, readonly terminal: boolean, options?: ErrorOptions) {
    const providerReason = context.providerReason ? ` providerReasonCode=${context.providerReason.code} providerReason=${context.providerReason.message}` : "";
    super(`Legacy import ${causeCode}: harness=${context.harness} providerThreadId=${context.providerThreadId} workbenchThreadId=${context.workbenchThreadId} bindingState=${context.bindingState} correlationId=${context.correlationId} sourceKind=${context.sourceKind}${providerReason}`, options);
    this.name = "LegacyMigrationSnapshotError";
  }
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

function sanitizeProviderReason(error: NonNullable<JsonRpcResponse["error"]>, cwd: string): SafeProviderReason {
  const escapedCwd = cwd.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const message = error.message
    .replace(new RegExp(`${escapedCwd}(?:[\\\\/][^\\s\"'<>]*)?`, "giu"), "[path]")
    .replace(/\b[A-Za-z]:[\\/][^\s"'<>]*/gu, "[path]")
    .replace(/(^|\s)\/(?:Users|home|private|tmp|var|etc|opt|srv|mnt)\/[^\s"'<>]*/giu, "$1[path]")
    .replace(/\b(Bearer\s+)[^\s,;]+/giu, "$1[redacted]")
    .replace(/\b(api[_-]?key|authorization|secret|token)(\s*[:=]\s*)[^\s,;]+/giu, "$1$2[redacted]")
    .replace(/\s+/gu, " ")
    .trim();
  return {
    code: error.code,
    message: message.length > MAX_PROVIDER_REASON_LENGTH ? `${message.slice(0, MAX_PROVIDER_REASON_LENGTH - 1)}…` : message,
  };
}

function withProviderReason(context: SnapshotContext, error: NonNullable<JsonRpcResponse["error"]>, cwd: string): SnapshotContext {
  return { ...context, providerReason: sanitizeProviderReason(error, cwd) };
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

function missingProviderMessage(message: string, providerThreadId: string) {
  const normalized = message.toLocaleLowerCase();
  return normalized === `thread not found: ${providerThreadId}`.toLocaleLowerCase()
    || normalized === `thread deleted: ${providerThreadId}`.toLocaleLowerCase()
    || normalized === `thread does not exist: ${providerThreadId}`.toLocaleLowerCase();
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
    const exactScope = scope.project.id === projectId && exactPath(scope.cwd, cwd);
    if (operation === "threadSnapshot") return await this.readThreadSnapshot(body, harness, scope.cwd, projectId, timeoutMs as number, exactScope, signal);
    if (!exactScope || !this.options.allowedProjectIds.has(projectId)) throw new Error("Legacy migration scope is not allowlisted.");

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

  private async readThreadSnapshot(body: Record<string, unknown>, harness: WorkbenchHarness, cwd: string, projectId: string, timeoutMs: number, exactScope: boolean, signal?: AbortSignal) {
    const context: SnapshotContext = {
      bindingState: requireString(body.bindingState, "Legacy migration bindingState"),
      correlationId: requireString(body.correlationId, "Legacy migration correlationId"),
      harness,
      providerThreadId: requireString(body.providerThreadId, "Legacy migration providerThreadId"),
      sourceKind: requireString(body.sourceKind, "Legacy migration sourceKind"),
      workbenchThreadId: requireString(body.workbenchThreadId, "Legacy migration workbenchThreadId"),
    };
    if (!exactScope) throw new LegacyMigrationSnapshotError("identityMismatch", context, true);
    if (!this.options.allowedProjectIds.has(projectId)) throw new LegacyMigrationSnapshotError("scopeNotAllowlisted", context, true);
    if (context.providerThreadId === ACTIVE_THREAD_ID) throw new Error("The active Workbench thread is excluded from legacy migration reads.");
    const read = async (suffix: string) => await raceDeadline(this.options.requestHarness(harness, {
      id: `legacy-migration:${context.correlationId}:${suffix}`,
      method: "thread/read",
      params: { cwd, includeTurns: true, ...(harness === "codex" ? {} : { projectId }), threadId: context.providerThreadId },
    }), timeoutMs, signal);
    let response = await read("thread-read");
    if (response.error?.message === `thread not loaded: ${context.providerThreadId}` && harness === "codex") {
      const resumed = await raceDeadline(this.options.requestHarness(harness, {
        id: `legacy-migration:${context.correlationId}:thread-resume`,
        method: "thread/resume",
        params: { threadId: context.providerThreadId },
      }), timeoutMs, signal);
      if (resumed.error) throw new LegacyMigrationSnapshotError("providerResumeFailed", withProviderReason(context, resumed.error, cwd), false, { cause: resumed.error });
      response = await read("thread-read-after-resume");
    }
    if (response.error) {
      if (missingProviderMessage(response.error.message, context.providerThreadId)) throw new LegacyMigrationSnapshotError("providerMissing", context, true, { cause: response.error });
      throw new LegacyMigrationSnapshotError("providerReadFailed", withProviderReason(context, response.error, cwd), false, { cause: response.error });
    }
    const thread = isRecord(response.result) && isRecord(response.result.thread) ? response.result.thread : null;
    if (!thread || thread.id !== context.providerThreadId || typeof thread.cwd !== "string" || !exactPath(thread.cwd, cwd) || !Array.isArray(thread.turns)) throw new LegacyMigrationSnapshotError("identityMismatch", context, true);
    return { harness, projectId, providerThreadId: context.providerThreadId, thread };
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
      const snapshotError = error instanceof LegacyMigrationSnapshotError ? error : null;
      sendJson(response, snapshotError?.terminal ? 410 : 400, { ...(snapshotError ? { cause: snapshotError.causeCode, context: snapshotError.context } : {}), error: error instanceof Error ? error.message : "Legacy migration source failed." });
    } finally {
      request.removeListener("aborted", onAborted);
    }
  }
}
