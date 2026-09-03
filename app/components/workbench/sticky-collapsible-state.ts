/*
 * Exports:
 * - StickyCollapsiblePlacement: identify whether the stable composer host occupies its inline or sticky slot. Keywords: sticky, collapsible, placement.
 * - resolveStickyCollapsiblePlacement: apply the near-bottom release and separate geometric thresholds to composer placement. Keywords: sticky, collapsible, hysteresis, viewport.
 */

export type StickyCollapsiblePlacement = "inline" | "sticky";

export function resolveStickyCollapsiblePlacement({
  currentPlacement,
  inlineSlotTop,
  isNearScrollBottom,
  scrollTargetBottom,
  stickyComposerTop,
  viewportBottom,
}: {
  currentPlacement: StickyCollapsiblePlacement;
  inlineSlotTop: number;
  isNearScrollBottom: boolean;
  scrollTargetBottom: number | null;
  stickyComposerTop: number | null;
  viewportBottom: number;
}): StickyCollapsiblePlacement {
  if (isNearScrollBottom) return "inline";

  if (currentPlacement === "inline") {
    const visibleBottom = scrollTargetBottom === null
      ? viewportBottom
      : Math.min(scrollTargetBottom, viewportBottom);
    return inlineSlotTop >= visibleBottom ? "sticky" : "inline";
  }

  return stickyComposerTop !== null && inlineSlotTop <= stickyComposerTop
    ? "inline"
    : "sticky";
}
