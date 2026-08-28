/*
 * Exports:
 * - default StickyCollapsibleSurface: own composer-style sentinel arming, sticky overlay, height preservation, and collapse interaction. Keywords: sticky, collapsible, surface, scrollport.
 * - Local helpers: classify interactive targets and report geometry-derived armed-state edges. Keywords: sticky, sentinel, armed state, interaction.
 */
"use client";

import {
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import ChevronIcon from "./ChevronIcon";
import { isStickyCollapsibleSentinelBelowVisibleBoundary } from "./sticky-collapsible-state";

const STICKY_MOTION_DURATION_MS = 240;

function isInteractiveTarget(currentTarget: HTMLElement, target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  const interactiveTarget = target.closest("button,a,input,textarea,select,[contenteditable='true']");
  return Boolean(interactiveTarget && interactiveTarget !== currentTarget);
}

function isArmedForElement(sentinelElement: HTMLElement, scrollTargetSelector: string) {
  const viewport = window.visualViewport;
  const viewportBottom = viewport ? viewport.offsetTop + viewport.height : window.innerHeight;
  const scrollTarget = sentinelElement.closest<HTMLElement>(scrollTargetSelector);
  return isStickyCollapsibleSentinelBelowVisibleBoundary({
    scrollTargetBottom: scrollTarget?.getBoundingClientRect().bottom ?? null,
    sentinelTop: sentinelElement.getBoundingClientRect().top,
    viewportBottom,
  });
}

export default function StickyCollapsibleSurface({
  children,
  collapseLabel,
  collapsed,
  collapsedAccessory,
  collapsedContent,
  collapsedLabel,
  collapsedPreviewKind,
  onArmedChange,
  onCollapsedChange,
  order,
  scrollTargetSelector,
}: {
  children: ReactNode;
  collapseLabel: string;
  collapsed: boolean;
  collapsedAccessory?: ReactNode;
  collapsedContent: ReactNode;
  collapsedLabel: string;
  collapsedPreviewKind?: string;
  onArmedChange?: (armed: boolean) => void;
  onCollapsedChange(collapsed: boolean): void;
  order?: number;
  scrollTargetSelector: string;
}) {
  const [expandedHeightPx, setExpandedHeightPx] = useState(0);
  const [isArmed, setIsArmed] = useState(false);
  const [motionState, setMotionState] = useState<"idle" | "entering" | "leaving">("idle");
  const expandedRef = useRef<HTMLDivElement>(null);
  const isArmedRef = useRef(false);
  const previousArmedRef = useRef(false);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);

  const commitArmedState = useCallback((nextArmed: boolean) => {
    if (isArmedRef.current === nextArmed) return;
    isArmedRef.current = nextArmed;
    setIsArmed(nextArmed);
    onArmedChange?.(nextArmed);
  }, [onArmedChange]);

  useEffect(() => {
    const sentinelElement = sentinelRef.current;
    if (!sentinelElement) {
      commitArmedState(true);
      return;
    }

    const scrollTarget = sentinelElement.closest<HTMLElement>(scrollTargetSelector);
    let frameId: number | null = null;
    const updateArmedState = () => {
      frameId = null;
      commitArmedState(isArmedForElement(sentinelElement, scrollTargetSelector));
    };
    const requestUpdateArmedState = () => {
      if (frameId === null) frameId = window.requestAnimationFrame(updateArmedState);
    };
    const resizeObserver = scrollTarget && typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(requestUpdateArmedState)
      : null;
    const scrollEventTarget: HTMLElement | Window = scrollTarget ?? window;

    updateArmedState();
    resizeObserver?.observe(scrollTarget!);
    scrollEventTarget.addEventListener("scroll", requestUpdateArmedState, { passive: true });
    window.addEventListener("resize", requestUpdateArmedState);
    window.visualViewport?.addEventListener("resize", requestUpdateArmedState);
    window.visualViewport?.addEventListener("scroll", requestUpdateArmedState);
    return () => {
      if (frameId !== null) window.cancelAnimationFrame(frameId);
      resizeObserver?.disconnect();
      scrollEventTarget.removeEventListener("scroll", requestUpdateArmedState);
      window.removeEventListener("resize", requestUpdateArmedState);
      window.visualViewport?.removeEventListener("resize", requestUpdateArmedState);
      window.visualViewport?.removeEventListener("scroll", requestUpdateArmedState);
    };
  }, [commitArmedState, scrollTargetSelector]);

  useEffect(() => {
    const sentinelElement = sentinelRef.current;
    if (sentinelElement) commitArmedState(isArmedForElement(sentinelElement, scrollTargetSelector));
  });

  useEffect(() => {
    const previousIsArmed = previousArmedRef.current;
    if (previousIsArmed === isArmed) return;
    previousArmedRef.current = isArmed;
    setMotionState(isArmed ? "entering" : "leaving");
    const timeoutId = window.setTimeout(() => setMotionState("idle"), STICKY_MOTION_DURATION_MS);
    return () => window.clearTimeout(timeoutId);
  }, [isArmed]);

  useEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    const expandedElement = expandedRef.current;
    const surfaceElement = surfaceRef.current;
    if (!expandedElement || !surfaceElement) return;

    const updateHeight = () => {
      const surfaceStyle = window.getComputedStyle(surfaceElement);
      const verticalPadding = (
        (Number.parseFloat(surfaceStyle.paddingTop) || 0)
        + (Number.parseFloat(surfaceStyle.paddingBottom) || 0)
      );
      const nextHeight = expandedElement.getBoundingClientRect().height + verticalPadding;
      setExpandedHeightPx((currentHeight) => (
        Math.abs(currentHeight - nextHeight) < 0.5 ? currentHeight : nextHeight
      ));
    };
    updateHeight();
    const frameId = window.requestAnimationFrame(updateHeight);
    const observer = new ResizeObserver(updateHeight);
    observer.observe(expandedElement);
    observer.observe(surfaceElement);
    return () => {
      window.cancelAnimationFrame(frameId);
      observer.disconnect();
    };
  }, [collapsed]);

  const expand = () => onCollapsedChange(false);
  const handleCollapsedKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    if (isInteractiveTarget(event.currentTarget, event.target)) return;
    event.preventDefault();
    expand();
  };
  const style = {
    ...(expandedHeightPx > 0 ? { "--sticky-collapsible-expanded-height": `${expandedHeightPx}px` } : {}),
    ...(order === undefined ? {} : { order }),
  } as CSSProperties;
  const collapseControlLabel = collapsed ? collapsedLabel : collapseLabel;

  return (
    <>
      <div
        ref={sentinelRef}
        aria-hidden="true"
        className="sticky-collapsible-top-sentinel"
        style={order === undefined ? undefined : { order }}
      />
      <div
        className="sticky-collapsible-host"
        data-collapsed={collapsed ? "true" : "false"}
        data-sticky-armed={isArmed ? "true" : "false"}
        data-sticky-motion={motionState}
        style={style}
      >
        <div className="sticky-collapsible-spacer" aria-hidden="true" />
        <div className="sticky-collapsible-shell">
          <div
            ref={surfaceRef}
            className="sticky-collapsible-surface"
            data-collapsed={collapsed ? "true" : "false"}
          >
            <div ref={expandedRef} className="sticky-collapsible-expanded">
              <div className="sticky-collapsible-collapse-button-slot">
                <button
                  aria-expanded={!collapsed}
                  aria-label={collapseControlLabel}
                  className="inline-flex size-9 items-center justify-center rounded-full text-muted transition hover:bg-[color-mix(in_srgb,var(--text)_5%,transparent)] hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
                  onClick={() => onCollapsedChange(!collapsed)}
                  title={collapseControlLabel}
                  type="button"
                >
                  <ChevronIcon className={`size-4 transition-transform ${collapsed ? "-rotate-90" : "rotate-90"}`} />
                </button>
              </div>
              <div className="min-w-0">{children}</div>
            </div>
            <div
              aria-label={collapsedLabel}
              className="sticky-collapsible-collapsed"
              onClick={(event) => {
                if (!isInteractiveTarget(event.currentTarget, event.target)) expand();
              }}
              onKeyDown={handleCollapsedKeyDown}
              role="button"
              tabIndex={0}
            >
              <span className="sticky-collapsible-collapsed-chevron" aria-hidden="true">
                <ChevronIcon className="size-4 -rotate-90" />
              </span>
              <span className="sticky-collapsible-collapsed-text" data-preview-kind={collapsedPreviewKind}>
                {collapsedContent}
              </span>
              {collapsedAccessory ? <span className="sticky-collapsible-collapsed-accessory">{collapsedAccessory}</span> : null}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
