/*
 * Exports:
 * - default StickyComposerSurface: render one sticky host with geometry-owned stuck state and flow reservation.
 */
"use client";

import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";

import ChevronIcon from "../ChevronIcon";
import { useThreadScrollViewportContext } from "./thread-scroll-viewport-context";

function isInteractiveTarget(currentTarget: HTMLElement, target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  const interactiveTarget = target.closest("button,a,input,textarea,select,[contenteditable='true']");
  return Boolean(interactiveTarget && interactiveTarget !== currentTarget);
}

export default function StickyComposerSurface({
  children,
  collapseLabel,
  collapsed,
  collapsedAccessory,
  collapsedContent,
  collapsedLabel,
  collapsedPreviewKind,
  getViewport,
  onCollapsedChange,
}: {
  children: ReactNode;
  collapseLabel: string;
  collapsed: boolean;
  collapsedAccessory?: ReactNode;
  collapsedContent: ReactNode;
  collapsedLabel: string;
  collapsedPreviewKind?: string;
  getViewport?: () => HTMLDivElement | null;
  onCollapsedChange(collapsed: boolean): void;
}) {
  const flowReserverRef = useRef<HTMLDivElement>(null);
  const originMarkerRef = useRef<HTMLSpanElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const threadScrollViewport = useThreadScrollViewportContext();
  const expand = () => onCollapsedChange(false);
  const handleCollapsedKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    if (isInteractiveTarget(event.currentTarget, event.target)) return;
    event.preventDefault();
    expand();
  };
  const collapseControlLabel = collapsed ? collapsedLabel : collapseLabel;

  useEffect(() => {
    const flowReserver = flowReserverRef.current;
    const originMarker = originMarkerRef.current;
    const shell = shellRef.current;
    const viewport = getViewport ? getViewport() : threadScrollViewport.getViewport();
    if (!flowReserver || !originMarker || !shell || !viewport) return;

    const syncFlowReserver = () => {
      const shellStyle = getComputedStyle(shell);
      const marginBlockEnd = Number.parseFloat(shellStyle.marginBottom);
      const shellRect = shell.getBoundingClientRect();
      const stuck = shellRect.bottom + marginBlockEnd
        < flowReserver.getBoundingClientRect().bottom - 0.5;
      const stuckValue = stuck ? "true" : "false";
      if (shell.dataset.stickyComposerStuck !== stuckValue) {
        shell.dataset.stickyComposerStuck = stuckValue;
      }
      if (stuck) return;
      const marginBlockStart = Number.parseFloat(shellStyle.marginTop);
      flowReserver.style.height = `${shellRect.height + marginBlockStart + marginBlockEnd}px`;
    };
    syncFlowReserver();

    // The marker wakes geometry reconciliation when the natural composer row crosses the viewport.
    const intersectionObserver = new IntersectionObserver(syncFlowReserver, {
      root: viewport,
      threshold: 0,
    });
    const resizeObserver = new ResizeObserver(syncFlowReserver);
    intersectionObserver.observe(originMarker);
    resizeObserver.observe(shell);
    viewport.addEventListener("scroll", syncFlowReserver, { passive: true });
    return () => {
      intersectionObserver.disconnect();
      resizeObserver.disconnect();
      viewport.removeEventListener("scroll", syncFlowReserver);
      flowReserver.style.height = "";
      delete shell.dataset.stickyComposerStuck;
    };
  }, [getViewport, threadScrollViewport]);

  return (
    <>
      <div ref={shellRef} className="sticky-composer-shell">
        <div
          className="sticky-composer-surface"
          data-collapsed={collapsed ? "true" : "false"}
        >
          <div className="sticky-composer-expanded">
            <div className="sticky-composer-collapse-button-slot">
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
            className="sticky-composer-collapsed"
            onClick={(event) => {
              if (!isInteractiveTarget(event.currentTarget, event.target)) expand();
            }}
            onKeyDown={handleCollapsedKeyDown}
            role="button"
            tabIndex={0}
          >
            <span className="sticky-composer-collapsed-chevron" aria-hidden="true">
              <ChevronIcon className="rotate-180" size={16} />
            </span>
            <span className="sticky-composer-collapsed-text" data-preview-kind={collapsedPreviewKind}>
              {collapsedContent}
            </span>
            {collapsedAccessory ? <span className="sticky-composer-collapsed-accessory">{collapsedAccessory}</span> : null}
          </div>
        </div>
      </div>
      <div
        ref={flowReserverRef}
        aria-hidden="true"
        className="sticky-composer-flow-reserver"
      >
        <span
          ref={originMarkerRef}
          className="sticky-composer-origin-marker"
        />
      </div>
    </>
  );
}
