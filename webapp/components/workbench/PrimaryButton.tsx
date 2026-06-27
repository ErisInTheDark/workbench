/*
 * Exports:
 * - default PrimaryButton: render high-emphasis Workbench action buttons with layered backgrounds, disabled states, and optional pending halo support. Keywords: primary, button, action, halo.
 * - Local helpers: class joining and shape-specific button layout classes. Keywords: button, class names, shape.
 */
"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";

type PrimaryButtonShape = "pill" | "circle";

type PrimaryButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  children: ReactNode;
  pendingHalo?: boolean;
  shape?: PrimaryButtonShape;
};

function joinClasses (...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

const baseClassName = [
  "relative isolate inline-flex items-center justify-center overflow-visible bg-transparent font-medium [color:var(--bg)]",
  "transition duration-150 ease-out",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:color-mix(in_srgb,var(--text)_22%,transparent)]",
  "disabled:cursor-not-allowed",
  "[--primary-button-bg:color-mix(in_srgb,var(--text)_92%,var(--bg)_8%)]",
  "enabled:hover:[--primary-button-bg:color-mix(in_srgb,var(--text)_86%,var(--bg)_14%)]",
  "disabled:[--primary-button-bg:color-mix(in_srgb,var(--text)_45%,var(--shell-fade-bg)_55%)]",
  "after:pointer-events-none after:absolute after:inset-0 after:z-[-1] after:rounded-full after:bg-[color:var(--primary-button-bg)] after:transition-colors after:content-['']",
  "[&>*]:relative [&>*]:z-10",
].join(" ");

const shapeClassNames: Record<PrimaryButtonShape, string> = {
  circle: "size-10 shrink-0 rounded-full",
  pill: "rounded-full px-4 py-2 text-[0.84rem]",
};

export default function PrimaryButton ({
  children,
  className,
  pendingHalo = false,
  shape = "pill",
  type = "button",
  ...buttonProps
}: PrimaryButtonProps) {
  return (
    <button
      {...buttonProps}
      type={type}
      className={joinClasses(
        baseClassName,
        shapeClassNames[shape],
        pendingHalo && "thread-pending-control-button-active",
        className,
      )}
    >
      {children}
    </button>
  );
}
