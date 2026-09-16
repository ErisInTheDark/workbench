/* Exports: default ThreadMeasuredContent replaces offscreen content with its measured space.
 * useThreadContentWasHidden keeps remounted disclosures closed without retaining child state.
 */
"use client";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useThreadScrollViewportContext } from "./thread-scroll-viewport-context";
import type { ThreadContentVisibility } from "./ThreadViewportVisibilityController";

const WasHiddenContext = createContext(false);

export function useThreadContentWasHidden() {
  return useContext(WasHiddenContext);
}

export default function ThreadMeasuredContent({ children, onHidden }: {
  children: ReactNode;
  onHidden?: () => void;
}) {
  const viewport = useThreadScrollViewportContext();
  const inheritedHidden = useThreadContentWasHidden();
  const element = useRef<HTMLDivElement>(null);
  const onHiddenRef = useRef(onHidden);
  onHiddenRef.current = onHidden;
  const [state, setState] = useState<ThreadContentVisibility>({ visible: true, height: 0 });
  const [wasHidden, setWasHidden] = useState(false);
  useEffect(() => {
    if (!element.current) return;
    return viewport.observeContent(element.current, next => {
      if (!next.visible) {
        setWasHidden(true);
        onHiddenRef.current?.();
      }
      setState(next);
    });
  }, [viewport]);
  return <div ref={element} className="flow-root min-w-0" data-thread-measured-content={state.visible ? "visible" : "placeholder"}
    style={state.visible ? undefined : { height: state.height }} aria-hidden={state.visible ? undefined : true}>
    {state.visible ? <WasHiddenContext.Provider value={wasHidden || inheritedHidden}>{children}</WasHiddenContext.Provider> : null}
  </div>;
}
