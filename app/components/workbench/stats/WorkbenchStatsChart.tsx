"use client";

/*
 * Exports:
 * - default WorkbenchStatsChart: render one focusable, inspectable nullable multi-series graph. Keywords: stats, chart, SVG, keyboard.
 * Local helpers: split genuine gaps and map values to bounded SVG coordinates. Keywords: chart, coordinates, gaps.
 */
import { useEffect, useMemo, useState, type KeyboardEvent, type PointerEvent } from "react";

interface ChartSeries {
  colour: string;
  label: string;
  summary?: string;
  values: readonly (number | null)[];
}

function xAt(index: number, length: number) {
  return length === 1 ? 50 : index / Math.max(1, length - 1) * 100;
}

function yAt(value: number, maximum: number) {
  return 34 - value / maximum * 30;
}

function segments(values: readonly (number | null)[], maximum: number) {
  const result: string[] = [];
  let current: string[] = [];
  values.forEach((value, index) => {
    if (value === null) {
      if (current.length) result.push(current.join(" "));
      current = [];
      return;
    }
    current.push(`${xAt(index, values.length).toFixed(2)},${yAt(value, maximum).toFixed(2)}`);
  });
  if (current.length) result.push(current.join(" "));
  return result;
}

export default function WorkbenchStatsChart({
  buckets,
  formatValue,
  series,
  title,
}: {
  buckets: readonly number[];
  formatValue: (value: number) => string;
  series: readonly ChartSeries[];
  title: string;
}) {
  const [selectedIndex, setSelectedIndex] = useState(Math.max(0, buckets.length - 1));
  const maximum = Math.max(1, ...series.flatMap(({ values }) => values.filter((value): value is number => value !== null)));
  const availableSeries = useMemo(
    () => series.filter(({ values }) => values.some((value) => value !== null)),
    [series],
  );

  useEffect(() => {
    setSelectedIndex((current) => Math.min(current, Math.max(0, buckets.length - 1)));
  }, [buckets.length]);

  const selectFromPointer = (event: PointerEvent<HTMLDivElement>) => {
    if (!buckets.length) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (event.clientX - bounds.left) / Math.max(1, bounds.width)));
    setSelectedIndex(Math.round(ratio * (buckets.length - 1)));
  };

  const moveSelection = (event: KeyboardEvent<HTMLDivElement>) => {
    let next = selectedIndex;
    if (event.key === "ArrowLeft") next -= 1;
    else if (event.key === "ArrowRight") next += 1;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = buckets.length - 1;
    else return;
    event.preventDefault();
    setSelectedIndex(Math.min(Math.max(0, next), Math.max(0, buckets.length - 1)));
  };

  const selectedAt = buckets[selectedIndex] ?? null;
  const selectedDate = selectedAt === null
    ? "No samples"
    : new Date(selectedAt).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  return (
    <figure className="m-0 min-w-0 space-y-3">
      <figcaption className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <span className="text-[0.9rem] font-semibold text-text">{title}</span>
        <span className="flex flex-wrap gap-x-3 gap-y-1 text-[0.72rem] text-muted">
          {availableSeries.map(({ colour, label, summary }) => (
            <span className="inline-flex items-center gap-1.5" key={label}>
              <span className="size-1.5 rounded-full" style={{ background: colour }} />
              {label}{summary ? ` ${summary}` : ""}
            </span>
          ))}
        </span>
      </figcaption>
      <div
        aria-label={`${title}. Use left and right arrow keys to inspect dates.`}
        className="rounded-md outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
        onKeyDown={moveSelection}
        onPointerDown={selectFromPointer}
        onPointerMove={(event) => {
          if (event.pointerType === "mouse" || event.buttons) selectFromPointer(event);
        }}
        role="group"
        tabIndex={0}
      >
        <svg aria-hidden="true" className="h-32 w-full overflow-visible" viewBox="0 0 100 38">
          {[4, 19, 34].map((y) => (
            <line key={y} stroke="color-mix(in srgb, var(--muted) 18%, transparent)" strokeWidth="0.35" x1="0" x2="100" y1={y} y2={y} />
          ))}
          {selectedAt !== null ? (
            <line
              stroke="color-mix(in srgb, var(--text) 40%, transparent)"
              strokeDasharray="1 1.5"
              strokeWidth="0.4"
              x1={xAt(selectedIndex, buckets.length)}
              x2={xAt(selectedIndex, buckets.length)}
              y1="3"
              y2="35"
            />
          ) : null}
          {availableSeries.map(({ colour, label, values }) => (
            <g key={label}>
              {segments(values, maximum).map((pathPoints, segmentIndex) => (
                <polyline
                  fill="none"
                  key={segmentIndex}
                  points={pathPoints}
                  stroke={colour}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="1.25"
                  vectorEffect="non-scaling-stroke"
                />
              ))}
              {values.map((value, index) => value === null ? null : (
                <circle
                  cx={xAt(index, values.length)}
                  cy={yAt(value, maximum)}
                  fill={colour}
                  key={index}
                  r={index === selectedIndex ? "1.15" : "0.65"}
                />
              ))}
            </g>
          ))}
        </svg>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-[0.7rem] text-muted">
        <span>{buckets.length ? new Date(buckets[0]!).toLocaleDateString(undefined, { day: "numeric", month: "short" }) : ""}</span>
        <span aria-live="polite" className="flex flex-wrap justify-center gap-x-3 text-center">
          <span className="font-medium text-text">{selectedDate}</span>
          {availableSeries.map(({ label, values }) => (
            <span key={label}>{label} {values[selectedIndex] === null || values[selectedIndex] === undefined ? "unavailable" : formatValue(values[selectedIndex])}</span>
          ))}
        </span>
        <span>{buckets.length ? new Date(buckets.at(-1)!).toLocaleDateString(undefined, { day: "numeric", month: "short" }) : ""}</span>
      </div>
    </figure>
  );
}
