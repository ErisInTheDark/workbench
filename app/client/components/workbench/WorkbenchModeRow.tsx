/*
 * Exports:
 * - default WorkbenchModeRow: render a compact pill row of mutually exclusive Workbench modes. Keywords: workbench, mode, radio, segmented, pill.
 */
"use client";

import { useRef, type KeyboardEvent, type ReactNode } from "react";

type WorkbenchModeRowOption<T extends string> = {
  ariaLabel: string;
  icon: ReactNode;
  label: ReactNode;
  value: T;
};

export default function WorkbenchModeRow<T extends string>({
  ariaLabel,
  disabled = false,
  onChange,
  options,
  value,
}: {
  ariaLabel: string;
  disabled?: boolean;
  onChange: (value: T) => void;
  options: readonly WorkbenchModeRowOption<T>[];
  value: T;
}) {
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value));
  const selectFromKeyboard = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex: number | null = null;
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") nextIndex = (index - 1 + options.length) % options.length;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") nextIndex = (index + 1) % options.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = options.length - 1;
    if (nextIndex === null || !options[nextIndex]) return;
    event.preventDefault();
    optionRefs.current[nextIndex]?.focus();
    onChange(options[nextIndex].value);
  };

  return (
    <div
      aria-label={ariaLabel}
      className="inline-flex max-w-full items-center gap-0.5 rounded-full bg-[color-mix(in_srgb,var(--text)_5%,transparent)] [--mode-row-fg-bg:color-mix(in_srgb,var(--text)_5%,var(--fg-bg,var(--bg)))] [color:color-mix(in_srgb,var(--text)_var(--muted-strength),var(--mode-row-fg-bg))] p-1"
      role="radiogroup"
    >
      {options.map((option, index) => {
        const selected = option.value === value;
        return (
          <button
            type="button"
            aria-checked={selected}
            aria-label={option.ariaLabel}
            className={`inline-flex min-w-0 items-center gap-1 rounded-full border px-2 py-1 text-[0.78em] font-medium leading-none transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft disabled:cursor-not-allowed disabled:opacity-45 ${selected
              ? "border-[color-mix(in_srgb,var(--text)_22%,transparent)] bg-[color-mix(in_srgb,var(--bg)_82%,transparent)] text-text"
              : "border-transparent hover:bg-[color-mix(in_srgb,var(--text)_4%,transparent)] hover:text-text"}`}
            disabled={disabled}
            key={option.value}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => selectFromKeyboard(event, index)}
            ref={(node) => { optionRefs.current[index] = node; }}
            role="radio"
            tabIndex={index === selectedIndex ? 0 : -1}
          >
            {option.icon}
            <span className="truncate">{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
