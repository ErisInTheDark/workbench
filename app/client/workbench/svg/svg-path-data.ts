/*
 * Exports:
 * - SvgPoint: one coordinate pair.
 * - SvgPathSegment: one path command with absolute start and points, its original relativity and its source range inside `d`.
 * - SvgArcCircle: centre, radius and (for rounded corners) tangent intersection of a circular arc.
 * - parseSvgPathData: parse `d` into absolute segments, or null when the data is malformed.
 * - serializeSvgPathData: write segments back, recomputing relative offsets so untouched points keep their absolute positions.
 * - svgArcCircle: centre of a circular arc segment (rx = ry), or null for elliptical arcs.
 * - formatSvgNumber: compact coordinate text rounded to three decimals.
 */

export interface SvgPoint {
  x: number;
  y: number;
}

type SvgPathCommand = "M" | "L" | "H" | "V" | "C" | "S" | "Q" | "T" | "A" | "Z";

export interface SvgPathSegment {
  type: SvgPathCommand;
  relative: boolean;
  start: SvgPoint;
  /** Absolute control points then end point; Z holds its subpath start. */
  points: SvgPoint[];
  /** rx, ry, x-axis rotation, large-arc flag, sweep flag. */
  arc?: [number, number, number, number, number];
  /** Offsets inside the `d` text, from the command letter (or first number of an implicit repeat) through its last parameter. */
  range?: { start: number; end: number };
}

export interface SvgArcCircle extends SvgPoint {
  r: number;
  tangentIntersection: SvgPoint | null;
}

const PARAMETER_COUNTS: Record<SvgPathCommand, number> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };
const NUMBER = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/y;
const SEPARATORS = /[\s,]*/y;

export function formatSvgNumber(value: number) {
  const rounded = Math.round(value * 1000) / 1000;
  return Object.is(rounded, -0) ? "0" : String(rounded);
}

export function parseSvgPathData(data: string): SvgPathSegment[] | null {
  const segments: SvgPathSegment[] = [];
  let offset = 0;
  let command: SvgPathCommand | null = null;
  let relative = false;
  let current: SvgPoint = { x: 0, y: 0 };
  let subpathStart = current;
  const skip = () => {
    SEPARATORS.lastIndex = offset;
    SEPARATORS.exec(data);
    offset = SEPARATORS.lastIndex;
  };
  const readNumber = () => {
    skip();
    NUMBER.lastIndex = offset;
    const found = NUMBER.exec(data);
    if (!found) return null;
    offset = NUMBER.lastIndex;
    return Number(found[0]);
  };
  const readFlag = () => {
    skip();
    const flag = data[offset];
    if (flag !== "0" && flag !== "1") return null;
    offset += 1;
    return Number(flag);
  };

  for (;;) {
    skip();
    if (offset >= data.length) break;
    const letter = data[offset]!;
    const start = offset;
    if (/[MLHVCSQTAZ]/iu.test(letter)) {
      command = letter.toUpperCase() as SvgPathCommand;
      relative = letter !== command;
      offset += 1;
      if (command === "Z") {
        segments.push({ type: "Z", relative, start: current, points: [subpathStart], range: { start, end: offset } });
        current = subpathStart;
        continue;
      }
    } else if (!command || command === "Z") {
      return null;
    }
    const values: number[] = [];
    for (let index = 0; index < PARAMETER_COUNTS[command]; index += 1) {
      const value = command === "A" && (index === 3 || index === 4) ? readFlag() : readNumber();
      if (value === null) return null;
      values.push(value);
    }
    const at = (x: number, y: number): SvgPoint => relative ? { x: current.x + x, y: current.y + y } : { x, y };
    const segmentStart = current;
    let points: SvgPoint[];
    switch (command) {
      case "H": points = [{ x: relative ? current.x + values[0]! : values[0]!, y: current.y }]; break;
      case "V": points = [{ x: current.x, y: relative ? current.y + values[0]! : values[0]! }]; break;
      case "A": points = [at(values[5]!, values[6]!)]; break;
      default: points = [];
        for (let index = 0; index < values.length; index += 2) points.push(at(values[index]!, values[index + 1]!));
    }
    const segment: SvgPathSegment = { type: command, relative, start: segmentStart, points, range: { start, end: offset } };
    if (command === "A") segment.arc = [values[0]!, values[1]!, values[2]!, values[3]!, values[4]!];
    segments.push(segment);
    current = points.at(-1)!;
    if (command === "M") {
      subpathStart = current;
      command = "L";
    }
  }
  return segments;
}

export function serializeSvgPathData(segments: readonly SvgPathSegment[]) {
  const parts: string[] = [];
  let current: SvgPoint = { x: 0, y: 0 };
  let subpathStart = current;
  for (const segment of segments) {
    const letter = segment.relative ? segment.type.toLowerCase() : segment.type;
    if (segment.type === "Z") {
      parts.push(letter);
      current = subpathStart;
      continue;
    }
    const end = segment.points.at(-1)!;
    const coordinate = (point: SvgPoint) => segment.relative
      ? [point.x - current.x, point.y - current.y]
      : [point.x, point.y];
    let values: number[];
    switch (segment.type) {
      case "H": values = [segment.relative ? end.x - current.x : end.x]; break;
      case "V": values = [segment.relative ? end.y - current.y : end.y]; break;
      case "A": values = [...segment.arc!, ...coordinate(end)]; break;
      default: values = segment.points.flatMap(coordinate);
    }
    parts.push(letter + values.map(formatSvgNumber).join(" "));
    current = segment.type === "H" ? { x: end.x, y: current.y }
      : segment.type === "V" ? { x: current.x, y: end.y }
      : end;
    if (segment.type === "M") subpathStart = current;
  }
  return parts.join("");
}

function tangentIntersection(start: SvgPoint, end: SvgPoint, center: SvgPoint): SvgPoint | null {
  const t1 = { x: -(start.y - center.y), y: start.x - center.x };
  const t2 = { x: -(end.y - center.y), y: end.x - center.x };
  const determinant = t1.x * -t2.y - -t2.x * t1.y;
  if (Math.abs(determinant) < 1e-10) return null;
  const lambda = ((end.x - start.x) * -t2.y - (end.y - start.y) * -t2.x) / determinant;
  return { x: start.x + lambda * t1.x, y: start.y + lambda * t1.y };
}

/** Endpoint-to-centre conversion (SVG 1.1 F.6.5) for circular arcs. */
export function svgArcCircle(start: SvgPoint, arc: readonly [number, number, number, number, number], end: SvgPoint): SvgArcCircle | null {
  const [rawRx, rawRy, rotation, largeArc, sweep] = arc;
  if (Math.abs(Math.abs(rawRx) - Math.abs(rawRy)) > 1e-9 || !rawRx) return null;
  const phi = rotation * Math.PI / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx = (start.x - end.x) / 2;
  const dy = (start.y - end.y) / 2;
  const x1 = cos * dx + sin * dy;
  const y1 = -sin * dx + cos * dy;
  let r = Math.abs(rawRx);
  const lambda = (x1 * x1 + y1 * y1) / (r * r);
  if (lambda > 1) r *= Math.sqrt(lambda);
  const sign = largeArc === sweep ? -1 : 1;
  const factor = sign * Math.sqrt(Math.max(r * r * r * r - r * r * y1 * y1 - r * r * x1 * x1, 0) / (r * r * y1 * y1 + r * r * x1 * x1 || 1));
  const cx1 = factor * y1;
  const cy1 = -factor * x1;
  const center = {
    x: cos * cx1 - sin * cy1 + (start.x + end.x) / 2,
    y: sin * cx1 + cos * cy1 + (start.y + end.y) / 2,
  };
  return { ...center, r: Math.hypot(start.x - center.x, start.y - center.y), tangentIntersection: tangentIntersection(start, end, center) };
}
