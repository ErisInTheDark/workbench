/*
 * Exports:
 * - isStickyCollapsibleSentinelBelowVisibleBoundary: decide when a collapsible source position has moved below its visible scrollport. Keywords: sticky, collapsible, scrollport, viewport.
 * - preserveStickyCollapsibleExpandedHeight: keep the mounted surface's source footprint from shrinking across content replacement. Keywords: sticky, collapsible, height, placeholder.
 */

export function preserveStickyCollapsibleExpandedHeight(
  preservedHeight: number,
  measuredHeight: number,
) {
  return Math.max(preservedHeight, measuredHeight);
}

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
