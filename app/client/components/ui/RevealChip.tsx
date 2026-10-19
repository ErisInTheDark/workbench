/*
 * Exports:
 * - default RevealChip: the quiet pill button that reveals (or hides again) the rest of a shortened list, e.g. "+7 more".
 */
"use client";

import type { ComponentProps } from "react";

export default function RevealChip({ className = "", type = "button", ...button }: ComponentProps<"button">) {
  return (
    <button
      {...button}
      className={`
        inline-flex h-6 shrink-0 cursor-pointer items-center rounded-full px-2 text-[0.74rem] text-fg/muted
        hover:bg-fg/6 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft
        ${className}
      `}
      type={type}
    />
  );
}
