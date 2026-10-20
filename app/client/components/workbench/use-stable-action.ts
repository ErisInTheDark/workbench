/*
 * Exports:
 * - default useStableAction: one identity for an action called from events and effects, always running its latest closure.
 */
"use client";

import { useCallback, useLayoutEffect, useRef } from "react";

/** Only for actions; anything read during render (an href, a label) must keep an identity that changes with its output. */
export default function useStableAction<Args extends unknown[], Result>(action: (...args: Args) => Result) {
  const latest = useRef(action);
  useLayoutEffect(() => { latest.current = action; });
  return useCallback((...args: Args) => latest.current(...args), []);
}
