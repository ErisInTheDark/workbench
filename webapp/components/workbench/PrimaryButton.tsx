/*
 * Exports:
 * - default PrimaryButton: render high-emphasis Workbench action buttons with layered backgrounds, disabled states, and optional pending halo support. Keywords: primary, button, action, halo.
 * - Local helpers: class joining and shape-specific button layout classes. Keywords: button, class names, shape.
 */
"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";

import WorkbenchSpinningBorder from "./WorkbenchSpinningBorder";

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
  "relative isolate inline-flex items-center justify-center overflow-visible bg-transparent font-medium [color:var(--text)]",
  "transition duration-150 ease-out",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:color-mix(in_srgb,var(--text)_22%,transparent)]",
  "disabled:cursor-not-allowed disabled:[color:color-mix(in_srgb,var(--text)_10%,transparent)]",
  "[--primary-button-bg:color-mix(in_srgb,white_14%,var(--shell-fade-bg)_86%)]",
  "enabled:hover:[--primary-button-bg:color-mix(in_srgb,white_20%,var(--shell-fade-bg)_80%)]",
  "disabled:[--primary-button-bg:color-mix(in_srgb,white_7%,var(--shell-fade-bg)_93%)]",
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
  const showSpinningBorder = pendingHalo;
  const isDisabled = Boolean(buttonProps.disabled);

  return (
    <button
      {...buttonProps}
      type={type}
      className={joinClasses(
        baseClassName,
        shapeClassNames[shape],
        className,
      )}
    >
      {showSpinningBorder ? <WorkbenchSpinningBorder radius="50cqb" /> : null}
      <span
        aria-hidden="true"
        className={joinClasses(
          "pointer-events-none absolute z-10 rounded-full transition-[inset,background-color] duration-150",
          isDisabled
            ? "bg-transparent ring-1 ring-inset ring-[color:color-mix(in_srgb,var(--text)_10%,transparent)]"
            : "bg-[color:var(--primary-button-bg)]",
          showSpinningBorder ? "inset-[3px]" : "inset-0",
        )}
      />
      <span className="relative z-20 inline-flex items-center justify-center">{children}</span>
    </button>
  );
}
