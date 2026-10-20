/*
 * Exports:
 * - default ThreadRevealText: fade one run of newly streamed text in with the style's text motion, continuing from when it first appeared.
 * - ThreadRevealBlock: play the style's block motion on a framed block that first appeared in streamed text.
 * - ThreadEntryAnimation: play the style's item motion on a newly arrived thread item or row, or slide an absorbing entry
 *   up from where the entry it absorbed had been.
 * - ThreadStreamCaretSlot: an empty line holding the caret where the next block or item will land.
 * - ThreadStreamCaret: the typewriter caret riding the end of streaming text.
 */
"use client";

import { useContext, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";

import type { ThreadMotion } from "../../../workbench/thread/thread-animation-styles";
import ThreadAnimationStyleContext from "./ThreadAnimationStyleContext";
import { useThreadScrollViewportContext } from "./thread-scroll-viewport-context";

const MERGE_MS = 280;
const MERGE_EASING = "cubic-bezier(0.2, 0, 0, 1)";

/**
 * Re-renders split or remount a run while it is still animating (a closer arrives, a chip forms);
 * a timeline-relative delay continues the motion instead of restarting it.
 */
function canAnimate(element: HTMLElement | null): element is HTMLElement {
  return Boolean(element?.animate) && !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

function usePlayOnMount<Element extends HTMLElement>(motion: ThreadMotion | null, startedAt: number | null) {
  const ref = useRef<Element>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!motion || !canAnimate(element)) return;
    const animation = element.animate(motion.keyframes(element), {
      delay: startedAt === null ? 0 : startedAt - performance.now(),
      duration: motion.duration,
      easing: motion.easing,
      fill: "backwards",
    });
    return () => animation.cancel();
    // A run animates once from when it appeared; later renders of the same run never restart it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return ref;
}

export default function ThreadRevealText ({ children, startedAt }: { children: ReactNode; startedAt: number }) {
  const ref = usePlayOnMount<HTMLSpanElement>(useContext(ThreadAnimationStyleContext).text, startedAt);
  return <span className="relative" data-thread-reveal="true" ref={ref}>{children}</span>;
}

export function ThreadRevealBlock ({ children, startedAt }: { children: ReactNode; startedAt: number }) {
  const ref = usePlayOnMount<HTMLDivElement>(useContext(ThreadAnimationStyleContext).block, startedAt);
  return <div data-thread-reveal-block="true" ref={ref}>{children}</div>;
}

/**
 * An entry that absorbs another (a retried arc start taking in its failed attempts) mounts where the earliest of them
 * was; it slides up from where the absorbed entry it continues had been, so the newer entry reads as merging upward.
 */
function useMergeMotion(ref: RefObject<HTMLElement | null>, slideFrom: string | null, trackAs: string | null) {
  const controller = useThreadScrollViewportContext().entryMotion;
  // Read while rendering: the commit about to mount this entry removes the one it absorbs and shifts what was below.
  const [fromTop] = useState(() => slideFrom ? controller?.topOf(slideFrom) ?? null : null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!controller || !element) return;
    const offset = fromTop === null ? 0 : fromTop - element.getBoundingClientRect().top;
    const animation = offset > 0 && canAnimate(element)
      ? element.animate([{ transform: `translateY(${offset}px)` }, { transform: "none" }], { duration: MERGE_MS, easing: MERGE_EASING })
      : null;
    const untrack = trackAs ? controller.track(trackAs, element) : null;
    return () => {
      animation?.cancel();
      untrack?.();
    };
    // Both roles are fixed at mount: the slide plays once, and the entry stays findable while mounted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

/**
 * `play` is read once at mount, so the wrapper never changes shape and its children never remount.
 * `inline` renders a span, for rows that appear inside phrasing content such as a button.
 * `trackAs` keeps this entry findable by an entry that may absorb it; `slideFrom` slides in from where that entry is.
 */
export function ThreadEntryAnimation ({ children, className = "block", inline = false, play, slideFrom = null, trackAs = null }: {
  children: ReactNode;
  className?: string;
  inline?: boolean;
  play: boolean;
  slideFrom?: string | null;
  trackAs?: string | null;
}) {
  const motion = useContext(ThreadAnimationStyleContext).item;
  const ref = usePlayOnMount<HTMLDivElement & HTMLSpanElement>(play ? motion : null, null);
  useMergeMotion(ref, slideFrom, trackAs);
  return inline
    ? <span className={className} ref={ref}>{children}</span>
    : <div className={className} ref={ref}>{children}</div>;
}

/** An empty line where the next streamed block or thread item will land; the typewriter caret waits in it. */
export function ThreadStreamCaretSlot () {
  return <p className="mb-[0.9em] last:mb-0" data-thread-stream-caret-slot="true"><ThreadStreamCaret /></p>;
}

export function ThreadStreamCaret () {
  return (
    <span
      aria-hidden="true"
      className="ml-px inline-block h-[1.05em] w-[0.12em] translate-y-[0.15em] animate-blink bg-accent motion-reduce:animate-none"
      data-thread-stream-caret="true"
    />
  );
}
