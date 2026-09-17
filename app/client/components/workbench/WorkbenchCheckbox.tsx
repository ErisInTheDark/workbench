/*
 * Exports:
 * - WorkbenchCheckboxMarker: render checked, unchecked or masked mixed selection.
 * - default WorkbenchCheckbox: render a controlled native checkbox with Workbench presentation.
 */
"use client";

import type { ReactNode } from "react";

function joinClasses (...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

export function WorkbenchCheckboxMarker({
  checked,
  className,
  disabled = false,
  indeterminate = false,
}: {
  checked: boolean;
  className?: string;
  disabled?: boolean;
  indeterminate?: boolean;
}) {
  return (
    <span
      aria-hidden="true"
      className={joinClasses(
        "inline-flex size-4 shrink-0 items-center justify-center rounded-[0.28rem] border transition",
        checked || indeterminate
          ? "border-[color-mix(in_srgb,var(--text)_40%,transparent)] bg-[color-mix(in_srgb,var(--text)_86%,var(--bg)_14%)]"
          : "border-[color-mix(in_srgb,var(--text)_22%,transparent)] bg-transparent",
        disabled && "opacity-45",
        className,
      )}
      style={indeterminate ? {
        clipPath: "polygon(evenodd, 0% 0%, 100% 0%, 100% 100%, 0% 100%, 0% 0%, 25% 44%, 25% 56%, 75% 56%, 75% 44%, 25% 44%, 0% 0%)",
      } : undefined}
    >
    </span>
  );
}

export default function WorkbenchCheckbox({
  checked,
  className,
  disabled = false,
  indeterminate = false,
  label,
  onChange,
}: {
  checked: boolean;
  className?: string;
  disabled?: boolean;
  indeterminate?: boolean;
  label: ReactNode;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className={joinClasses(
      "inline-flex items-center gap-2 rounded-full px-2 py-1 text-[0.78em] text-fg/muted transition",
      disabled
        ? "cursor-not-allowed opacity-55"
        : "cursor-pointer hover:bg-[color-mix(in_srgb,var(--text)_5%,transparent)] hover:text-text",
      className,
    )}>
      <input
        checked={checked}
        aria-checked={indeterminate ? "mixed" : checked}
        ref={element => { if (element) element.indeterminate = indeterminate; }}
        className="peer sr-only"
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        type="checkbox"
      />
      <WorkbenchCheckboxMarker
        checked={checked}
        indeterminate={indeterminate}
        disabled={disabled}
        className="peer-focus-visible:ring-2 peer-focus-visible:ring-accent-soft"
      />
      <span className="font-medium leading-[1.5]">{label}</span>
    </label>
  );
}
