"use client";

/*
 * Exports:
 * - StatsBarSeries: one stacked category with its colour and per-bucket values.
 * - default WorkbenchStatsBarChart: stacked, pointer- and keyboard-inspectable bucket bars with a live readout and optional bucket picking.
 */
import { useEffect, useState, type KeyboardEvent, type ReactNode } from "react";

export interface StatsBarSeries {
  key: string;
  label: string;
  fillClassName: string;
  textClassName: string;
  icon?: ReactNode;
  values: readonly number[];
}

export default function WorkbenchStatsBarChart({ buckets, formatBucket, formatValue, label, onPick, picked = null, series, total }: {
  buckets: readonly number[];
  formatBucket: (startedAt: number) => string;
  formatValue: (value: number) => string;
  label: string;
  /** Clicking or pressing Enter on a bucket picks it; shift extends the pick. */
  onPick?: (index: number, extend: boolean) => void;
  /** Inclusive bucket indexes to highlight. */
  picked?: { first: number; last: number } | null;
  series: readonly StatsBarSeries[];
  /** Overrides the stacked sum shown in the readout, such as a cost total that includes hidden categories. */
  total?: readonly number[];
}) {
  const [inspected, setInspected] = useState<number | null>(null);
  const totals = buckets.map((_, index) => series.reduce((sum, entry) => sum + (entry.values[index] ?? 0), 0));
  const maximum = Math.max(0, ...totals) || 1;
  const latest = Math.max(0, buckets.length - 1);
  const selected = inspected ?? latest;
  const empty = totals.every((value) => value === 0);

  useEffect(() => {
    setInspected((current) => current === null ? null : Math.min(current, latest));
  }, [latest]);

  const isPicked = (index: number) => picked !== null && index >= picked.first && index <= picked.last;
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    if (onPick && buckets.length && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      onPick(selected, event.shiftKey);
      return;
    }
    const next = { ArrowLeft: selected - 1, ArrowRight: selected + 1, Home: 0, End: latest }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    setInspected(Math.min(latest, Math.max(0, next)));
  };

  return (
    <figure className="m-0 min-w-0 space-y-3">
      <div
        aria-label={`${label}. Use left and right arrow keys to inspect each period${onPick ? ", Enter to pick it, and Shift+Enter to extend the pick" : ""}.`}
        className="relative rounded-md outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
        onKeyDown={move}
        onPointerLeave={() => setInspected(null)}
        role="group"
        tabIndex={0}
      >
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 flex flex-col justify-between">
          {[0, 1, 2].map((line) => <div className="border-t border-dashed border-fg/8" key={line} />)}
        </div>
        <div aria-hidden="true" className="relative flex h-48 items-end gap-[3px] sm:gap-1">
          {buckets.map((startedAt, index) => {
            const height = totals[index]! / maximum * 100;
            // A pick outranks hover dimming, so the chosen days stay readable while inspecting others.
            const dimmed = picked ? !isPicked(index) && index !== inspected : inspected !== null && index !== selected;
            return (
              <div
                className={`
                  relative flex h-full min-w-0 flex-1 items-end
                  ${onPick ? "cursor-pointer" : "cursor-crosshair"}
                `}
                key={startedAt}
                onClick={onPick ? (event) => onPick(index, event.shiftKey) : undefined}
                onPointerEnter={() => setInspected(index)}
                onPointerDown={(event) => {
                  setInspected(index);
                  // Shift-clicking would otherwise select the page text between the two bars.
                  if (event.shiftKey) event.preventDefault();
                }}
              >
                {isPicked(index) ? <div className="absolute inset-x-0 -bottom-1.5 h-0.5 rounded-full bg-text/60" /> : null}
                <div
                  className={`
                    flex w-full flex-col-reverse overflow-hidden rounded-t-[3px] transition-opacity duration-150
                    motion-reduce:transition-none
                    ${dimmed ? picked ? "opacity-30" : "opacity-45" : ""}
                    ${totals[index] ? "" : "bg-fg/8"}
                  `}
                  style={{ height: totals[index] ? `max(${height}%, 2px)` : "2px" }}
                >
                  {series.map((entry) => entry.values[index] ? (
                    <div className={`${entry.fillClassName} min-h-px`} key={entry.key} style={{ flexGrow: entry.values[index] }} />
                  ) : null)}
                </div>
              </div>
            );
          })}
        </div>
        {empty ? (
          <p className="absolute inset-0 m-0 flex items-center justify-center text-[0.8rem] text-fg/muted">No usage in this period</p>
        ) : null}
      </div>
      {buckets.length ? (
        <div aria-hidden="true" className="flex justify-between text-[0.68rem] tabular-nums text-fg/muted">
          <span>{formatBucket(buckets[0]!)}</span>
          <span>{formatBucket(buckets[latest]!)}</span>
        </div>
      ) : null}
      <figcaption className="flex min-h-10 flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-[0.76rem] tabular-nums" aria-live="polite">
        <span className="font-semibold text-text">
          {buckets.length ? formatBucket(buckets[selected]!) : "No samples"}
          <span className="ml-2 font-normal text-fg/muted">{formatValue(total?.[selected] ?? totals[selected] ?? 0)}</span>
        </span>
        <span className="flex flex-wrap gap-x-3 gap-y-1">
          {series.map((entry) => (
            <span className={`inline-flex items-center gap-1 font-semibold ${entry.textClassName}`} key={entry.key}>
              {entry.icon}{entry.label} {formatValue(entry.values[selected] ?? 0)}
            </span>
          ))}
        </span>
      </figcaption>
    </figure>
  );
}
