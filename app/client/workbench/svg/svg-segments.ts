/*
 * Exports:
 * - SvgSegment: one drawable piece of an element (path command, polyline edge, line, or a whole primitive) with local geometry and source range.
 * - SVG_SEGMENT_TAGS: element names that produce segments.
 * - getSvgSegments: split an element into segments, with source ranges when its geometry text maps 1:1 to its value.
 * - svgSegmentKey/svgElementKey: stable `element:segment` keys, `element:*` for elements without segments.
 * - groupSvgSelection/svgElementSelectionKeys: group selection keys by element; every key of one element.
 * - moveSvgSegments: attribute edits moving selected segments' points (whole primitives translate).
 * - deleteSvgSegments: remove selected segments, splitting paths and dropping emptied elements.
 * - extractSvgSegmentsPath: standalone absolute path data for selected segments.
 * - transformSvgElement: map every point of an element (flip, scale), keeping arcs and radii consistent.
 * - circlifySvgSegments: replace selected circular arcs by one `<circle>` per distinct circle.
 */
import { getSvgShape, type SvgAttributeEdit } from "./svg-geometry";
import {
  formatSvgNumber,
  parseSvgPathData,
  serializeSvgPathData,
  svgArcCircle,
  type SvgArcCircle,
  type SvgPathSegment,
  type SvgPoint,
} from "./svg-path-data";
import { applySvgAttributeEdits, removeSvgElement } from "./svg-source-edits";
import { getSvgAttribute, type SvgSourceElement } from "./svg-source";

export interface SvgSegment {
  key: string;
  elementIndex: number;
  index: number;
  kind: "line" | "curve" | "arc" | "shape";
  start: SvgPoint;
  end: SvgPoint;
  /** Curve control points (cubic-equivalent order) for handles and guides. */
  controls: SvgPoint[];
  /** Points used for box selection and snapping. */
  points: SvgPoint[];
  /** Standalone absolute path data in the element's local coordinates. */
  d: string;
  range: { start: number; end: number } | null;
  circle: SvgArcCircle | null;
  /** Open subpath ends, for endpoint markers. */
  opensSubpath: boolean;
  closesSubpath: boolean;
}

export const SVG_SEGMENT_TAGS = new Set(["path", "line", "polyline", "polygon", "rect", "circle", "ellipse"]);

const NUMBER_PATTERN = /[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/giu;
const n = formatSvgNumber;
const pointText = (point: SvgPoint) => `${n(point.x)} ${n(point.y)}`;

export function svgSegmentKey(elementIndex: number, index: number) {
  return `${elementIndex}:${index}`;
}

/** Selection key for an element without segments (text, use, image, groups). */
export function svgElementKey(elementIndex: number) {
  return `${elementIndex}:*`;
}

/** Group selection keys by element; `null` marks a whole element without segments. */
export function groupSvgSelection(keys: Iterable<string>) {
  const grouped = new Map<number, Set<number> | null>();
  for (const key of keys) {
    const [element, segment] = key.split(":");
    const index = Number(element);
    if (!Number.isInteger(index)) continue;
    if (segment === "*") { grouped.set(index, null); continue; }
    const set = grouped.get(index) ?? new Set<number>();
    set.add(Number(segment));
    grouped.set(index, set);
  }
  return grouped;
}

/** Every selection key for one element. */
export function svgElementSelectionKeys(element: SvgSourceElement) {
  const segments = getSvgSegments(element);
  return segments.length ? segments.map(segment => segment.key) : [svgElementKey(element.index)];
}

function localName(element: SvgSourceElement) {
  return element.name.slice(element.name.indexOf(":") + 1);
}

function numberAttribute(element: SvgSourceElement, name: string) {
  const value = Number.parseFloat(getSvgAttribute(element, name) ?? "0");
  return Number.isFinite(value) ? value : 0;
}

/** Offset of an attribute's raw value, when it has no entities so value offsets equal source offsets. */
function rawValueOffset(element: SvgSourceElement, name: string) {
  const attribute = element.attributes.find(candidate => candidate.name === name);
  return attribute && attribute.valueEnd - attribute.valueStart === attribute.value.length ? attribute.valueStart : null;
}

function reflect(point: SvgPoint, around: SvgPoint) {
  return { x: 2 * around.x - point.x, y: 2 * around.y - point.y };
}

function pathSegments(element: SvgSourceElement): SvgSegment[] {
  const parsed = parseSvgPathData(getSvgAttribute(element, "d") ?? "");
  if (!parsed) return [];
  const offset = rawValueOffset(element, "d");
  const segments: SvgSegment[] = [];
  let previousControl: { kind: "cubic" | "quad"; point: SvgPoint } | null = null;
  parsed.forEach((segment, index) => {
    const range = offset !== null && segment.range ? { start: offset + segment.range.start, end: offset + segment.range.end } : null;
    const base = { key: svgSegmentKey(element.index, index), elementIndex: element.index, index, range, circle: null,
      opensSubpath: false, closesSubpath: false };
    const start = segment.start;
    const end = segment.points.at(-1)!;
    let next: SvgSegment | null = null;
    let control: typeof previousControl = null;
    switch (segment.type) {
      case "M": break;
      case "L": case "H": case "V": case "Z":
        if (segment.type === "Z" && start.x === end.x && start.y === end.y) break;
        next = { ...base, kind: "line", start, end, controls: [], points: [start, end], d: `M${pointText(start)}L${pointText(end)}` };
        break;
      case "C": case "S": {
        const first = segment.type === "C" ? segment.points[0]!
          : previousControl?.kind === "cubic" ? reflect(previousControl.point, start) : start;
        const second = segment.points[segment.type === "C" ? 1 : 0]!;
        control = { kind: "cubic", point: second };
        next = { ...base, kind: "curve", start, end, controls: [first, second], points: [start, first, second, end],
          d: `M${pointText(start)}C${pointText(first)} ${pointText(second)} ${pointText(end)}` };
        break;
      }
      case "Q": case "T": {
        const quad = segment.type === "Q" ? segment.points[0]!
          : previousControl?.kind === "quad" ? reflect(previousControl.point, start) : start;
        control = { kind: "quad", point: quad };
        next = { ...base, kind: "curve", start, end, controls: [quad], points: [start, quad, end],
          d: `M${pointText(start)}Q${pointText(quad)} ${pointText(end)}` };
        break;
      }
      case "A":
        next = { ...base, kind: "arc", start, end, controls: [], points: [start, end],
          circle: svgArcCircle(start, segment.arc!, end),
          d: `M${pointText(start)}A${segment.arc!.slice(0, 3).map(n).join(" ")} ${segment.arc![3]} ${segment.arc![4]} ${pointText(end)}` };
        break;
    }
    previousControl = control;
    if (next) segments.push(next);
  });
  // Open subpath ends get endpoint markers; closed subpaths (Z or returning to their start) have none.
  let first = 0;
  parsed.forEach((segment, index) => {
    if (segment.type !== "M" && index !== parsed.length - 1) return;
    const last = segment.type === "M" ? index - 1 : index;
    const members = segments.filter(item => item.index >= first && item.index <= last);
    const head = members[0];
    const tail = members.at(-1);
    const closed = parsed.slice(first, last + 1).some(item => item.type === "Z")
      || (head && tail && head.start.x === tail.end.x && head.start.y === tail.end.y);
    if (head && tail && !closed) {
      head.opensSubpath = true;
      tail.closesSubpath = true;
    }
    first = index;
  });
  return segments;
}

function pointsSegments(element: SvgSourceElement, closed: boolean): SvgSegment[] {
  const raw = getSvgAttribute(element, "points") ?? "";
  const offset = rawValueOffset(element, "points");
  const numbers = [...raw.matchAll(NUMBER_PATTERN)].map(match => ({ value: Number(match[0]), start: match.index, end: match.index + match[0].length }));
  const points: Array<SvgPoint & { start: number; end: number }> = [];
  for (let index = 0; index + 1 < numbers.length; index += 2) {
    points.push({ x: numbers[index]!.value, y: numbers[index + 1]!.value, start: numbers[index]!.start, end: numbers[index + 1]!.end });
  }
  const pairs = points.slice(0, -1).map((point, index) => [point, points[index + 1]!] as const);
  if (closed && points.length > 2) pairs.push([points.at(-1)!, points[0]!]);
  return pairs.map(([start, end], index) => ({
    key: svgSegmentKey(element.index, index), elementIndex: element.index, index, kind: "line" as const,
    start: { x: start.x, y: start.y }, end: { x: end.x, y: end.y }, controls: [], points: [start, end],
    d: `M${pointText(start)}L${pointText(end)}`, circle: null,
    range: offset !== null && end.start > start.start ? { start: offset + start.start, end: offset + end.end } : null,
    opensSubpath: index === 0 && !closed, closesSubpath: index === pairs.length - 1 && !closed,
  }));
}

function primitiveSegment(element: SvgSourceElement, d: string, points: SvgPoint[], circle: SvgArcCircle | null = null): SvgSegment {
  return {
    key: svgSegmentKey(element.index, 0), elementIndex: element.index, index: 0, kind: "shape",
    start: points[0]!, end: points[0]!, controls: [], points, d, range: { start: element.start, end: element.end },
    circle, opensSubpath: false, closesSubpath: false,
  };
}

export function getSvgSegments(element: SvgSourceElement): SvgSegment[] {
  switch (localName(element)) {
    case "path": return pathSegments(element);
    case "polyline": return pointsSegments(element, false);
    case "polygon": return pointsSegments(element, true);
    case "line": {
      const start = { x: numberAttribute(element, "x1"), y: numberAttribute(element, "y1") };
      const end = { x: numberAttribute(element, "x2"), y: numberAttribute(element, "y2") };
      return [{ ...primitiveSegment(element, `M${pointText(start)}L${pointText(end)}`, [start, end]), kind: "line", start, end,
        opensSubpath: true, closesSubpath: true }];
    }
    case "circle": {
      const [cx, cy, r] = ["cx", "cy", "r"].map(name => numberAttribute(element, name)) as [number, number, number];
      return [primitiveSegment(element, `M${n(cx - r)} ${n(cy)}a${n(r)} ${n(r)} 0 1 0 ${n(2 * r)} 0a${n(r)} ${n(r)} 0 1 0 ${n(-2 * r)} 0`,
        [{ x: cx - r, y: cy - r }, { x: cx + r, y: cy + r }], { x: cx, y: cy, r, tangentIntersection: null })];
    }
    case "ellipse": {
      const [cx, cy, rx, ry] = ["cx", "cy", "rx", "ry"].map(name => numberAttribute(element, name)) as [number, number, number, number];
      return [primitiveSegment(element, `M${n(cx - rx)} ${n(cy)}a${n(rx)} ${n(ry)} 0 1 0 ${n(2 * rx)} 0a${n(rx)} ${n(ry)} 0 1 0 ${n(-2 * rx)} 0`,
        [{ x: cx - rx, y: cy - ry }, { x: cx + rx, y: cy + ry }])];
    }
    case "rect": {
      const [x, y, width, height] = ["x", "y", "width", "height"].map(name => numberAttribute(element, name)) as [number, number, number, number];
      const rxValue = getSvgAttribute(element, "rx");
      const ryValue = getSvgAttribute(element, "ry");
      const rx = Math.min(width / 2, Number.parseFloat(rxValue ?? ryValue ?? "0") || 0);
      const ry = Math.min(height / 2, Number.parseFloat(ryValue ?? rxValue ?? "0") || 0);
      const d = rx && ry
        ? `M${n(x + rx)} ${n(y)}h${n(width - 2 * rx)}a${n(rx)} ${n(ry)} 0 0 1 ${n(rx)} ${n(ry)}v${n(height - 2 * ry)}`
          + `a${n(rx)} ${n(ry)} 0 0 1 ${n(-rx)} ${n(ry)}h${n(2 * rx - width)}a${n(rx)} ${n(ry)} 0 0 1 ${n(-rx)} ${n(-ry)}`
          + `v${n(2 * ry - height)}a${n(rx)} ${n(ry)} 0 0 1 ${n(rx)} ${n(-ry)}Z`
        : `M${n(x)} ${n(y)}h${n(width)}v${n(height)}h${n(-width)}Z`;
      return [primitiveSegment(element, d, [{ x, y }, { x: x + width, y: y + height }])];
    }
    default: return [];
  }
}

function pathEdit(segments: readonly SvgPathSegment[]): SvgAttributeEdit[] {
  return [{ name: "d", value: serializeSvgPathData(segments) }];
}

function clonePath(segments: readonly SvgPathSegment[]) {
  return segments.map(segment => ({ ...segment, start: { ...segment.start }, points: segment.points.map(point => ({ ...point })) }));
}

/** Indices of path segments whose end anchor moves when `selected` segments move (each selected segment's own end and its start anchor). */
function movedAnchors(segments: readonly SvgPathSegment[], selected: ReadonlySet<number>) {
  const anchors = new Set<number>();
  let subpathStart = -1;
  segments.forEach((segment, index) => {
    if (segment.type === "M") subpathStart = index;
    if (!selected.has(index)) return;
    if (segment.type === "Z") {
      anchors.add(index - 1);
      anchors.add(subpathStart);
      return;
    }
    anchors.add(index);
    anchors.add(index - 1);
  });
  return anchors;
}

export function moveSvgSegments(element: SvgSourceElement, selected: ReadonlySet<number>, delta: SvgPoint): SvgAttributeEdit[] {
  const name = localName(element);
  if (name === "polyline" || name === "polygon") {
    const segments = getSvgSegments(element);
    const raw = getSvgAttribute(element, "points") ?? "";
    const numbers = [...raw.matchAll(NUMBER_PATTERN)].map(match => Number(match[0]));
    const count = Math.floor(numbers.length / 2);
    const moved = new Set<number>();
    for (const index of selected) {
      if (!segments[index]) continue;
      moved.add(index);
      moved.add((index + 1) % count);
    }
    const points = Array.from({ length: count }, (_, index) => ({
      x: numbers[index * 2]! + (moved.has(index) ? delta.x : 0), y: numbers[index * 2 + 1]! + (moved.has(index) ? delta.y : 0),
    }));
    return [{ name: "points", value: points.map(point => `${n(point.x)},${n(point.y)}`).join(" ") }];
  }
  if (name !== "path") return getSvgShape(element)?.translate(delta) ?? [];
  const segments = parseSvgPathData(getSvgAttribute(element, "d") ?? "");
  if (!segments) return [];
  const next = clonePath(segments);
  const anchors = movedAnchors(segments, selected);
  const shift = (point: SvgPoint) => { point.x += delta.x; point.y += delta.y; };
  next.forEach((segment, index) => {
    if (segment.type === "Z") return;
    if (anchors.has(index)) shift(segment.points.at(-1)!);
    if (selected.has(index)) segment.points.slice(0, -1).forEach(shift);
  });
  return pathEdit(next);
}

export function extractSvgSegmentsPath(element: SvgSourceElement, selected: ReadonlySet<number>, offset: SvgPoint = { x: 0, y: 0 }) {
  const shift = (point: SvgPoint) => ({ x: point.x + offset.x, y: point.y + offset.y });
  const parts: string[] = [];
  let last: SvgPoint | null = null;
  for (const segment of getSvgSegments(element)) {
    if (!selected.has(segment.index)) continue;
    const body = serializeSvgPathData(parseSvgPathData(segment.d)!.map(item => ({
      ...item, relative: false, start: shift(item.start), points: item.points.map(shift),
    })));
    const continues = last !== null && last.x === segment.start.x && last.y === segment.start.y;
    parts.push(continues ? body.replace(/^M[^A-Za-z]*/u, "") : body);
    last = segment.kind === "shape" ? null : segment.end;
  }
  return parts.join("");
}

export function deleteSvgSegments(text: string, element: SvgSourceElement, selected: ReadonlySet<number>): string {
  const all = getSvgSegments(element);
  if (!all.length || all.every(segment => selected.has(segment.index))) return removeSvgElement(text, element);
  const name = localName(element);
  if (name !== "path") {
    const keep = new Set(all.filter(segment => !selected.has(segment.index)).map(segment => segment.index));
    const d = extractSvgSegmentsPath(element, keep);
    return replaceElementWithPath(text, element, d);
  }
  const segments = parseSvgPathData(getSvgAttribute(element, "d") ?? "")!;
  const next: SvgPathSegment[] = [];
  let needsMove = false;
  let broken = false;
  let subpathStart: SvgPoint = { x: 0, y: 0 };
  segments.forEach((segment, index) => {
    if (segment.type === "M") {
      next.push(segment);
      subpathStart = segment.points[0]!;
      needsMove = false;
      broken = false;
      return;
    }
    if (selected.has(index)) {
      needsMove = true;
      broken = true;
      return;
    }
    if (needsMove) {
      next.push({ type: "M", relative: false, start: segment.start, points: [{ ...segment.start }] });
      needsMove = false;
    }
    next.push(segment.type === "Z" && broken
      ? { type: "L", relative: false, start: segment.start, points: [{ ...subpathStart }] }
      : segment);
  });
  const cleaned = next.filter((segment, index) => segment.type !== "M" || (next[index + 1] && next[index + 1]!.type !== "M"));
  return applySvgAttributeEdits(text, element, pathEdit(cleaned));
}

function replaceElementWithPath(text: string, element: SvgSourceElement, d: string) {
  const geometry = new Set(["x", "y", "width", "height", "rx", "ry", "cx", "cy", "r", "x1", "y1", "x2", "y2", "points", "d"]);
  const attributes = element.attributes.filter(attribute => !geometry.has(attribute.name))
    .map(attribute => ` ${text.slice(attribute.start, attribute.end).trim()}`).join("");
  return `${text.slice(0, element.start)}<path d="${d}"${attributes} />${text.slice(element.end)}`;
}

export function transformSvgElement(
  element: SvgSourceElement,
  map: (point: SvgPoint) => SvgPoint,
  { mirrored, scale }: { mirrored: boolean; scale: number },
): SvgAttributeEdit[] {
  const name = localName(element);
  const number = (attribute: string) => numberAttribute(element, attribute);
  const point = (x: string, y: string) => map({ x: number(x), y: number(y) });
  const write = (values: Record<string, number>) => Object.entries(values).map(([key, value]) => ({ name: key, value: n(value) }));
  switch (name) {
    case "path": {
      const segments = parseSvgPathData(getSvgAttribute(element, "d") ?? "");
      if (!segments) return [];
      return pathEdit(segments.map(segment => ({
        ...segment,
        type: segment.type === "H" || segment.type === "V" ? "L" : segment.type,
        start: map(segment.start),
        points: segment.points.map(map),
        ...(segment.arc ? { arc: [segment.arc[0] * scale, segment.arc[1] * scale, segment.arc[2], segment.arc[3],
          mirrored ? 1 - segment.arc[4] : segment.arc[4]] as SvgPathSegment["arc"] } : {}),
      })));
    }
    case "line": {
      const a = point("x1", "y1");
      const b = point("x2", "y2");
      return write({ x1: a.x, y1: a.y, x2: b.x, y2: b.y });
    }
    case "circle": {
      const center = point("cx", "cy");
      return write({ cx: center.x, cy: center.y, r: number("r") * scale });
    }
    case "ellipse": {
      const center = point("cx", "cy");
      return write({ cx: center.x, cy: center.y, rx: number("rx") * scale, ry: number("ry") * scale });
    }
    case "rect": {
      const a = point("x", "y");
      const b = map({ x: number("x") + number("width"), y: number("y") + number("height") });
      return write({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) });
    }
    case "polyline": case "polygon": {
      const numbers = [...(getSvgAttribute(element, "points") ?? "").matchAll(NUMBER_PATTERN)].map(match => Number(match[0]));
      const points: SvgPoint[] = [];
      for (let index = 0; index + 1 < numbers.length; index += 2) points.push(map({ x: numbers[index]!, y: numbers[index + 1]! }));
      return [{ name: "points", value: points.map(item => `${n(item.x)},${n(item.y)}`).join(" ") }];
    }
    default: return [];
  }
}

export function circlifySvgSegments(text: string, element: SvgSourceElement, selected: ReadonlySet<number>): string | null {
  const arcs = getSvgSegments(element).filter(segment => selected.has(segment.index) && segment.circle && segment.kind === "arc");
  if (!arcs.length || localName(element) !== "path") return null;
  const circles: SvgArcCircle[] = [];
  for (const arc of arcs) {
    if (!circles.some(circle => Math.hypot(circle.x - arc.circle!.x, circle.y - arc.circle!.y) < 0.01 && Math.abs(circle.r - arc.circle!.r) < 0.01)) {
      circles.push(arc.circle!);
    }
  }
  const onCircle = new Set(getSvgSegments(element).filter(segment => segment.circle && circles.some(circle =>
    Math.hypot(circle.x - segment.circle!.x, circle.y - segment.circle!.y) < 0.01 && Math.abs(circle.r - segment.circle!.r) < 0.01))
    .map(segment => segment.index));
  const indent = text.slice(text.lastIndexOf("\n", element.start - 1) + 1, element.start).replace(/\S.*$/u, "");
  const markup = circles.map(circle => `\n${indent}<circle cx="${n(circle.x)}" cy="${n(circle.y)}" r="${n(circle.r)}" />`).join("");
  const withCircles = text.slice(0, element.end) + markup + text.slice(element.end);
  return deleteSvgSegments(withCircles, element, onCircle);
}
