/*
 * Default export:
 * - WorkbenchTextField: shared single-line input matching the InputList surface for settings and forms.
 */
"use client";
import type { ComponentPropsWithRef } from "react";

export default function WorkbenchTextField({ className = "", ...props }: ComponentPropsWithRef<"input">) {
  return <input {...props} className={`
    h-10 min-w-0 rounded-[0.8rem] border border-text/16 bg-text/[0.03] px-3 text-[0.85rem] text-text outline-none transition
    placeholder:text-fg/muted/60 hover:border-text/22 focus:border-text/22 focus:bg-text/[0.07]
    aria-[invalid=true]:border-danger/50
    disabled:cursor-not-allowed disabled:opacity-50
    ${className}
  `} />;
}
