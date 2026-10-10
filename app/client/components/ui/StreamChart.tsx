"use client";

/*
 * Exports:
 * - StatsStreamSeries: one stacked category with its colour and per-bucket values; null marks an unavailable bucket.
 * - default StreamChart: stacked, smoothly curved bucket bands that are pointer- and keyboard-inspectable, with a live readout and optional bucket picking.
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { chartPointerIndex, chartSmoothPath, chartX } from "./chart-geometry";

export interface StatsStreamSeries {
  key: string;
  label: string;
  /** Sets the band's colour through currentColor. */
  textClassName: string;
  icon?: ReactNode;
  /** Null leaves a gap in the band, so a period without samples does not read as zero. */
  values: readonly (number | null)[];
}

// View-box height; the tallest stack stops short of the top so its line is never clipped.
const HEIGHT = 40;
const TOP = 3;

/** Unbroken runs of available buckets for one band. */
function runs(values: readonly (number | null)[], count: number) {
  const result: number[][] = [];
  let current: number[] = [];
  for (let index = 0; index < count; index++) {
    if (values[index] === null || values[index] === undefined) {
      if (current.length) result.push(current);
      current = [];
    } else current.push(index);
  }
  if (current.length) result.push(current);
  return result;
}

export default function StreamChart({
  buckets, className = "h-48", emptyLabel, formatBucket, formatValue, label, maximum: fixedMaximum, minimum = 0, onPick, picked = null, series, total,
}: {
  buckets: readonly number[];
  /** Sizes the plot; defaults to h-48. */
  className?: string;
  /** Shown over the plot when every stack is zero; without it, only a chart with no samples at all reads as empty. */
  emptyLabel?: string;
  formatBucket: (startedAt: number) => string;
  formatValue: (value: number) => string;
  label: string;
  /** Value drawn at the top; defaults to the tallest stack. */
  maximum?: number;
  /** Value drawn on the baseline, so a narrow band such as 97% to 100% fills the height. */
  minimum?: number;
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
  // Running sums per bucket: band n spans from the previous band's top to its own. Gaps stack as nothing.
  const stacks = buckets.map((_, index) => {
    let sum = 0;
    return series.map((entry) => sum += entry.values[index] ?? 0);
  });
  const totals = stacks.map((stack) => stack.at(-1) ?? 0);
  const maximum = fixedMaximum ?? (Math.max(minimum, ...totals) || 1);
  const sampled = series.some(({ values }) => values.some((value) => value !== null));
  const empty = !sampled || (emptyLabel !== undefined && totals.every((value) => value === 0));
  const y = (value: number) => HEIGHT - Math.min(1, Math.max(0, (value - minimum) / (maximum - minimum || 1))) * (HEIGHT - TOP);
  const x = (index: number) => chartX(index, count);
  const step = count > 1 ? 100 / (count - 1) : 100;
  // A lone sample spans its own column rather than collapsing to a point.
  const columns = (run: readonly number[]) => run.length > 1 ? run.map((index) => ({ x: x(index), index }))
    : [{ x: Math.max(0, x(run[0]!) - step / 2), index: run[0]! }, { x: Math.min(100, x(run[0]!) + step / 2), index: run[0]! }];
  const pickLeft = picked ? Math.max(0, x(picked.first) - step / 2) : 0;
  const pickRight = picked ? Math.min(100, x(picked.last) + step / 2) : 100;
  const readoutValue = (value: number | null | undefined) => value === null || value === undefined ? "unavailable" : formatValue(value);

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
          relative rounded-md outline-none focus-visible:ring-2 focus-visible:ring-accent-soft
          ${className}
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
          {!empty ? series.map((entry, band) => (
            <g className={entry.textClassName} key={entry.key}>
              <defs>
                <linearGradient id={`${fade}-${band}`} x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0" stopColor="currentColor" stopOpacity="0.42" />
                  <stop offset="1" stopColor="currentColor" stopOpacity="0.08" />
                </linearGradient>
              </defs>
              {runs(entry.values, count).map((run) => {
                const points = columns(run);
                const top = points.map(({ x: left, index }) => ({ x: left, y: y(stacks[index]![band]!) }));
                const bottom = points.map(({ x: left, index }) => ({ x: left, y: band ? y(stacks[index]![band - 1]!) : HEIGHT })).reverse();
                return (
                  <g key={run[0]}>
                    <path d={`${chartSmoothPath(top)} ${chartSmoothPath(bottom, "L")} Z`} fill={`url(#${fade}-${band})`} />
                    <path d={chartSmoothPath(top)} fill="none" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.75" vectorEffect="non-scaling-stroke" />
                  </g>
                );
              })}
            </g>
          )) : null}
        </svg>
        {inspected !== null && !empty ? (
          <div aria-hidden="true" className="pointer-events-none absolute inset-y-0" style={{ left: `${x(inspected)}%` }}>
            <div className="absolute inset-y-0 w-px -translate-x-1/2 bg-fg/40" />
            {series.map((entry, band) => {
              const value = entry.values[inspected];
              // Zero-height bands in a stack would pile their dots onto the band below.
              return value === null || value === undefined || (value === 0 && series.length > 1) ? null : (
                <span
                  className={`absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-current ring-2 ring-canvas ${entry.textClassName}`}
                  key={entry.key}
                  style={{ top: `${y(stacks[inspected]![band]!) / HEIGHT * 100}%` }}
                />
              );
            })}
          </div>
        ) : null}
        {empty && emptyLabel ? (
          <p className="absolute inset-0 m-0 flex items-center justify-center text-[0.8rem] text-fg/muted">{emptyLabel}</p>
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
          {/* A lone series is its own total, so only stacks repeat the sum. */}
          {series.length > 1 || total ? <span className="ml-2 font-normal text-fg/muted">{formatValue(total?.[selected] ?? totals[selected] ?? 0)}</span> : null}
        </span>
        <span className="flex flex-wrap gap-x-3 gap-y-1">
          {series.map((entry) => (
            <span className={`inline-flex items-center gap-1 font-semibold ${entry.textClassName}`} key={entry.key}>
              {entry.icon}{entry.label} {readoutValue(entry.values[selected])}
            </span>
          ))}
        </span>
      </figcaption>
    </figure>
  );
}
