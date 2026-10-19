/*
 * Exports:
 * - default SidebarLoadingSkeleton: animated placeholder rows for loading sidebar sections.
 */
"use client";

export default function SidebarLoadingSkeleton({ ariaLabel, rows }: { ariaLabel: string; rows: number }) {
  return (
    <div aria-label={ariaLabel} aria-live="polite" role="status" className="space-y-1 py-1 pr-2 md:pr-4.5">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex h-7 min-w-0 items-center gap-2 px-2">
          <span className="size-4 shrink-0 rounded-full workbench-skeleton" aria-hidden="true" />
          <span
            className="h-3.5 rounded-full workbench-skeleton"
            style={{ width: `${Math.max(42, 86 - index * 7)}%` }}
            aria-hidden="true"
          />
        </div>
      ))}
    </div>
  );
}
