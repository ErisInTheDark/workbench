/*
 * Keywords: thread, duration, live clock, cleanup.
 * Exports:
 * - useThreadLiveDuration: add active elapsed time to recorded duration, refreshing once per second.
 * - useThreadItemLiveDuration: prefer canonical active-item timing over provider-reported duration.
 */
"use client";

import { useEffect, useState } from "react";

export function useThreadLiveDuration(
  durationMs: number | null | undefined,
  activeStartedAtMs: number | null | undefined,
) {
  const [nowMs, setNowMs] = useState(Date.now);
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
      ? durationMs + Math.max(0, nowMs - activeStartedAtMs)
      : durationMs;
}

export function useThreadItemLiveDuration(
  durationMs: number | null | undefined,
  activeStartedAtMs: number | null | undefined,
) {
  return useThreadLiveDuration(
    activeStartedAtMs === null || activeStartedAtMs === undefined ? durationMs : 0,
    activeStartedAtMs,
  );
}
