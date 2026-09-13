/*
 * Exports:
 * - default ThreadScrollViewport: own normal-flow end snapping and off-screen layout preservation.
 */
"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type ForwardedRef,
  type ReactNode,
} from "react";

import {
  getInitialThreadScrollTop,
  getPreservedThreadScrollTop,
  resolveThreadScrollDirection,
  type ThreadScrollDirection,
  type ThreadScrollMetrics,
} from "./thread-scroll-snap";
import {
  ThreadScrollViewportContext,
  type ThreadScrollViewportContextValue,
} from "./thread-scroll-viewport-context";

interface ThreadScrollViewportProps {
  children: ReactNode;
  className?: string;
  contentClassName?: string;
  enabled?: boolean;
  resetKey: string;
}

interface ActiveThreadScrollViewportProps extends Omit<ThreadScrollViewportProps, "enabled" | "resetKey"> {
  forwardedRef: ForwardedRef<HTMLDivElement>;
}

function joinClasses (...values: Array<string | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

function assignRef<T> (ref: ForwardedRef<T>, value: T | null) {
  if (typeof ref === "function") {
    ref(value);
    return;
  }
  if (ref) ref.current = value;
}

function readScrollMetrics (viewport: HTMLDivElement): ThreadScrollMetrics {
  return {
    clientHeight: viewport.clientHeight,
    scrollHeight: viewport.scrollHeight,
    scrollTop: viewport.scrollTop,
  };
}

function ActiveThreadScrollViewport ({
  children,
  className,
  contentClassName,
  forwardedRef,
}: ActiveThreadScrollViewportProps) {
  const directionRef = useRef<ThreadScrollDirection>("down");
  const endTargetRef = useRef<HTMLElement | null>(null);
  const initialPlacementPendingRef = useRef(true);
  const previousScrollTopRef = useRef(0);
  const viewportRef = useRef<HTMLDivElement>(null);

  const placeInitialViewportAtEnd = useCallback(() => {
    if (!initialPlacementPendingRef.current) return;
    const viewport = viewportRef.current;
    const endTarget = endTargetRef.current;
    if (!viewport) return;
    const scrollTop = getInitialThreadScrollTop(
      Boolean(endTarget && viewport.contains(endTarget)),
      viewport.scrollHeight,
    );
    if (scrollTop === null) return;
    viewport.scrollTop = scrollTop;
    previousScrollTopRef.current = viewport.scrollTop;
    initialPlacementPendingRef.current = false;
  }, []);

  const setViewportRef = useCallback((viewport: HTMLDivElement | null) => {
    viewportRef.current = viewport;
    previousScrollTopRef.current = viewport?.scrollTop ?? 0;
    assignRef(forwardedRef, viewport);
    placeInitialViewportAtEnd();
  }, [forwardedRef, placeInitialViewportAtEnd]);

  const contextValue = useMemo<ThreadScrollViewportContextValue>(() => ({
    getViewport: () => viewportRef.current,
    preserveOffscreenLayout: () => {
      const viewport = viewportRef.current;
      if (!viewport) return () => {};
      const previousMetrics = readScrollMetrics(viewport);
      return () => {
        if (viewportRef.current !== viewport) return;
        const preservedScrollTop = getPreservedThreadScrollTop(previousMetrics, readScrollMetrics(viewport));
        if (preservedScrollTop !== null) viewport.scrollTop = preservedScrollTop;
        previousScrollTopRef.current = viewport.scrollTop;
      };
    },
    setEndTarget: (target) => {
      endTargetRef.current = target;
      placeInitialViewportAtEnd();
    },
  }), [placeInitialViewportAtEnd]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    const handleScroll = () => {
      const direction = resolveThreadScrollDirection(
        directionRef.current,
        previousScrollTopRef.current,
        viewport.scrollTop,
      );
      previousScrollTopRef.current = viewport.scrollTop;
      if (direction === directionRef.current) return;
      directionRef.current = direction;
      viewport.dataset.threadScrollDirection = direction;
    };

    viewport.addEventListener("scroll", handleScroll, { passive: true });
    return () => viewport.removeEventListener("scroll", handleScroll);
  }, []);

  return (
    <div
      ref={setViewportRef}
      className={joinClasses(
        "explorer-scrollbar flex min-h-0 flex-col overflow-x-hidden overflow-y-auto",
        className,
      )}
      data-thread-scroll-direction="down"
      data-thread-scroll-target="true"
    >
      <ThreadScrollViewportContext.Provider value={contextValue}>
        <div className={joinClasses("min-h-full shrink-0", contentClassName)}>
          {children}
        </div>
      </ThreadScrollViewportContext.Provider>
    </div>
  );
}

const ThreadScrollViewport = forwardRef<HTMLDivElement, ThreadScrollViewportProps>(function ThreadScrollViewport ({
  children,
  className,
  contentClassName,
  enabled = true,
  resetKey,
}, ref) {
  if (!enabled) {
    return <>{children}</>;
  }

  return (
    <ActiveThreadScrollViewport
      key={resetKey}
      className={className}
      contentClassName={contentClassName}
      forwardedRef={ref}
    >
      {children}
    </ActiveThreadScrollViewport>
  );
});

ThreadScrollViewport.displayName = "ThreadScrollViewport";

export default ThreadScrollViewport;
