/*
 * Exports:
 * - default WorkbenchModeRow: render a compact pill row of mutually exclusive Workbench modes.
 */
"use client";

import { useRef, type KeyboardEvent, type ReactNode } from "react";

type WorkbenchModeRowOption<T extends string> = {
  ariaLabel?: string;
  disabled?: boolean;
  icon?: ReactNode;
  label: ReactNode;
  title?: string;
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
    const step = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1, Home: 1, End: -1 }[event.key];
    if (step === undefined) return;
    event.preventDefault();
    // Home and End search inward from their edge; arrows walk from the current option, skipping disabled ones.
    const start = event.key === "Home" ? -1 : event.key === "End" ? options.length : index;
    for (let offset = 1; offset <= options.length; offset += 1) {
      const nextIndex = (start + step * offset + options.length * 2) % options.length;
      const next = options[nextIndex];
      if (!next || next.disabled) continue;
      optionRefs.current[nextIndex]?.focus();
      onChange(next.value);
      return;
    }
  };

  return (
    <div
      aria-label={ariaLabel}
      className="inline-flex max-w-full items-center gap-0.5 rounded-full bg-fg/5 text-fg/muted p-1"
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
            disabled={disabled || option.disabled}
            key={option.value}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => selectFromKeyboard(event, index)}
            ref={(node) => { optionRefs.current[index] = node; }}
            role="radio"
            tabIndex={index === selectedIndex ? 0 : -1}
            title={option.title}
          >
            {option.icon ?? null}
            <span className="truncate">{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
