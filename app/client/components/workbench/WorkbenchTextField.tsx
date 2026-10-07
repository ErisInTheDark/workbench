/*
 * Default export:
 * - WorkbenchTextField: shared single-line input; `boxed` matches the InputList surface, `flush` sits inside other surfaces behind a left rule.
 */
"use client";
import type { ComponentPropsWithRef } from "react";

const variantClassName = {
  boxed: "h-10 rounded-[0.8rem] border border-text/16 bg-text/[0.03] hover:border-text/22 focus:border-text/22 focus:bg-text/[0.07] aria-[invalid=true]:border-danger/50",
  flush: "h-8 border-l border-[color-mix(in_srgb,var(--text)_10%,transparent)] bg-transparent focus:border-text/22 aria-[invalid=true]:border-danger/50",
};

export default function WorkbenchTextField({ className = "", variant = "boxed", ...props }: ComponentPropsWithRef<"input"> & {
  variant?: keyof typeof variantClassName;
}) {
  return <input {...props} className={`
    min-w-0 px-3 text-[0.85rem] text-text outline-none transition
    placeholder:text-fg/muted/60 disabled:cursor-not-allowed disabled:opacity-50
    ${variantClassName[variant]}
    ${className}
  `} />;
}
