/*
 * Exports:
 * - default WorkbenchRotatorButton: render the shared pill control for click-to-next choices. Keywords: control, rotator, button, pill.
 */
"use client";

import type { ReactNode } from "react";

export default function WorkbenchRotatorButton({
  ariaLabel,
  children,
  disabled = false,
  onRotate,
  title,
}: {
  ariaLabel: string;
  children: ReactNode;
  disabled?: boolean;
  onRotate: () => void;
  title?: string;
}) {
  return (
    <button
      aria-label={ariaLabel}
      className="inline-flex min-w-28 max-w-48 shrink-0 items-center justify-center gap-2 rounded-full border border-[color-mix(in_srgb,var(--text)_10%,transparent)] px-3 py-1.5 font-semibold text-text transition hover:border-[color-mix(in_srgb,var(--text)_18%,transparent)] hover:bg-[color-mix(in_srgb,var(--text)_5%,transparent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft disabled:cursor-wait disabled:opacity-60"
      disabled={disabled}
      onClick={onRotate}
      title={title}
      type="button"
    >
      {children}
    </button>
  );
}
