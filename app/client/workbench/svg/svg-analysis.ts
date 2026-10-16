/*
 * Exports:
 * - SvgRootSegment: one segment mapped into root user space, with sampled points along it.
 * - SvgAnalysis: icon-grid guides and violations derived from root-space segments.
 * - analyzeSvgSegments: off-axis line angles, arc centres/radii/tangents (radii off-grid or under 2 flagged), near-miss snap points and stroke-gap groups.
 */
import type { SvgPoint } from "./svg-path-data";

export interface SvgRootSegment {
  key: string;
  elementIndex: number;
  kind: "line" | "curve" | "arc" | "shape";
  start: SvgPoint;
  end: SvgPoint;
  controls: SvgPoint[];
  circle: { x: number; y: number; r: number; tangentIntersection: SvgPoint | null } | null;
  opensSubpath: boolean;
  closesSubpath: boolean;
  samples: SvgPoint[];
}

export interface SvgAnalysis {
  angles: Array<{ key: string; at: SvgPoint; angle: number; label: string; start: SvgPoint; end: SvgPoint }>;
  /** `ends` is null for whole circles, which have no radius spokes. */
  arcs: Array<{ key: string; center: SvgPoint; r: number; centerOffGrid: boolean; radiusOffGrid: boolean;
    tangent: SvgPoint | null; ends: [SvgPoint, SvgPoint] | null }>;
  snaps: Array<{ at: SvgPoint; suggestion: SvgPoint | null }>;
  /** Element indices of separate glyph parts; each pair is drawn as a stroke-gap check. */
  gapGroups: number[][];
}

const GAP_MERGE_DISTANCE = 2;
const SNAP_DISTANCE = 1;
const ANGLE_LABEL_MIN_LENGTH = 3.5;
const EPSILON = 0.01;
/** Smaller radii break the icon guidelines and Figma round-tripping. */
const MIN_RADIUS = 2;

const distance = (a: SvgPoint, b: SvgPoint) => Math.hypot(a.x - b.x, a.y - b.y);
const offGrid = (value: number, precision: number) => Math.abs(Math.round(value * precision) / precision % 1) > 1e-9;

function angleOf(segment: SvgRootSegment) {
  let angle = Math.atan2(segment.end.y - segment.start.y, segment.end.x - segment.start.x) * 180 / Math.PI;
  if (angle < 0) angle += 360;
  return angle % 90;
}

function mergeGroups(segments: readonly SvgRootSegment[]) {
  const byElement = new Map<number, SvgPoint[]>();
  for (const segment of segments) byElement.set(segment.elementIndex, [...byElement.get(segment.elementIndex) ?? [], ...segment.samples]);
  const groups = [...byElement].map(([index, points]) => ({ indices: [index], points }));
  const close = (left: SvgPoint[], right: SvgPoint[]) =>
    left.some(a => right.some(b => distance(a, b) <= GAP_MERGE_DISTANCE));
  for (let changed = true; changed;) {
    changed = false;
    outer: for (let i = 0; i < groups.length; i += 1) {
      for (let j = i + 1; j < groups.length; j += 1) {
        if (!close(groups[i]!.points, groups[j]!.points)) continue;
        groups[i] = { indices: [...groups[i]!.indices, ...groups[j]!.indices], points: [...groups[i]!.points, ...groups[j]!.points] };
        groups.splice(j, 1);
        changed = true;
        break outer;
      }
    }
  }
  return groups.map(group => group.indices);
}

function snapIssues(segments: readonly SvgRootSegment[]) {
  const issues: SvgAnalysis["snaps"] = [];
  const lines = segments.filter(segment => segment.kind === "line");
  // Circular arcs and whole circles both attract nearby ends.
  const arcs = segments.filter(segment => segment.kind !== "curve" && segment.circle);
  const points = segments.flatMap(segment => [segment.start, segment.end]);
  const ends = segments.flatMap(segment => [
    ...segment.opensSubpath ? [[segment.start, segment.end] as const] : [],
    ...segment.closesSubpath ? [[segment.end, segment.start] as const] : [],
  ]);
  for (const [end, inward] of ends) {
    for (const arc of arcs) {
      const circle = arc.circle!;
      const gap = Math.abs(distance(end, circle) - circle.r);
      if (gap <= EPSILON || gap >= SNAP_DISTANCE) continue;
      const angle = Math.atan2(end.y - circle.y, end.x - circle.x);
      const projected = { x: circle.x + circle.r * Math.cos(angle), y: circle.y + circle.r * Math.sin(angle) };
      const onArc = arc.samples.some(sample => distance(sample, projected) < 0.75);
      if (onArc && distance(inward, projected) >= 0.5) issues.push({ at: end, suggestion: projected });
    }
    for (const line of lines) {
      const dx = line.end.x - line.start.x;
      const dy = line.end.y - line.start.y;
      const lengthSquared = dx * dx + dy * dy;
      if (!lengthSquared) continue;
      const t = ((end.x - line.start.x) * dx + (end.y - line.start.y) * dy) / lengthSquared;
      if (t < 0 || t > 1) continue;
      const projected = { x: line.start.x + t * dx, y: line.start.y + t * dy };
      const gap = distance(end, projected);
      if (gap <= EPSILON || gap >= SNAP_DISTANCE || distance(inward, projected) < SNAP_DISTANCE) continue;
      if (points.filter(point => distance(point, end) < SNAP_DISTANCE).length > 1) continue;
      issues.push({ at: end, suggestion: projected });
    }
  }
  const unique: SvgAnalysis["snaps"] = [];
  for (const issue of issues) if (!unique.some(item => distance(item.at, issue.at) < EPSILON)) unique.push(issue);
  return unique;
}

export function analyzeSvgSegments(segments: readonly SvgRootSegment[]): SvgAnalysis {
  const angles = segments.flatMap(segment => {
    if (segment.kind !== "line") return [];
    const angle = angleOf(segment);
    const rounded = Math.round(angle * 100) / 100;
    if (rounded % 45 <= 0.001 || rounded % 45 >= 44.999 || distance(segment.start, segment.end) < ANGLE_LABEL_MIN_LENGTH) return [];
    return [{
      key: segment.key, angle, label: `${rounded}°`, start: segment.start, end: segment.end,
      at: { x: (segment.start.x + segment.end.x) / 2, y: (segment.start.y + segment.end.y) / 2 },
    }];
  });
  const arcs = segments.flatMap(segment => {
    if (!segment.circle || segment.kind === "curve") return [];
    const { x, y, r, tangentIntersection } = segment.circle;
    return [{
      key: segment.key, center: { x, y }, r, tangent: segment.kind === "arc" ? tangentIntersection : null,
      centerOffGrid: offGrid(x, 100) || offGrid(y, 100), radiusOffGrid: offGrid(r, 1000) || r < MIN_RADIUS - EPSILON,
      ends: segment.kind === "arc" ? [segment.start, segment.end] as [SvgPoint, SvgPoint] : null,
    }];
  });
  return { angles, arcs, snaps: snapIssues(segments), gapGroups: mergeGroups(segments) };
}
