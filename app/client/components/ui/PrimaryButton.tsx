/*
 * Exports:
 * - default PrimaryButton: high-emphasis actions with optional pending halos and hold confirmation.
 */
"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";

import WorkbenchSpinningBorder from "../workbench/WorkbenchSpinningBorder";
import HoldConfirmationRail from "./HoldConfirmationRail";
import useHoldToConfirm from "./use-hold-to-confirm";

type PrimaryButtonShape = "pill" | "circle" | "compact";
type PrimaryButtonTone = "attention" | "danger" | "default";

type PrimaryButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  children: ReactNode;
  holdToConfirmMs?: number;
  pendingHalo?: boolean;
  shape?: PrimaryButtonShape;
  tone?: PrimaryButtonTone;
};

function joinClasses (...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

const baseClassName = `
  relative isolate inline-flex enabled:cursor-pointer items-center justify-center
  overflow-visible bg-transparent font-medium [color: var(--text)]
  transition duration-150 ease-out
  focus-visible:(outline-none ring-2 ring-[color: color-mix(in srgb, var(--text) 22%, transparent)])
  disabled:cursor-not-allowed
  [--primary-button-bg: color-mix(in srgb, white 14%, var(--app-bg-solid) 86%)]
  disabled:[--primary-button-bg: color-mix(in srgb, white 7%, var(--app-bg-solid) 93%)]
  [--fg-bg: var(--primary-button-bg)]
`;

const shapeClassNames: Record<PrimaryButtonShape, string> = {
  circle: "size-10 shrink-0 rounded-full",
  compact: "rounded-full px-3 py-1.5 text-[0.76rem]",
  pill: "rounded-full px-4 py-2 text-[0.84rem]",
};

const toneClassNames: Record<PrimaryButtonTone, string> = {
  // Needs the user's attention before it can proceed normally; matches the amber "needs attention" status tone.
  attention: `
    !text-amber-700 dark:!text-amber-300
    [--primary-button-bg: color-mix(in srgb, var(--color-amber-500) 16%, var(--app-bg-solid) 84%)]
    enabled:hover:[--primary-button-bg: color-mix(in srgb, var(--color-amber-500) 28%, var(--app-bg-solid) 72%)]
  `,
  default: "enabled:hover:[--primary-button-bg:var(--color-button-hover)]",
  danger: `
    enabled:hover:(
      [--primary-button-bg: color-mix(in srgb, var(--danger) 48%, var(--app-bg-solid) 52%)]
      [color: var(--text)]
    )
    enabled:focus-visible:(
      [--primary-button-bg: color-mix(in srgb, var(--danger) 48%, var(--app-bg-solid) 52%)]
      [color: var(--text)]
      ring-[color: color-mix(in srgb, var(--danger) 48%, transparent)]
    )
    data-[confirming=true]:(
      [--primary-button-bg: color-mix(in srgb, var(--danger) 72%, var(--app-bg-solid) 28%)]
      [color: var(--text)]
    )
  `,
};

export default function PrimaryButton ({
  children,
  className,
  disabled,
  holdToConfirmMs,
  onBlur,
  onClick,
  onKeyDown,
  onKeyUp,
  onPointerCancel,
  onPointerDown,
  onPointerUp,
  pendingHalo = false,
  shape = "pill",
  tone = "default",
  type = "button",
  ...buttonProps
}: PrimaryButtonProps) {
  const isDisabled = Boolean(disabled);
  const hold = useHoldToConfirm(holdToConfirmMs, isDisabled);

  return (
    <button
      {...buttonProps}
      {...hold.buttonProps({ onBlur, onClick, onKeyDown, onKeyUp, onPointerCancel, onPointerDown, onPointerUp })}
      type={type}
      data-confirming={hold.holding === "keyboard" ? "true" : undefined}
      data-hold-to-confirm-ms={hold.confirmationMs ?? undefined}
      data-tone={tone}
      disabled={disabled}
      className={joinClasses(
        baseClassName,
        shapeClassNames[shape],
        toneClassNames[tone],
        hold.enabled && "touch-none select-none [-webkit-touch-callout:none]",
        pendingHalo
          ? "disabled:text-fg/32"
          : "disabled:text-fg/10",
        className,
      )}
    >
      {pendingHalo ? <WorkbenchSpinningBorder radius="50cqb" /> : null}
      <span
        aria-hidden="true"
        className={joinClasses(
          "pointer-events-none absolute z-10 rounded-full transition-[inset,background-color] duration-150",
          isDisabled
            ? "bg-transparent ring-1 ring-inset ring-[color:color-mix(in_srgb,var(--text)_10%,transparent)]"
            : "bg-[color:var(--primary-button-bg)]",
          pendingHalo ? "inset-[3px]" : "inset-0",
        )}
      />
      <span className="relative z-20 inline-flex items-center justify-center">{children}</span>
      {hold.enabled ? <HoldConfirmationRail holding={hold.holding !== null} progress={hold.progressProps} /> : null}
    </button>
  );
}
