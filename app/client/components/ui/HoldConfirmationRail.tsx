/*
 * Exports:
 * - default HoldConfirmationRail: bottom rail behind a rounded control's content whose bar fills while a hold-to-confirm
 *   press is held, then rises to cover the control (marked `data-hold-filled`) until the hold ends.
 */
import { useState, type CSSProperties, type TransitionEvent } from "react";

/**
 * Paints at `-z-10`, so the host must be a stacking context (`isolate` or z-indexed). Hosts may set `--hold-rail-fill`
 * and `--hold-rail-track` to tint it, and restyle their content with the `hold-filled` variant.
 */
export default function HoldConfirmationRail ({ holding, progress }: {
  holding: boolean;
  /** Fill style (see `holdProgressStyle`) plus any listener that confirms when the fill finishes. */
  progress: { style: CSSProperties; onTransitionEnd?: (event: TransitionEvent<HTMLElement>) => void };
}) {
  const [filled, setFilled] = useState(false);
  if (filled && !holding) setFilled(false);

  return (
    <span
      aria-hidden="true"
      data-hold-filled={filled || undefined}
      className={`
        pointer-events-none absolute inset-0 -z-10 overflow-hidden rounded-[inherit] [--corner-shape:round] transition-opacity duration-100
        ${holding ? "opacity-100" : "opacity-0"}
      `}
    >
      <span
        className={`
          absolute inset-x-0 bottom-0
          bg-[color:var(--hold-rail-track,color-mix(in_srgb,var(--text)_18%,transparent))]
          ${filled ? "h-full transition-[height] duration-200 ease-hold" : "h-1.5"}
        `}
      >
        <span
          className="block h-full origin-left bg-[color:var(--hold-rail-fill,var(--text))] transition-transform"
          style={progress.style}
          onTransitionEnd={(event) => {
            if (event.propertyName === "transform" && holding) setFilled(true);
            progress.onTransitionEnd?.(event);
          }}
        />
      </span>
    </span>
  );
}
