/*
 * Exports:
 * - default ThreadMeasuredContent: skip rendering exact or nearby offscreen content inside its measured space, keeping it mounted.
 */
"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useThreadScrollViewportContext } from "./thread-scroll-viewport-context";
import type {
  ThreadContentVisibility,
  ThreadContentVisibilityRange,
} from "./ThreadViewportVisibilityController";

export default function ThreadMeasuredContent({ children, onHidden, visibilityRange = "viewport" }: {
  children: ReactNode;
  onHidden?: () => void;
  visibilityRange?: ThreadContentVisibilityRange;
}) {
  const viewport = useThreadScrollViewportContext();
  const element = useRef<HTMLDivElement>(null);
  const onHiddenRef = useRef(onHidden);
  onHiddenRef.current = onHidden;
  const [state, setState] = useState<ThreadContentVisibility>({ visible: true, height: 0 });
  useEffect(() => {
    if (!element.current) return;
    return viewport.observeContent(element.current, next => {
      if (!next.visible) {
        onHiddenRef.current?.();
      }
      setState(next);
    }, visibilityRange);
  }, [viewport, visibilityRange]);
  // Hidden content stays mounted so its React state (open disclosures, edits) survives; the browser skips its style, layout and paint.
  return <div ref={element} className="flow-root min-w-0" data-thread-measured-content={state.visible ? "visible" : "placeholder"}
    style={state.visible ? undefined : { height: state.height, contentVisibility: "hidden" }} aria-hidden={state.visible ? undefined : true}>
    {children}
  </div>;
}
