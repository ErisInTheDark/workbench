/*
 * Exports:
 * - HoldToConfirmHandlers: the button events a hold-to-confirm control composes with its own handlers.
 * - holdProgressStyle: the `transform` style that fills a hold's progress over `holdMs` while holding and empties at once.
 * - default useHoldToConfirm: turn a button's click into a press-and-hold (pointer, Enter or Space) that confirms when its
 *   progress transition finishes; letting go early, leaving focus or Escape cancels.
 */
"use client";

import {
  useCallback, useEffect, useRef, useState,
  type FocusEvent, type KeyboardEvent, type MouseEvent, type PointerEvent as ReactPointerEvent, type TransitionEvent,
} from "react";

type HoldSource = "keyboard" | "pointer";

export interface HoldToConfirmHandlers {
  onBlur?: (event: FocusEvent<HTMLButtonElement>) => void;
  onClick?: (event: MouseEvent<HTMLButtonElement>) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLButtonElement>) => void;
  onKeyUp?: (event: KeyboardEvent<HTMLButtonElement>) => void;
  onPointerCancel?: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onPointerDown?: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onPointerUp?: (event: ReactPointerEvent<HTMLButtonElement>) => void;
}

export function holdProgressStyle(holding: boolean, holdMs: number | null) {
  return {
    transform: holding ? "scaleX(1)" : "scaleX(0)",
    transitionDuration: holding ? `${holdMs ?? 0}ms` : "0ms",
  };
}

function isConfirmationKey(key: string) {
  return key === "Enter" || key === " ";
}

/**
 * `holdMs` null or non-positive leaves clicks untouched. Otherwise `onClick` runs only once a hold completes: keyboard holds
 * confirm as the progress fills, pointer holds when released after it filled, so dragging off the button still cancels.
 */
export default function useHoldToConfirm(holdMs: number | null | undefined, disabled: boolean) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const confirmedClickRef = useRef(false);
  const holdSourceRef = useRef<HoldSource | null>(null);
  const pointerHoldCompletedRef = useRef(false);
  const [holding, setHolding] = useState<HoldSource | null>(null);
  const confirmationMs = typeof holdMs === "number" && Number.isFinite(holdMs) && holdMs > 0 ? holdMs : null;
  const enabled = confirmationMs !== null;

  const cancelHold = useCallback((source?: HoldSource, preservePointerCompletion = false) => {
    if (source && holdSourceRef.current !== source) return;
    holdSourceRef.current = null;
    if (!preservePointerCompletion) pointerHoldCompletedRef.current = false;
    setHolding(null);
  }, []);

  const beginHold = useCallback((source: HoldSource) => {
    if (!enabled || disabled || holdSourceRef.current) return;
    pointerHoldCompletedRef.current = false;
    holdSourceRef.current = source;
    setHolding(source);
  }, [enabled, disabled]);

  useEffect(() => {
    if (disabled) cancelHold();
  }, [cancelHold, disabled]);

  useEffect(() => {
    if (holding !== "pointer") return;
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
  }, [cancelHold, holding]);

  useEffect(() => () => {
    holdSourceRef.current = null;
    pointerHoldCompletedRef.current = false;
  }, []);

  function dispatchConfirmedClick() {
    confirmedClickRef.current = true;
    buttonRef.current?.click();
    confirmedClickRef.current = false;
  }

  function buttonProps(handlers: HoldToConfirmHandlers = {}) {
    return {
      ref: buttonRef,
      onBlur: (event: FocusEvent<HTMLButtonElement>) => {
        handlers.onBlur?.(event);
        cancelHold();
      },
      onClick: (event: MouseEvent<HTMLButtonElement>) => {
        const pointerConfirmed = pointerHoldCompletedRef.current && event.detail > 0;
        if (!enabled || confirmedClickRef.current || pointerConfirmed) {
          confirmedClickRef.current = false;
          pointerHoldCompletedRef.current = false;
          handlers.onClick?.(event);
          return;
        }
        event.preventDefault();
        event.stopPropagation();
      },
      onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => {
        handlers.onKeyDown?.(event);
        if (!enabled || event.defaultPrevented) return;
        if (event.key === "Escape") {
          cancelHold("keyboard");
          return;
        }
        if (!isConfirmationKey(event.key)) return;
        event.preventDefault();
        if (!event.repeat) beginHold("keyboard");
      },
      onKeyUp: (event: KeyboardEvent<HTMLButtonElement>) => {
        handlers.onKeyUp?.(event);
        if (!enabled || !isConfirmationKey(event.key)) return;
        event.preventDefault();
        cancelHold("keyboard");
      },
      onPointerCancel: (event: ReactPointerEvent<HTMLButtonElement>) => {
        handlers.onPointerCancel?.(event);
        cancelHold("pointer");
      },
      onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => {
        handlers.onPointerDown?.(event);
        if (event.defaultPrevented || event.button !== 0 || !event.isPrimary) return;
        beginHold("pointer");
      },
      onPointerUp: (event: ReactPointerEvent<HTMLButtonElement>) => {
        handlers.onPointerUp?.(event);
        const completed = pointerHoldCompletedRef.current;
        cancelHold("pointer");
        if (completed && !event.defaultPrevented) dispatchConfirmedClick();
      },
    };
  }

  /** Spread onto the element whose `transform` transition shows progress; it fills over the hold while `holding`. */
  const progressProps = {
    onTransitionEnd: (event: TransitionEvent<HTMLElement>) => {
      const source = holdSourceRef.current;
      if (event.propertyName !== "transform" || !source) return;
      if (source === "pointer") {
        pointerHoldCompletedRef.current = true;
        return;
      }
      dispatchConfirmedClick();
      cancelHold("keyboard");
    },
    style: holdProgressStyle(holding !== null, confirmationMs),
  };

  return { buttonProps, confirmationMs, enabled, holding, progressProps };
}
