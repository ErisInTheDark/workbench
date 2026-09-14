/*
 * Exports:
 * - positionWorkbenchPopover: align an above/below-anchor popup within viewport gutters.
 */
export function positionWorkbenchPopover(
  anchor: { left: number; top: number; width: number; height: number },
  viewport: { width: number; height: number; left?: number; top?: number },
  desired: { width: number; height: number; align?: "center" | "end"; side?: "above" | "below" },
) {
  const gutter = 12;
  const left = viewport.left ?? 0;
  const top = viewport.top ?? 0;
  const width = Math.min(desired.width, Math.max(0, viewport.width - gutter * 2));
  const height = Math.min(desired.height, Math.max(0, viewport.height - gutter * 2));
  const alignedLeft = desired.align === "end" ? anchor.left + anchor.width - width : anchor.left + anchor.width / 2 - width / 2;
  return {
    width,
    height,
    left: Math.max(left + gutter, Math.min(alignedLeft, left + viewport.width - gutter - width)),
    top: Math.max(top + gutter, Math.min(desired.side === "below" ? anchor.top + anchor.height + 8 : anchor.top - height - 8, top + viewport.height - gutter - height)),
  };
}
