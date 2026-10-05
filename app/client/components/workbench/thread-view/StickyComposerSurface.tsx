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
      if (shell.dataset.stickyStuck !== stuckValue) {
        shell.dataset.stickyStuck = stuckValue;
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
      delete shell.dataset.stickyStuck;
    };
  }, [getViewport, threadScrollViewport]);

  return (
    <>
      <div
        ref={shellRef}
        className="sticky bottom-[calc(env(safe-area-inset-bottom,0px)+0.75rem)] z-20 col-start-1 row-start-2 mt-6 min-w-0 shrink-0 self-end rounded-[1.15rem] bg-canvas/80 [--fg-bg:var(--app-bg-solid)] [--sticky-composer-motion-duration:220ms] [--sticky-composer-motion-ease:cubic-bezier(0.16,1,0.3,1)] coarse-touch:bottom-0"
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
      <div
        ref={flowReserverRef}
        aria-hidden="true"
        className="pointer-events-none relative col-start-1 row-start-2 h-0 w-full shrink-0 self-end"
      >
        <span
          ref={originMarkerRef}
          className="absolute bottom-0 h-px w-full"
        />
      </div>
    </>
  );
}
