/*
 * Exports:
 * - default useThreadActivityTimestamp: track fallback and observed visible thread activity time. Keywords: workbench, thread, activity, timestamp.
 */
"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import type { ThreadPayload, ThreadSummary } from "../../../lib/types";

function getFallbackActivityTimestampMs(...threads: Array<ThreadPayload | ThreadSummary | null | undefined>) {
  let timestampMs = 0;
  for (const thread of threads) {
    if (!thread || !Number.isFinite(thread.updatedAt) || thread.updatedAt <= 0) {
      continue;
    }

    timestampMs = Math.max(timestampMs, thread.updatedAt * 1000);
  }

  return timestampMs;
}

function getThreadActivitySignature(thread: ThreadPayload | ThreadSummary | null) {
  if (!thread || !("turns" in thread)) {
    return "";
  }

  const latestTurn = thread.turns.at(-1);
  const latestItem = latestTurn?.items.at(-1);
  return [
    thread.harness,
    thread.id,
    thread.status,
    thread.turns.length,
    latestTurn?.id ?? "",
    latestTurn?.status ?? "",
    latestTurn?.items.length ?? 0,
    latestItem?.id ?? "",
    latestItem?.type ?? "",
  ].join("|");
}

export default function useThreadActivityTimestamp(
  thread: ThreadPayload | ThreadSummary | null,
  fallbackThread?: ThreadPayload | ThreadSummary | null,
) {
  const fallbackTimestampMs = getFallbackActivityTimestampMs(thread, fallbackThread);
  const activitySignature = useMemo(() => getThreadActivitySignature(thread), [thread]);
  const latestFallbackTimestampRef = useRef<{
    key: string;
    timestampMs: number;
  } | null>(null);
  const previousActivityRef = useRef<{
    key: string;
    signature: string;
  } | null>(null);
  const [observedActivityTimestampMs, setObservedActivityTimestampMs] = useState(0);
  const threadKey = thread ? `${thread.harness}:${thread.id}` : "";

  useEffect(() => {
    if (!threadKey) {
      latestFallbackTimestampRef.current = null;
      previousActivityRef.current = null;
      setObservedActivityTimestampMs(0);
      return;
    }

    const latestFallback = latestFallbackTimestampRef.current;
    latestFallbackTimestampRef.current = {
      key: threadKey,
      timestampMs: latestFallback?.key === threadKey
        ? Math.max(latestFallback.timestampMs, fallbackTimestampMs)
        : fallbackTimestampMs,
    };

    const previous = previousActivityRef.current;
    if (!previous || previous.key !== threadKey) {
      previousActivityRef.current = { key: threadKey, signature: activitySignature };
      setObservedActivityTimestampMs(0);
      return;
    }

    if (!activitySignature || previous.signature === activitySignature) {
      return;
    }

    previousActivityRef.current = { key: threadKey, signature: activitySignature };
    if (!previous.signature) {
      return;
    }

    setObservedActivityTimestampMs(Date.now());
  }, [activitySignature, fallbackTimestampMs, threadKey]);

  const latestFallbackTimestampMs = latestFallbackTimestampRef.current?.key === threadKey
    ? Math.max(latestFallbackTimestampRef.current.timestampMs, fallbackTimestampMs)
    : fallbackTimestampMs;
  return Math.max(latestFallbackTimestampMs, observedActivityTimestampMs);
}
