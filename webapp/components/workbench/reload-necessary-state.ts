/*
 * Exports:
 * - NORMAL_RELOAD_HOLD_MS/DESTRUCTIVE_RELOAD_HOLD_MS: user-confirmation durations for ordinary and destructive scopes. Keywords: reload, confirmation, duration.
 * - getReloadScopeHoldMs/getReloadAllHoldMs: derive user-confirmation duration from destructive scope metadata. Keywords: reload, confirmation, destructive.
 * - readReloadResponse: parse the reload HTTP boundary without exposing malformed or HTML response bodies. Keywords: reload, HTTP, JSON, error.
 * - waitForReloadCompletion: follow one admitted reload to its matching terminal state with caller-owned cancellation. Keywords: reload, status, polling, cancellation.
 */
import type { OrchestratorReloadResponse, WorkbenchReloadDirtScope } from "../../lib/types";

export const NORMAL_RELOAD_HOLD_MS = 500;
export const DESTRUCTIVE_RELOAD_HOLD_MS = 2_000;
const RELOAD_STATUS_POLL_MS = 250;
type ReloadResponsePayload = OrchestratorReloadResponse | { error?: string };

export function getReloadScopeHoldMs(scope: WorkbenchReloadDirtScope) {
  return scope.destructive ? DESTRUCTIVE_RELOAD_HOLD_MS : NORMAL_RELOAD_HOLD_MS;
}

export function getReloadAllHoldMs(scopes: readonly WorkbenchReloadDirtScope[]) {
  return Math.max(NORMAL_RELOAD_HOLD_MS, ...scopes.map(getReloadScopeHoldMs));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isReloadResponse(value: unknown): value is OrchestratorReloadResponse {
  if (!isRecord(value)) return false;
  return value.ok === true
    && (value.state === "failed" || value.state === "running" || value.state === "succeeded")
    && (typeof value.startedAt === "number" || value.startedAt === null)
    && (typeof value.completedAt === "number" || value.completedAt === null)
    && (typeof value.error === "string" || value.error === null)
    && isStringArray(value.appliedScopes)
    && isStringArray(value.queuedScopes)
    && isStringArray(value.requestedScopes);
}

export async function readReloadResponse(response: Response): Promise<ReloadResponsePayload> {
  const text = await response.text();
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error(`The reload endpoint returned an empty response (HTTP ${response.status}).`);
  }
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    const responseKind = contentType.includes("text/html") || trimmed.startsWith("<") ? "HTML" : "non-JSON";
    throw new Error(`The reload endpoint returned ${responseKind} instead of JSON (HTTP ${response.status}).`);
  }
  if (isReloadResponse(value)) return value;
  if (isRecord(value) && typeof value.error === "string") return { error: value.error };
  throw new Error(`The reload endpoint returned an invalid response (HTTP ${response.status}).`);
}

function waitForNextPoll(signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timeoutId = window.setTimeout(() => {
      signal.removeEventListener("abort", cancel);
      resolve();
    }, RELOAD_STATUS_POLL_MS);
    const cancel = () => {
      window.clearTimeout(timeoutId);
      reject(signal.reason);
    };
    signal.addEventListener("abort", cancel, { once: true });
  });
}

export async function waitForReloadCompletion({
  admission,
  readStatus,
  signal,
  wait = waitForNextPoll,
}: {
  admission: OrchestratorReloadResponse;
  readStatus(signal: AbortSignal): Promise<OrchestratorReloadResponse>;
  signal: AbortSignal;
  wait?(signal: AbortSignal): Promise<void>;
}) {
  const startedAt = admission.startedAt;
  if (admission.state !== "running" || startedAt === null) return admission;
  let status = admission;
  while (status.state === "running") {
    await wait(signal);
    status = await readStatus(signal);
    if (status.startedAt !== startedAt) {
      throw new Error("The reload status was replaced by a different request.");
    }
  }
  return status;
}
