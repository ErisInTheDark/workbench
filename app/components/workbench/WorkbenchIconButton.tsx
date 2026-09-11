/*
 * Exports:
 * - default WorkbenchIconButton: circular bordered action with shared focus, disabled and danger styling.
 */
"use client";

import type { ComponentPropsWithRef } from "react";

type WorkbenchIconButtonProps = Omit<ComponentPropsWithRef<"button">, "aria-label"> & {
  label: string;
  size?: "small" | "medium";
  tone?: "default" | "danger";
};

export default function WorkbenchIconButton({
  label, size = "medium", tone = "default", className = "", type = "button", title = label, ...props
}: WorkbenchIconButtonProps) {
  return <button
    {...props}
    type={type}
    aria-label={label}
    title={title}
    className={`
      inline-flex shrink-0 items-center justify-center rounded-full border border-[color-mix(in_srgb,var(--text)_10%,transparent)] bg-transparent text-muted transition
      enabled:hover:border-[color-mix(in_srgb,var(--text)_18%,transparent)] enabled:hover:bg-[color-mix(in_srgb,var(--text)_5%,transparent)]
      focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft disabled:cursor-not-allowed disabled:opacity-45
      ${size === "small" ? "size-8" : "size-9"}
      ${tone === "danger" ? "enabled:hover:text-danger" : "enabled:hover:text-text"}
      ${className}
    `}
  />;
}
