/*
 * Exports:
 * - StickyComposerPinGeometry: measured shell, slot and viewport positions one pin decision reads.
 * - shouldPinStickyComposer: decide whether the sticky composer shell pins to the viewport or sits in its natural slot.
 */

export interface StickyComposerPinGeometry {
  /** Following the thread end keeps the shell in its docked slot. */
  docked: boolean;
  stuck: boolean;
  collapsed: boolean;
  naturalTop: number;
  shellHeight: number;
  /** Height the shell takes once pinned, for the current natural height. */
  pinnedHeight: number;
  pinLine: number;
  viewportBottom: number;
}

/**
 * How far above its pinned position the slot must rise before a pinned shell unpins. Pinning moves the composer's
 * contents (chevron column), which can change its height (a hovered field expanding); the band must outgrow such
 * changes, or each state's height flips back to the other.
 */
const UNPIN_HYSTERESIS_PX = 24;

export function shouldPinStickyComposer ({
  docked, stuck, collapsed, naturalTop, shellHeight, pinnedHeight, pinLine, viewportBottom,
}: StickyComposerPinGeometry) {
  if (docked) return false;
  // Sticky positioning already holds a pinned shell in its slot once the slot rises above the pin, so the band unpins without a jump.
  if (stuck) return naturalTop > pinLine - shellHeight - UNPIN_HYSTERESIS_PX;
  // A collapsed bar returns only once its slot is off screen.
  if (collapsed) return naturalTop >= viewportBottom;
  return naturalTop + pinnedHeight > pinLine;
}
