/*
 * Exports:
 * - getWorkbenchTooltipPosition: center a right-side tooltip and clamp it inside vertical viewport gutters. Keywords: tooltip, portal, position, viewport.
 * - isPointWithinWorkbenchTooltipArea: test trigger and optional interactive-surface pointer proximity. Keywords: tooltip, hover, proximity, interaction.
 */

const TOOLTIP_ANCHOR_GAP_PX = 8;
const TOOLTIP_VIEWPORT_GUTTER_PX = 12;

type TooltipRect = Pick<DOMRect, "bottom" | "height" | "left" | "right" | "top" | "width">;

function pointWithinExpandedRect(x: number, y: number, rect: TooltipRect, distance: number) {
  return x >= rect.left - distance
    && x <= rect.right + distance
    && y >= rect.top - distance
    && y <= rect.bottom + distance;
}

export function isPointWithinWorkbenchTooltipArea(
  x: number,
  y: number,
  triggerRect: TooltipRect,
  tooltipRect: TooltipRect | null,
  hoverDistancePx: number,
  interactive: boolean,
) {
  return pointWithinExpandedRect(x, y, triggerRect, hoverDistancePx)
    || Boolean(interactive && tooltipRect && pointWithinExpandedRect(x, y, tooltipRect, hoverDistancePx));
}

export function getWorkbenchTooltipPosition({
  anchorGapPx = TOOLTIP_ANCHOR_GAP_PX,
  tooltipHeight,
  triggerRect,
  viewportGutterPx = TOOLTIP_VIEWPORT_GUTTER_PX,
  viewportHeight,
  viewportWidth,
}: {
  anchorGapPx?: number;
  tooltipHeight: number;
  triggerRect: TooltipRect;
  viewportGutterPx?: number;
  viewportHeight: number;
  viewportWidth: number;
}) {
  const left = triggerRect.right + anchorGapPx;
  const maxHeight = Math.max(0, viewportHeight - viewportGutterPx * 2);
  const measuredHeight = Math.min(Math.max(tooltipHeight, 0), maxHeight);
  const idealTop = triggerRect.top + (triggerRect.height - measuredHeight) / 2;
  const maximumTop = Math.max(viewportGutterPx, viewportHeight - measuredHeight - viewportGutterPx);
  return {
    left,
    maxHeight,
    maxWidth: Math.max(0, viewportWidth - left - viewportGutterPx),
    top: Math.min(Math.max(idealTop, viewportGutterPx), maximumTop),
  };
}
