/*
 * Exports:
 * - sliderAccentColour: faint-to-saturated accent track for intensity-like values.
 * - sliderSpectrumColour: blue-to-red-to-grey track through six ordered stops for size-like values.
 */

export function sliderAccentColour (fraction: number) {
  return `color-mix(in srgb,var(--accent) ${20 + fraction * 80}%,transparent)`;
}

export function sliderSpectrumColour (fraction: number) {
  const stops = ["#3b82f6", "#22c55e", "#eab308", "#f97316", "#ef4444", "#9ca3af"];
  const position = Math.max(0, Math.min(1, fraction)) * (stops.length - 1);
  const index = Math.floor(position);
  return `color-mix(in srgb,${stops[index]} ${(1 - (position - index)) * 100}%,${stops[Math.min(index + 1, stops.length - 1)]})`;
}
