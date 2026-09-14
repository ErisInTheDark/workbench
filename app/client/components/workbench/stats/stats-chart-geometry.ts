/*
 * Keywords: SVG, chart geometry, pointer, transforms, scale, gaps.
 * Exports:
 * - chartX/chartY: map sample index and value to view-box coordinates.
 * - chartMaximum: find a nonzero scale without spreading large sample arrays.
 * - chartSegments: split polylines at unavailable values.
 * - chartPointerIndex: invert the SVG screen transform and select the nearest sample.
 */
export function chartX(index: number, length: number) {
  return length === 1 ? 50 : index / Math.max(1, length - 1) * 100;
}

export function chartY(value: number, maximum: number) {
  return 34 - value / maximum * 30;
}

export function chartMaximum(values: readonly (number | null)[]) {
  return values.reduce<number>((maximum, value) => Math.max(maximum, value ?? 0), 0) || 1;
}

export function chartSegments(values: readonly (number | null)[], maximum: number) {
  const result: string[] = [];
  let current: string[] = [];
  values.forEach((value, index) => {
    if (value === null) {
      if (current.length) result.push(current.join(" "));
      current = [];
    } else current.push(`${chartX(index, values.length)},${chartY(value, maximum)}`);
  });
  if (current.length) result.push(current.join(" "));
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
