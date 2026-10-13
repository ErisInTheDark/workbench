/*
 * Exports:
 * - default WorkbenchMenuSurface: shared translucent menu frame and portal-event boundary; callers own placement and lifecycle.
 */
"use client";

import type { ComponentPropsWithRef } from "react";

export default function WorkbenchMenuSurface({
  className = "",
  onClick,
  onContextMenu,
  onKeyDown,
  onKeyUp,
  onPointerDown,
  onPointerUp,
  ...props
}: ComponentPropsWithRef<"div">) {
  return <div
    role="menu"
    {...props}
    onClick={event => {
      event.stopPropagation();
      onClick?.(event);
    }}
    onContextMenu={event => {
      event.stopPropagation();
      onContextMenu?.(event);
    }}
    onKeyDown={event => {
      event.stopPropagation();
      onKeyDown?.(event);
    }}
    onKeyUp={event => {
      event.stopPropagation();
      onKeyUp?.(event);
    }}
    onPointerDown={event => {
      event.stopPropagation();
      onPointerDown?.(event);
    }}
    onPointerUp={event => {
      event.stopPropagation();
      onPointerUp?.(event);
    }}
    className={`fixed z-[51] rounded-2xl bg-[color-mix(in_srgb,var(--bg)_90%,transparent)] [--fg-bg:color-mix(in_srgb,var(--bg)_90%,var(--app-bg-solid))] p-1 text-sm shadow-float backdrop-blur-xl ${className}`}
  />;
}
