/*
 * Exports:
 * - default ThreadScrollViewport: own atomic reverse-at-bottom and normal-while-reading thread scroll modes. Keywords: thread, scroll, viewport, reverse flex, reading.
 * - Local state owner and helpers: convert scroll coordinates before paint and receive composer-arming intent through the nearest viewport context. Keywords: thread, scroll mode, composer, atomic transition.
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
  const scrollQuietPeriodTimeoutRef = useRef<number | null>(null);
  const viewportRef = useRef<HTMLDivElement>(null);

  const setViewportRef = useCallback((viewport: HTMLDivElement | null) => {
    viewportRef.current = viewport;
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
    if (!viewport || modeRef.current !== "bottom-following" || pendingTransitionRef.current) return;

    const metrics = readScrollMetrics(viewport);
    if (ThreadScrollMode.isAtBottom("bottom-following", metrics)) {
      pendingReadingModeRef.current = false;
      cancelReadingTransition();
      return;
    }
    if (!armed) {
      pendingReadingModeRef.current = false;
      cancelReadingTransition();
      return;
    }

    pendingReadingModeRef.current = true;
    scheduleReadingTransition();
  }, [
    cancelReadingTransition,
    scheduleReadingTransition,
  ]);

  const reportComposerGeometryChange = useCallback(() => {
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
    scheduleReadingTransition();
  }, [cancelReadingTransition, scheduleReadingTransition]);

  const contextValue = useMemo<ThreadScrollViewportContextValue>(() => ({
    reportComposerArmed,
    reportComposerGeometryChange,
  }), [reportComposerArmed, reportComposerGeometryChange]);

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
      if (composerArmedRef.current) {
        pendingReadingModeRef.current = true;
        scheduleReadingTransition();
      }
    };
    const handleWheel = () => {
      if (
        pendingTransitionRef.current
        || modeRef.current !== "bottom-following"
        || !composerArmedRef.current
      ) {
        return;
      }

      pendingReadingModeRef.current = true;
      scheduleReadingTransition();
    };

    viewport.addEventListener("scroll", handleScroll, { passive: true });
    viewport.addEventListener("wheel", handleWheel, { passive: true });
    return () => {
      cancelReadingTransition();
      const pendingTransition = pendingTransitionRef.current;
      if (pendingTransition) {
        pendingTransitionRef.current = null;
        releaseScrollModeTransition(pendingTransition);
      }
      viewport.removeEventListener("scroll", handleScroll);
      viewport.removeEventListener("wheel", handleWheel);
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
