/*
 * Exports:
 * - default ThreadScrollViewport: own normal-flow end snapping and off-screen layout preservation.
 * - ThreadScrollViewportEnd: register the committed end of the nearest scroll viewport.
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
  didThreadScrollReattach,
  getInitialThreadScrollTop,
  getPreservedThreadScrollTop,
  isThreadScrollAtEnd,
  resolveThreadScrollDirection,
  resolveThreadScrollProximity,
  resolveThreadTouchScrollDirection,
  type ThreadScrollDirection,
  type ThreadScrollMetrics,
  type ThreadScrollProximity,
} from "./thread-scroll-snap";
import {
  ThreadScrollViewportContext,
  useThreadScrollViewportContext,
  type ThreadScrollViewportContextValue,
} from "./thread-scroll-viewport-context";
import ThreadViewportVisibilityController from "./ThreadViewportVisibilityController";

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

const THREAD_SCROLL_DOWN_KEYS = new Set(["ArrowDown", "End", "PageDown"]);
const THREAD_SCROLL_NEAR_END_DISTANCE_REM = 6;
const THREAD_SCROLL_UP_KEYS = new Set(["ArrowUp", "Home", "PageUp"]);
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

function isInteractiveScrollKeyTarget (target: EventTarget | null) {
  return target instanceof HTMLElement
    && Boolean(target.closest("a,button,input,select,textarea,[contenteditable='true']"));
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
  const nearEndDistancePxRef = useRef(0);
  const pointerScrollActiveRef = useRef(false);
  const pointerScrollMovedRef = useRef(false);
  const previousScrollTopRef = useRef(0);
  const touchClientYRef = useRef<number | null>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const wasAtEndRef = useRef(true);
  const bottomListeners = useRef(new Set<() => void>());
  const visibility = useRef<ThreadViewportVisibilityController | null>(null);
  useEffect(() => () => {
    visibility.current?.dispose();
    visibility.current = null;
  }, []);

  const syncScrollProximity = useCallback((viewport: HTMLDivElement): ThreadScrollProximity => {
    const metrics = readScrollMetrics(viewport);
    const reattached = didThreadScrollReattach(wasAtEndRef.current, metrics);
    wasAtEndRef.current = isThreadScrollAtEnd(metrics);
    const proximity = resolveThreadScrollProximity(
      metrics,
      nearEndDistancePxRef.current,
    );
    viewport.dataset.threadScrollProximity = proximity;
    if (reattached) bottomListeners.current.forEach(listener => listener());
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
    entryMotion: null,
    getViewport: () => viewportRef.current,
    observeContent: (element, listener, range = "viewport") => {
      const root = viewportRef.current;
      if (!root) return () => { };
      visibility.current ??= new ThreadViewportVisibilityController({
        root,
        intersection: (callback, observedRange, rootMarginPx) => new IntersectionObserver(callback, {
          root,
          rootMargin: observedRange === "nearby" ? `${rootMarginPx}px 0px` : "0px",
        }),
        resize: callback => new ResizeObserver(callback),
      });
      return visibility.current.observe(element, listener, range);
    },
    onBottomReattached: (listener) => {
      bottomListeners.current.add(listener);
      return () => { bottomListeners.current.delete(listener); };
    },
    preserveOffscreenLayout: () => {
      const viewport = viewportRef.current;
      if (!viewport) return () => { };
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
    if (!viewport) return;

    const setScrollDirection = (direction: ThreadScrollDirection) => {
      if (direction === directionRef.current) return;
      directionRef.current = direction;
      viewport.dataset.threadScrollDirection = direction;
    };
    const handleScroll = () => {
      setScrollDirection(resolveThreadScrollDirection(
        directionRef.current,
        previousScrollTopRef.current,
        viewport.scrollTop,
        pointerScrollActiveRef.current && pointerScrollMovedRef.current,
      ));
      pointerScrollMovedRef.current = false;
      previousScrollTopRef.current = viewport.scrollTop;
      syncScrollProximity(viewport);
    };
    const handleWheel = (event: WheelEvent) => {
      if (event.target instanceof Element && event.target.closest("[data-thread-scroll-target]") !== viewport) return;
      if (event.deltaY > 0) setScrollDirection("down");
      if (event.deltaY < 0) setScrollDirection("up");
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.target instanceof Element && event.target.closest("[data-thread-scroll-target]") !== viewport) return;
      if (isInteractiveScrollKeyTarget(event.target)) return;
      if (THREAD_SCROLL_DOWN_KEYS.has(event.key) || (event.key === " " && !event.shiftKey)) {
        setScrollDirection("down");
      }
      if (THREAD_SCROLL_UP_KEYS.has(event.key) || (event.key === " " && event.shiftKey)) {
        setScrollDirection("up");
      }
    };
    const handlePointerDown = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest("[data-thread-scroll-target]") !== viewport) return;
      pointerScrollActiveRef.current = true;
      pointerScrollMovedRef.current = false;
      previousScrollTopRef.current = viewport.scrollTop;
    };
    const handlePointerMove = () => {
      if (pointerScrollActiveRef.current) pointerScrollMovedRef.current = true;
    };
    const handlePointerEnd = () => {
      pointerScrollActiveRef.current = false;
      pointerScrollMovedRef.current = false;
    };
    const handleTouchStart = (event: TouchEvent) => {
      if (event.target instanceof Element && event.target.closest("[data-thread-scroll-target]") !== viewport) return;
      touchClientYRef.current = event.touches.length === 1 ? event.touches[0].clientY : null;
    };
    const handleTouchMove = (event: TouchEvent) => {
      if (event.target instanceof Element && event.target.closest("[data-thread-scroll-target]") !== viewport) return;
      const previousClientY = touchClientYRef.current;
      if (event.touches.length !== 1 || previousClientY === null) {
        touchClientYRef.current = null;
        return;
      }
      const currentClientY = event.touches[0].clientY;
      setScrollDirection(resolveThreadTouchScrollDirection(
        directionRef.current,
        previousClientY,
        currentClientY,
      ));
      touchClientYRef.current = currentClientY;
    };
    const handleTouchEnd = () => {
      touchClientYRef.current = null;
    };

    viewport.addEventListener("keydown", handleKeyDown);
    viewport.addEventListener("pointerdown", handlePointerDown, { passive: true });
    viewport.addEventListener("pointermove", handlePointerMove, { passive: true });
    viewport.addEventListener("scroll", handleScroll, { passive: true });
    viewport.addEventListener("touchcancel", handleTouchEnd, { passive: true });
    viewport.addEventListener("touchend", handleTouchEnd, { passive: true });
    viewport.addEventListener("touchmove", handleTouchMove, { passive: true });
    viewport.addEventListener("touchstart", handleTouchStart, { passive: true });
    viewport.addEventListener("wheel", handleWheel, { passive: true });
    viewport.ownerDocument.addEventListener("pointercancel", handlePointerEnd, { passive: true });
    viewport.ownerDocument.addEventListener("pointerup", handlePointerEnd, { passive: true });
    return () => {
      pointerScrollActiveRef.current = false;
      pointerScrollMovedRef.current = false;
      touchClientYRef.current = null;
      viewport.removeEventListener("keydown", handleKeyDown);
      viewport.removeEventListener("pointerdown", handlePointerDown);
      viewport.removeEventListener("pointermove", handlePointerMove);
      viewport.removeEventListener("scroll", handleScroll);
      viewport.removeEventListener("touchcancel", handleTouchEnd);
      viewport.removeEventListener("touchend", handleTouchEnd);
      viewport.removeEventListener("touchmove", handleTouchMove);
      viewport.removeEventListener("touchstart", handleTouchStart);
      viewport.removeEventListener("wheel", handleWheel);
      viewport.ownerDocument.removeEventListener("pointercancel", handlePointerEnd);
      viewport.ownerDocument.removeEventListener("pointerup", handlePointerEnd);
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
        <div className={joinClasses("min-h-full shrink-0", contentClassName)}>
          {children}
        </div>
      </ThreadScrollViewportContext.Provider>
    </div>
  );
}

export function ThreadScrollViewportEnd () {
  const viewport = useThreadScrollViewportContext();
  return <div ref={viewport.setEndTarget} data-thread-scroll-end="true" className="h-px shrink-0" aria-hidden="true" />;
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
