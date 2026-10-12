/*
 * Exports:
 * - default StatsTrend: a triangle pointing the way a figure moved, green or red when that way is better or worse and grey when
 *   neither, or a grey diamond when it barely moved; an optional label shares its colour.
 */
import type { ReactNode } from "react";
import { DiamondIcon, TriangleIcon, type IconProps } from "../workbench-icons";

const GOOD = "text-hue-150 [--hue-chroma:60%]";
const BAD = "text-hue-25 [--hue-chroma:65%]";
const NEUTRAL = "text-fg/muted";

export default function StatsTrend({ better, change, label, size = 12, steady = 0.5 }: {
  /** The direction that is good news, or null when moving either way is neither. */
  better: "up" | "down" | null;
  change: number;
  label?: ReactNode;
  size?: IconProps["size"];
  /** Changes smaller than this read as no change. */
  steady?: number;
}) {
  const moved = Math.abs(change) >= steady;
  const up = change > 0;
  const tone = !moved || better === null ? NEUTRAL : (better === "up") === up ? GOOD : BAD;
  const icon = moved
    ? <TriangleIcon className={`shrink-0 ${up ? "" : "rotate-180"}`} size={size} />
    : <DiamondIcon className="shrink-0" size={size} />;
  return label === undefined
    ? <span className={`inline-flex ${tone}`}>{icon}</span>
    : <span className={`inline-flex items-center gap-0.5 ${tone}`}>{icon}{label}</span>;
}
