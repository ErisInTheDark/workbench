/*
 * Exports:
 * - default ThreadPickerGroupMoveButton: render the shared circular up/down group-transfer action. Keywords: picker, group, priority, scope.
 */
"use client";

export default function ThreadPickerGroupMoveButton({ direction, disabled = false, label, onClick }: {
  direction: "down" | "up";
  disabled?: boolean;
  label: string;
  onClick: () => void;
}) {
  return <button type="button" disabled={disabled} aria-label={label} title={label} className="inline-flex size-8 items-center justify-center rounded-full border border-[color-mix(in_srgb,var(--text)_10%,transparent)] text-muted transition hover:border-[color-mix(in_srgb,var(--text)_18%,transparent)] hover:bg-[color-mix(in_srgb,var(--text)_5%,transparent)] hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft disabled:cursor-not-allowed disabled:opacity-40" onClick={(event) => { event.stopPropagation(); onClick(); }}>
    <svg viewBox="0 0 16 16" className="size-4" aria-hidden="true"><path d={direction === "up" ? "M4 9.5L8 5.5L12 9.5" : "M4 6.5L8 10.5L12 6.5"} fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" /></svg>
  </button>;
}
