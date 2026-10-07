/*
 * Exports:
 * - formatDuration: format durations in short d/h/m/s form, shared by thread metadata and daemon-authored messages.
 */

export function formatDuration (durationMs: number | null) {
  if (durationMs === null) {
    return "";
  }

  const totalMs = Math.max(0, Math.floor(durationMs));
  if (totalMs > 0 && totalMs < 1000) {
    return `${totalMs}ms`;
  }

  let remainingMs = totalMs;
  const days = Math.floor(remainingMs / 86_400_000);
  remainingMs -= days * 86_400_000;
  const hours = Math.floor(remainingMs / 3_600_000);
  remainingMs -= hours * 3_600_000;
  const minutes = Math.floor(remainingMs / 60_000);
  remainingMs -= minutes * 60_000;
  const seconds = Math.floor(remainingMs / 1000);
  remainingMs -= seconds * 1000;

  const parts = [];
  if (days) {
    parts.push(`${days}d`);
  }
  if (hours) {
    parts.push(`${hours}h`);
  }
  if (minutes) {
    parts.push(`${minutes}m`);
  }
  if (seconds || (!parts.length && !remainingMs)) {
    parts.push(`${seconds}s`);
  }

  if (!parts.length) {
    parts.push("0s");
  }

  return parts.join(" ");
}
