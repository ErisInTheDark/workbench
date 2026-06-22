/*
 * Exports:
 * - default WorkbenchProgressWheel: render a compact circular percent progress indicator. Keywords: workbench, progress, wheel, context, timer.
 */
"use client";

export default function WorkbenchProgressWheel ({
  percent,
}: {
  percent: number;
}) {
  const radius = 7;
  const clampedPercent = Math.min(100, Math.max(0, percent));
  const center = 10;
  const startX = center;
  const startY = center - radius;
  const endAngleRadians = (-90 - (360 * clampedPercent) / 100) * (Math.PI / 180);
  const endX = center + radius * Math.cos(endAngleRadians);
  const endY = center + radius * Math.sin(endAngleRadians);
  const isLargeArc = clampedPercent > 50 ? 1 : 0;
  const pathData = `M ${startX} ${startY} A ${radius} ${radius} 0 ${isLargeArc} 0 ${endX} ${endY}`;

  return (
    <svg viewBox="0 0 20 20" className="size-5" aria-hidden="true">
      <circle
        cx="10"
        cy="10"
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        className="text-[color-mix(in_srgb,var(--text)_14%,transparent)]"
      />
      {clampedPercent >= 99.5 ? (
        <circle
          cx="10"
          cy="10"
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeWidth="2"
          className="text-accent"
        />
      ) : clampedPercent > 0 ? (
        <path
          d={pathData}
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeWidth="2"
          className="text-accent"
        />
      ) : null}
    </svg>
  );
}
