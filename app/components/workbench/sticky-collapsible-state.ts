/*
 * Exports:
 * - StickyCollapsiblePlacement: identify the stable composer host's inline or sticky slot.
 * - resolveStickyCollapsiblePlacement: keep non-scrollable content inline and apply bottom release and geometric hysteresis.
 */

export type StickyCollapsiblePlacement = "inline" | "sticky";

export function resolveStickyCollapsiblePlacement({
  currentPlacement,
  hasScrollableOverflow,
  inlineSlotTop,
  isNearScrollBottom,
  scrollTargetBottom,
  stickyComposerTop,
  viewportBottom,
}: {
  currentPlacement: StickyCollapsiblePlacement;
  hasScrollableOverflow: boolean;
  inlineSlotTop: number;
  isNearScrollBottom: boolean;
  scrollTargetBottom: number | null;
  stickyComposerTop: number | null;
  viewportBottom: number;
}): StickyCollapsiblePlacement {
  if (!hasScrollableOverflow || isNearScrollBottom) return "inline";

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
