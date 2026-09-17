/*
 * Exports:
 * - WorkingTreeDiffGesture: one pointer-owned range preview.
 * - beginDiffGesture/moveDiffGesture/finishDiffGesture: preview and commit visible change groups.
 */
export interface WorkingTreeDiffGesture {
  pointerId: number;
  groups: readonly (readonly string[])[];
  anchor: number;
  end: number;
  included: boolean;
}
export function beginDiffGesture(pointerId: number, groups: readonly (readonly string[])[], anchor: number, included: boolean): WorkingTreeDiffGesture {
  return { pointerId, groups, anchor, end: anchor, included };
}
export function moveDiffGesture(gesture: WorkingTreeDiffGesture, pointerId: number, end: number) {
  return pointerId !== gesture.pointerId || end < 0 || end >= gesture.groups.length
    ? gesture : { ...gesture, end };
}
export function finishDiffGesture(gesture: WorkingTreeDiffGesture, pointerId: number, cancelled = false, releaseGroup?: number) {
  if (cancelled || pointerId !== gesture.pointerId) return null;
  const final = releaseGroup === undefined ? gesture : moveDiffGesture(gesture, pointerId, releaseGroup);
  return {
    ids: [...new Set(final.groups.slice(Math.min(final.anchor, final.end), Math.max(final.anchor, final.end) + 1).flat())],
    included: gesture.included,
  };
}
