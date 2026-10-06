/*
 * Exports:
 * - default ThreadMeasuredContent: skip offscreen content inside its measured space, unmounting far-offscreen content for a windowed parent.
 * - useThreadWindowPin: let a state-bearing descendant keep its windowed ancestors mounted while it holds state.
 */
"use client";
import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode,
} from "react";
import { useThreadScrollViewportContext } from "./thread-scroll-viewport-context";
import type {
  ThreadContentVisibility,
  ThreadContentVisibilityRange,
} from "./ThreadViewportVisibilityController";

interface ThreadWindowPin {
  pin: () => void;
  unpin: () => void;
}

const NO_WINDOW_PIN: ThreadWindowPin = { pin: () => {}, unpin: () => {} };
const ThreadWindowPinContext = createContext<ThreadWindowPin>(NO_WINDOW_PIN);

export function useThreadWindowPin() {
  return useContext(ThreadWindowPinContext);
}

export default function ThreadMeasuredContent({ children, onHidden, visibilityRange = "viewport", windowed = false }: {
  children: ReactNode;
  onHidden?: () => void;
  visibilityRange?: ThreadContentVisibilityRange;
  /** Unmount far-offscreen content so an infinite transcript keeps a bounded DOM. Descendants can pin to stay mounted. */
  windowed?: boolean;
}) {
  const viewport = useThreadScrollViewportContext();
  const element = useRef<HTMLDivElement>(null);
  const onHiddenRef = useRef(onHidden);
  onHiddenRef.current = onHidden;
  const [state, setState] = useState<ThreadContentVisibility>({ visible: true, height: 0 });
  const [pinCount, setPinCount] = useState(0);
  // A focused control (an in-progress edit) pins the slice too, so scrolling away never discards typed state.
  const focused = useRef(false);
  const parentPin = useContext(ThreadWindowPinContext);
  const parentPinRef = useRef(parentPin);
  parentPinRef.current = parentPin;
  useEffect(() => {
    if (!element.current) return;
    return viewport.observeContent(element.current, next => {
      if (!next.visible) {
        onHiddenRef.current?.();
      }
      setState(next);
    }, visibilityRange);
  }, [viewport, visibilityRange]);
  // Pinning propagates to every windowed ancestor so a descendant that holds state keeps its whole slice mounted.
  const pin = useCallback(() => {
    setPinCount(count => count + 1);
    parentPinRef.current.pin();
  }, []);
  const unpin = useCallback(() => {
    setPinCount(count => Math.max(0, count - 1));
    parentPinRef.current.unpin();
  }, []);
  const contextValue = useMemo(() => ({ pin, unpin }), [pin, unpin]);
  // Hidden content keeps its exact measured height so scroll positions stay stable. A windowed wrapper unmounts
  // far-offscreen content; descendants that hold state pin it so their state survives remounting.
  const mounted = !windowed || state.visible || pinCount > 0;
  return (
    <ThreadWindowPinContext.Provider value={contextValue}>
      <div ref={element} className="flow-root min-w-0" data-thread-measured-content={state.visible ? "visible" : "placeholder"}
        style={state.visible ? undefined : { height: state.height, contentVisibility: "hidden" }} aria-hidden={state.visible ? undefined : true}
        onFocus={windowed ? () => { if (!focused.current) { focused.current = true; pin(); } } : undefined}
        onBlur={windowed ? () => { if (focused.current) { focused.current = false; unpin(); } } : undefined}>
        {mounted ? children : null}
      </div>
    </ThreadWindowPinContext.Provider>
  );
}
