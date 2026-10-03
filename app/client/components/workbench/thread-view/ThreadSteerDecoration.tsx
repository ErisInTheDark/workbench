/*
 * Exports:
 * - ThreadSteerState: delivery state a steer bubble shows; null for delivered or ordinary input.
 * - default ThreadSteerDecoration: wrap a message bubble surface in the pending halo or the undelivered glow.
 */
"use client";

import type { ReactNode } from "react";

import WorkbenchSpinningBorder from "../WorkbenchSpinningBorder";

export type ThreadSteerState = "pending" | "unsent" | null;

const surfaceClassName = "bg-[color-mix(in_srgb,var(--text)_6%,transparent)] [--fg-bg:color-mix(in_srgb,var(--text)_6%,var(--app-bg-solid))]";

/** One owner for steer delivery visuals, shared by user steers and incoming agent messages. */
export default function ThreadSteerDecoration({
  children,
  className = "",
  state,
}: {
  children: ReactNode;
  /** Layout classes for the bubble surface. */
  className?: string;
  state: ThreadSteerState;
}) {
  if (state === "pending") {
    return (
      <div className="relative isolate overflow-hidden rounded-[1.4rem]">
        <WorkbenchSpinningBorder radius="1.4rem" />
        <div className={`
          relative z-10 rounded-[1.4rem] border-[3px] border-transparent px-4 py-3 [clip-path:padding-box]
          bg-[color-mix(in_srgb,var(--text)_6%,var(--app-bg-solid))] [--fg-bg:color-mix(in_srgb,var(--text)_6%,var(--app-bg-solid))]
          ${className}
        `}>
          {children}
        </div>
      </div>
    );
  }
  if (state === "unsent") {
    return (
      <div className="relative isolate overflow-hidden rounded-[1.4rem] px-0.5 py-0.5">
        <span
          aria-hidden="true"
          className={`
            pointer-events-none absolute inset-0 -z-20 rounded-[inherit]
            bg-[
              radial-gradient(circle at 22% 18%, color-mix(in srgb, #f97316 38%, transparent), transparent 32%),
              radial-gradient(circle at 82% 72%, color-mix(in srgb, #ef4444 30%, transparent), transparent 34%),
              linear-gradient(135deg, color-mix(in srgb, #f97316 42%, transparent), color-mix(in srgb, #ef4444 30%, transparent))
            ] opacity-[0.46]
          `}
        />
        <span aria-hidden="true" className="pointer-events-none absolute inset-0.5 -z-10 rounded-[inherit] bg-canvas" />
        <div className={`relative z-10 rounded-[1.15rem] px-4 py-3 ${surfaceClassName} ${className}`}>
          {children}
        </div>
      </div>
    );
  }
  return <div className={`rounded-[1.15rem] px-4 py-3 ${surfaceClassName} ${className}`}>{children}</div>;
}
