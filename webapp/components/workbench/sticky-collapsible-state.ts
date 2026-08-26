/*
 * Exports:
 * - isStickyCollapsibleSentinelBelowVisibleBoundary: decide when a collapsible source position has moved below its visible scrollport. Keywords: sticky, collapsible, scrollport, viewport.
 */

export function isStickyCollapsibleSentinelBelowVisibleBoundary({
  scrollTargetBottom,
  sentinelTop,
  viewportBottom,
}: {
  scrollTargetBottom: number | null;
  sentinelTop: number;
  viewportBottom: number;
}) {
  const visibleBottom = scrollTargetBottom === null
    ? viewportBottom
    : Math.min(scrollTargetBottom, viewportBottom);
  return sentinelTop >= visibleBottom;
}
