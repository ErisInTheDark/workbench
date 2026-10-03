/*
 * Exports:
 * - boundWebSocketLogText: strip control characters and cap untrusted log text.
 * - dimWebSocketDetail: style secondary transport details grey.
 * - formatWebSocketBytes: use consistent B/KB/MB units for requests and event traffic.
 * - formatWebSocketEventSummary: render one bounded traffic window line without payloads.
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
