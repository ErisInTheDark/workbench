/*
 * Default export:
 * - WorkbenchTextField: shared boxed input treatment for editable settings.
 */
"use client";
import type { ComponentPropsWithRef } from "react";

export default function WorkbenchTextField({ className = "", ...props }: ComponentPropsWithRef<"input">) {
  return <input {...props} className={`h-10 min-w-0 rounded-xl border border-[color-mix(in_srgb,var(--text)_10%,transparent)] bg-transparent px-3 font-mono text-[0.9rem] text-text outline-none transition focus:border-[color-mix(in_srgb,var(--text)_22%,transparent)] focus:ring-2 focus:ring-accent-soft disabled:cursor-not-allowed disabled:opacity-50 ${className}`} />;
}
