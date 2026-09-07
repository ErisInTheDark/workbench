/*
 * Keywords: websocket, diagnostics, routing, bounded logs, payload privacy.
 * Exports:
 * - dimWebSocketDetail: style secondary transport timing.
 * - webSocketMethodLabel: identify a provider or Workbench method consistently.
 * - formatWebSocketSendFailure: report bounded send context without serialising payload bodies.
 */
import type { WorkbenchHarness } from "workbench-shared/types";

const ANSI_DIM = "\u001b[2m";
const ANSI_RESET = "\u001b[0m";

export function dimWebSocketDetail(value: string) {
  return `${ANSI_DIM}${value}${ANSI_RESET}`;
}

export function webSocketMethodLabel(harness: WorkbenchHarness | "unknown" | "workbench", method: string) {
  if (harness !== "workbench") return `${harness}:${method}`;
  return `wb:${method.startsWith("workbench/") ? method.slice("workbench/".length) : method}`;
}

export function formatWebSocketSendFailure(message: unknown, error: unknown) {
  const record = (value: unknown): Record<string, unknown> | null => (
    value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
  );
  const bounded = (value: string, limit = 160) => value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, "").slice(0, limit);
  const envelope = record(message);
  const params = record(envelope?.params);
  const identity = record(params?.identity);
  const sidebar = record(params?.sidebar);
  const summary = record(params?.summary);
  const harness = envelope?.workbenchHarness;
  const method = typeof envelope?.method === "string" ? bounded(envelope.method) : "response";
  const label = webSocketMethodLabel(
    harness === "codex" || harness === "copilot" || harness === "opencode" ? harness : "workbench",
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
