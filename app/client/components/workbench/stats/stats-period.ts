/*
 * Exports:
 * - StatsPeriodSelection: picked activity buckets, as bucket starts, with the bucket that shift-clicks extend from.
 * - nextStatsPeriod: apply one click or shift-click on a bucket to the current selection.
 */

export interface StatsPeriodSelection {
  anchor: number;
  from: number;
  to: number;
}

/** A click picks one bucket, or clears it when it is already the whole selection; shift extends from the anchor. */
export function nextStatsPeriod(current: StatsPeriodSelection | null, startedAt: number, extend: boolean): StatsPeriodSelection | null {
  if (extend && current) {
    return { anchor: current.anchor, from: Math.min(current.anchor, startedAt), to: Math.max(current.anchor, startedAt) };
  }
  if (current && current.from === startedAt && current.to === startedAt) return null;
  return { anchor: startedAt, from: startedAt, to: startedAt };
}
