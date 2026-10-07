"use client";

/*
 * Exports:
 * - default WorkbenchStickyCard: the glassy bordered card for sticky action bars; it rises in when opened and, when closed,
 *   keeps showing its last open content while it sinks away.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type TransitionEvent } from "react";

function prefersReducedMotion() {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

export default function WorkbenchStickyCard({ children, className = "", label, open }: {
  children: ReactNode;
  /** Positions the sticky host, such as `sticky bottom-0 z-20`. */
  className?: string;
  label?: string;
  open: boolean;
}) {
  const retained = useRef(children);
  const wasOpen = useRef(open);
  const [exiting, setExiting] = useState(false);

  // Content captured while open is what a closing card keeps showing, so it never flashes empty on its way out.
  useLayoutEffect(() => {
    if (open) retained.current = children;
  });

  useEffect(() => {
    if (open) setExiting(false);
    else if (wasOpen.current && !prefersReducedMotion()) setExiting(true);
    wasOpen.current = open;
  }, [open]);

  if (!open && !exiting) return null;
  const finishExit = (event: TransitionEvent<HTMLElement>) => {
    if (!open && event.target === event.currentTarget && event.propertyName === "opacity") setExiting(false);
  };
  return (
    <section
      aria-hidden={open ? undefined : true}
      aria-label={label}
      className={`
        transition-[opacity,translate] duration-200 ease-out motion-reduce:transition-none
        ${open ? "translate-y-0 opacity-100 starting:(translate-y-2 opacity-0)" : "pointer-events-none translate-y-2 opacity-0"}
        ${className}
      `}
      onTransitionEnd={finishExit}
    >
      <div className="rounded-[1.15rem] border border-[color-mix(in srgb, var(--text) 20%, transparent)] bg-[color: color-mix(in srgb, var(--text) 4%, var(--app-bg-solid))] [--fg-bg: color-mix(in srgb, var(--text) 4%, var(--app-bg-solid))] p-2.5 backdrop-blur-md">
        {open ? children : retained.current}
      </div>
    </section>
  );
}
