/*
 * Exports:
 * - default WorkbenchMenuSurface: shared translucent menu frame; callers own placement and lifecycle.
 */
"use client";

import type { ComponentPropsWithRef } from "react";

export default function WorkbenchMenuSurface({ className = "", ...props }: ComponentPropsWithRef<"div">) {
  return <div
    role="menu"
    {...props}
    className={`fixed z-[51] rounded-2xl bg-[color-mix(in_srgb,var(--bg)_90%,transparent)] p-1 text-sm shadow-float backdrop-blur-xl ${className}`}
  />;
}
