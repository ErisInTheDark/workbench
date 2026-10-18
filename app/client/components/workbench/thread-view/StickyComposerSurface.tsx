/*
 * Exports:
 * - default StickyComposerSurface: own independent composer and optional bottom-ui sticky layers with flow reserves.
 * - StickyComposerSurface.BottomUi: surrounding thread chrome and its existing bottom spacing.
 */
"use client";

import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";

import ChevronIcon from "../ChevronIcon";
import { useThreadScrollViewportContext } from "./thread-scroll-viewport-context";
import useHeightTransition from "./use-height-transition";

function isInteractiveTarget(currentTarget: HTMLElement, target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  const interactiveTarget = target.closest("button,a,input,textarea,select,[contenteditable='true']");
  return Boolean(interactiveTarget && interactiveTarget !== currentTarget);
}

const stickySurfaceClassName = `
  group/composer relative grid rounded-[1.15rem] border border-transparent bg-fg/4 backdrop-blur-[8px] p-3
  transition-[border-color,padding,height] duration-surface ease-surface
  stuck:(content-end border-fg-alpha/20 [animation: sticky-composer-enter var(--transition-duration-surface) var(--ease-surface) both])
  data-[collapsed=true]:stuck:[padding-bottom: calc(0.75rem + min(0.75rem, var(--workbench-safe-area-bottom, 0px)))]
  coarse-touch:stuck:([margin-inline: calc(0px - var(--thread-scroll-inline-padding, 0px))] rounded-b-none)
  motion-reduce:(transition-none stuck:animate-none)
`;

const expandedClassName = `
  grid col-start-1 row-start-1 grid-cols-[0rem minmax(0, 1fr)] gap-y-3 gap-x-0 opacity-100
  transition-[opacity,grid-template-columns,column-gap] transition-discrete duration-surface ease-surface
  stuck:(grid-cols-[2.25rem minmax(0, 1fr)] gap-x-3)
  group-data-[collapsed=true]/composer:stuck:(
    absolute col-start-auto row-start-auto inset-x-3 bottom-3 invisible opacity-0 pointer-events-none
    [transition:
      opacity var(--transition-duration-surface-exit) var(--ease-surface),
      visibility 0s linear var(--transition-duration-surface-exit)
    ]
  )
  motion-reduce:(animate-none transition-none group-data-[collapsed=true]/composer:stuck:transition-none)
`;

const chevronColumnClassName = `
  min-w-0 overflow-clip [overflow-clip-margin: 0.25rem] invisible opacity-0
  [transition:
    opacity var(--transition-duration-surface-exit) var(--ease-surface),
    visibility 0s linear var(--transition-duration-surface-exit)
  ]
  stuck:(visible opacity-100 transition-[opacity] duration-surface ease-surface)
  motion-reduce:transition-none
`;

const collapsedClassName = `
  hidden col-start-1 row-start-1 self-end min-h-[2.8rem] grid-cols-[auto minmax(0, 1fr) auto] items-center gap-3
  text-text text-[0.92em] leading-[1.45] opacity-0 outline-none
  transition-[opacity,display] transition-discrete duration-surface-exit ease-surface
  group-data-[collapsed=true]/composer:stuck:(grid cursor-pointer opacity-100 duration-surface)
  starting:group-data-[collapsed=true]/composer:stuck:opacity-0
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
  const surfaceRef = useRef<HTMLDivElement>(null);
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
  const cancelCollapseHeightTransition = useHeightTransition(surfaceRef, collapsed ? "collapsed" : "expanded");

  // Child layout effects run before the ancestor viewport ref is attached.
  useEffect(() => {
    const flowReserver = flowReserverRef.current;
    const originMarker = originMarkerRef.current;
    const shell = shellRef.current;
    const surface = surfaceRef.current;
    const viewport = getViewport ? getViewport() : threadScrollViewport.getViewport();
    if (!flowReserver || !originMarker || !shell || !surface || !viewport) return;

    // Pinned height observed for a given natural height; predicts where re-pinning would put the shell's top.
    let pinned: { height: number; naturalHeight: number } | null = null;
    const syncFlowReserver = () => {
      const bottom = bottomRef.current;
      const bottomReserve = bottomReserveRef.current;
      const docked = Boolean(bottom
        && viewport.dataset.threadScrollDirection !== "up"
        && viewport.dataset.threadScrollProximity === "near");
      if (bottom) bottom.dataset.docked = String(docked);
      const shellStyle = getComputedStyle(shell);
      const marginBlockStart = Number.parseFloat(shellStyle.marginTop);
      const flowMarginEnd = bottom ? 0 : Number.parseFloat(shellStyle.marginBottom);
      const reserveRect = flowReserver.getBoundingClientRect();
      const naturalTop = reserveRect.top + marginBlockStart;
      const naturalHeight = reserveRect.height - marginBlockStart - flowMarginEnd;
      const viewportBottom = viewport.getBoundingClientRect().bottom;
      const pinLine = viewportBottom - Number.parseFloat(shellStyle.getPropertyValue("--sticky-composer-inset"));
      const pinnedHeight = pinned?.naturalHeight === naturalHeight ? pinned.height : naturalHeight;
      // Hand over at the top edge, so pinned and natural shells meet without a jump. A collapsed bar returns only once its slot is off screen.
      const stuck = !docked && (shell.dataset.stickyStuck === "true"
        ? naturalTop > shell.getBoundingClientRect().top
        : surface.dataset.collapsed === "true"
          ? naturalTop >= viewportBottom
          : naturalTop + pinnedHeight > pinLine);
      // A collapse resize only means something while pinned; finish it before the reserve can measure a mid-flight height.
      if (shell.dataset.stickyStuck !== String(stuck)) cancelCollapseHeightTransition();
      shell.dataset.stickyStuck = String(stuck);
      shell.dataset.stickyNatural = String(!stuck && !docked);
      // Stuck styles cap or collapse the shell, so the reserve measures only the unstuck box.
      const height = shell.getBoundingClientRect().height;
      if (stuck) pinned = { height, naturalHeight };
      else flowReserver.style.height = `${height + marginBlockStart + flowMarginEnd}px`;
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
      delete shell.dataset.stickyNatural;
    };
  }, [cancelCollapseHeightTransition, hasBottomUi, getViewport, threadScrollViewport]);

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
          sticky [bottom:var(--sticky-composer-inset)] z-20 col-start-1 mt-6 min-w-0 shrink-0 self-end rounded-[1.15rem] bg-canvas/80
          [--sticky-composer-inset:calc(env(safe-area-inset-bottom,0px)+0.75rem)] coarse-touch:[--sticky-composer-inset:0px]
          [--fg-bg:var(--app-bg-solid)]
          data-[sticky-natural=true]:(relative [bottom:auto])
          ${bottomUi ? "row-start-1 row-span-2" : "row-start-2"}
        `}
      >
        <div
          ref={surfaceRef}
          className={stickySurfaceClassName}
          data-collapsed={collapsed ? "true" : "false"}
        >
          <div className={expandedClassName}>
            <div className={chevronColumnClassName}>
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
