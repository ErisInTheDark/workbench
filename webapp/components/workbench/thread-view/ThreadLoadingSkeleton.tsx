/*
 * Exports:
 * - default ThreadLoadingSkeleton: render a full-area placeholder for hydrating thread views. Keywords: workbench, thread, loading, skeleton.
 */
"use client";

function joinClasses(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

export default function ThreadLoadingSkeleton ({
  contained = false,
  showHeader = false,
  statusLabel = "",
  title = "",
}: {
  contained?: boolean;
  showHeader?: boolean;
  statusLabel?: string;
  title?: string;
}) {
  return (
    <div
      aria-label="Loading thread"
      aria-live="polite"
      role="status"
      className={joinClasses(
        "mx-auto flex w-full min-w-0 max-w-[56rem] flex-col justify-end overflow-hidden",
        contained ? "min-h-full pb-8" : "min-h-[calc(100dvh-8rem)] pb-16",
      )}
    >
      <div className="flex min-h-0 flex-1 flex-col justify-end gap-6 py-6">
        {showHeader ? (
          <header className="space-y-2">
            {title ? (
              <p className="m-0 truncate text-base font-semibold leading-tight text-text">{title}</p>
            ) : (
              <div className="h-4 w-48 max-w-[70%] rounded-full workbench-skeleton" aria-hidden="true" />
            )}
            {statusLabel ? (
              <p className="m-0 truncate text-[0.84rem] tracking-[0.02em] text-muted">{statusLabel}</p>
            ) : (
              <div className="h-3 w-24 rounded-full workbench-skeleton" aria-hidden="true" />
            )}
          </header>
        ) : null}

        <div className="space-y-7">
          <section className="space-y-3 border-t border-[color-mix(in_srgb,var(--text)_10%,transparent)] pt-4">
            <div className="h-3 w-28 rounded-full workbench-skeleton" aria-hidden="true" />
            <div className="space-y-2">
              <div className="h-3.5 w-[86%] rounded-full workbench-skeleton" aria-hidden="true" />
              <div className="h-3.5 w-[68%] rounded-full workbench-skeleton" aria-hidden="true" />
              <div className="h-3.5 w-[78%] rounded-full workbench-skeleton" aria-hidden="true" />
            </div>
          </section>

          <section className="ml-auto w-[88%] max-w-[44rem] space-y-3 rounded-[1.35rem] border border-[color-mix(in_srgb,var(--text)_8%,transparent)] px-4 py-3">
            <div className="h-3 w-24 rounded-full workbench-skeleton" aria-hidden="true" />
            <div className="space-y-2">
              <div className="h-3.5 w-[94%] rounded-full workbench-skeleton" aria-hidden="true" />
              <div className="h-3.5 w-[62%] rounded-full workbench-skeleton" aria-hidden="true" />
            </div>
          </section>

          <section className="space-y-3 border-t border-[color-mix(in_srgb,var(--text)_10%,transparent)] pt-4">
            <div className="h-3 w-32 rounded-full workbench-skeleton" aria-hidden="true" />
            <div className="space-y-2">
              <div className="h-3.5 w-[76%] rounded-full workbench-skeleton" aria-hidden="true" />
              <div className="h-3.5 w-[89%] rounded-full workbench-skeleton" aria-hidden="true" />
              <div className="h-3.5 w-[54%] rounded-full workbench-skeleton" aria-hidden="true" />
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
