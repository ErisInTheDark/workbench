/*
 * Exports:
 * - areDeeplyEqual: compare JSON-like object graphs structurally without serialization. Keywords: equality, structural, compare.
 */

export function areDeeplyEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true;
  }

  if (
    left === null
    || right === null
    || typeof left !== "object"
    || typeof right !== "object"
  ) {
    return false;
  }

  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }

    return left.every((value, index) => areDeeplyEqual(value, right[index]));
  }

  const leftPrototype = Object.getPrototypeOf(left);
  const rightPrototype = Object.getPrototypeOf(right);
  if (leftPrototype !== Object.prototype || rightPrototype !== Object.prototype) {
    return false;
  }

  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }

  const rightKeySet = new Set(rightKeys);
  for (const key of leftKeys) {
    if (!rightKeySet.has(key) || !areDeeplyEqual(leftRecord[key], rightRecord[key])) {
      return false;
    }
  }

  return true;
}
