"use client";

/*
 * Exports:
 * - StatsStreamSeries: one stacked category with its colour and per-bucket values.
 * - default WorkbenchStatsStreamChart: stacked, smoothly curved bucket bands that are pointer- and keyboard-inspectable, with a live readout and optional bucket picking.
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { chartPointerIndex, chartSmoothPath, chartX } from "./stats-chart-geometry";

export interface StatsStreamSeries {
  key: string;
  label: string;
  /** Sets the band's colour through currentColor. */
  textClassName: string;
  icon?: ReactNode;
  values: readonly number[];
}

// View-box height; the tallest stack stops short of the top so its line is never clipped.
const HEIGHT = 40;
const TOP = 3;

export default function WorkbenchStatsStreamChart({ buckets, formatBucket, formatValue, label, onPick, picked = null, series, total }: {
  buckets: readonly number[];
  formatBucket: (startedAt: number) => string;
  formatValue: (value: number) => string;
  label: string;
  /** Clicking or pressing Enter on a bucket picks it; shift extends the pick. */
  onPick?: (index: number, extend: boolean) => void;
  /** Inclusive bucket indexes to highlight. */
  picked?: { first: number; last: number } | null;
  series: readonly StatsStreamSeries[];
  /** Overrides the stacked sum shown in the readout, such as a cost total that includes hidden categories. */
  total?: readonly number[];
}) {
  const svg = useRef<SVGSVGElement>(null);
  // Each gradient resolves currentColor where it is defined, so every band needs its own.
  const fade = `stats-stream-${useId().replace(/[^\w-]/gu, "")}`;
  const [inspected, setInspected] = useState<number | null>(null);
  const count = buckets.length;
  const latest = Math.max(0, count - 1);
  const selected = inspected ?? latest;
  // Running sums per bucket: band n spans from the previous band's top to its own.
  const stacks = buckets.map((_, index) => {
    let sum = 0;
    return series.map((entry) => sum += entry.values[index] ?? 0);
  });
  const totals = stacks.map((stack) => stack.at(-1) ?? 0);
  const maximum = Math.max(0, ...totals) || 1;
  const empty = totals.every((value) => value === 0);
  const y = (value: number) => HEIGHT - value / maximum * (HEIGHT - TOP);
  const x = (index: number) => chartX(index, count);
  // A lone bucket spans the width rather than collapsing to a point.
  const columns = count === 1 ? [{ x: 0, index: 0 }, { x: 100, index: 0 }] : buckets.map((_, index) => ({ x: x(index), index }));
  const edge = (band: number) => columns.map(({ x: left, index }) => ({ x: left, y: band < 0 ? HEIGHT : y(stacks[index]![band]!) }));
  const step = count > 1 ? 100 / (count - 1) : 100;
  const pickLeft = picked ? Math.max(0, x(picked.first) - step / 2) : 0;
  const pickRight = picked ? Math.min(100, x(picked.last) + step / 2) : 100;

  useEffect(() => {
    setInspected((current) => current === null ? null : Math.min(current, latest));
  }, [latest]);

  const pointerIndex = (event: { clientX: number; clientY: number }) => chartPointerIndex(event.clientX, event.clientY, svg.current?.getScreenCTM() ?? null, count);
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    if (onPick && count && (event.key === "Enter" || event.key === " ")) {
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
        className={`
          relative h-48 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-accent-soft
          ${onPick ? "cursor-pointer" : "cursor-crosshair"}
        `}
        onClick={onPick ? (event) => {
          const index = pointerIndex(event);
          if (index !== null) onPick(index, event.shiftKey);
        } : undefined}
        onKeyDown={move}
        onPointerDown={(event) => {
          setInspected(pointerIndex(event));
          // Shift-clicking would otherwise select the page text across the chart.
          if (event.shiftKey) event.preventDefault();
        }}
        onPointerLeave={() => setInspected(null)}
        onPointerMove={(event) => setInspected(pointerIndex(event))}
        role="group"
        tabIndex={0}
      >
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 flex flex-col justify-between">
          {[0, 1].map((line) => <div className="border-t border-dashed border-fg/8" key={line} />)}
          <div className="border-t border-fg/10" />
        </div>
        {picked ? (
          <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 rounded-md bg-fg/5" style={{ left: `${pickLeft}%`, width: `${pickRight - pickLeft}%` }}>
            <div className="absolute inset-x-0 -bottom-1.5 h-0.5 rounded-full bg-text/60" />
          </div>
        ) : null}
        <svg
          aria-hidden="true"
          className="absolute inset-0 size-full overflow-visible"
          preserveAspectRatio="none"
          ref={svg}
          // A pick keeps its own bands vivid and fades the rest of the range.
          style={picked ? { maskImage: `linear-gradient(to right, rgb(0 0 0 / 0.35) ${pickLeft}%, #000 ${pickLeft}%, #000 ${pickRight}%, rgb(0 0 0 / 0.35) ${pickRight}%)` } : undefined}
          viewBox={`0 0 100 ${HEIGHT}`}
        >
          {!empty && columns.length ? series.map((entry, band) => {
            const top = edge(band);
            const bottom = edge(band - 1).reverse();
            return (
              <g className={entry.textClassName} key={entry.key}>
                <defs>
                  <linearGradient id={`${fade}-${band}`} x1="0" x2="0" y1="0" y2="1">
                    <stop offset="0" stopColor="currentColor" stopOpacity="0.42" />
                    <stop offset="1" stopColor="currentColor" stopOpacity="0.08" />
                  </linearGradient>
                </defs>
                <path d={`${chartSmoothPath(top)} ${chartSmoothPath(bottom, "L")} Z`} fill={`url(#${fade}-${band})`} />
                <path d={chartSmoothPath(top)} fill="none" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.75" vectorEffect="non-scaling-stroke" />
              </g>
            );
          }) : null}
        </svg>
        {inspected !== null && !empty ? (
          <div aria-hidden="true" className="pointer-events-none absolute inset-y-0" style={{ left: `${x(inspected)}%` }}>
            <div className="absolute inset-y-0 w-px -translate-x-1/2 bg-fg/40" />
            {series.map((entry, band) => entry.values[inspected] ? (
              <span
                className={`absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-current ring-2 ring-canvas ${entry.textClassName}`}
                key={entry.key}
                style={{ top: `${y(stacks[inspected]![band]!) / HEIGHT * 100}%` }}
              />
            ) : null)}
          </div>
        ) : null}
        {empty ? (
          <p className="absolute inset-0 m-0 flex items-center justify-center text-[0.8rem] text-fg/muted">No usage in this period</p>
        ) : null}
      </div>
      {count ? (
        <div aria-hidden="true" className="flex justify-between text-[0.68rem] tabular-nums text-fg/muted">
          <span>{formatBucket(buckets[0]!)}</span>
          <span>{formatBucket(buckets[latest]!)}</span>
        </div>
      ) : null}
      <figcaption className="flex min-h-10 flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-[0.76rem] tabular-nums" aria-live="polite">
        <span className="font-semibold text-text">
          {count ? formatBucket(buckets[selected]!) : "No samples"}
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
