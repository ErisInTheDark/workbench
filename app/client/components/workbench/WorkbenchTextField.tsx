/*
 * Default export:
 * - WorkbenchTextField: shared single-line input; `boxed` matches the InputList surface, `flush` sits inside other surfaces behind a left rule, `dotted` reads as inline editable text over a dotted underline.
 */
"use client";
import type { ComponentPropsWithRef } from "react";

const variantClassName = {
  boxed: "h-10 rounded-[0.8rem] border border-text/16 bg-text/[0.03] hover:border-text/22 focus:border-text/22 focus:bg-text/[0.07] aria-[invalid=true]:border-danger/50",
  flush: "h-8 border-l border-[color-mix(in_srgb,var(--text)_10%,transparent)] bg-transparent focus:border-text/22 aria-[invalid=true]:border-danger/50",
  dotted: "h-7 border-b border-dotted border-text/35 bg-transparent px-0.5 hover:border-text/55 focus:border-solid focus:border-text/60 aria-[invalid=true]:border-danger/60",
};

export default function WorkbenchTextField({ className = "", variant = "boxed", ...props }: ComponentPropsWithRef<"input"> & {
  variant?: keyof typeof variantClassName;
}) {
  return <input {...props} className={`
    min-w-0 text-[0.85rem] text-text outline-none transition
    ${variant === "dotted" ? "" : "px-3"}
    placeholder:text-fg/muted/60 disabled:cursor-not-allowed disabled:opacity-50
    ${variantClassName[variant]}
    ${className}
  `} />;
}
