/*
 * Exports:
 * - reuseEqual: keep the previous value when the next one is structurally equal.
 * - reuseEntries: keep each record value that is structurally unchanged, and the previous record when all are.
 * - reuseKeyed: keep each keyed list item that is structurally unchanged, and the previous list when all are in place.
 */
import { areDeeplyEqual } from "workbench-shared/workbench/deep-equality";

export function reuseEqual<Value>(previous: Value, next: Value) {
  return areDeeplyEqual(previous, next) ? previous : next;
}

export function reuseEntries<Value>(previous: Readonly<Record<string, Value>>, next: Readonly<Record<string, Value>>) {
  const keys = Object.keys(next);
  let same = keys.length === Object.keys(previous).length;
  const merged: Record<string, Value> = {};
  for (const key of keys) {
    const kept = key in previous && areDeeplyEqual(previous[key], next[key]) ? previous[key]! : next[key]!;
    if (kept !== previous[key]) same = false;
    merged[key] = kept;
  }
  return same ? previous : merged;
}

export function reuseKeyed<List extends readonly unknown[]>(previous: List, next: List, key: (item: List[number]) => string): List {
  const byKey = new Map(previous.map(item => [key(item), item]));
  let same = previous.length === next.length;
  const merged = next.map((item, index) => {
    const prior = byKey.get(key(item));
    const kept = prior !== undefined && areDeeplyEqual(prior, item) ? prior : item;
    if (kept !== previous[index]) same = false;
    return kept;
  });
  return same ? previous : merged as unknown as List;
}
