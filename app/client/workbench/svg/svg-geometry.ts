/*
 * Exports:
 * - SvgHandle: one draggable point in an element's local coordinates, with guide lines to related points.
 * - SvgAttributeEdit: one attribute value to write.
 * - SvgShape: an element's handles and the attribute edits for moving one handle or the whole element.
 * - getSvgShape: editable geometry for one element through the per-tag shape registry, or null when not editable.
 */
import { getSvgAttribute, type SvgSourceElement } from "./svg-source";
import {
  formatSvgNumber,
  parseSvgPathData,
  serializeSvgPathData,
  type SvgPathSegment,
  type SvgPoint,
} from "./svg-path-data";

export interface SvgHandle {
  id: string;
  kind: "anchor" | "control" | "radius";
  point: SvgPoint;
  links: SvgPoint[];
}

export interface SvgAttributeEdit {
  name: string;
  value: string;
}

export interface SvgShape {
  handles: SvgHandle[];
  move(handleId: string, to: SvgPoint): SvgAttributeEdit[];
  translate(delta: SvgPoint): SvgAttributeEdit[];
}

const LENGTH = /^\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)\s*(?:px)?\s*$/iu;

function length(element: SvgSourceElement, name: string, fallback: number | null = 0) {
  const raw = getSvgAttribute(element, name);
  if (raw === null) return fallback;
  const found = LENGTH.exec(raw);
  return found ? Number(found[1]) : null;
}

function lengths<const Names extends readonly string[]>(element: SvgSourceElement, names: Names) {
  const values: Record<string, number> = {};
  for (const name of names) {
    const value = length(element, name);
    if (value === null) return null;
    values[name] = value;
  }
  return values as Record<Names[number], number>;
}

function edits(values: Record<string, number>): SvgAttributeEdit[] {
  return Object.entries(values).map(([name, value]) => ({ name, value: formatSvgNumber(value) }));
}

const add = (point: SvgPoint, delta: SvgPoint) => ({ x: point.x + delta.x, y: point.y + delta.y });
const anchor = (id: string, point: SvgPoint, links: SvgPoint[] = []): SvgHandle => ({ id, kind: "anchor", point, links });

function lineShape(element: SvgSourceElement): SvgShape | null {
  const v = lengths(element, ["x1", "y1", "x2", "y2"] as const);
  if (!v) return null;
  const a = { x: v.x1, y: v.y1 };
  const b = { x: v.x2, y: v.y2 };
  return {
    handles: [anchor("a", a), anchor("b", b)],
    move: (id, to) => edits(id === "a" ? { x1: to.x, y1: to.y } : { x2: to.x, y2: to.y }),
    translate: d => edits({ x1: a.x + d.x, y1: a.y + d.y, x2: b.x + d.x, y2: b.y + d.y }),
  };
}

function pointsShape(element: SvgSourceElement): SvgShape | null {
  const numbers = (getSvgAttribute(element, "points") ?? "").trim().split(/[\s,]+/u).filter(Boolean).map(Number);
  if (numbers.length < 2 || numbers.length % 2 || numbers.some(value => !Number.isFinite(value))) return null;
  const points: SvgPoint[] = [];
  for (let index = 0; index < numbers.length; index += 2) points.push({ x: numbers[index]!, y: numbers[index + 1]! });
  const write = (next: SvgPoint[]) => [{
    name: "points", value: next.map(point => `${formatSvgNumber(point.x)},${formatSvgNumber(point.y)}`).join(" "),
  }];
  return {
    handles: points.map((point, index) => anchor(`p${index}`, point)),
    move: (id, to) => write(points.map((point, index) => `p${index}` === id ? to : point)),
    translate: d => write(points.map(point => add(point, d))),
  };
}

function circleShape(element: SvgSourceElement): SvgShape | null {
  const v = lengths(element, ["cx", "cy", "r"] as const);
  if (!v) return null;
  const center = { x: v.cx, y: v.cy };
  return {
    handles: [anchor("c", center), { id: "r", kind: "radius", point: { x: v.cx + v.r, y: v.cy }, links: [center] }],
    move: (id, to) => id === "c"
      ? edits({ cx: to.x, cy: to.y })
      : edits({ r: Math.hypot(to.x - v.cx, to.y - v.cy) }),
    translate: d => edits({ cx: v.cx + d.x, cy: v.cy + d.y }),
  };
}

function ellipseShape(element: SvgSourceElement): SvgShape | null {
  const v = lengths(element, ["cx", "cy", "rx", "ry"] as const);
  if (!v) return null;
  const center = { x: v.cx, y: v.cy };
  return {
    handles: [
      anchor("c", center),
      { id: "rx", kind: "radius", point: { x: v.cx + v.rx, y: v.cy }, links: [center] },
      { id: "ry", kind: "radius", point: { x: v.cx, y: v.cy + v.ry }, links: [center] },
    ],
    move: (id, to) => id === "c" ? edits({ cx: to.x, cy: to.y })
      : id === "rx" ? edits({ rx: Math.abs(to.x - v.cx) })
      : edits({ ry: Math.abs(to.y - v.cy) }),
    translate: d => edits({ cx: v.cx + d.x, cy: v.cy + d.y }),
  };
}

function rectShape(element: SvgSourceElement): SvgShape | null {
  const v = lengths(element, ["x", "y", "width", "height"] as const);
  if (!v) return null;
  const far = { x: v.x + v.width, y: v.y + v.height };
  return {
    handles: [anchor("tl", { x: v.x, y: v.y }), anchor("br", far)],
    move: (id, to) => {
      if (id === "br") return edits({ width: Math.max(0, to.x - v.x), height: Math.max(0, to.y - v.y) });
      const x = Math.min(to.x, far.x);
      const y = Math.min(to.y, far.y);
      return edits({ x, y, width: far.x - x, height: far.y - y });
    },
    translate: d => edits({ x: v.x + d.x, y: v.y + d.y }),
  };
}

function positionedShape(element: SvgSourceElement): SvgShape | null {
  const v = lengths(element, ["x", "y"] as const);
  if (!v) return null;
  return {
    handles: [anchor("p", { x: v.x, y: v.y })],
    move: (_id, to) => edits({ x: to.x, y: to.y }),
    translate: d => edits({ x: v.x + d.x, y: v.y + d.y }),
  };
}

function cloneSegments(segments: readonly SvgPathSegment[]): SvgPathSegment[] {
  return segments.map(segment => ({
    ...segment, start: { ...segment.start }, points: segment.points.map(point => ({ ...point })),
  }));
}

/** Points that travel with segment `index`'s end anchor: its own incoming control and the next segment's outgoing one. */
function attachedControls(segments: SvgPathSegment[], index: number) {
  const segment = segments[index]!;
  const next = segments[index + 1];
  return [
    ...segment.type === "C" ? [segment.points[1]!] : segment.type === "S" ? [segment.points[0]!] : [],
    ...next?.type === "C" ? [next.points[0]!] : [],
  ];
}

function pathShape(element: SvgSourceElement): SvgShape | null {
  const segments = parseSvgPathData(getSvgAttribute(element, "d") ?? "");
  if (!segments?.length) return null;
  const handles: SvgHandle[] = [];
  segments.forEach((segment, index) => {
    if (segment.type === "Z") return;
    const end = segment.points.at(-1)!;
    if (segment.type === "C") {
      handles.push({ id: `${index}:0`, kind: "control", point: segment.points[0]!, links: [segment.start] });
      handles.push({ id: `${index}:1`, kind: "control", point: segment.points[1]!, links: [end] });
    } else if (segment.type === "S") {
      handles.push({ id: `${index}:0`, kind: "control", point: segment.points[0]!, links: [end] });
    } else if (segment.type === "Q") {
      handles.push({ id: `${index}:0`, kind: "control", point: segment.points[0]!, links: [segment.start, end] });
    }
    handles.push(anchor(`${index}:${segment.points.length - 1}`, end));
  });
  const write = (next: SvgPathSegment[]) => [{ name: "d", value: serializeSvgPathData(next) }];
  return {
    handles,
    move: (id, to) => {
      const [segmentIndex, pointIndex] = id.split(":").map(Number) as [number, number];
      const next = cloneSegments(segments);
      const segment = next[segmentIndex];
      const point = segment?.points[pointIndex];
      if (!segment || !point) return [];
      const target = { x: segment.type === "V" ? point.x : to.x, y: segment.type === "H" ? point.y : to.y };
      if (pointIndex === segment.points.length - 1) {
        const delta = { x: target.x - point.x, y: target.y - point.y };
        for (const control of attachedControls(next, segmentIndex)) Object.assign(control, add(control, delta));
      }
      Object.assign(point, target);
      return write(next);
    },
    translate: d => {
      const next = cloneSegments(segments);
      for (const segment of next) {
        if (segment.type === "Z") continue;
        for (const point of segment.points) Object.assign(point, add(point, d));
      }
      return write(next);
    },
  };
}

const SHAPES: Record<string, (element: SvgSourceElement) => SvgShape | null> = {
  circle: circleShape,
  ellipse: ellipseShape,
  image: positionedShape,
  line: lineShape,
  path: pathShape,
  polygon: pointsShape,
  polyline: pointsShape,
  rect: rectShape,
  text: positionedShape,
  use: positionedShape,
};

export function getSvgShape(element: SvgSourceElement): SvgShape | null {
  return SHAPES[element.name.slice(element.name.indexOf(":") + 1)]?.(element) ?? null;
}
