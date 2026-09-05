"use client";

/*
 * Exports:
 * - default WorkbenchStatsChart: render one focusable, inspectable nullable multi-series graph. Keywords: stats, chart, SVG, keyboard.
 * ChartSeries: labelled nullable samples with optional shared category icons. Keywords: chart, series.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { chartX as xAt, chartY as yAt, chartSegments as segments, chartMaximum, chartPointerIndex } from "./stats-chart-geometry";

interface ChartSeries {
  colour: string;
  label: string;
  summary?: string;
  values: readonly (number | null)[];
  icon?: ReactNode;
}

export default function WorkbenchStatsChart({
  buckets,
  formatValue,
  series,
  title,
  scale = "shared",
}: {
  buckets: readonly number[];
  formatValue: (value: number) => string;
  series: readonly ChartSeries[];
  title: string;
  scale?: "shared" | "independent";
}) {
  const svg = useRef<SVGSVGElement>(null);
  const [selection, setSelectedIndex] = useState<number | null>(null);
  const selectedIndex = selection ?? Math.max(0, buckets.length - 1);
  const maximum = chartMaximum(series.flatMap(({ values }) => values));
  const availableSeries = useMemo(
    () => series.filter(({ values }) => values.some((value) => value !== null)).map((entry) => ({ ...entry, maximum: chartMaximum(entry.values) })),
    [series],
  );

  useEffect(() => {
    setSelectedIndex((current) => current === null ? null : Math.min(current, Math.max(0, buckets.length - 1)));
  }, [buckets.length]);

  const selectFromPointer = (event: PointerEvent<HTMLDivElement>) => {
    const index = chartPointerIndex(event.clientX, event.clientY, svg.current?.getScreenCTM() ?? null, buckets.length);
    if (index !== null) setSelectedIndex(index);
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
      <figcaption className="flex h-14 flex-wrap items-center justify-between gap-x-4 gap-y-2 overflow-hidden">
        <span className="text-[0.9rem] font-semibold text-text">{title}</span>
        <span className="flex flex-wrap gap-x-3 gap-y-1 text-[0.72rem] text-muted">
          {availableSeries.map(({ colour, label, summary, icon }) => (
            <span className="inline-flex items-center gap-1.5" key={label}>
              <span className="inline-flex" style={{ color: colour }}>{icon ?? <span className="size-1.5 rounded-full" style={{ background: colour }} />}</span>
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
        <svg ref={svg} aria-hidden="true" className="h-32 w-full overflow-visible" viewBox="0 0 100 38">
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
          {availableSeries.map(({ colour, label, values, maximum: seriesMaximum }) => (
            <g key={label}>
              {segments(values, scale === "independent" ? seriesMaximum : maximum).map((pathPoints, segmentIndex) => (
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
                  cy={yAt(value, scale === "independent" ? seriesMaximum : maximum)}
                  fill={colour}
                  key={index}
                  r={index === selectedIndex ? "1.15" : "0.65"}
                />
              ))}
            </g>
          ))}
        </svg>
      </div>
      <div className="grid h-24 grid-cols-2 content-start gap-x-4 gap-y-1 overflow-hidden text-[0.7rem] tabular-nums text-muted">
        <span>{buckets.length ? new Date(buckets[0]!).toLocaleDateString(undefined, { day: "numeric", month: "short" }) : ""}</span>
        <span aria-live="polite" className="col-span-2 row-start-2 grid grid-cols-2 gap-x-3 gap-y-1">
          <span className="font-medium text-text">{selectedDate}</span>
          {availableSeries.map(({ label, values, icon, colour }) => (
            <span className="inline-flex items-center gap-1" key={label}><span style={{ color: colour }}>{icon}</span>{label} {values[selectedIndex] === null || values[selectedIndex] === undefined ? "unavailable" : formatValue(values[selectedIndex])}</span>
          ))}
        </span>
        <span className="col-start-2 row-start-1 text-right">{buckets.length ? new Date(buckets.at(-1)!).toLocaleDateString(undefined, { day: "numeric", month: "short" }) : ""}</span>
      </div>
    </figure>
  );
}
