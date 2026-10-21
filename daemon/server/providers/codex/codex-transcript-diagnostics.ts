/*
 * Exports:
 * - CODEX_TRANSCRIPT_DIAGNOSTIC_INTERVAL_MS: shared anomaly check and repeat interval.
 * - CodexTranscriptDiagnosticInput/CodexTranscriptDiagnostic: current queue and memory evidence contracts.
 * - createCodexTranscriptDiagnostic: emit one compact anomaly only for a large or old pending queue, in constant time per call.
 */
export const CODEX_TRANSCRIPT_DIAGNOSTIC_INTERVAL_MS = 5_000;

const BACKLOG_COUNT_THRESHOLD = 25;
const OLDEST_PENDING_AGE_THRESHOLD_MS = 5_000;

export interface CodexTranscriptDiagnosticInput {
  lastLoggedAt: number | null;
  /** Read only when a line is emitted; checks run on every capture. */
  memory: () => Pick<NodeJS.MemoryUsage, "heapTotal" | "heapUsed" | "rss">;
  now: number;
  pending: { count: number; oldest: { label: string; startedAt: number } | undefined };
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
  const { count, oldest } = pending;
  if (!count || !oldest) return null;
  if (lastLoggedAt !== null && now - lastLoggedAt < CODEX_TRANSCRIPT_DIAGNOSTIC_INTERVAL_MS) return null;
  const oldestAgeMs = Math.max(0, now - oldest.startedAt);
  if (count < BACKLOG_COUNT_THRESHOLD && oldestAgeMs < OLDEST_PENDING_AGE_THRESHOLD_MS) return null;
  const usage = memory();
  return {
    loggedAt: now,
    message: `backlog pending=${count} oldest=${oldest.label} age=${formatDuration(oldestAgeMs)} rss=${formatMegabytes(usage.rss)} heap=${formatMegabytes(usage.heapUsed)}/${formatMegabytes(usage.heapTotal)}`,
  };
}
