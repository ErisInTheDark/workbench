/*
 * Exports:
 * - default useThreadActivityTimestamp: track fallback and observed visible thread activity time. Keywords: workbench, thread, activity, timestamp.
 */
"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import type { ThreadPayload, ThreadSummary } from "../../../lib/types";
import { getTurnRenderSignature } from "../../../lib/workbench/thread/thread-item-signature";

function getFallbackActivityTimestampMs(thread: ThreadPayload | ThreadSummary | null) {
  if (!thread || !Number.isFinite(thread.updatedAt) || thread.updatedAt <= 0) {
    return 0;
  }

  return thread.updatedAt * 1000;
}

function getThreadActivitySignature(thread: ThreadPayload | ThreadSummary | null) {
  if (!thread || !("turns" in thread)) {
    return "";
  }

  return thread.turns.map((turn) => getTurnRenderSignature(turn)).join("\n\n");
}

export default function useThreadActivityTimestamp(thread: ThreadPayload | ThreadSummary | null) {
  const fallbackTimestampMs = getFallbackActivityTimestampMs(thread);
  const activitySignature = useMemo(() => getThreadActivitySignature(thread), [thread]);
  const previousActivityRef = useRef<{
    key: string;
    signature: string;
  } | null>(null);
  const [observedActivityTimestampMs, setObservedActivityTimestampMs] = useState(0);
  const threadKey = thread ? `${thread.harness}:${thread.id}` : "";

  useEffect(() => {
    if (!threadKey) {
      previousActivityRef.current = null;
      setObservedActivityTimestampMs(0);
      return;
    }

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
    setObservedActivityTimestampMs(Date.now());
  }, [activitySignature, threadKey]);

  return Math.max(fallbackTimestampMs, observedActivityTimestampMs);
}
