/*
 * Exports:
 * - default WorkbenchRangeInput: native range with shared track/thumb styling.
 */
"use client";

import type { ComponentPropsWithRef } from "react";

export default function WorkbenchRangeInput({ className = "", variant = "step", ...props }: Omit<ComponentPropsWithRef<"input">, "type"> & { variant?: "step" | "bar" }) {
  const input = <input
    {...props}
    type="range"
    className={`
      relative z-10 cursor-pointer appearance-none bg-transparent focus-visible:outline-none disabled:cursor-not-allowed
      w-full
      [&::-webkit-slider-runnable-track]:rounded-full
      [&::-webkit-slider-thumb]:appearance-none
      [&::-webkit-slider-thumb]:rounded-full
      [&::-webkit-slider-thumb]:transition
      hover:[&::-webkit-slider-thumb]:scale-110
      focus-visible:[&::-webkit-slider-thumb]:scale-110
      focus-visible:[&::-webkit-slider-thumb]:ring-2
      focus-visible:[&::-webkit-slider-thumb]:ring-accent-soft
      [&::-moz-range-track]:rounded-full
      [&::-moz-range-track]:border-0
      [&::-moz-range-thumb]:rounded-full
      [&::-moz-range-thumb]:transition
      hover:[&::-moz-range-thumb]:scale-110
      focus-visible:[&::-moz-range-thumb]:scale-110
      focus-visible:[&::-moz-range-thumb]:ring-2
      focus-visible:[&::-moz-range-thumb]:ring-accent-soft
      ${variant === "bar" ? `
        [&::-webkit-slider-runnable-track]:h-5
        [&::-webkit-slider-runnable-track]:bg-transparent
        [&::-webkit-slider-thumb]:mt-0.5 [&::-webkit-slider-thumb]:size-4
        [&::-webkit-slider-thumb]:border-0 [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:shadow
        [&::-moz-range-track]:h-5
        [&::-moz-range-track]:bg-transparent
        [&::-moz-range-thumb]:size-4
        [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-white [&::-moz-range-thumb]:shadow
      ` : `
        [&::-webkit-slider-runnable-track]:h-[0.28rem] [&::-webkit-slider-thumb]:mt-[-0.36rem]
        [&::-webkit-slider-runnable-track]:bg-[var(--slider-step-color)]
        [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4
        [&::-webkit-slider-thumb]:border [&::-webkit-slider-thumb]:border-[color-mix(in_srgb,var(--text)_28%,transparent)]
        [&::-webkit-slider-thumb]:bg-[color-mix(in_srgb,var(--text)_86%,var(--bg)_14%)]
        [&::-moz-range-track]:h-[0.28rem]
        [&::-moz-range-track]:bg-[var(--slider-step-color)]
        [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:w-4
        [&::-moz-range-thumb]:border [&::-moz-range-thumb]:border-[color-mix(in_srgb,var(--text)_28%,transparent)]
        [&::-moz-range-thumb]:bg-[color-mix(in_srgb,var(--text)_86%,var(--bg)_14%)]
      `}
      ${className}
    `}
  />;
  return variant === "bar" ? <span className="relative inline-flex min-w-0 items-center px-0.5 before:pointer-events-none before:absolute before:inset-x-0 before:top-1/2 before:h-5 before:-translate-y-1/2 before:rounded-full before:bg-[var(--slider-step-color)] before:content-['']">{input}</span> : input;
}
