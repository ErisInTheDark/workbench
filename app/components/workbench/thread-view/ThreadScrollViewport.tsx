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
  type CSSProperties,
  type ForwardedRef,
  type ReactNode,
} from "react";

import {
  getInitialThreadScrollTop,
  getPreservedThreadScrollTop,
  resolveThreadEndFollowing,
  resolveThreadScrollDirection,
  resolveThreadScrollProximity,
  THREAD_COARSE_POINTER_MEDIA_QUERY,
  type ThreadScrollDirection,
  type ThreadScrollMetrics,
  type ThreadScrollProximity,
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

const THREAD_SCROLL_NEAR_END_DISTANCE_REM = 30;
const THREAD_SCROLL_VIEWPORT_STYLE: CSSProperties & {
  "--thread-scroll-near-end-distance": string;
} = {
  "--thread-scroll-near-end-distance": `${THREAD_SCROLL_NEAR_END_DISTANCE_REM}rem`,
};

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
  const endFollowingRef = useRef(true);
  const initialPlacementPendingRef = useRef(true);
  const nearEndDistancePxRef = useRef(0);
  const previousScrollTopRef = useRef(0);
  const contentRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);

  const syncScrollProximity = useCallback((viewport: HTMLDivElement): ThreadScrollProximity => {
    const proximity = resolveThreadScrollProximity(
      readScrollMetrics(viewport),
      nearEndDistancePxRef.current,
    );
    viewport.dataset.threadScrollProximity = proximity;
    return proximity;
  }, []);

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
    endFollowingRef.current = true;
    syncScrollProximity(viewport);
    initialPlacementPendingRef.current = false;
  }, [syncScrollProximity]);

  const setViewportRef = useCallback((viewport: HTMLDivElement | null) => {
    viewportRef.current = viewport;
    previousScrollTopRef.current = viewport?.scrollTop ?? 0;
    nearEndDistancePxRef.current = viewport
      ? THREAD_SCROLL_NEAR_END_DISTANCE_REM * Number.parseFloat(
        getComputedStyle(viewport.ownerDocument.documentElement).fontSize,
      )
      : 0;
    assignRef(forwardedRef, viewport);
    if (viewport) syncScrollProximity(viewport);
    placeInitialViewportAtEnd();
  }, [forwardedRef, placeInitialViewportAtEnd, syncScrollProximity]);

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
        syncScrollProximity(viewport);
      };
    },
    setEndTarget: (target) => {
      endTargetRef.current = target;
      placeInitialViewportAtEnd();
    },
  }), [placeInitialViewportAtEnd, syncScrollProximity]);

  useEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport) return;
    // Coarse-touch WebKit needs managed growth following because active CSS snap suppresses momentum.
    const managesEndFollowing = matchMedia(THREAD_COARSE_POINTER_MEDIA_QUERY).matches;

    const handleScroll = () => {
      const direction = resolveThreadScrollDirection(
        directionRef.current,
        previousScrollTopRef.current,
        viewport.scrollTop,
      );
      previousScrollTopRef.current = viewport.scrollTop;
      const proximity = syncScrollProximity(viewport);
      if (managesEndFollowing) {
        endFollowingRef.current = resolveThreadEndFollowing(
          endFollowingRef.current,
          direction,
          proximity,
        );
      }
      if (direction === directionRef.current) return;
      directionRef.current = direction;
      viewport.dataset.threadScrollDirection = direction;
    };

    const contentResizeObserver = managesEndFollowing && content
      ? new ResizeObserver(() => {
        if (!endFollowingRef.current || viewportRef.current !== viewport) return;
        viewport.scrollTop = viewport.scrollHeight;
        previousScrollTopRef.current = viewport.scrollTop;
        syncScrollProximity(viewport);
      })
      : null;
    if (content && contentResizeObserver) contentResizeObserver.observe(content);
    viewport.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      contentResizeObserver?.disconnect();
      viewport.removeEventListener("scroll", handleScroll);
    };
  }, [syncScrollProximity]);

  return (
    <div
      ref={setViewportRef}
      className={joinClasses(
        "explorer-scrollbar flex min-h-0 flex-col overflow-x-hidden overflow-y-auto",
        className,
      )}
      data-thread-scroll-direction="down"
      data-thread-scroll-proximity="far"
      data-thread-scroll-target="true"
      style={THREAD_SCROLL_VIEWPORT_STYLE}
    >
      <ThreadScrollViewportContext.Provider value={contextValue}>
        <div ref={contentRef} className={joinClasses("min-h-full shrink-0", contentClassName)}>
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
