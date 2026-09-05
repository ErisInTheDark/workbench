/*
 * Keywords: thread, duration, live clock, cleanup.
 * Exports:
 * - useThreadLiveDuration: add active elapsed time to recorded duration, refreshing once per second.
 */
"use client";

import { useEffect, useState } from "react";

export function useThreadLiveDuration(
  durationMs: number | null | undefined,
  activeStartedAtMs: number | null | undefined,
) {
  const [nowMs, setNowMs] = useState<number | null>(null);
  useEffect(() => {
    if (activeStartedAtMs === null || activeStartedAtMs === undefined) {
      return;
    }

    const updateNow = () => setNowMs(Date.now());
    updateNow();
    const intervalId = window.setInterval(updateNow, 1_000);
    return () => window.clearInterval(intervalId);
  }, [activeStartedAtMs]);

  return activeStartedAtMs !== null
    && activeStartedAtMs !== undefined
    && durationMs !== null
    && durationMs !== undefined
    && nowMs !== null
      ? durationMs + Math.max(0, nowMs - activeStartedAtMs)
      : durationMs;
}
