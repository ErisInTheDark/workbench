/*
 * Exports:
 * - UpstreamFetchFocus: how closely a folder's upstream is being watched.
 * - UPSTREAM_FETCH_TICK_MS: how often demanded repositories are checked for a due fetch.
 * - upstreamFetchTtl: how long a fetch stays fresh for a focus, stretched by consecutive failures.
 * - isUpstreamFetchDue: whether a repository's last fetch attempt has outlived its ttl.
 */

/** `ambient`: a thread or the branch position is observed. `focused`: the git panel is open. */
export type UpstreamFetchFocus = "ambient" | "focused";

export const UPSTREAM_FETCH_TICK_MS = 15_000;
const TTL_MS: Record<UpstreamFetchFocus, number> = { focused: 60_000, ambient: 10 * 60_000 };
const MAX_BACKOFF_MS = 30 * 60_000;

export function upstreamFetchTtl(focus: UpstreamFetchFocus, failures: number) {
  const ttl = TTL_MS[focus];
  return failures > 0 ? Math.max(ttl, Math.min(ttl * 2 ** failures, MAX_BACKOFF_MS)) : ttl;
}

export function isUpstreamFetchDue({ focus, fetchedAt, failures, now }: {
  focus: UpstreamFetchFocus;
  /** When the last fetch attempt finished, successful or not; null when never attempted. */
  fetchedAt: number | null;
  failures: number;
  now: number;
}) {
  return fetchedAt === null || now - fetchedAt >= upstreamFetchTtl(focus, failures);
}
