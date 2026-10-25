/*
 * Exports:
 * - default PrimaryButton: high-emphasis actions with optional pending halos, hold confirmation (its own press, or a hold
 *   held elsewhere) and joined segments.
 * - PrimaryButton.className/PrimaryButton.Face: the same look for a button another control owns, such as a menu trigger.
 */
"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";

import WorkbenchSpinningBorder from "../workbench/WorkbenchSpinningBorder";
import HoldConfirmationRail from "./HoldConfirmationRail";
import useHoldToConfirm, { holdProgressStyle } from "./use-hold-to-confirm";

type PrimaryButtonShape = "pill" | "circle" | "compact";
type PrimaryButtonTone = "attention" | "danger" | "default";

type PrimaryButtonSegment = "start" | "middle" | "end";

type PrimaryButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  children: ReactNode;
  /** A hold confirming this action from elsewhere, such as a held Enter key; its fill shows on this button. */
  externalHold?: { holding: boolean; durationMs: number };
  holdToConfirmMs?: number;
  pendingHalo?: boolean;
  /** Joins buttons into one pill: joined edges go square and flush, with a hairline before each middle or end segment. */
  segment?: PrimaryButtonSegment;
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
  [--primary-button-rest: color-mix(in srgb, white 14%, var(--app-bg-solid) 86%)]
  [--primary-button-hover: color-mix(in srgb, var(--text) 8%, var(--primary-button-rest))]
  [--primary-button-bg: var(--primary-button-rest)]
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
  default: "enabled:hover:[--primary-button-bg:var(--primary-button-hover)]",
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

// The fill's flush side uses the same selector callers inset the fill with, so it wins and the halves meet without a gap.
const segmentHairline = `
  after:(pointer-events-none absolute inset-y-[9px] left-0 z-20 w-px content-[''])
  after:bg-[color-mix(in_srgb,var(--text)_16%,transparent)]
`;
const segmentClassNames: Record<PrimaryButtonSegment, string> = {
  start: "!rounded-r-none !pr-2 [&>span:first-of-type]:(!rounded-r-none !right-0)",
  middle: `!rounded-none !px-2 [&>span:first-of-type]:(!rounded-none !left-0 !right-0) ${segmentHairline}`,
  end: `!rounded-l-none !pl-2 [&>span:first-of-type]:(!rounded-l-none !left-0) ${segmentHairline}`,
};

function primaryButtonClassName (shape: PrimaryButtonShape = "pill", tone: PrimaryButtonTone = "default", pendingHalo = false) {
  return joinClasses(
    baseClassName,
    shapeClassNames[shape],
    toneClassNames[tone],
    pendingHalo ? "disabled:text-fg/32" : "disabled:text-fg/10",
  );
}

function PrimaryButtonFace ({ children, disabled = false, pendingHalo = false, rail }: {
  children: ReactNode;
  disabled?: boolean;
  pendingHalo?: boolean;
  rail?: ReactNode;
}) {
  return <>
    {pendingHalo ? <WorkbenchSpinningBorder radius="50cqb" /> : null}
    <span
      aria-hidden="true"
      className={joinClasses(
        "pointer-events-none absolute z-10 rounded-full transition-[inset,background-color] duration-150",
        disabled
          ? "bg-transparent ring-1 ring-inset ring-[color:color-mix(in_srgb,var(--text)_10%,transparent)]"
          : "bg-[color:var(--primary-button-bg)]",
        pendingHalo ? "inset-[3px]" : "inset-0",
      )}
    >
      {rail}
    </span>
    <span className="relative z-20 inline-flex items-center justify-center">{children}</span>
  </>;
}

function PrimaryButton ({
  children,
  className,
  disabled,
  externalHold,
  holdToConfirmMs,
  onBlur,
  onClick,
  onKeyDown,
  onKeyUp,
  onPointerCancel,
  onPointerDown,
  onPointerUp,
  pendingHalo = false,
  segment,
  shape = "pill",
  tone = "default",
  type = "button",
  ...buttonProps
}: PrimaryButtonProps) {
  const isDisabled = Boolean(disabled);
  const hold = useHoldToConfirm(holdToConfirmMs, isDisabled);
  const rail = hold.enabled
    ? <HoldConfirmationRail holding={hold.holding !== null} progress={hold.progressProps} />
    : externalHold
      ? <HoldConfirmationRail holding={externalHold.holding} progress={{ style: holdProgressStyle(externalHold.holding, externalHold.durationMs) }} />
      : null;

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
        primaryButtonClassName(shape, tone, pendingHalo),
        hold.enabled && "touch-none select-none [-webkit-touch-callout:none]",
        rail && "hold-filled:![color:var(--app-bg-solid)] hold-filled:duration-200 hold-filled:ease-hold",
        className,
        segment && segmentClassNames[segment],
      )}
    >
      <PrimaryButtonFace disabled={isDisabled} pendingHalo={pendingHalo} rail={rail}>{children}</PrimaryButtonFace>
    </button>
  );
}

namespace PrimaryButton {
  /** Classes giving another control's `<button>` this look; pair with `Face` as its content. */
  export const className = primaryButtonClassName;
  export const Face = PrimaryButtonFace;
}

export default PrimaryButton;
