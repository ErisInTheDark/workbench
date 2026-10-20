/*
 * Exports:
 * - default ThreadRevealText: fade one run of newly streamed text in with the style's text motion, continuing from when it first appeared.
 * - ThreadRevealBlock: play the style's block motion on a framed block that first appeared in streamed text.
 * - ThreadEntryAnimation: play the style's item motion on a newly arrived thread item or row.
 * - ThreadStreamCaret: the typewriter caret riding the end of streaming text.
 */
"use client";

import { useContext, useLayoutEffect, useRef, type ReactNode } from "react";

import type { ThreadMotion } from "../../../workbench/thread/thread-animation-styles";
import ThreadAnimationStyleContext from "./ThreadAnimationStyleContext";

/**
 * Re-renders split or remount a run while it is still animating (a closer arrives, a chip forms);
 * a timeline-relative delay continues the motion instead of restarting it.
 */
function usePlayOnMount<Element extends HTMLElement>(motion: ThreadMotion | null, startedAt: number | null) {
  const ref = useRef<Element>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!motion || !element?.animate || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
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
 * `play` is read once at mount, so the wrapper never changes shape and its children never remount.
 * `inline` renders a span, for rows that appear inside phrasing content such as a button.
 */
export function ThreadEntryAnimation ({ children, className = "block", inline = false, play }: {
  children: ReactNode;
  className?: string;
  inline?: boolean;
  play: boolean;
}) {
  const motion = useContext(ThreadAnimationStyleContext).item;
  const ref = usePlayOnMount<HTMLDivElement & HTMLSpanElement>(play ? motion : null, null);
  return inline
    ? <span className={className} ref={ref}>{children}</span>
    : <div className={className} ref={ref}>{children}</div>;
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
