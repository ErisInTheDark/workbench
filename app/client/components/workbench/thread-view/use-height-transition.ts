/*
 * Exports:
 * - default useHeightTransition: animate an element from its shown height to its new natural height whenever a key changes, timed by its CSS height transition; returns a stable cancel.
 */
"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from "react";

function splitCssList (value: string) {
  const items: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (character === "(") depth++;
    else if (character === ")") depth--;
    else if (character === "," && depth === 0) {
      items.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  items.push(value.slice(start).trim());
  return items;
}

function parseCssTimeMs (value: string) {
  const time = Number.parseFloat(value);
  if (!Number.isFinite(time)) return 0;
  return value.endsWith("ms") ? time : time * 1000;
}

function getHeightTransitionTiming (style: CSSStyleDeclaration) {
  const index = splitCssList(style.transitionProperty).findIndex(property => property === "height" || property === "all");
  if (index < 0) return null;
  const durations = splitCssList(style.transitionDuration);
  const easings = splitCssList(style.transitionTimingFunction);
  const duration = parseCssTimeMs(durations[index % durations.length] ?? "");
  return duration ? { duration, easing: easings[index % easings.length] ?? "ease" } : null;
}

/**
 * Auto heights cannot transition, so the element's declared `transition: height <duration> <easing>` only supplies timing.
 * The shown height is tracked continuously so an interrupted change restarts from what is on screen; content clips only while animating.
 */
export default function useHeightTransition (ref: RefObject<HTMLElement | null>, key: string) {
  const shownHeightRef = useRef<number | null>(null);
  const animationRef = useRef<Animation | null>(null);
  const keyRef = useRef(key);
  const cancel = useCallback(() => {
    animationRef.current?.cancel();
    animationRef.current = null;
  }, []);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      shownHeightRef.current = element.getBoundingClientRect().height;
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      cancel();
    };
  }, [cancel, ref]);

  useLayoutEffect(() => {
    if (keyRef.current === key) return;
    keyRef.current = key;
    const element = ref.current;
    const from = shownHeightRef.current;
    if (!element || from === null) return;
    cancel();
    const timing = getHeightTransitionTiming(getComputedStyle(element));
    const to = element.getBoundingClientRect().height;
    if (!timing || Math.abs(from - to) < 0.5 || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    animationRef.current = element.animate(
      [{ height: `${from}px`, overflow: "clip" }, { height: `${to}px`, overflow: "clip" }],
      timing,
    );
  }, [cancel, key, ref]);

  return cancel;
}
