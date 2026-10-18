/*
 * Exports:
 * - default SurfacePanels: one grid cell stacking crossfading panels; its height glides to the active panel, and a null key closes it.
 * - SurfacePanels.Panel: one stacked panel; inactive panels leave flow, fade out on the short exit timing and become inert.
 */
"use client";

import { useEffect, useRef, type HTMLAttributes, type ReactNode } from "react";

import useHeightTransition from "./use-height-transition";

const panelsClassName = `
  relative hidden
  transition-[height,display] transition-discrete duration-surface ease-surface
  data-[open=true]:grid
  motion-reduce:transition-none
`;

const panelClassName = `
  hidden absolute inset-0 col-start-1 row-start-1 min-w-0 overflow-clip
  opacity-0 translate-y-[0.45rem] scale-[0.985]
  transition-[opacity,translate,scale,display] transition-discrete duration-surface-exit ease-surface
  data-[active=true]:(block relative inset-auto opacity-100 translate-y-0 scale-100 duration-surface)
  starting:data-[active=true]:(opacity-0 translate-y-[0.45rem] scale-[0.985])
  motion-reduce:(animate-none transition-none)
`;

type DivProps = Omit<HTMLAttributes<HTMLDivElement>, "children" | "className">;

function SurfacePanels({ activeKey, children, className = "", onClosed, ...props }: DivProps & {
  /** The active panel's key; null closes the whole surface. */
  activeKey: string | null;
  children: ReactNode;
  className?: string;
  /** Runs once closing has finished animating, so content can unmount without cutting its exit short. */
  onClosed?: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const open = activeKey !== null;
  const onClosedRef = useRef(onClosed);
  onClosedRef.current = onClosed;
  useHeightTransition(ref, activeKey ?? "");
  useEffect(() => {
    const element = ref.current;
    if (open || !element) return;
    let reopened = false;
    void Promise.allSettled(element.getAnimations({ subtree: true }).map(({ finished }) => finished)).then(() => {
      if (!reopened) onClosedRef.current?.();
    });
    return () => { reopened = true; };
  }, [open]);
  return (
    <div {...props} className={`${panelsClassName} ${className}`} data-open={open ? "true" : "false"} ref={ref}>
      {children}
    </div>
  );
}

namespace SurfacePanels {
  export function Panel({ active, children, className = "", ...props }: DivProps & {
    active: boolean;
    children: ReactNode;
    className?: string;
  }) {
    return (
      <div
        {...props}
        aria-hidden={!active}
        className={`${panelClassName} ${className}`}
        data-active={active ? "true" : "false"}
        inert={!active}
      >
        {children}
      </div>
    );
  }
}

export default SurfacePanels;
