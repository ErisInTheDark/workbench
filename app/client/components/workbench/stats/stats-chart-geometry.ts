/*
 * Exports:
 * - chartX/chartY: map sample index and value to view-box coordinates, optionally above a floor.
 * - chartMaximum: find a nonzero scale without spreading large sample arrays.
 * - chartSegments: split lines and their filled areas at unavailable values.
 * - chartPointerIndex: invert the SVG screen transform and select the nearest sample.
 */
export function chartX(index: number, length: number) {
  return length === 1 ? 50 : index / Math.max(1, length - 1) * 100;
}

/** Values at `minimum` sit on the baseline; a zero-width band falls back to one unit so nothing divides by zero. */
export function chartY(value: number, maximum: number, minimum = 0) {
  return 34 - (value - minimum) / (maximum - minimum || 1) * 30;
}

export function chartMaximum(values: readonly (number | null)[]) {
  return values.reduce<number>((maximum, value) => Math.max(maximum, value ?? 0), 0) || 1;
}

/** Each unbroken run of values becomes a line plus the area beneath it, down to the bottom of the view box. */
export function chartSegments(values: readonly (number | null)[], maximum: number, minimum = 0) {
  const result: Array<{ area: string; line: string }> = [];
  let current: Array<{ x: number; y: number }> = [];
  const flush = () => {
    if (!current.length) return;
    const line = current.map(({ x, y }) => `${x},${y}`).join(" ");
    result.push({ line, area: `${current[0]!.x},38 ${line} ${current.at(-1)!.x},38` });
    current = [];
  };
  values.forEach((value, index) => {
    if (value === null) flush();
    else current.push({ x: chartX(index, values.length), y: chartY(value, maximum, minimum) });
  });
  flush();
  return result;
}

export function chartPointerIndex(clientX: number, clientY: number, matrix: {
  a: number; b: number; c: number; d: number; e: number; f: number;
} | null, count: number) {
  if (!matrix || count === 0) return null;
  const determinant = matrix.a * matrix.d - matrix.b * matrix.c;
  if (!determinant) return null;
  const x = (matrix.d * (clientX - matrix.e) - matrix.c * (clientY - matrix.f)) / determinant;
  return Math.round(Math.min(1, Math.max(0, x / 100)) * (count - 1));
}
