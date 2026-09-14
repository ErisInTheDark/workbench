/*
 * Exports:
 * - WorkbenchCheckboxMarker: render the shared square checked or unchecked Workbench marker. Keywords: checkbox, marker, checked, workbench.
 * - default WorkbenchCheckbox: render a controlled native checkbox with Workbench presentation. Keywords: checkbox, input, accessibility, workbench.
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
}: {
  checked: boolean;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <span
      aria-hidden="true"
      className={joinClasses(
        "inline-flex size-4 shrink-0 items-center justify-center rounded-[0.28rem] border transition",
        checked
          ? "border-[color-mix(in_srgb,var(--text)_40%,transparent)] bg-[color-mix(in_srgb,var(--text)_86%,var(--bg)_14%)]"
          : "border-[color-mix(in_srgb,var(--text)_22%,transparent)] bg-transparent",
        disabled && "opacity-45",
        className,
      )}
    >
    </span>
  );
}

export default function WorkbenchCheckbox({
  checked,
  className,
  disabled = false,
  label,
  onChange,
}: {
  checked: boolean;
  className?: string;
  disabled?: boolean;
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
        className="peer sr-only"
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        type="checkbox"
      />
      <WorkbenchCheckboxMarker
        checked={checked}
        disabled={disabled}
        className="peer-focus-visible:ring-2 peer-focus-visible:ring-accent-soft"
      />
      <span className="font-medium leading-[1.5]">{label}</span>
    </label>
  );
}
