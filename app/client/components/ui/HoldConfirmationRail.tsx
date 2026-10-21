/*
 * Exports:
 * - default HoldConfirmationRail: bottom rail inside a rounded control whose bar fills while a hold-to-confirm press is held.
 */
import type { CSSProperties, TransitionEvent } from "react";

export default function HoldConfirmationRail ({ holding, progress }: {
  holding: boolean;
  /** Fill style (see `holdProgressStyle`) plus any listener that confirms when the fill finishes. */
  progress: { style: CSSProperties; onTransitionEnd?: (event: TransitionEvent<HTMLElement>) => void };
}) {
  return (
    <span
      aria-hidden="true"
      className={`
        pointer-events-none absolute inset-0 z-30 overflow-hidden rounded-[inherit] transition-opacity duration-100
        ${holding ? "opacity-100" : "opacity-0"}
      `}
    >
      <span className="absolute inset-x-0 bottom-0 h-1.5 bg-[color-mix(in_srgb,var(--text)_18%,transparent)]">
        <span className="block h-full origin-left bg-[color:var(--text)] transition-transform" {...progress} />
      </span>
    </span>
  );
}
