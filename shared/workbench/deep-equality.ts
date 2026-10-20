/*
 * Exports:
 * - areDeeplyEqual: compare JSON-like object graphs structurally without serialization. Keywords: equality, structural, compare.
 * - firstDeepDifference: the path of the first place two JSON-like graphs differ, or null when they are deeply equal.
 */

/** One walk serves both: with `path` undefined no path strings are built and any difference returns "". */
function difference(left: unknown, right: unknown, path: string | undefined): string | null {
  if (Object.is(left, right)) return null;
  const here = path ?? "";
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return here;

  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return path === undefined ? "" : `${path}.length`;
    }
    for (let index = 0; index < left.length; index += 1) {
      const found = difference(left[index], right[index], path === undefined ? undefined : `${path}[${index}]`);
      if (found !== null) return found;
    }
    return null;
  }

  if (Object.getPrototypeOf(left) !== Object.prototype || Object.getPrototypeOf(right) !== Object.prototype) return here;

  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  const rightKeySet = new Set(rightKeys);
  if (leftKeys.length !== rightKeys.length) {
    if (path === undefined) return "";
    const leftKeySet = new Set(leftKeys);
    const odd = leftKeys.find(key => !rightKeySet.has(key)) ?? rightKeys.find(key => !leftKeySet.has(key));
    return `${path}.${odd ?? "{keys}"}`;
  }
  for (const key of leftKeys) {
    if (!rightKeySet.has(key)) return path === undefined ? "" : `${path}.${key}`;
    const found = difference(leftRecord[key], rightRecord[key], path === undefined ? undefined : `${path}.${key}`);
    if (found !== null) return found;
  }
  return null;
}

export function areDeeplyEqual(left: unknown, right: unknown): boolean {
  return difference(left, right, undefined) === null;
}

export function firstDeepDifference(left: unknown, right: unknown): string | null {
  return difference(left, right, "$");
}
