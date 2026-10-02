/*
 * Exports:
 * - default WorkbenchStatsSparkline: decorative filled trend line that sits behind a headline value.
 */
import { useId } from "react";

/** Gaps (null) are skipped so a day without input does not read as a zero hit rate. */
export default function WorkbenchStatsSparkline({ className = "", values }: {
  className?: string;
  values: readonly (number | null)[];
}) {
  // Each gradient resolves currentColor where it is defined, so every sparkline needs its own.
  const fade = `stats-sparkline-${useId().replace(/[^\w-]/gu, "")}`;
  const points = values.flatMap((value, index) => value === null ? [] : [{ index, value }]);
  if (points.length < 2) return null;
  const minimum = Math.min(...points.map(({ value }) => value));
  const maximum = Math.max(...points.map(({ value }) => value));
  // Counts start at zero; rates such as cache hits zoom onto their own band.
  const floor = minimum >= 0 && minimum < (maximum - minimum) ? 0 : minimum;
  const span = maximum - floor || 1;
  const x = (index: number) => values.length > 1 ? index / (values.length - 1) * 100 : 50;
  const y = (value: number) => 30 - (value - floor) / span * 26;
  const line = points.map(({ index, value }) => `${x(index).toFixed(2)},${y(value).toFixed(2)}`).join(" ");
  const area = `${x(points[0]!.index).toFixed(2)},32 ${line} ${x(points.at(-1)!.index).toFixed(2)},32`;
  return (
    <svg aria-hidden="true" className={`pointer-events-none absolute inset-x-0 bottom-0 h-3/5 w-full overflow-visible ${className}`} preserveAspectRatio="none" viewBox="0 0 100 32">
      <defs>
        <linearGradient id={fade} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="currentColor" stopOpacity="0.22" />
          <stop offset="1" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon fill={`url(#${fade})`} points={area} />
      <polyline fill="none" points={line} stroke="currentColor" strokeLinejoin="round" strokeOpacity="0.55" strokeWidth="1.25" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
