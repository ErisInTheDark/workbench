/*
 * Exports:
 * - CODEX_TRANSCRIPT_DIAGNOSTIC_INTERVAL_MS: shared anomaly check and repeat interval. Keywords: transcript, diagnostics, interval.
 * - CodexTranscriptDiagnosticInput/CodexTranscriptDiagnostic: current queue and memory evidence contracts. Keywords: transcript, backlog, memory.
 * - createCodexTranscriptDiagnostic: emit one compact anomaly only for a large or old pending queue. Keywords: transcript, anomaly, logging.
 */
export const CODEX_TRANSCRIPT_DIAGNOSTIC_INTERVAL_MS = 5_000;

const BACKLOG_COUNT_THRESHOLD = 25;
const OLDEST_PENDING_AGE_THRESHOLD_MS = 5_000;

export interface CodexTranscriptDiagnosticInput {
  lastLoggedAt: number | null;
  memory: Pick<NodeJS.MemoryUsage, "heapTotal" | "heapUsed" | "rss">;
  now: number;
  pending: ReadonlyArray<{ label: string; startedAt: number }>;
}

export interface CodexTranscriptDiagnostic {
  loggedAt: number;
  message: string;
}

function formatMegabytes(value: number) {
  return `${Math.round(value / 1_024 / 1_024)}MB`;
}

function formatDuration(value: number) {
  const duration = Math.max(0, value);
  return duration < 1_000 ? `${Math.round(duration)}ms` : `${(duration / 1_000).toFixed(1)}s`;
}

export function createCodexTranscriptDiagnostic({ lastLoggedAt, memory, now, pending }: CodexTranscriptDiagnosticInput): CodexTranscriptDiagnostic | null {
  if (!pending.length) return null;
  const oldest = pending.reduce((current, candidate) => candidate.startedAt < current.startedAt ? candidate : current);
  const oldestAgeMs = Math.max(0, now - oldest.startedAt);
  if (pending.length < BACKLOG_COUNT_THRESHOLD && oldestAgeMs < OLDEST_PENDING_AGE_THRESHOLD_MS) return null;
  if (lastLoggedAt !== null && now - lastLoggedAt < CODEX_TRANSCRIPT_DIAGNOSTIC_INTERVAL_MS) return null;
  return {
    loggedAt: now,
    message: `backlog pending=${pending.length} oldest=${oldest.label} age=${formatDuration(oldestAgeMs)} rss=${formatMegabytes(memory.rss)} heap=${formatMegabytes(memory.heapUsed)}/${formatMegabytes(memory.heapTotal)}`,
  };
}
