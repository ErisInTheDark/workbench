/*
 * Exports:
 * - default StickyCollapsibleSurface: own composer placement across viewport and content resizing while preserving its DOM and inline footprint.
 */
"use client";

import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import ChevronIcon from "./ChevronIcon";
import {
  resolveStickyCollapsiblePlacement,
  type StickyCollapsiblePlacement,
} from "./sticky-collapsible-state";

const STICKY_MOTION_DURATION_MS = 240;
const STICKY_BOTTOM_RELEASE_TOLERANCE_PX = 25;

type MoveBeforeDestination = HTMLElement & {
  moveBefore?: (movedNode: Node, referenceNode: Node | null) => void;
};

function isInteractiveTarget(currentTarget: HTMLElement, target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  const interactiveTarget = target.closest("button,a,input,textarea,select,[contenteditable='true']");
  return Boolean(interactiveTarget && interactiveTarget !== currentTarget);
}

function movePortalHost(destination: HTMLElement, portalHost: HTMLElement) {
  const moveBeforeDestination = destination as MoveBeforeDestination;
  if (
    destination.isConnected
    && portalHost.isConnected
    && typeof moveBeforeDestination.moveBefore === "function"
  ) {
    moveBeforeDestination.moveBefore(portalHost, null);
    return;
  }
  destination.insertBefore(portalHost, null);
}

function getVisibleViewportBottom() {
  const viewport = window.visualViewport;
  return viewport ? viewport.offsetTop + viewport.height : window.innerHeight;
}

export default function StickyCollapsibleSurface({
  children,
  collapseLabel,
  collapsed,
  collapsedAccessory,
  collapsedContent,
  collapsedLabel,
  collapsedPreviewKind,
  isWithinScrollBottomDistance,
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
  isWithinScrollBottomDistance?: (tolerancePx: number) => boolean;
  onArmedChange?: (armed: boolean) => void;
  onCollapsedChange(collapsed: boolean): void;
  order?: number;
  scrollTargetSelector: string;
}) {
  const [placement, setPlacement] = useState<StickyCollapsiblePlacement>("inline");
  const inlineSlotRef = useRef<HTMLDivElement>(null);
  const placementRef = useRef<StickyCollapsiblePlacement>("inline");
  const portalHostRef = useRef<HTMLDivElement | null>(null);
  const previousPlacementRef = useRef<StickyCollapsiblePlacement>("inline");
  const stickySlotRef = useRef<HTMLDivElement>(null);

  if (portalHostRef.current === null && typeof document !== "undefined") {
    const portalHost = document.createElement("div");
    portalHost.className = "sticky-collapsible-portal-host";
    portalHost.dataset.stickyArmed = "false";
    portalHost.dataset.stickyMotion = "idle";
    portalHostRef.current = portalHost;
  }

  const setInlineSlot = useCallback((inlineSlot: HTMLDivElement | null) => {
    inlineSlotRef.current = inlineSlot;
    const portalHost = portalHostRef.current;
    if (inlineSlot && portalHost && placementRef.current === "inline" && portalHost.parentNode !== inlineSlot) {
      movePortalHost(inlineSlot, portalHost);
    }
  }, []);

  const setStickySlot = useCallback((stickySlot: HTMLDivElement | null) => {
    stickySlotRef.current = stickySlot;
    const portalHost = portalHostRef.current;
    if (stickySlot && portalHost && placementRef.current === "sticky" && portalHost.parentNode !== stickySlot) {
      movePortalHost(stickySlot, portalHost);
    }
  }, []);

  const commitPlacement = useCallback((nextPlacement: StickyCollapsiblePlacement) => {
    const inlineSlot = inlineSlotRef.current;
    const stickySlot = stickySlotRef.current;
    const portalHost = portalHostRef.current;
    if (
      nextPlacement === placementRef.current
      || !inlineSlot
      || !stickySlot
      || !portalHost
    ) {
      return;
    }

    if (nextPlacement === "sticky") {
      inlineSlot.style.height = `${inlineSlot.getBoundingClientRect().height}px`;
      portalHost.dataset.stickyArmed = "true";
      movePortalHost(stickySlot, portalHost);
    } else {
      portalHost.dataset.stickyArmed = "false";
      movePortalHost(inlineSlot, portalHost);
      inlineSlot.style.removeProperty("height");
    }

    placementRef.current = nextPlacement;
    setPlacement(nextPlacement);
    onArmedChange?.(nextPlacement === "sticky");
  }, [onArmedChange]);

  useLayoutEffect(() => {
    const inlineSlot = inlineSlotRef.current;
    const portalHost = portalHostRef.current;
    if (!inlineSlot || !portalHost) return;

    const scrollTarget = inlineSlot.closest<HTMLElement>(scrollTargetSelector);
    const scrollEventTarget: HTMLElement | Window = scrollTarget ?? window;
    let frameId: number | null = null;

    const updatePlacement = () => {
      frameId = null;
      const scrollElement = scrollTarget ?? document.scrollingElement ?? document.documentElement;
      const nextPlacement = resolveStickyCollapsiblePlacement({
        currentPlacement: placementRef.current,
        hasScrollableOverflow: scrollElement.scrollHeight > scrollElement.clientHeight,
        inlineSlotTop: inlineSlot.getBoundingClientRect().top,
        isNearScrollBottom: isWithinScrollBottomDistance?.(STICKY_BOTTOM_RELEASE_TOLERANCE_PX) ?? false,
        scrollTargetBottom: scrollTarget?.getBoundingClientRect().bottom ?? null,
        stickyComposerTop: placementRef.current === "sticky"
          ? portalHost.getBoundingClientRect().top
          : null,
        viewportBottom: getVisibleViewportBottom(),
      });
      commitPlacement(nextPlacement);
    };
    const requestPlacementUpdate = () => {
      if (frameId === null) frameId = window.requestAnimationFrame(updatePlacement);
    };
    const resizeObserver = typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(requestPlacementUpdate)
      : null;

    // Parent viewport refs must be attached before asking for bottom distance.
    requestPlacementUpdate();
    if (scrollTarget) resizeObserver?.observe(scrollTarget);
    // The viewport can stay fixed while transcript growth or shrinkage changes overflow.
    if (inlineSlot.parentElement) resizeObserver?.observe(inlineSlot.parentElement);
    resizeObserver?.observe(portalHost);
    scrollEventTarget.addEventListener("scroll", requestPlacementUpdate, { passive: true });
    window.addEventListener("resize", requestPlacementUpdate);
    window.visualViewport?.addEventListener("resize", requestPlacementUpdate);
    window.visualViewport?.addEventListener("scroll", requestPlacementUpdate);
    return () => {
      if (frameId !== null) window.cancelAnimationFrame(frameId);
      resizeObserver?.disconnect();
      scrollEventTarget.removeEventListener("scroll", requestPlacementUpdate);
      window.removeEventListener("resize", requestPlacementUpdate);
      window.visualViewport?.removeEventListener("resize", requestPlacementUpdate);
      window.visualViewport?.removeEventListener("scroll", requestPlacementUpdate);
    };
  }, [commitPlacement, isWithinScrollBottomDistance, scrollTargetSelector]);

  useEffect(() => {
    const previousPlacement = previousPlacementRef.current;
    if (previousPlacement === placement) return;
    previousPlacementRef.current = placement;

    const portalHost = portalHostRef.current;
    if (!portalHost) return;
    portalHost.dataset.stickyMotion = placement === "sticky" ? "entering" : "leaving";
    const timeoutId = window.setTimeout(() => {
      portalHost.dataset.stickyMotion = "idle";
    }, STICKY_MOTION_DURATION_MS);
    return () => window.clearTimeout(timeoutId);
  }, [placement]);

  const expand = () => onCollapsedChange(false);
  const handleCollapsedKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    if (isInteractiveTarget(event.currentTarget, event.target)) return;
    event.preventDefault();
    expand();
  };
  const collapseControlLabel = collapsed ? collapsedLabel : collapseLabel;
  const portalHost = portalHostRef.current;

  return (
    <>
      <div
        ref={setInlineSlot}
        className="sticky-collapsible-inline-slot"
        style={order === undefined ? undefined : { order }}
      />
      <div
        ref={setStickySlot}
        className="sticky-collapsible-sticky-slot"
        style={order === undefined ? undefined : { order }}
      />
      {portalHost
        ? createPortal(
          <div
            className="sticky-collapsible-host"
            data-collapsed={collapsed ? "true" : "false"}
          >
            <div className="sticky-collapsible-shell">
              <div
                className={`sticky-collapsible-surface ${collapsed
                  ? "in-[.sticky-collapsible-sticky-slot]:pb-[calc(0.75rem+min(0.75rem,var(--workbench-safe-area-bottom,0px)))]"
                  : ""
                }`}
                data-collapsed={collapsed ? "true" : "false"}
              >
                <div className="sticky-collapsible-expanded">
                  <div className="sticky-collapsible-collapse-button-slot">
                    <button
                      aria-expanded={!collapsed}
                      aria-label={collapseControlLabel}
                      className="inline-flex size-9 items-center justify-center rounded-full text-fg/muted transition hover:bg-[color-mix(in_srgb,var(--text)_5%,transparent)] hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
                      onClick={() => onCollapsedChange(!collapsed)}
                      title={collapseControlLabel}
                      type="button"
                    >
                      <ChevronIcon className={`transition-transform ${collapsed ? "rotate-180" : ""}`} size={16} />
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
                    <ChevronIcon className="rotate-180" size={16} />
                  </span>
                  <span className="sticky-collapsible-collapsed-text" data-preview-kind={collapsedPreviewKind}>
                    {collapsedContent}
                  </span>
                  {collapsedAccessory ? <span className="sticky-collapsible-collapsed-accessory">{collapsedAccessory}</span> : null}
                </div>
              </div>
            </div>
          </div>,
          portalHost,
        )
        : null}
    </>
  );
}
