/*
 * Exports:
 * - default WorkbenchIconButton: circular action or link with shared border, focus, pressed and invalid styling.
 */
"use client";

import type { ComponentPropsWithRef } from "react";

type WorkbenchIconButtonProps = {
  label: string;
  size?: "compact" | "small" | "medium";
  tone?: "default" | "danger";
  display?: "bordered" | "hover-border";
} & (
  | (Omit<ComponentPropsWithRef<"button">, "aria-label"> & { as?: "button" })
  | (Omit<ComponentPropsWithRef<"a">, "aria-label"> & { as: "a" })
);

export default function WorkbenchIconButton({
  label, size = "medium", tone = "default", display = "bordered", className = "", title = label, ...props
}: WorkbenchIconButtonProps) {
  const classes = `
      inline-flex shrink-0 items-center justify-center rounded-full border bg-transparent text-fg/muted transition enabled:cursor-pointer
      [&:not(:disabled)]:hover:border-[color-mix(in_srgb,var(--text)_18%,transparent)] [&:not(:disabled)]:hover:bg-[color-mix(in_srgb,var(--text)_5%,transparent)]
      focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft disabled:cursor-not-allowed disabled:opacity-45
      aria-pressed:text-text data-[thread-codeblock-toggle-state=active]:text-text
      data-[invalid=true]:bg-[color-mix(in_srgb,var(--danger)_14%,transparent)] data-[invalid=true]:text-danger
      data-[invalid=true]:hover:bg-[color-mix(in_srgb,var(--danger)_18%,transparent)] data-[invalid=true]:focus-visible:bg-[color-mix(in_srgb,var(--danger)_18%,transparent)]
      [&[data-invalid=true]_.save-icon-slash]:opacity-100 [&[data-invalid=true]_.save-icon-main]:opacity-45
      ${display === "hover-border" ? "border-transparent" : "border-[color-mix(in_srgb,var(--text)_10%,transparent)]"}
      ${size === "compact" ? "size-6" : size === "small" ? "size-8" : "size-9"}
      ${tone === "danger" ? "[&:not(:disabled)]:hover:text-danger" : "[&:not(:disabled)]:hover:text-text"}
      ${className}
    `;
  if (props.as === "a") {
    const { as, ...linkProps } = props;
    return <a {...linkProps} aria-label={label} title={title} className={classes} />;
  }
  const { as, type = "button", ...buttonProps } = props;
  return <button {...buttonProps} type={type} aria-label={label} title={title} className={classes} />;
}
