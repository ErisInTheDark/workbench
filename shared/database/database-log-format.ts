/*
 * Exports:
 * - DATABASE_LOG_PREFIX: identify database-produced progress lines.
 * - formatDatabaseLog: style bounded database progress like WS and CLI messages.
 */
export const DATABASE_LOG_PREFIX = " DB ";

const ANSI_DIM = "\u001b[2m";
const ANSI_GREEN = "\u001b[32m";
const ANSI_YELLOW = "\u001b[33m";
const ANSI_RESET = "\u001b[0m";

export function formatDatabaseLog(
  operation: string,
  status: "pending" | "copying" | "ok",
  detail: string,
  elapsedMs?: number,
) {
  const bounded = (value: string) => value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, "").slice(0, 300);
  const duration = elapsedMs === undefined ? null : Math.max(0, elapsedMs);
  const time = duration === null ? "" : ` ${status === "ok" ? "in" : "after"} ${
    duration < 1_000 ? `${Math.round(duration)}ms` : `${(duration / 1_000).toFixed(1)}s`
  }`;
  const color = status === "ok" ? ANSI_GREEN : ANSI_YELLOW;
  return `${DATABASE_LOG_PREFIX}${bounded(operation)} ${color}${status}${ANSI_RESET}${time} ${ANSI_DIM}(${bounded(detail)})${ANSI_RESET}`;
}
