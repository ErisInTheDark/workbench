/*
 * Exports:
 * - formatRateLimitWindowLabel: name a quota window from its duration. Keywords: rate limit, duration, label.
 * - formatRateLimitResetTime: format a reset timestamp for compact local display. Keywords: rate limit, reset, time.
 * - formatRateLimitIdentity: name an account limit without duplicate provider identity. Keywords: rate limit, provider, label.
 */
import type { WorkbenchHarness } from "workbench-shared/types";

function providerLabel(provider: WorkbenchHarness) {
  if (provider === "opencode") return "OpenCode";
  return `${provider[0]!.toUpperCase()}${provider.slice(1)}`;
}

export function formatRateLimitIdentity(
  provider: WorkbenchHarness,
  limitId: string,
  limitName: string | null,
) {
  const providerName = providerLabel(provider);
  const duplicatesProvider = (value: string | null) => value?.trim().toLocaleLowerCase() === provider.toLocaleLowerCase();
  const meaningfulName = limitName?.trim() && !duplicatesProvider(limitName) && limitName !== limitId
    ? limitName.trim()
    : null;
  const meaningfulId = limitId.trim() && !duplicatesProvider(limitId) ? limitId.trim() : null;
  return meaningfulName ? `${providerName} · ${meaningfulName}` : meaningfulId ? `${providerName} · ${meaningfulId}` : providerName;
}
export function formatRateLimitWindowLabel(durationMinutes: number | null, fallback: string) {
  if (durationMinutes === null) return fallback;
  if (durationMinutes === 60 * 24 * 7) return "Weekly";
  if (durationMinutes % (60 * 24) === 0) return `${durationMinutes / (60 * 24)}d`;
  if (durationMinutes % 60 === 0) return `${durationMinutes / 60}h`;
  return `${durationMinutes}m`;
}

export function formatRateLimitResetTime(timestampMs: number | null) {
  if (timestampMs === null) return "No reset";
  const resetDate = new Date(timestampMs);
  const now = new Date();
  if (
    resetDate.getFullYear() === now.getFullYear()
    && resetDate.getMonth() === now.getMonth()
    && resetDate.getDate() === now.getDate()
  ) {
    return resetDate.toLocaleTimeString([], { hour: "2-digit", hour12: false, minute: "2-digit" });
  }
  return resetDate.toLocaleDateString([], { day: "numeric", month: "short" });
}
