/*
 * Exports:
 * - default ThreadScrollViewport: own normal-flow end snapping, initial end placement, the reader's anchored position across every layout change (activated controls stay put, end snapping paused, until the reader moves), gesture-safe correction, and clipping content above unrevealed history.
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
  isThreadScrollAtEnd,
  resolveThreadScrollDirection,
  resolveThreadScrollProximity,
  resolveThreadTouchScrollDirection,
  type ThreadScrollDirection,
  type ThreadScrollMetrics,
  type ThreadScrollProximity,
} from "./thread-scroll-snap";
import ThreadInitialEndPlacementController from "./ThreadInitialEndPlacementController";
import ThreadReadingAnchorController, {
  getThreadContentOffset, pickThreadActivationAnchor, pickThreadReadingAnchor,
} from "./ThreadReadingAnchorController";
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

function readScrollMetrics (viewport: HTMLDivElement, endTarget: HTMLElement | null): ThreadScrollMetrics {
  return {
    clientHeight: viewport.clientHeight,
    scrollHeight: viewport.scrollHeight,
    scrollTop: viewport.scrollTop,
    endOffsetPx: endTarget
      ? Math.max(0, viewport.scrollHeight - viewport.scrollTop
        - (endTarget.getBoundingClientRect().bottom - viewport.getBoundingClientRect().top))
      : 0,
  };
}

/** Older turns can still load, or the topmost progressive window still hides chunks. */
function hasThreadContentAbove (content: HTMLElement) {
  return Boolean(content.querySelector("[data-thread-history-above]"))
    || Boolean(content.querySelector("[data-thread-progressive-window]")?.hasAttribute("data-thread-progressive-hidden"));
}

// Only the top edge clips; the other edges sit far out so overflowing popovers and shadows stay visible.
const THREAD_REVEAL_CLIP_OUTSET_PX = 100_000;

/**
 * Everything above the last window still hiding chunks is older than those chunks, so showing it would put
 * disconnected content above a hole. Clip it until reveals connect it; the reader sees blank, never wrong order.
 * Only the transcript is clipped: sticky chrome sharing the scroll content must stay visible.
 */
function clipAboveRevealFrontier (content: HTMLElement) {
  const hidden = content.querySelectorAll("[data-thread-progressive-hidden]");
  const frontier = hidden[hidden.length - 1];
  const transcript = frontier?.closest<HTMLElement>("[data-thread-transcript]") ?? null;
  for (const element of content.querySelectorAll<HTMLElement>("[data-thread-transcript]")) {
    const top = element === transcript && frontier
      ? frontier.getBoundingClientRect().top - element.getBoundingClientRect().top : 0;
    const outset = THREAD_REVEAL_CLIP_OUTSET_PX;
    const clip = top > 0 ? `inset(${top}px -${outset}px -${outset}px -${outset}px)` : "";
    if (element.style.clipPath !== clip) element.style.clipPath = clip;
  }
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
  const readerMovedListeners = useRef(new Set<() => void>());
  const visibility = useRef<ThreadViewportVisibilityController | null>(null);
  const progressiveWindowStartsRef = useRef(new Map<string, string>());
  const syncScrollProximity = useCallback((viewport: HTMLDivElement): ThreadScrollProximity => {
    const metrics = readScrollMetrics(viewport, endTargetRef.current);
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
  const anchorRef = useRef<ThreadReadingAnchorController<HTMLElement> | null>(null);
  const anchor = anchorRef.current ??= new ThreadReadingAnchorController<HTMLElement>({
    pick: () => viewportRef.current && contentRef.current
      ? pickThreadReadingAnchor(viewportRef.current, contentRef.current) : null,
    offset: (element) => {
      const content = contentRef.current;
      return content && element.isConnected && content.contains(element) ? getThreadContentOffset(element, content) : null;
    },
    shift: delta => settle.shift(delta),
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
    viewport.scrollTop = endTarget
      ? viewport.scrollTop + endTarget.getBoundingClientRect().bottom
        - viewport.getBoundingClientRect().top - viewport.clientHeight
      : scrollTop;
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
    activityRuns: null,
    progressiveWindowing: true,
    progressiveWindowStarts: progressiveWindowStartsRef.current,
    getViewport: () => viewportRef.current,
    reconcileLayout: () => anchor.reconcile(),
    observeContent: (element, listener, range = "viewport") => {
      const root = viewportRef.current;
      if (!root) return () => { };
      visibility.current ??= new ThreadViewportVisibilityController({
        root,
        intersection: (callback, observedRange, rootMarginPx) => new IntersectionObserver(callback, {
          root,
          rootMargin: observedRange === "viewport" ? "0px" : `${rootMarginPx}px 0px`,
        }),
        resize: callback => new ResizeObserver(callback),
      });
      return visibility.current.observe(element, listener, range);
    },
    onBottomReattached: (listener) => {
      bottomListeners.current.add(listener);
      return () => { bottomListeners.current.delete(listener); };
    },
    onReaderMoved: (listener) => {
      readerMovedListeners.current.add(listener);
      return () => { readerMovedListeners.current.delete(listener); };
    },
    setEndTarget: (target) => {
      endTargetRef.current = target;
      placeInitialViewportAtEnd();
    },
  }), [anchor, placeInitialViewportAtEnd]);

  // Every layout change is reconciled before it paints: size changes through the resize observer (later ticks of
  // settling content included), and mounts that move the anchor without changing total height through mutations.
  // Initial bottom placement re-pins after the anchor until reader intent.
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content || typeof ResizeObserver === "undefined") return;
    anchor.record();
    clipAboveRevealFrontier(content);
    const resize = new ResizeObserver(() => {
      anchor.reconcile();
      clipAboveRevealFrontier(content);
      placeInitialViewportAtEnd();
      settle.reconcileReserve();
      readerMovedListeners.current.forEach(listener => listener());
    });
    resize.observe(content);
    resize.observe(viewport);
    const mutations = new MutationObserver(() => {
      anchor.reconcile();
      clipAboveRevealFrontier(content);
      readerMovedListeners.current.forEach(listener => listener());
    });
    mutations.observe(content, { childList: true, subtree: true });
    return () => {
      resize.disconnect();
      mutations.disconnect();
    };
  }, [anchor, placeInitialViewportAtEnd, settle]);

  useEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;

    const setScrollDirection = (direction: ThreadScrollDirection) => {
      if (direction === directionRef.current) return;
      directionRef.current = direction;
      viewport.dataset.threadScrollDirection = direction;
    };
    // An activated control holds the reader in place until they move on their own: end snapping and the initial end pin
    // would otherwise follow what it revealed to the new end, and its own correction scrolls must not drop the hold.
    const holdActivation = (control: HTMLElement) => {
      anchor.hold(pickThreadActivationAnchor(control, content));
      initialEndPlacement.release();
      viewport.dataset.threadScrollHeld = "true";
    };
    const readerMoved = () => {
      initialEndPlacement.release();
      delete viewport.dataset.threadScrollHeld;
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
      if (viewport.dataset.threadScrollHeld) anchor.reconcile();
      else anchor.record();
      readerMovedListeners.current.forEach(listener => listener());
    };
    const handleScrollEnd = () => settle.scrollEnded();
    // Capture runs before the control's own handlers and default action (a disclosure toggling), whatever they stop.
    // Only expanding controls: one that removes itself would drop the hold and skip correcting its own removal.
    const handleControlActivated = (event: MouseEvent) => {
      const control = event.target instanceof Element
        ? event.target.closest<HTMLElement>("summary, [aria-expanded], [data-thread-expander]") : null;
      if (control && content.contains(control)) holdActivation(control);
    };
    const handleWheel = (event: WheelEvent) => {
      if (event.target instanceof Element && event.target.closest("[data-thread-scroll-target]") !== viewport) return;
      const direction = event.deltaY > 0 ? "down" : event.deltaY < 0 ? "up" : null;
      if (!direction) return;
      readerMoved();
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
        readerMoved();
        setScrollDirection("down");
        onScrollIntent?.("down", viewport.clientHeight);
      }
      if (THREAD_SCROLL_UP_KEYS.has(event.key) || (event.key === " " && event.shiftKey)) {
        readerMoved();
        setScrollDirection("up");
        onScrollIntent?.("up", viewport.clientHeight);
      }
    };
    const handlePointerDown = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest("[data-thread-scroll-target]") !== viewport) return;
      // The viewport itself is only hit on its scrollbar.
      if (event.target === viewport) readerMoved();
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
    // A touch's later events go to the element it started on even once that element is unmounted (history landing,
    // windows remounting), and then never bubble to the viewport; listening on the start target never loses the lift.
    const touchTargets = new Set<GlobalEventHandlers>();
    const releaseTouchTargets = () => {
      for (const target of touchTargets) {
        target.removeEventListener("touchmove", handleTouchMove);
        target.removeEventListener("touchend", handleTouchEnd);
        target.removeEventListener("touchcancel", handleTouchEnd);
      }
      touchTargets.clear();
    };
    const handleTouchStart = (event: TouchEvent) => {
      if (!(event.target instanceof HTMLElement || event.target instanceof SVGElement)) return;
      if (event.target.closest("[data-thread-scroll-target]") !== viewport) return;
      const target: GlobalEventHandlers = event.target;
      if (!touchTargets.has(target)) {
        touchTargets.add(target);
        target.addEventListener("touchmove", handleTouchMove, { passive: true });
        target.addEventListener("touchend", handleTouchEnd, { passive: true });
        target.addEventListener("touchcancel", handleTouchEnd, { passive: true });
      }
      touchClientYRef.current = event.touches.length === 1 ? event.touches[0].clientY : null;
      settle.touchStarted();
      onTouchActivityChange?.(touchClientYRef.current !== null);
    };
    function handleTouchMove (event: TouchEvent) {
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
        readerMoved();
        onScrollIntent?.(direction, Math.abs(currentClientY - previousClientY));
      }
      touchClientYRef.current = currentClientY;
    }
    function handleTouchEnd (event: TouchEvent) {
      touchClientYRef.current = null;
      if (event.touches.length === 0) {
        releaseTouchTargets();
        settle.touchEnded();
      }
      onTouchActivityChange?.(false);
    }

    content.addEventListener("click", handleControlActivated, { capture: true, passive: true });
    viewport.addEventListener("keydown", handleKeyDown);
    viewport.addEventListener("pointerdown", handlePointerDown, { passive: true });
    viewport.addEventListener("pointermove", handlePointerMove, { passive: true });
    viewport.addEventListener("scroll", handleScroll, { passive: true });
    viewport.addEventListener("scrollend", handleScrollEnd, { passive: true });
    viewport.addEventListener("touchstart", handleTouchStart, { passive: true });
    viewport.addEventListener("wheel", handleWheel, { passive: true });
    viewport.ownerDocument.addEventListener("pointercancel", handlePointerEnd, { passive: true });
    viewport.ownerDocument.addEventListener("pointerup", handlePointerEnd, { passive: true });
    return () => {
      pointerScrollActiveRef.current = false;
      pointerScrollMovedRef.current = false;
      touchClientYRef.current = null;
      content.removeEventListener("click", handleControlActivated, { capture: true });
      viewport.removeEventListener("keydown", handleKeyDown);
      viewport.removeEventListener("pointerdown", handlePointerDown);
      viewport.removeEventListener("pointermove", handlePointerMove);
      viewport.removeEventListener("scroll", handleScroll);
      viewport.removeEventListener("scrollend", handleScrollEnd);
      releaseTouchTargets();
      viewport.removeEventListener("touchstart", handleTouchStart);
      viewport.removeEventListener("wheel", handleWheel);
      viewport.ownerDocument.removeEventListener("pointercancel", handlePointerEnd);
      viewport.ownerDocument.removeEventListener("pointerup", handlePointerEnd);
    };
  }, [anchor, onScrollIntent, onTouchActivityChange, settle, syncScrollProximity]);

  return (
    <div
      ref={setViewportRef}
      className={joinClasses(
        "scrollbar-hover-reveal flex min-h-0 flex-col overflow-x-hidden overflow-y-auto",
        "[--thread-scroll-inline-padding:1.25rem] md:[--thread-scroll-inline-padding:1.5rem]",
        "[--thread-scroll-snap-distance:0px] [overflow-anchor:none] snap-none",
        "[&[data-thread-scroll-direction=down][data-thread-scroll-proximity=near]:not([data-thread-scroll-held])]:[scroll-snap-type:y_proximity]",
        "[&[data-thread-scroll-direction=down][data-thread-scroll-proximity=near]:not([data-thread-scroll-held])]:[--thread-scroll-snap-distance:calc(100dvh-1px)]",
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
