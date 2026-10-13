/*
 * Exports:
 * - default StickyComposerSurface: own independent composer and optional bottom-ui sticky layers with flow reserves.
 * - StickyComposerSurface.BottomUi: surrounding thread chrome and its existing bottom spacing.
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

const stickySurfaceClassName = `
  group/composer relative grid rounded-[1.15rem] bg-fg/4 backdrop-blur-[8px] p-3
  [transition:
    border-color var(--sticky-composer-motion-duration) var(--sticky-composer-motion-ease),
    padding var(--sticky-composer-motion-duration) var(--sticky-composer-motion-ease)
  ]
  stuck:(border border-fg-alpha/20 [animation: sticky-composer-enter var(--sticky-composer-motion-duration) var(--sticky-composer-motion-ease) both])
  data-[collapsed=true]:stuck:[padding-bottom: calc(0.75rem + min(0.75rem, var(--workbench-safe-area-bottom, 0px)))]
  coarse-touch:stuck:([margin-inline: calc(0px - var(--thread-scroll-inline-padding, 0px))] rounded-b-none)
  motion-reduce:(transition-none stuck:animate-none)
`;

const expandedClassName = `
  grid col-start-1 row-start-1 grid-cols-[minmax(0, 1fr)] gap-3 opacity-100
  transform-[translateY(0) scale(1)]
  [transition:
    opacity var(--sticky-composer-motion-duration) var(--sticky-composer-motion-ease),
    transform var(--sticky-composer-motion-duration) var(--sticky-composer-motion-ease)
  ]
  [transition-behavior: allow-discrete]
  stuck:grid-cols-[auto minmax(0, 1fr)]
  group-data-[collapsed=true]/composer:stuck:(
    absolute inset-3 invisible opacity-0 pointer-events-none
    transform-[translateY(-0.25rem) scale(0.985)]
    [transition:
      opacity var(--sticky-composer-motion-duration) var(--sticky-composer-motion-ease),
      transform var(--sticky-composer-motion-duration) var(--sticky-composer-motion-ease),
      visibility 0s linear var(--sticky-composer-motion-duration)
    ]
  )
  motion-reduce:(animate-none transition-none group-data-[collapsed=true]/composer:stuck:transition-none)
`;

const collapsedClassName = `
  hidden col-start-1 row-start-1 opacity-0 transform-[translateY(0.35rem) scale(0.985)]
  [transition:
    opacity var(--sticky-composer-motion-duration) var(--sticky-composer-motion-ease),
    transform var(--sticky-composer-motion-duration) var(--sticky-composer-motion-ease),
    display var(--sticky-composer-motion-duration) allow-discrete
  ]
  [transition-behavior: allow-discrete]
  group-data-[collapsed=true]/composer:stuck:(
    grid min-h-[2.8rem] grid-cols-[auto minmax(0, 1fr) auto] items-center gap-3
    cursor-pointer text-text text-[0.92em] leading-[1.45] opacity-100 outline-none
    transform-[translateY(0) scale(1)]
  )
  starting:group-data-[collapsed=true]/composer:stuck:(opacity-0 transform-[translateY(0.35rem) scale(0.985)])
  group-data-[collapsed=true]/composer:stuck:focus-visible:(rounded-[0.85rem] [box-shadow: 0 0 0 2px var(--accent-soft)])
  motion-reduce:(animate-none transition-none)
`;

function StickyComposerSurface({
  children,
  collapseLabel,
  collapsed,
  collapsedAccessory,
  collapsedContent,
  collapsedLabel,
  collapsedPreviewKind,
  getViewport,
  onCollapsedChange,
  bottomUi,
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
  bottomUi?: StickyComposerSurface.BottomUi;
}) {
  const flowReserverRef = useRef<HTMLDivElement>(null);
  const originMarkerRef = useRef<HTMLSpanElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const bottomReserveRef = useRef<HTMLDivElement>(null);
  const hasBottomUi = Boolean(bottomUi);
  const threadScrollViewport = useThreadScrollViewportContext();
  const expand = () => onCollapsedChange(false);
  const handleCollapsedKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    if (isInteractiveTarget(event.currentTarget, event.target)) return;
    event.preventDefault();
    expand();
  };
  const collapseControlLabel = collapsed ? collapsedLabel : collapseLabel;

  // Child layout effects run before the ancestor viewport ref is attached.
  useEffect(() => {
    const flowReserver = flowReserverRef.current;
    const originMarker = originMarkerRef.current;
    const shell = shellRef.current;
    const viewport = getViewport ? getViewport() : threadScrollViewport.getViewport();
    if (!flowReserver || !originMarker || !shell || !viewport) return;

    const syncFlowReserver = () => {
      const bottom = bottomRef.current;
      const bottomReserve = bottomReserveRef.current;
      const docked = Boolean(bottom
        && viewport.dataset.threadScrollDirection !== "up"
        && viewport.dataset.threadScrollProximity === "near");
      if (bottom) bottom.dataset.docked = String(docked);
      const shellStyle = getComputedStyle(shell);
      const marginBlockEnd = Number.parseFloat(shellStyle.marginBottom);
      const shellRect = shell.getBoundingClientRect();
      const stuck = !docked && shellRect.bottom + (bottom ? 0 : marginBlockEnd)
        < flowReserver.getBoundingClientRect().bottom - 0.5;
      const stuckValue = stuck ? "true" : "false";
      if (shell.dataset.stickyStuck !== stuckValue) {
        shell.dataset.stickyStuck = stuckValue;
      }
      if (!stuck) {
        const marginBlockStart = Number.parseFloat(shellStyle.marginTop);
        flowReserver.style.height = `${shellRect.height + marginBlockStart + (bottom ? 0 : marginBlockEnd)}px`;
      }
      if (bottom && bottomReserve) {
        const rect = bottom.getBoundingClientRect();
        const footer = rect.bottom - flowReserver.getBoundingClientRect().bottom;
        shell.style.marginBottom = `${footer}px`;
        shell.style.bottom = docked ? `${footer}px` : "";
        bottomReserve.style.height = `calc(${rect.height}px + 1rem)`;
      }
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
    if (bottomRef.current) resizeObserver.observe(bottomRef.current);
    const attributes = new MutationObserver(syncFlowReserver);
    attributes.observe(viewport, { attributes: true, attributeFilter: ["data-thread-scroll-direction", "data-thread-scroll-proximity"] });
    viewport.addEventListener("scroll", syncFlowReserver, { passive: true });
    return () => {
      intersectionObserver.disconnect();
      resizeObserver.disconnect();
      attributes.disconnect();
      viewport.removeEventListener("scroll", syncFlowReserver);
      flowReserver.style.height = "";
      shell.style.marginBottom = "";
      shell.style.bottom = "";
      delete shell.dataset.stickyStuck;
    };
  }, [hasBottomUi, getViewport, threadScrollViewport]);

  const reserve = (
    <div
      ref={flowReserverRef}
      aria-hidden="true"
      className="pointer-events-none relative col-start-1 row-start-2 h-0 w-full shrink-0 self-end"
    >
      <span ref={originMarkerRef} className="absolute bottom-0 h-px w-full" />
    </div>
  );

  return (
    <>
      {bottomUi ? <>
        <div ref={bottomReserveRef} aria-hidden="true" className="pointer-events-none col-start-1 row-start-2" />
        <div
          ref={bottomRef}
          data-thread-bottom-ui="true"
          className={`relative col-start-1 row-start-2 min-w-0 self-end data-[docked=true]:sticky bottom-0 ${bottomUi.paddingClassName}`}
        >
          {bottomUi.before}
          {reserve}
          {bottomUi.after}
        </div>
      </> : null}
      <div
        ref={shellRef}
        className={`
          sticky bottom-[calc(env(safe-area-inset-bottom,0px)+0.75rem)] z-20 col-start-1 mt-6 min-w-0 shrink-0 self-end rounded-[1.15rem] bg-canvas/80
          [--fg-bg:var(--app-bg-solid)] [--sticky-composer-motion-duration:220ms] [--sticky-composer-motion-ease:cubic-bezier(0.16,1,0.3,1)] coarse-touch:bottom-0
          ${bottomUi ? "row-start-1 row-span-2" : "row-start-2"}
        `}
      >
        <div
          className={stickySurfaceClassName}
          data-collapsed={collapsed ? "true" : "false"}
        >
          <div className={expandedClassName}>
            <div className="hidden stuck:block">
              <button
                aria-expanded={!collapsed}
                aria-label={collapseControlLabel}
                className="inline-flex size-9 items-center justify-center rounded-full text-fg/muted transition hover:bg-[color-mix(in srgb, var(--text) 5%, transparent)] hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
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
            className={collapsedClassName}
            onClick={(event) => {
              if (!isInteractiveTarget(event.currentTarget, event.target)) expand();
            }}
            onKeyDown={handleCollapsedKeyDown}
            role="button"
            tabIndex={0}
          >
            <span className="inline-flex w-9 items-center justify-center text-fg/muted" aria-hidden="true">
              <ChevronIcon className="rotate-180" size={16} />
            </span>
            <span className="min-w-0 line-clamp-2 data-[preview-kind=placeholder]:text-fg/muted" data-preview-kind={collapsedPreviewKind}>
              {collapsedContent}
            </span>
            {collapsedAccessory ? <span className="inline-flex shrink-0 flex-nowrap gap-[0.35rem]">{collapsedAccessory}</span> : null}
          </div>
        </div>
      </div>
      {!bottomUi ? reserve : null}
    </>
  );
}

namespace StickyComposerSurface {
  export interface BottomUi {
    before: ReactNode;
    after: ReactNode;
    paddingClassName: string;
  }
}

export default StickyComposerSurface;
