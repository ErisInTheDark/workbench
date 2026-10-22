/*
 * Exports:
 * - default useThreadViewBleed: while enabled, write the distances from an element's column edges to its thread view's
 *   inner edges, which the `thread-view-bleed` utility turns into margins that widen the element to the whole view.
 */
"use client";

import { useLayoutEffect, type RefObject } from "react";
import { useThreadScrollViewportContext } from "./thread-scroll-viewport-context";

const START = "--thread-view-bleed-start";
const END = "--thread-view-bleed-end";

/** Measures the element's parent, never the element, so the widened element cannot feed back into its own measurement. */
export default function useThreadViewBleed(ref: RefObject<HTMLElement | null>, enabled: boolean) {
  const { getViewport } = useThreadScrollViewportContext();
  useLayoutEffect(() => {
    const element = ref.current;
    const column = element?.parentElement;
    const viewport = getViewport();
    if (!enabled || !element || !column || !viewport) return;
    const measure = () => {
      const outer = viewport.getBoundingClientRect();
      const inner = column.getBoundingClientRect();
      const viewStart = outer.left + viewport.clientLeft;
      element.style.setProperty(START, `${inner.left - viewStart}px`);
      element.style.setProperty(END, `${viewStart + viewport.clientWidth - inner.right}px`);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    observer.observe(column);
    return () => {
      observer.disconnect();
      element.style.removeProperty(START);
      element.style.removeProperty(END);
    };
  }, [enabled, getViewport, ref]);
}
