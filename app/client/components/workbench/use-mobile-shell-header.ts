/*
 * Exports:
 * - default useMobileShellHeader: own the mobile shell header's visibility controller and feed it the main pane's or thread
 *   viewport's scroll, touch, wheel and key gestures; returns the controller plus the thread viewport's gesture callbacks.
 */
"use client";

import { useCallback, useEffect, useMemo, useState, type RefObject } from "react";

import type { MobileShellHeaderEvent } from "./mobile-shell-header-visibility";
import MobileShellHeaderVisibilityController from "./MobileShellHeaderVisibilityController";

interface MobileShellHeaderOptions {
  isMobile: boolean;
  shouldShowShellHeader: boolean;
  showThreadView: boolean;
  mainPaneRef: RefObject<HTMLElement | null>;
  threadViewportRef: RefObject<HTMLDivElement | null>;
  /** Scrolls a non-thread main pane back to the top whenever it changes. */
  mainPaneScrollKey: string;
  /** Re-reads the scroll target whenever the viewed surface changes. */
  surfaceKey: string;
}

export default function useMobileShellHeader ({
  isMobile, shouldShowShellHeader, showThreadView, mainPaneRef, threadViewportRef, mainPaneScrollKey, surfaceKey,
}: MobileShellHeaderOptions) {
  const [visibility] = useState(() => new MobileShellHeaderVisibilityController());

  useEffect(() => {
    if (!isMobile || !shouldShowShellHeader || !mainPaneScrollKey || showThreadView) {
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      if (mainPaneRef.current) {
        mainPaneRef.current.scrollTop = 0;
      }
    });

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [showThreadView, isMobile, mainPaneRef, mainPaneScrollKey, shouldShowShellHeader]);

  const apply = useCallback((event: MobileShellHeaderEvent) => {
    if (!isMobile || !shouldShowShellHeader) return;
    visibility.apply(event);
  }, [isMobile, visibility, shouldShowShellHeader]);

  const onScrollIntent = useCallback((direction: "up" | "down", travelPx: number) => {
    apply({ kind: "gesture", direction, travelPx });
  }, [apply]);
  const onTouchActivity = useCallback((active: boolean) => {
    apply({ kind: "touch", active });
  }, [apply]);

  useEffect(() => {
    const scrollTarget = showThreadView ? threadViewportRef.current : mainPaneRef.current;
    visibility.reset(scrollTarget ? {
      scrollTop: scrollTarget.scrollTop,
      scrollHeight: scrollTarget.scrollHeight,
      clientHeight: scrollTarget.clientHeight,
    } : null);
    if (!isMobile || !shouldShowShellHeader) return;
    if (!scrollTarget) return;

    const handleScroll = () => {
      apply({
        kind: "scroll",
        scrollTop: scrollTarget.scrollTop,
        scrollHeight: scrollTarget.scrollHeight,
        clientHeight: scrollTarget.clientHeight,
      });
    };
    scrollTarget.addEventListener("scroll", handleScroll, { passive: true });

    if (showThreadView) {
      return () => {
        scrollTarget.removeEventListener("scroll", handleScroll);
      };
    }

    let touchClientY: number | null = null;
    const handleGesture = (direction: "up" | "down", travelPx: number) => {
      apply({ kind: "gesture", direction, travelPx });
    };
    const belongsToMainPane = (target: EventTarget | null) => (
      !(target instanceof Element) || !target.closest("[data-thread-scroll-target]")
    );
    const handleTouchStart = (event: TouchEvent) => {
      touchClientY = belongsToMainPane(event.target) && event.touches.length === 1
        ? event.touches[0].clientY : null;
      if (touchClientY !== null) apply({ kind: "touch", active: true });
    };
    const handleTouchMove = (event: TouchEvent) => {
      if (!belongsToMainPane(event.target) || event.touches.length !== 1 || touchClientY === null) {
        touchClientY = null;
        apply({ kind: "touch", active: false });
        return;
      }
      const nextClientY = event.touches[0].clientY;
      if (nextClientY !== touchClientY) {
        handleGesture(nextClientY > touchClientY ? "up" : "down", Math.abs(nextClientY - touchClientY));
      }
      touchClientY = nextClientY;
    };
    const handleTouchEnd = () => {
      touchClientY = null;
      apply({ kind: "touch", active: false });
    };
    const handleWheel = (event: WheelEvent) => {
      if (!belongsToMainPane(event.target) || event.deltaY === 0) return;
      const travelPx = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? Math.abs(event.deltaY) * 16
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? Math.abs(event.deltaY) * scrollTarget.clientHeight
          : Math.abs(event.deltaY);
      handleGesture(event.deltaY > 0 ? "down" : "up", travelPx);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!belongsToMainPane(event.target)) return;
      if (event.target instanceof HTMLElement
        && event.target.closest("a,button,input,select,textarea,[contenteditable='true']")) return;
      if (["ArrowDown", "End", "PageDown"].includes(event.key) || (event.key === " " && !event.shiftKey)) {
        handleGesture("down", scrollTarget.clientHeight);
      } else if (["ArrowUp", "Home", "PageUp"].includes(event.key) || (event.key === " " && event.shiftKey)) {
        handleGesture("up", scrollTarget.clientHeight);
      }
    };

    scrollTarget.addEventListener("touchstart", handleTouchStart, { passive: true });
    scrollTarget.addEventListener("touchmove", handleTouchMove, { passive: true });
    scrollTarget.addEventListener("touchend", handleTouchEnd, { passive: true });
    scrollTarget.addEventListener("touchcancel", handleTouchEnd, { passive: true });
    scrollTarget.addEventListener("wheel", handleWheel, { passive: true });
    scrollTarget.addEventListener("keydown", handleKeyDown);
    return () => {
      scrollTarget.removeEventListener("scroll", handleScroll);
      scrollTarget.removeEventListener("touchstart", handleTouchStart);
      scrollTarget.removeEventListener("touchmove", handleTouchMove);
      scrollTarget.removeEventListener("touchend", handleTouchEnd);
      scrollTarget.removeEventListener("touchcancel", handleTouchEnd);
      scrollTarget.removeEventListener("wheel", handleWheel);
      scrollTarget.removeEventListener("keydown", handleKeyDown);
    };
  }, [apply, showThreadView, isMobile, visibility, mainPaneRef, threadViewportRef, shouldShowShellHeader, surfaceKey]);

  return useMemo(() => ({ visibility, onScrollIntent, onTouchActivity }), [visibility, onScrollIntent, onTouchActivity]);
}
