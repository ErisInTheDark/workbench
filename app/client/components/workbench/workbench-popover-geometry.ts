/*
 * Exports:
 * - positionWorkbenchPopover: align an above/below-anchor popup within viewport gutters; "auto" picks the roomier side, favouring above.
 */
const gutter = 12;
const gap = 8;
// Composer-adjacent triggers dominate, so above wins unless below is clearly roomier.
const aboveBias = 1.25;

export function positionWorkbenchPopover(
  anchor: { left: number; top: number; width: number; height: number },
  viewport: { width: number; height: number; left?: number; top?: number },
  desired: { width: number; height: number; align?: "center" | "end"; side?: "above" | "below" | "auto" },
) {
  const left = viewport.left ?? 0;
  const top = viewport.top ?? 0;
  const roomAbove = Math.max(0, anchor.top - gap - (top + gutter));
  const roomBelow = Math.max(0, top + viewport.height - gutter - (anchor.top + anchor.height + gap));
  const side = desired.side === "auto" ? (roomAbove * aboveBias >= roomBelow ? "above" : "below") : desired.side ?? "above";
  const sideRoom = desired.side === "auto" ? (side === "above" ? roomAbove : roomBelow) : Number.POSITIVE_INFINITY;
  const width = Math.min(desired.width, Math.max(0, viewport.width - gutter * 2));
  const height = Math.min(desired.height, Math.max(0, viewport.height - gutter * 2), sideRoom);
  const alignedLeft = desired.align === "end" ? anchor.left + anchor.width - width : anchor.left + anchor.width / 2 - width / 2;
  return {
    width,
    height,
    left: Math.max(left + gutter, Math.min(alignedLeft, left + viewport.width - gutter - width)),
    top: Math.max(top + gutter, Math.min(side === "below" ? anchor.top + anchor.height + gap : anchor.top - height - gap, top + viewport.height - gutter - height)),
  };
}
