/*
 * Exports:
 * - default useReasoningSentence: live reasoning's latest sentence, changing at most every 800ms; null when not live.
 */
"use client";

import { useEffect, useRef, useState } from "react";

import { getLatestReasoningSentence } from "./thread-reasoning-display";

const SENTENCE_SWAP_MS = 800;

/** Streaming reasoning stays readable: each sentence shows for at least 800ms, and newer ones wait their turn. */
export default function useReasoningSentence(markdown: string, live: boolean) {
  const sentence = live ? getLatestReasoningSentence(markdown) : null;
  const [shown, setShown] = useState(sentence);
  const lastSwap = useRef(0);
  useEffect(() => {
    if (sentence === shown) return;
    const timer = window.setTimeout(() => {
      lastSwap.current = performance.now();
      setShown(sentence);
    }, Math.max(0, lastSwap.current + SENTENCE_SWAP_MS - performance.now()));
    return () => window.clearTimeout(timer);
  }, [sentence, shown]);
  return shown;
}
