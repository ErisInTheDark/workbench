/*
 * Exports:
 * - boundWebSocketLogText: strip control characters and cap untrusted log text.
 * - dimWebSocketDetail: style secondary transport details grey.
 * - formatWebSocketBytes: use consistent B/KB/MB units for requests and event traffic.
 * - formatWebSocketEventSummary: render one bounded traffic window line without payloads.
 * - WebSocketSubjectWindow/webSocketSubjectKey/formatWebSocketSubjectSummary: roll frames about the same threads into one line.
 * - threadEventSubject: the thread a provider event names, as a log subject.
 */
const ANSI_DIM = "\u001b[2m";
const ANSI_RESET = "\u001b[0m";

export function boundWebSocketLogText(value: string, limit = 160) {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, "").slice(0, limit);
}

export function dimWebSocketDetail(value: string) {
  return `${ANSI_DIM}${value}${ANSI_RESET}`;
}

export function formatWebSocketBytes(value: number) {
  if (value < 1_024) return `${Math.max(0, Math.round(value))}B`;
  if (value < 1_024 * 1_024) return `${(value / 1_024).toFixed(1)}KB`;
  return `${(value / 1_024 / 1_024).toFixed(1)}MB`;
}

export function formatWebSocketEventSummary(direction: "in" | "out", label: string, count: number, bytes: number) {
  return ` WS ${direction} ${boundWebSocketLogText(label)} ${dimWebSocketDetail(`(count: ${count}, ${direction}: ${formatWebSocketBytes(bytes)})`)}`;
}

/** What frames about the same subjects (thread or project id prefixes) carried during one window. */
export interface WebSocketSubjectWindow {
  direction: "in" | "out";
  subjects: readonly string[];
  /** Event kinds in arrival order, e.g. `codex:item/started` or a workspace observation kind. */
  kinds: Set<string>;
  fields: Set<string>;
  /** Distinct connections the frames went to; logged only when more than one. */
  connections: Set<string>;
  count: number;
  bytes: number;
}

const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** The thread a provider event names (`threadId` or `thread.id`), as a subject; null when it names none. */
export function threadEventSubject(params: unknown): { subjects: string[]; fields: string[] } | null {
  if (!params || typeof params !== "object") return null;
  const values = params as { threadId?: unknown; thread?: { id?: unknown } | null };
  const threadId = typeof values.threadId === "string" ? values.threadId
    : typeof values.thread?.id === "string" ? values.thread.id : null;
  return threadId && THREAD_ID.test(threadId) ? { subjects: [threadId.slice(0, 8)], fields: [] } : null;
}

export function webSocketSubjectKey(direction: "in" | "out", subjects: readonly string[]) {
  return `${direction}:${subjects.join(",")}`;
}

/** One line per subject window: `WS out c6c7f1bd: thread, summaries [-waitingFor, status] (count: 3, out: 1.3KB)`. */
export function formatWebSocketSubjectSummary(window: WebSocketSubjectWindow) {
  const subjects = window.subjects.length > 3
    ? `${window.subjects.slice(0, 3).join(", ")} +${window.subjects.length - 3}` : window.subjects.join(", ");
  const kinds = [...window.kinds];
  const fields = [...window.fields];
  const label = `${subjects}: ${kinds.slice(0, 6).join(", ")}${kinds.length > 6 ? ", ..." : ""}`
    + (fields.length ? ` [${fields.slice(0, 8).join(", ")}${fields.length > 8 ? ", ..." : ""}]` : "");
  const tabs = window.connections.size > 1 ? `, to: ${window.connections.size}` : "";
  return ` WS ${window.direction} ${boundWebSocketLogText(label, 320)} ${dimWebSocketDetail(
    `(count: ${window.count}${tabs}, ${window.direction}: ${formatWebSocketBytes(window.bytes)})`)}`;
}
