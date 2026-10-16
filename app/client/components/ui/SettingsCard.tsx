/*
 * Exports:
 * - default SettingsCard: bordered group of related settings rows divided by faint rules.
 * - SettingsCardRow: one labelled row with its controls, or a full-width row when unlabelled.
 */
"use client";

import type { ReactNode } from "react";

export default function SettingsCard({ label, children }: { label: string; children: ReactNode }) {
  return <section aria-label={label} className="
    divide-y divide-[color-mix(in_srgb,var(--text)_6%,transparent)] rounded-[0.95rem]
    border border-[color-mix(in_srgb,var(--text)_10%,transparent)] px-3 text-sm
  ">{children}</section>;
}

export function SettingsCardRow({ label, children }: { label?: ReactNode; children: ReactNode }) {
  return <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 py-2.5">
    {label ? <span className="w-full shrink-0 text-fg/muted sm:w-28">{label}</span> : null}
    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">{children}</div>
  </div>;
}
