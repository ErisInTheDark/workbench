/*
 * Exports:
 * - default WorkbenchStatsChart: render one focusable, inspectable nullable multi-series graph.
 */
"use client";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { chartMaximum, chartPointerIndex, chartSegments as segments, chartX as xAt, chartY as yAt } from "./stats-chart-geometry";

interface ChartSeries {
  colour?: string;
  colourClassName?: string;
  label: string;
  summary?: string;
  values: readonly (number | null)[];
  icon?: ReactNode;
}

export default function WorkbenchStatsChart ({
  buckets,
  formatValue,
  series,
  title,
  scale = "shared",
  fixedMaximum,
}: {
  buckets: readonly number[];
  formatValue: (value: number) => string;
  series: readonly ChartSeries[];
  title: string;
  scale?: "shared" | "independent";
  fixedMaximum?: number;
}) {
  const svg = useRef<SVGSVGElement>(null);
  const [selection, setSelectedIndex] = useState<number | null>(null);
  const selectedIndex = selection ?? Math.max(0, buckets.length - 1);
  const maximum = fixedMaximum ?? chartMaximum(series.flatMap(({ values }) => values));
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
    <figure className="m-0 min-w-0 space-y-2 [--hue-chroma:50%]">
      <figcaption className="flex min-h-6 flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <span className="text-[0.9rem] font-semibold text-text">{title}</span>
        <span className="flex flex-wrap gap-x-3 gap-y-1 text-[0.72rem] text-fg/muted">
          {availableSeries.map(({ colour, colourClassName, label, summary, icon }) => (
            <span className={`inline-flex items-center gap-1.5 font-bold ${colourClassName ?? ""}`} style={{ color: colour }} key={label}>
              <span className="inline-flex">{icon ?? <span className="size-1.5 rounded-full bg-current" />}</span>
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
        <svg ref={svg} aria-hidden="true" className="h-40 w-full overflow-visible" viewBox="0 0 100 38" preserveAspectRatio="none">
          {[4, 19, 34].map((y) => (
            <line key={y} className="stroke-fg/muted-grid" strokeWidth="1" vectorEffect="non-scaling-stroke" x1="0" x2="100" y1={y} y2={y} />
          ))}
          {selectedAt !== null ? (
            <line
              className="stroke-fg/40"
              strokeDasharray="1 1.5"
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
              x1={xAt(selectedIndex, buckets.length)}
              x2={xAt(selectedIndex, buckets.length)}
              y1="3"
              y2="35"
            />
          ) : null}
          {availableSeries.map(({ colour, colourClassName, label, values, maximum: seriesMaximum }) => (
            <g className={`${colourClassName} font-bold`} style={{ color: colour }} key={label}>
              {segments(values, fixedMaximum ?? (scale === "independent" ? seriesMaximum : maximum)).map((pathPoints, segmentIndex) => (
                <polyline
                  fill="none"
                  key={segmentIndex}
                  points={pathPoints}
                  stroke="currentColor"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="1.25"
                  vectorEffect="non-scaling-stroke"
                />
              ))}
              {values.map((value, index) => value === null ? null : (
                <line
                  x1={xAt(index, values.length)}
                  x2={xAt(index, values.length)}
                  y1={yAt(value, fixedMaximum ?? (scale === "independent" ? seriesMaximum : maximum))}
                  y2={yAt(value, fixedMaximum ?? (scale === "independent" ? seriesMaximum : maximum))}
                  stroke="currentColor"
                  strokeLinecap="round"
                  strokeWidth={index === selectedIndex ? "6" : "3"}
                  vectorEffect="non-scaling-stroke"
                  key={index}
                />
              ))}
            </g>
          ))}
        </svg>
      </div>
      <div className="grid min-h-14 grid-cols-2 content-start gap-x-4 gap-y-1 text-[0.7rem] tabular-nums text-fg/muted">
        <span>{buckets.length ? new Date(buckets[0]!).toLocaleDateString(undefined, { day: "numeric", month: "short" }) : ""}</span>
        <span aria-live="polite" className="col-span-2 row-start-2 grid grid-cols-2 gap-x-3 gap-y-1">
          <span className="font-medium text-text">{selectedDate}</span>
          {availableSeries.map(({ label, values, icon, colour, colourClassName }) => (
            <span className={`inline-flex items-center gap-1 font-bold ${colourClassName ?? ""}`} style={{ color: colour }} key={label}><span>{icon}</span>{label} {values[selectedIndex] === null || values[selectedIndex] === undefined ? "unavailable" : formatValue(values[selectedIndex])}</span>
          ))}
        </span>
        <span className="col-start-2 row-start-1 text-right">{buckets.length ? new Date(buckets.at(-1)!).toLocaleDateString(undefined, { day: "numeric", month: "short" }) : ""}</span>
      </div>
    </figure>
  );
}
