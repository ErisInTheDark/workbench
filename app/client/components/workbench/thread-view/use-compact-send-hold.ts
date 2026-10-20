/*
 * Exports:
 * - COMPACT_SEND_HOLD_MS: how long Enter must be held before releasing it sends a compact-first message.
 * - default useCompactSendHold: track the composer's Enter hold that confirms a compact-first send, reporting when it holds.
 */
"use client";

import { useCallback, useEffect, useRef } from "react";

export const COMPACT_SEND_HOLD_MS = 1_000;

/**
 * Key event timestamps decide completion, so the progress bar other surfaces draw from `onHoldingChange` stays visual only.
 * The hold cancels once it is no longer `armed` (shift skips compaction, input empties, compaction stops being due) and on
 * unmount.
 */
export default function useCompactSendHold(armed: boolean, onHoldingChange?: (holding: boolean) => void) {
  const startedAtRef = useRef<number | null>(null);

  const cancel = useCallback(() => {
    if (startedAtRef.current === null) return;
    startedAtRef.current = null;
    onHoldingChange?.(false);
  }, [onHoldingChange]);

  useEffect(() => {
    if (!armed) cancel();
  }, [armed, cancel]);
  useEffect(() => cancel, [cancel]);

  const begin = (timeStamp: number) => {
    if (!armed || startedAtRef.current !== null) return;
    startedAtRef.current = timeStamp;
    onHoldingChange?.(true);
  };

  /** Ends the hold; true when it was held long enough to send. */
  const release = (timeStamp: number) => {
    const startedAt = startedAtRef.current;
    if (startedAt === null) return false;
    cancel();
    return timeStamp - startedAt >= COMPACT_SEND_HOLD_MS;
  };

  return { begin, cancel, release };
}
