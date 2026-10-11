/*
 * Exports:
 * - default ThreadScrollViewport: own normal-flow end snapping, initial end placement, gesture-safe scroll correction, measured-window stability, and off-screen layout preservation.
 * - ThreadScrollViewportEnd: register the committed end of the nearest scroll viewport.
 */
"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type ForwardedRef,
  type ReactNode,
} from "react";

import {
  didThreadScrollReattach,
  getPreservedThreadScrollTop,
  isThreadScrollAtEnd,
  resolveThreadScrollDirection,
  resolveThreadScrollProximity,
  resolveThreadTouchScrollDirection,
  type ThreadScrollDirection,
  type ThreadScrollMetrics,
  type ThreadScrollProximity,
} from "./thread-scroll-snap";
import ThreadInitialEndPlacementController from "./ThreadInitialEndPlacementController";
import ThreadScrollSettleController from "./ThreadScrollSettleController";
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
  onScrollIntent?: (direction: ThreadScrollDirection, travelPx: number) => void;
  onTouchActivityChange?: (active: boolean) => void;
  resetKey: string;
}

interface ActiveThreadScrollViewportProps extends Omit<ThreadScrollViewportProps, "enabled" | "resetKey"> {
  forwardedRef: ForwardedRef<HTMLDivElement>;
}

// Back-to-back flings never settle, so the reserve must outlast a whole flinging session of history arriving above.
// An empty spacer costs no paint, and this stays far below WebKit's ~33M px layout limit.
const THREAD_SCROLL_TOUCH_RESERVE_PX = 1_000_000;
const THREAD_SCROLL_DOWN_KEYS = new Set(["ArrowDown", "End", "PageDown"]);
const THREAD_SCROLL_UP_KEYS = new Set(["ArrowUp", "Home", "PageUp"]);

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

/** Older turns can still load, or the topmost progressive window still hides chunks. */
function hasThreadContentAbove (content: HTMLElement) {
  return Boolean(content.querySelector("[data-thread-history-above]"))
    || Boolean(content.querySelector("[data-thread-progressive-window]")?.hasAttribute("data-thread-progressive-hidden"));
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
  onScrollIntent,
  onTouchActivityChange,
}: ActiveThreadScrollViewportProps) {
  const directionRef = useRef<ThreadScrollDirection>("down");
  const endTargetRef = useRef<HTMLElement | null>(null);
  const initialEndPlacementRef = useRef<ThreadInitialEndPlacementController | null>(null);
  const initialEndPlacement = initialEndPlacementRef.current ??= new ThreadInitialEndPlacementController();
  const pointerScrollActiveRef = useRef(false);
  const pointerScrollMovedRef = useRef(false);
  const previousScrollTopRef = useRef(0);
  const touchClientYRef = useRef<number | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const reserveRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const wasAtEndRef = useRef(true);
  const bottomListeners = useRef(new Set<() => void>());
  const visibility = useRef<ThreadViewportVisibilityController | null>(null);
  const progressiveWindowStartsRef = useRef(new Map<string, number>());
  const syncScrollProximity = useCallback((viewport: HTMLDivElement): ThreadScrollProximity => {
    const metrics = readScrollMetrics(viewport);
    const reattached = didThreadScrollReattach(wasAtEndRef.current, metrics);
    wasAtEndRef.current = isThreadScrollAtEnd(metrics);
    const proximity = resolveThreadScrollProximity(metrics);
    if (viewport.dataset.threadScrollProximity !== proximity) viewport.dataset.threadScrollProximity = proximity;
    if (reattached) bottomListeners.current.forEach(listener => listener());
    return proximity;
  }, []);
  const settleRef = useRef<ThreadScrollSettleController | null>(null);
  const settle = settleRef.current ??= new ThreadScrollSettleController({
    schedule: (callback, delayMs) => {
      const timer = window.setTimeout(callback, delayMs);
      return () => window.clearTimeout(timer);
    },
    readScrollTop: () => viewportRef.current?.scrollTop ?? 0,
    scrollBy: (delta) => {
      const viewport = viewportRef.current;
      if (!viewport) return;
      viewport.scrollTop += delta;
      previousScrollTopRef.current = viewport.scrollTop;
      syncScrollProximity(viewport);
    },
    setContentOffset: (offsetPx) => {
      const content = contentRef.current;
      if (content) content.style.marginTop = offsetPx ? `${offsetPx}px` : "";
    },
    setScrollLocked: (locked) => {
      const viewport = viewportRef.current;
      if (viewport) viewport.style.overflowY = locked ? "hidden" : "";
    },
    setReserve: (heightPx) => {
      const reserve = reserveRef.current;
      if (reserve) reserve.style.height = heightPx ? `${heightPx}px` : "";
    },
    // Only touch scrolling needs it: wheel and trackpad corrections are plain scroll writes that already hold position.
    readReserveTarget: () => {
      const content = contentRef.current;
      return content && window.matchMedia("(pointer: coarse)").matches && hasThreadContentAbove(content)
        ? THREAD_SCROLL_TOUCH_RESERVE_PX : 0;
    },
  });
  useEffect(() => () => {
    visibility.current?.dispose();
    visibility.current = null;
  }, []);
  useEffect(() => () => settle.dispose(), [settle]);

  const placeInitialViewportAtEnd = useCallback(() => {
    const viewport = viewportRef.current;
    const endTarget = endTargetRef.current;
    if (!viewport) return;
    const scrollTop = initialEndPlacement.getScrollTop(
      Boolean(endTarget && viewport.contains(endTarget)),
      viewport.scrollHeight,
    );
    if (scrollTop === null) return;
    viewport.scrollTop = scrollTop;
    previousScrollTopRef.current = viewport.scrollTop;
    syncScrollProximity(viewport);
  }, [initialEndPlacement, syncScrollProximity]);

  const setViewportRef = useCallback((viewport: HTMLDivElement | null) => {
    viewportRef.current = viewport;
    previousScrollTopRef.current = viewport?.scrollTop ?? 0;
    assignRef(forwardedRef, viewport);
    if (viewport) syncScrollProximity(viewport);
    placeInitialViewportAtEnd();
  }, [forwardedRef, placeInitialViewportAtEnd, syncScrollProximity]);

  const contextValue = useMemo<ThreadScrollViewportContextValue>(() => ({
    entryMotion: null,
    workedRunState: null,
    progressiveWindowing: true,
    progressiveWindowStarts: progressiveWindowStartsRef.current,
    getViewport: () => viewportRef.current,
    shiftScrollTop: delta => settle.shift(delta),
    observeContent: (element, listener, range = "viewport", preserveReadingPosition = false) => {
      const root = viewportRef.current;
      const content = contentRef.current;
      if (!root || !content) return () => { };
      visibility.current ??= new ThreadViewportVisibilityController({
        root,
        content,
        shiftScrollTop: delta => settle.shift(delta),
        intersection: (callback, observedRange, rootMarginPx) => new IntersectionObserver(callback, {
          root,
          rootMargin: observedRange === "viewport" ? "0px" : `${rootMarginPx}px 0px`,
        }),
        resize: callback => new ResizeObserver(callback),
      });
      return visibility.current.observe(element, listener, range, preserveReadingPosition);
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
        if (preservedScrollTop !== null) settle.shift(preservedScrollTop - viewport.scrollTop);
        syncScrollProximity(viewport);
      };
    },
    setEndTarget: (target) => {
      endTargetRef.current = target;
      placeInitialViewportAtEnd();
    },
  }), [placeInitialViewportAtEnd, settle, syncScrollProximity]);

  // The one owner of initial bottom placement: any content or viewport resize re-pins before paint until reader intent.
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      placeInitialViewportAtEnd();
      settle.reconcileReserve();
    });
    observer.observe(content);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [placeInitialViewportAtEnd, settle]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    const setScrollDirection = (direction: ThreadScrollDirection) => {
      if (direction === directionRef.current) return;
      directionRef.current = direction;
      viewport.dataset.threadScrollDirection = direction;
    };
    const handleScroll = () => {
      const previousScrollTop = previousScrollTopRef.current;
      const scrollTop = viewport.scrollTop;
      setScrollDirection(resolveThreadScrollDirection(
        directionRef.current,
        previousScrollTop,
        scrollTop,
        pointerScrollActiveRef.current && pointerScrollMovedRef.current,
      ));
      if (Math.abs(scrollTop - previousScrollTop) >= viewport.clientHeight) {
        visibility.current?.refresh("approaching");
        visibility.current?.refresh("nearby");
        visibility.current?.refresh("viewport");
      }
      pointerScrollMovedRef.current = false;
      previousScrollTopRef.current = scrollTop;
      syncScrollProximity(viewport);
      settle.scrolled();
    };
    const handleScrollEnd = () => settle.scrollEnded();
    const handleWheel = (event: WheelEvent) => {
      if (event.target instanceof Element && event.target.closest("[data-thread-scroll-target]") !== viewport) return;
      const direction = event.deltaY > 0 ? "down" : event.deltaY < 0 ? "up" : null;
      if (!direction) return;
      initialEndPlacement.release();
      setScrollDirection(direction);
      const distance = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? Math.abs(event.deltaY) * 16
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? Math.abs(event.deltaY) * viewport.clientHeight
          : Math.abs(event.deltaY);
      onScrollIntent?.(direction, distance);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.target instanceof Element && event.target.closest("[data-thread-scroll-target]") !== viewport) return;
      if (isInteractiveScrollKeyTarget(event.target)) return;
      if (THREAD_SCROLL_DOWN_KEYS.has(event.key) || (event.key === " " && !event.shiftKey)) {
        initialEndPlacement.release();
        setScrollDirection("down");
        onScrollIntent?.("down", viewport.clientHeight);
      }
      if (THREAD_SCROLL_UP_KEYS.has(event.key) || (event.key === " " && event.shiftKey)) {
        initialEndPlacement.release();
        setScrollDirection("up");
        onScrollIntent?.("up", viewport.clientHeight);
      }
    };
    const handlePointerDown = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest("[data-thread-scroll-target]") !== viewport) return;
      if (event.target === viewport) initialEndPlacement.release();
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
      settle.touchStarted();
      onTouchActivityChange?.(touchClientYRef.current !== null);
    };
    const handleTouchMove = (event: TouchEvent) => {
      if (event.target instanceof Element && event.target.closest("[data-thread-scroll-target]") !== viewport) return;
      const previousClientY = touchClientYRef.current;
      if (event.touches.length !== 1 || previousClientY === null) {
        touchClientYRef.current = null;
        onTouchActivityChange?.(false);
        return;
      }
      const currentClientY = event.touches[0].clientY;
      const direction = resolveThreadTouchScrollDirection(
        directionRef.current,
        previousClientY,
        currentClientY,
      );
      setScrollDirection(direction);
      if (currentClientY !== previousClientY) {
        initialEndPlacement.release();
        onScrollIntent?.(direction, Math.abs(currentClientY - previousClientY));
      }
      touchClientYRef.current = currentClientY;
    };
    const handleTouchEnd = (event: TouchEvent) => {
      touchClientYRef.current = null;
      if (event.touches.length === 0) settle.touchEnded();
      onTouchActivityChange?.(false);
    };

    viewport.addEventListener("keydown", handleKeyDown);
    viewport.addEventListener("pointerdown", handlePointerDown, { passive: true });
    viewport.addEventListener("pointermove", handlePointerMove, { passive: true });
    viewport.addEventListener("scroll", handleScroll, { passive: true });
    viewport.addEventListener("scrollend", handleScrollEnd, { passive: true });
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
      viewport.removeEventListener("scrollend", handleScrollEnd);
      viewport.removeEventListener("touchcancel", handleTouchEnd);
      viewport.removeEventListener("touchend", handleTouchEnd);
      viewport.removeEventListener("touchmove", handleTouchMove);
      viewport.removeEventListener("touchstart", handleTouchStart);
      viewport.removeEventListener("wheel", handleWheel);
      viewport.ownerDocument.removeEventListener("pointercancel", handlePointerEnd);
      viewport.ownerDocument.removeEventListener("pointerup", handlePointerEnd);
    };
  }, [onScrollIntent, onTouchActivityChange, settle, syncScrollProximity]);

  return (
    <div
      ref={setViewportRef}
      className={joinClasses(
        "scrollbar-hover-reveal flex min-h-0 flex-col overflow-x-hidden overflow-y-auto",
        "[--thread-scroll-inline-padding:1.25rem] md:[--thread-scroll-inline-padding:1.5rem]",
        "[--thread-scroll-snap-distance:0px] [overflow-anchor:none] snap-none",
        "[&[data-thread-scroll-direction=down][data-thread-scroll-proximity=near]]:[scroll-snap-type:y_proximity]",
        "[&[data-thread-scroll-direction=down][data-thread-scroll-proximity=near]]:[--thread-scroll-snap-distance:calc(100dvh-1px)]",
        className,
      )}
      data-thread-scroll-direction="down"
      data-thread-scroll-proximity="far"
      data-thread-scroll-target="true"
    >
      <ThreadScrollViewportContext.Provider value={contextValue}>
        {/* Room above the content that history arriving mid-fling fills without a scroll write. Outside the content so content-relative positions stay stable. */}
        <div ref={reserveRef} className="shrink-0" aria-hidden="true" />
        <div ref={contentRef} className={joinClasses("min-h-full shrink-0", contentClassName)}>
          {children}
        </div>
      </ThreadScrollViewportContext.Provider>
    </div>
  );
}

export function ThreadScrollViewportEnd () {
  const viewport = useThreadScrollViewportContext();
  return <div ref={viewport.setEndTarget} data-thread-scroll-end="true" className="h-px shrink-0 [scroll-margin-block-start:var(--thread-scroll-snap-distance)] snap-end" aria-hidden="true" />;
}

const ThreadScrollViewport = forwardRef<HTMLDivElement, ThreadScrollViewportProps>(function ThreadScrollViewport ({
  children,
  className,
  contentClassName,
  enabled = true,
  onScrollIntent,
  onTouchActivityChange,
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
      onScrollIntent={onScrollIntent}
      onTouchActivityChange={onTouchActivityChange}
    >
      {children}
    </ActiveThreadScrollViewport>
  );
});

ThreadScrollViewport.displayName = "ThreadScrollViewport";

export default ThreadScrollViewport;
