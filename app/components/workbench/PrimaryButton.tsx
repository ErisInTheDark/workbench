/*
 * Exports:
 * - default PrimaryButton: high-emphasis actions with optional pending halos and hold confirmation.
 */
"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
  type TransitionEvent,
} from "react";

import WorkbenchSpinningBorder from "./WorkbenchSpinningBorder";

type PrimaryButtonShape = "pill" | "circle";
type PrimaryButtonTone = "danger" | "default";
type HoldSource = "keyboard" | "pointer";

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

const baseClassName = [
  "relative isolate inline-flex enabled:cursor-pointer items-center justify-center overflow-visible bg-transparent font-medium [color:var(--text)]",
  "transition duration-150 ease-out",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:color-mix(in_srgb,var(--text)_22%,transparent)]",
  "disabled:cursor-not-allowed",
  "[--primary-button-bg:color-mix(in_srgb,white_14%,var(--shell-fade-bg)_86%)]",
  "disabled:[--primary-button-bg:color-mix(in_srgb,white_7%,var(--shell-fade-bg)_93%)]",
].join(" ");

const shapeClassNames: Record<PrimaryButtonShape, string> = {
  circle: "size-10 shrink-0 rounded-full",
  pill: "rounded-full px-4 py-2 text-[0.84rem]",
};

const toneClassNames: Record<PrimaryButtonTone, string> = {
  default: "enabled:hover:[--primary-button-bg:var(--color-button-hover)]",
  danger: [
    "enabled:hover:[--primary-button-bg:color-mix(in_srgb,var(--danger)_48%,var(--shell-fade-bg)_52%)]",
    "enabled:hover:[color:var(--text)]",
    "enabled:focus-visible:[--primary-button-bg:color-mix(in_srgb,var(--danger)_48%,var(--shell-fade-bg)_52%)]",
    "enabled:focus-visible:[color:var(--text)]",
    "enabled:focus-visible:ring-[color:color-mix(in_srgb,var(--danger)_48%,transparent)]",
    "data-[confirming=true]:[--primary-button-bg:color-mix(in_srgb,var(--danger)_72%,var(--shell-fade-bg)_28%)]",
    "data-[confirming=true]:[color:var(--text)]",
  ].join(" "),
};

function isConfirmationKey (key: string) {
  return key === "Enter" || key === " ";
}

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
  onPointerLeave,
  onPointerUp,
  pendingHalo = false,
  shape = "pill",
  tone = "default",
  type = "button",
  ...buttonProps
}: PrimaryButtonProps) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const confirmedClickRef = useRef(false);
  const holdSourceRef = useRef<HoldSource | null>(null);
  const pointerHoldCompletedRef = useRef(false);
  const [holdSource, setHoldSource] = useState<HoldSource | null>(null);
  const showSpinningBorder = pendingHalo;
  const isDisabled = Boolean(disabled);
  const confirmationMs = typeof holdToConfirmMs === "number" && Number.isFinite(holdToConfirmMs) && holdToConfirmMs > 0
    ? holdToConfirmMs
    : null;
  const confirmationEnabled = confirmationMs !== null;

  const cancelHold = useCallback((source?: HoldSource, preservePointerCompletion = false) => {
    if (source && holdSourceRef.current !== source) return;
    holdSourceRef.current = null;
    if (!preservePointerCompletion) pointerHoldCompletedRef.current = false;
    setHoldSource(null);
  }, []);

  const beginHold = useCallback((source: HoldSource) => {
    if (!confirmationEnabled || isDisabled || holdSourceRef.current) return;
    pointerHoldCompletedRef.current = false;
    holdSourceRef.current = source;
    setHoldSource(source);
  }, [confirmationEnabled, isDisabled]);

  useEffect(() => {
    if (isDisabled) cancelHold();
  }, [cancelHold, isDisabled]);

  useEffect(() => {
    if (holdSource !== "pointer") return;
    const handlePointerUp = (event: PointerEvent) => {
      const button = buttonRef.current;
      if (button && event.composedPath().includes(button)) return;
      cancelHold("pointer");
    };
    const handlePointerCancel = () => cancelHold("pointer");
    window.addEventListener("pointerup", handlePointerUp, true);
    window.addEventListener("pointercancel", handlePointerCancel, true);
    return () => {
      window.removeEventListener("pointerup", handlePointerUp, true);
      window.removeEventListener("pointercancel", handlePointerCancel, true);
    };
  }, [cancelHold, holdSource]);

  useEffect(() => () => {
    holdSourceRef.current = null;
    pointerHoldCompletedRef.current = false;
  }, []);

  function confirmHold (event: TransitionEvent<HTMLSpanElement>) {
    const source = holdSourceRef.current;
    if (event.propertyName !== "transform" || !source) return;
    if (source === "pointer") {
      pointerHoldCompletedRef.current = true;
      return;
    }
    confirmedClickRef.current = true;
    buttonRef.current?.click();
    confirmedClickRef.current = false;
    cancelHold("keyboard");
  }

  return (
    <button
      {...buttonProps}
      ref={buttonRef}
      type={type}
      data-confirming={holdSource === "keyboard" ? "true" : undefined}
      data-hold-to-confirm-ms={confirmationMs ?? undefined}
      data-tone={tone}
      disabled={disabled}
      className={joinClasses(
        baseClassName,
        shapeClassNames[shape],
        toneClassNames[tone],
        pendingHalo
          ? "disabled:[color:color-mix(in_srgb,var(--text)_32%,transparent)]"
          : "disabled:[color:color-mix(in_srgb,var(--text)_10%,transparent)]",
        className,
      )}
      onBlur={(event) => {
        onBlur?.(event);
        cancelHold();
      }}
      onClick={(event) => {
        const pointerConfirmed = pointerHoldCompletedRef.current && event.detail > 0;
        if (!confirmationEnabled || confirmedClickRef.current || pointerConfirmed) {
          confirmedClickRef.current = false;
          pointerHoldCompletedRef.current = false;
          onClick?.(event);
          return;
        }
        event.preventDefault();
        event.stopPropagation();
      }}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (!confirmationEnabled || event.defaultPrevented) return;
        if (event.key === "Escape") {
          cancelHold("keyboard");
          return;
        }
        if (!isConfirmationKey(event.key)) return;
        event.preventDefault();
        if (!event.repeat) beginHold("keyboard");
      }}
      onKeyUp={(event) => {
        onKeyUp?.(event);
        if (!confirmationEnabled) return;
        if (!isConfirmationKey(event.key)) return;
        event.preventDefault();
        cancelHold("keyboard");
      }}
      onPointerCancel={(event) => {
        onPointerCancel?.(event);
        cancelHold("pointer");
      }}
      onPointerDown={(event) => {
        onPointerDown?.(event);
        if (event.defaultPrevented || event.button !== 0 || !event.isPrimary) return;
        beginHold("pointer");
      }}
      onPointerLeave={(event) => {
        onPointerLeave?.(event);
      }}
      onPointerUp={(event) => {
        onPointerUp?.(event);
        cancelHold("pointer", pointerHoldCompletedRef.current);
      }}
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
      {confirmationEnabled ? (
        <span
          aria-hidden="true"
          className={joinClasses(
            "pointer-events-none absolute inset-0 z-30 overflow-hidden rounded-[inherit] transition-opacity duration-100",
            holdSource ? "opacity-100" : "opacity-0",
          )}
          data-primary-button-confirmation-rail="true"
        >
          <span className="absolute inset-x-0 bottom-0 h-1.5 bg-[color-mix(in_srgb,var(--text)_18%,transparent)]">
            <span
              className="block h-full origin-left bg-[color:var(--text)] transition-transform ease-linear"
              data-primary-button-confirmation-progress="true"
              onTransitionEnd={confirmHold}
              style={{
                transform: holdSource ? "scaleX(1)" : "scaleX(0)",
                transitionDuration: holdSource ? `${confirmationMs}ms` : "0ms",
              }}
            />
          </span>
        </span>
      ) : null}
    </button>
  );
}
