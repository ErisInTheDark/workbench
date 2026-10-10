/*
 * Exports:
 * - default IconButton: circular or multi-glyph pill action or link with shared border, focus, pressed and invalid styling.
 */
"use client";

import type { ComponentPropsWithRef } from "react";
import WorkbenchSpinningBorder from "../workbench/WorkbenchSpinningBorder";

type IconButtonProps = {
  label: string;
  /** A pill holds several glyphs side by side at the circle's height. */
  shape?: "circle" | "pill";
  size?: "compact" | "small" | "medium" | "font";
  tone?: "default" | "danger";
  display?: "bordered" | "hover-border";
  pendingHalo?: boolean;
} & (
  | (Omit<ComponentPropsWithRef<"button">, "aria-label"> & { as?: "button" })
  | (Omit<ComponentPropsWithRef<"a">, "aria-label"> & { as: "a" })
);

export default function IconButton({
  label, shape = "circle", size = "medium", tone = "default", display = "bordered", pendingHalo = false, className = "", title = label, children, ...props
}: IconButtonProps) {
  const sizeClassName = shape === "pill"
    // Each child gets a circle-sized cell, so glyphs sit as far apart as separate buttons would.
    ? `[&>*]:(flex h-full items-center justify-center) ${size === "font" ? "h-[1.75em] [&>*]:min-w-[1.75em]"
      : size === "compact" ? "h-6 [&>*]:min-w-6" : size === "small" ? "h-8 [&>*]:min-w-8" : "h-9 [&>*]:min-w-9"}`
    : size === "font" ? "size-[1.75em]" : size === "compact" ? "size-6" : size === "small" ? "size-8" : "size-9";
  const classes = `
      inline-flex shrink-0 items-center justify-center rounded-full border bg-transparent text-fg/muted transition enabled:cursor-pointer
      ${pendingHalo ? "relative isolate" : ""}
      [&:not(:disabled)]:hover:border-[color-mix(in_srgb,var(--text)_18%,transparent)] [&:not(:disabled)]:hover:bg-[color-mix(in_srgb,var(--text)_5%,transparent)]
      focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft disabled:cursor-not-allowed disabled:opacity-45
      aria-pressed:text-text data-[thread-codeblock-toggle-state=active]:text-text
      data-[invalid=true]:bg-[color-mix(in_srgb,var(--danger)_14%,transparent)] data-[invalid=true]:text-danger
      data-[invalid=true]:hover:bg-[color-mix(in_srgb,var(--danger)_18%,transparent)] data-[invalid=true]:focus-visible:bg-[color-mix(in_srgb,var(--danger)_18%,transparent)]
      [&[data-invalid=true]_.save-icon-slash]:opacity-100 [&[data-invalid=true]_.save-icon-main]:opacity-45
      ${display === "hover-border" ? "border-transparent" : "border-[color-mix(in_srgb,var(--text)_10%,transparent)]"}
      ${sizeClassName}
      ${tone === "danger" ? "[&:not(:disabled)]:hover:text-danger" : "[&:not(:disabled)]:hover:text-text"}
      ${className}
    `;
  const content = <>{pendingHalo ? <WorkbenchSpinningBorder radius="50cqb" /> : null}{children}</>;
  if (props.as === "a") {
    const { as, ...linkProps } = props;
    return <a {...linkProps} aria-label={label} title={title} className={classes}>{content}</a>;
  }
  const { as, type = "button", ...buttonProps } = props;
  return <button {...buttonProps} type={type} aria-label={label} title={title} className={classes}>{content}</button>;
}
