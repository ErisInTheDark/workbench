/*
 * Exports:
 * - default WorkbenchMenuAction: shared compact menu action with pointer and keyboard highlighting.
 */
"use client";

import type { ComponentPropsWithRef } from "react";

export default function WorkbenchMenuAction({
  className = "", highlighted = false, ...props
}: ComponentPropsWithRef<"button"> & { highlighted?: boolean }) {
  return <button
    type="button"
    role="menuitem"
    {...props}
    data-highlighted={highlighted || undefined}
    className={`
      enabled:cursor-pointer flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-fg/muted transition
      hover:bg-accent-soft hover:text-accent focus-visible:bg-accent-soft focus-visible:text-accent focus-visible:outline-none
      data-[highlighted=true]:bg-accent-soft data-[highlighted=true]:text-accent
      disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-fg/muted
      data-[tone=danger]:text-danger data-[tone=danger]:hover:bg-[color-mix(in_srgb,var(--danger)_14%,transparent)] data-[tone=danger]:hover:text-danger
      data-[tone=danger]:focus-visible:bg-[color-mix(in_srgb,var(--danger)_14%,transparent)] data-[tone=danger]:focus-visible:text-danger
      ${className}
    `}
  />;
}
