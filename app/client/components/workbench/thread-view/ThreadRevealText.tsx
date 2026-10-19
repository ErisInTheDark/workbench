/*
 * Exports:
 * - default ThreadRevealText: fade one run of newly streamed content in, continuing from when it first appeared.
 */
"use client";

import { useLayoutEffect, useRef, type ReactNode } from "react";

import { REVEAL_DURATION_MS } from "../../../workbench/markdown/MarkdownRevealTimeline";

const REVEAL_KEYFRAMES: Keyframe[] = [
  { filter: "blur(0.14em)", opacity: 0, top: "0.12em" },
  { filter: "blur(0)", opacity: 1, top: "0" },
];
const REVEAL_EASING = "cubic-bezier(0.22, 0.82, 0.28, 1)";

/**
 * Re-renders split or remount a run while it is still fading (a closer arrives, a chip forms);
 * a timeline-relative delay continues the fade instead of restarting it.
 */
export default function ThreadRevealText ({ children, startedAt }: { children: ReactNode; startedAt: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element?.animate) return;
    const animation = element.animate(REVEAL_KEYFRAMES, {
      delay: startedAt - performance.now(),
      duration: REVEAL_DURATION_MS,
      easing: REVEAL_EASING,
      fill: "backwards",
    });
    return () => animation.cancel();
    // A run fades once from when it appeared; later renders of the same run never restart it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <span className="relative" data-thread-reveal="true" ref={ref}>{children}</span>;
}
