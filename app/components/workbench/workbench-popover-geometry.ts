/*
 * Exports:
 * - positionWorkbenchPopover: align an above-anchor popup and clamp it to viewport gutters.
 */
export function positionWorkbenchPopover(
  anchor: { left: number; top: number; width: number; height: number },
  viewport: { width: number; height: number; left?: number; top?: number },
  desired: { width: number; height: number; align?: "center" | "end" },
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
    top: Math.max(top + gutter, Math.min(anchor.top - height - 8, top + viewport.height - gutter - height)),
  };
}
