/*
 * Exports:
 * - RotatorOption: one choice a rotator steps through.
 * - default RotatorButton: pill showing the current choice; each click moves to the next, wrapping around.
 */
"use client";

import type { ReactNode } from "react";

export interface RotatorOption<T extends string> {
  icon?: ReactNode;
  label: string;
  value: T;
}

export default function RotatorButton<T extends string>({
  ariaLabel,
  className = "",
  disabled = false,
  onChange,
  options,
  value,
}: {
  /** Names what the choice controls, read before the current option. */
  ariaLabel: string;
  className?: string;
  disabled?: boolean;
  onChange: (value: T) => void;
  options: readonly RotatorOption<T>[];
  value: T;
}) {
  const index = Math.max(0, options.findIndex((option) => option.value === value));
  const current = options[index];
  const next = options[(index + 1) % options.length];
  return (
    <button
      type="button"
      aria-label={`${ariaLabel}: ${current?.label ?? ""}. Click for ${next?.label ?? ""}.`}
      className={`
        inline-flex shrink-0 items-center justify-center gap-2 rounded-full border border-[color-mix(in_srgb,var(--text)_10%,transparent)]
        px-3 py-1.5 font-semibold text-text transition enabled:cursor-pointer
        hover:border-[color-mix(in_srgb,var(--text)_18%,transparent)] hover:bg-[color-mix(in_srgb,var(--text)_5%,transparent)]
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft disabled:cursor-not-allowed disabled:opacity-45
        ${className}
      `}
      disabled={disabled || options.length < 2}
      onClick={() => {
        if (next) onChange(next.value);
      }}
    >
      {current?.icon ?? null}
      <span className="truncate">{current?.label}</span>
    </button>
  );
}
