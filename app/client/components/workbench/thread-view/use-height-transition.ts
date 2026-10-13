/*
 * Exports:
 * - default useHeightTransition: animate an element from its shown height to its new natural height whenever a key changes, timed by its CSS height transition.
 */
"use client";

import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

function parseCssTimeMs (value: string) {
  const time = Number.parseFloat(value);
  if (!Number.isFinite(time)) return 0;
  return value.trim().endsWith("ms") ? time : time * 1000;
}

/**
 * Auto heights cannot transition, so the element's declared `transition: height <duration> <easing>` only supplies timing.
 * The shown height is tracked continuously so an interrupted change restarts from what is on screen.
 */
export default function useHeightTransition (ref: RefObject<HTMLElement | null>, key: string) {
  const shownHeightRef = useRef<number | null>(null);
  const animationRef = useRef<Animation | null>(null);
  const keyRef = useRef(key);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      shownHeightRef.current = element.getBoundingClientRect().height;
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      animationRef.current?.cancel();
      animationRef.current = null;
    };
  }, [ref]);

  useLayoutEffect(() => {
    if (keyRef.current === key) return;
    keyRef.current = key;
    const element = ref.current;
    const from = shownHeightRef.current;
    if (!element || from === null) return;
    animationRef.current?.cancel();
    animationRef.current = null;
    const style = getComputedStyle(element);
    const duration = parseCssTimeMs(style.transitionDuration);
    const to = element.getBoundingClientRect().height;
    if (!duration || Math.abs(from - to) < 0.5 || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    animationRef.current = element.animate(
      [{ height: `${from}px` }, { height: `${to}px` }],
      { duration, easing: style.transitionTimingFunction },
    );
  }, [key, ref]);
}
