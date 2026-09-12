/*
 * Exports:
 * - default ThreadScrollViewport: own atomic bottom-following and reading scroll layouts.
 */
"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ForwardedRef,
  type ReactNode,
} from "react";

import ThreadScrollMode, {
  type ThreadScrollMetrics,
  type ThreadScrollMode as ThreadScrollModeValue,
} from "./thread-scroll-mode";
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

interface PendingScrollModeTransition {
  readonly mode: ThreadScrollModeValue;
  readonly preventWheel: (event: WheelEvent) => void;
  readonly target: HTMLDivElement;
  readonly topOriginOffset: number;
}

const THREAD_SCROLL_QUIET_PERIOD_MS = 500;

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

function releaseScrollModeTransition (transition: PendingScrollModeTransition) {
  transition.target.removeEventListener("wheel", transition.preventWheel);
}

function ActiveThreadScrollViewport ({
  children,
  className,
  contentClassName,
  forwardedRef,
}: ActiveThreadScrollViewportProps) {
  const [mode, setMode] = useState<ThreadScrollModeValue>("bottom-following");
  const composerArmedRef = useRef(false);
  const modeRef = useRef<ThreadScrollModeValue>("bottom-following");
  const pendingReadingModeRef = useRef(false);
  const pendingTransitionRef = useRef<PendingScrollModeTransition | null>(null);
  const previousMetricsRef = useRef<ThreadScrollMetrics | null>(null);
  const scrollQuietPeriodTimeoutRef = useRef<number | null>(null);
  const viewportRef = useRef<HTMLDivElement>(null);

  const setViewportRef = useCallback((viewport: HTMLDivElement | null) => {
    viewportRef.current = viewport;
    previousMetricsRef.current = viewport ? readScrollMetrics(viewport) : null;
    assignRef(forwardedRef, viewport);
  }, [forwardedRef]);

  const transitionToMode = useCallback((nextMode: ThreadScrollModeValue) => {
    const viewport = viewportRef.current;
    const currentMode = modeRef.current;
    if (!viewport || currentMode === nextMode || pendingTransitionRef.current) return;

    const preventWheel = (event: WheelEvent) => {
      event.preventDefault();
    };
    viewport.addEventListener("wheel", preventWheel, { passive: false });
    const metrics = readScrollMetrics(viewport);
    previousMetricsRef.current = metrics;
    pendingTransitionRef.current = {
      mode: nextMode,
      preventWheel,
      target: viewport,
      topOriginOffset: ThreadScrollMode.toTopOriginOffset(currentMode, metrics),
    };
    setMode(nextMode);
  }, []);

  const cancelReadingTransition = useCallback(() => {
    if (scrollQuietPeriodTimeoutRef.current !== null) {
      window.clearTimeout(scrollQuietPeriodTimeoutRef.current);
      scrollQuietPeriodTimeoutRef.current = null;
    }
  }, []);

  const commitPendingReadingMode = useCallback(() => {
    const viewport = viewportRef.current;
    if (
      !viewport
      || !pendingReadingModeRef.current
      || !composerArmedRef.current
      || modeRef.current !== "bottom-following"
      || pendingTransitionRef.current
    ) {
      return;
    }

    const metrics = readScrollMetrics(viewport);
    if (ThreadScrollMode.isAtBottom("bottom-following", metrics)) {
      pendingReadingModeRef.current = false;
      cancelReadingTransition();
      return;
    }

    pendingReadingModeRef.current = false;
    cancelReadingTransition();
    transitionToMode("reading");
  }, [cancelReadingTransition, transitionToMode]);

  const scheduleReadingTransition = useCallback(() => {
    cancelReadingTransition();
    scrollQuietPeriodTimeoutRef.current = window.setTimeout(() => {
      scrollQuietPeriodTimeoutRef.current = null;
      commitPendingReadingMode();
    }, THREAD_SCROLL_QUIET_PERIOD_MS);
  }, [cancelReadingTransition, commitPendingReadingMode]);

  const reportComposerArmed = useCallback((armed: boolean) => {
    const viewport = viewportRef.current;
    composerArmedRef.current = armed;
    if (!viewport) return;

    const metrics = readScrollMetrics(viewport);
    previousMetricsRef.current = metrics;
    if (!armed || modeRef.current !== "bottom-following" || pendingTransitionRef.current) {
      pendingReadingModeRef.current = false;
      cancelReadingTransition();
    }
  }, [cancelReadingTransition]);

  const isWithinBottomDistance = useCallback((tolerancePx: number) => {
    const viewport = viewportRef.current;
    return viewport
      ? ThreadScrollMode.isAtBottom(modeRef.current, readScrollMetrics(viewport), tolerancePx)
      : false;
  }, []);

  const contextValue = useMemo<ThreadScrollViewportContextValue>(() => ({
    getViewport: () => viewportRef.current,
    preserveOffscreenLayout: () => {
      const viewport = viewportRef.current;
      if (!viewport || pendingTransitionRef.current) return () => {};
      const previousHeight = viewport.scrollHeight;
      const previousTop = viewport.scrollTop;
      const previousMode = modeRef.current;
      return () => {
        if (viewportRef.current !== viewport || modeRef.current !== previousMode || pendingTransitionRef.current) return;
        // Preserve distance from the bottom when content strictly above the reader changes.
        // Reverse flex already uses that distance as its coordinate.
        viewport.scrollTop = previousMode === "bottom-following"
          ? previousTop
          : previousTop + viewport.scrollHeight - previousHeight;
        previousMetricsRef.current = readScrollMetrics(viewport);
      };
    },
    isWithinBottomDistance,
    reportComposerArmed,
  }), [isWithinBottomDistance, reportComposerArmed]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const pendingTransition = pendingTransitionRef.current;
    modeRef.current = mode;
    if (!pendingTransition || pendingTransition.mode !== mode) return;

    try {
      if (viewport === pendingTransition.target) {
        viewport.scrollTop = mode === "bottom-following"
          ? 0
          : ThreadScrollMode.scrollTopForTopOriginOffset(
            mode,
            pendingTransition.topOriginOffset,
            readScrollMetrics(viewport),
          );
        previousMetricsRef.current = readScrollMetrics(viewport);
      }
    } finally {
      pendingTransitionRef.current = null;
      releaseScrollModeTransition(pendingTransition);
    }
  }, [mode]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    const handleScroll = () => {
      if (pendingTransitionRef.current) return;
      const currentMode = modeRef.current;
      const metrics = readScrollMetrics(viewport);
      const previousMetrics = previousMetricsRef.current;
      previousMetricsRef.current = metrics;
      if (currentMode === "reading") {
        if (ThreadScrollMode.isAtBottom("reading", metrics)) {
          pendingReadingModeRef.current = false;
          cancelReadingTransition();
          transitionToMode("bottom-following");
        }
        return;
      }

      if (ThreadScrollMode.isAtBottom("bottom-following", metrics)) {
        pendingReadingModeRef.current = false;
        cancelReadingTransition();
        return;
      }
      if (
        composerArmedRef.current
        && previousMetrics
        && ThreadScrollMode.didMoveAwayFromBottom("bottom-following", previousMetrics, metrics)
      ) {
        pendingReadingModeRef.current = true;
        scheduleReadingTransition();
      } else if (pendingReadingModeRef.current) {
        scheduleReadingTransition();
      }
    };
    const refreshMetrics = () => {
      previousMetricsRef.current = readScrollMetrics(viewport);
    };
    const resizeObserver = new ResizeObserver(refreshMetrics);
    resizeObserver.observe(viewport);
    const content = viewport.firstElementChild;
    if (content) resizeObserver.observe(content);

    viewport.addEventListener("scroll", handleScroll, { passive: true });
    refreshMetrics();
    return () => {
      cancelReadingTransition();
      const pendingTransition = pendingTransitionRef.current;
      if (pendingTransition) {
        pendingTransitionRef.current = null;
        releaseScrollModeTransition(pendingTransition);
      }
      resizeObserver.disconnect();
      viewport.removeEventListener("scroll", handleScroll);
    };
  }, [
    cancelReadingTransition,
    scheduleReadingTransition,
    transitionToMode,
  ]);

  return (
    <div
      ref={setViewportRef}
      className={joinClasses(
        "explorer-scrollbar flex min-h-0 overflow-x-hidden overflow-y-auto",
        mode === "bottom-following" ? "flex-col-reverse" : "flex-col",
        className,
      )}
      data-thread-scroll-mode={mode}
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
