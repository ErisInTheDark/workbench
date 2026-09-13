/*
 * Exports:
 * - default StickyComposerSurface: render one sticky host with native and coarse-touch stuck-state ownership.
 */
"use client";

import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";

import ChevronIcon from "../ChevronIcon";
import { THREAD_COARSE_POINTER_MEDIA_QUERY } from "./thread-scroll-snap";
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
  onCollapsedChange,
}: {
  children: ReactNode;
  collapseLabel: string;
  collapsed: boolean;
  collapsedAccessory?: ReactNode;
  collapsedContent: ReactNode;
  collapsedLabel: string;
  collapsedPreviewKind?: string;
  onCollapsedChange(collapsed: boolean): void;
}) {
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
    const originMarker = originMarkerRef.current;
    const shell = shellRef.current;
    const viewport = threadScrollViewport.getViewport();
    if (!originMarker || !shell || !viewport
      || !matchMedia(THREAD_COARSE_POINTER_MEDIA_QUERY).matches) return;

    const observer = new IntersectionObserver(([entry]) => {
      if (!entry?.rootBounds) return;
      // The marker stays in normal flow while the sticky shell is constrained.
      shell.dataset.stickyComposerStuck = entry.boundingClientRect.top >= entry.rootBounds.bottom
        ? "true"
        : "false";
    }, { root: viewport, threshold: 0 });
    observer.observe(originMarker);
    return () => {
      observer.disconnect();
      delete shell.dataset.stickyComposerStuck;
    };
  }, [threadScrollViewport]);

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
      <span
        ref={originMarkerRef}
        aria-hidden="true"
        className="sticky-composer-origin-marker"
      />
    </>
  );
}
