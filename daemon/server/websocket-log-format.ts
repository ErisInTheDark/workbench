/*
 * Keywords: websocket, diagnostics, routing, bounded logs, payload privacy.
 * Exports:
 * - dimWebSocketDetail: style secondary transport timing.
 * - formatWebSocketBytes: use consistent byte units for requests and event traffic.
 * - webSocketMethodLabel: identify a provider or Workbench method consistently.
 * - describeWebSocketEvent: name the event inside an envelope by kind and the thread or project it concerns.
 * - formatWebSocketEventSummary: render bounded event traffic without payloads or request timings.
 * - formatWebSocketSendFailure: report bounded send context without serialising payload bodies.
 */
import type { WorkbenchHarness } from "workbench-shared/types";
import { ProviderKeySchema } from "workbench-shared/workbench/provider/provider-key";

const ANSI_DIM = "\u001b[2m";
const ANSI_RESET = "\u001b[0m";
const SHORT_ID_LENGTH = 8;

const record = (value: unknown): Record<string, unknown> | null => (
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
);
const bounded = (value: string, limit = 160) => value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, "").slice(0, limit);
const shortId = (value: unknown) => typeof value === "string" && value.trim()
  ? bounded(value.trim(), SHORT_ID_LENGTH) : null;

export function dimWebSocketDetail(value: string) {
  return `${ANSI_DIM}${value}${ANSI_RESET}`;
}

export function webSocketMethodLabel(harness: WorkbenchHarness | "unknown" | "workbench", method: string) {
  if (harness !== "workbench") return `${harness}:${method}`;
  return `wb:${method.startsWith("workbench/") ? method.slice("workbench/".length) : method}`;
}

export function formatWebSocketBytes(value: number) {
  if (value < 1_024) return `${Math.max(0, Math.round(value))}B`;
  if (value < 1_024 * 1_024) return `${(value / 1_024).toFixed(1)}KB`;
  return `${(value / 1_024 / 1_024).toFixed(1)}MB`;
}

/**
 * Envelopes such as `workspace/updated` carry many different events; logs name the inner one.
 * Only kinds and shortened ids are read, never payload values.
 */
export function describeWebSocketEvent(params: unknown): string | null {
  const values = record(params);
  if (!values) return null;
  const data = record(values.data);
  const kind = [values.kind, values.updateKind, data?.updateKind]
    .find((value): value is string => typeof value === "string" && value.length > 0);
  const thread = shortId(values.threadId) ?? shortId(record(values.identity)?.threadId)
    ?? shortId(record(data?.target)?.threadId) ?? shortId(record(values.target)?.threadId);
  const project = thread ? null : shortId(values.projectId) ?? shortId(data?.projectId);
  const parts = [
    kind ? bounded(kind, 48) : null,
    thread ? `thread=${thread}` : null,
    project ? `project=${project}` : null,
  ].filter((part): part is string => part !== null);
  return parts.length ? parts.join(" ") : null;
}

export function formatWebSocketEventSummary(direction: "in" | "out", label: string, count: number, bytes: number) {
  return ` WS ${direction} ${bounded(label)} ${dimWebSocketDetail(`(count: ${count}, ${direction}: ${formatWebSocketBytes(bytes)})`)}`;
}

export function formatWebSocketSendFailure(message: unknown, error: unknown) {
  const envelope = record(message);
  const params = record(envelope?.params);
  const identity = record(params?.identity);
  const sidebar = record(params?.sidebar);
  const summary = record(params?.summary);
  const harness = envelope?.workbenchHarness;
  const method = typeof envelope?.method === "string" ? bounded(envelope.method) : "response";
  const label = webSocketMethodLabel(
    ProviderKeySchema.safeParse(harness).success ? harness as WorkbenchHarness : "workbench",
    method,
  );
  const context = Object.entries({
    update: params?.updateKind,
    project: params?.projectId ?? sidebar?.projectId ?? summary?.projectId,
    thread: params?.threadId ?? identity?.threadId,
  }).flatMap(([key, value]) => typeof value === "string" ? [`${key}=${JSON.stringify(bounded(value))}`] : []).join(" ");
  const detail = bounded(error instanceof Error ? error.message : String(error), 800);
  return ` WS ${label} \u001b[31msend-error${ANSI_RESET}${context ? ` ${context}` : ""} ${detail}`;
}
