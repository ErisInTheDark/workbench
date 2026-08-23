/*
 * Exports:
 * - isStickyComposerSentinelBelowVisibleBoundary: decide when the composer source position has moved below its visible scrollport. Keywords: thread, composer, sticky, scrollport, viewport.
 */

export function isStickyComposerSentinelBelowVisibleBoundary({
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
