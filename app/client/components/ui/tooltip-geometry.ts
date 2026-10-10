/*
 * Exports:
 * - isTooltipPointerSupported: identify pointer input that can intentionally activate a hover tooltip. Keywords: tooltip, pointer, mouse, touch.
 * - TooltipPlacement: which side of its trigger a tooltip opens on.
 * - getTooltipPosition: place a tooltip beside (right) or above its trigger, clamped inside viewport gutters.
 * - isPointWithinTooltipArea: test trigger and optional interactive-surface pointer proximity. Keywords: tooltip, hover, proximity, interaction.
 */

const TOOLTIP_ANCHOR_GAP_PX = 8;
const TOOLTIP_VIEWPORT_GUTTER_PX = 12;

type TooltipRect = Pick<DOMRect, "bottom" | "height" | "left" | "right" | "top" | "width">;

export function isTooltipPointerSupported(pointerType: string) {
  return pointerType === "mouse";
}

function pointWithinExpandedRect(x: number, y: number, rect: TooltipRect, distance: number) {
  return x >= rect.left - distance
    && x <= rect.right + distance
    && y >= rect.top - distance
    && y <= rect.bottom + distance;
}

export function isPointWithinTooltipArea(
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

export type TooltipPlacement = "right" | "top";

export function getTooltipPosition({
  anchorGapPx = TOOLTIP_ANCHOR_GAP_PX,
  placement = "right",
  tooltipHeight,
  tooltipWidth = 0,
  triggerRect,
  viewportGutterPx = TOOLTIP_VIEWPORT_GUTTER_PX,
  viewportHeight,
  viewportWidth,
}: {
  anchorGapPx?: number;
  placement?: TooltipPlacement;
  tooltipHeight: number;
  /** Only top placement centres on the measured width. */
  tooltipWidth?: number;
  triggerRect: TooltipRect;
  viewportGutterPx?: number;
  viewportHeight: number;
  viewportWidth: number;
}) {
  if (placement === "top") {
    const width = Math.max(tooltipWidth, 0);
    const above = Math.max(0, triggerRect.top - anchorGapPx - viewportGutterPx);
    const below = Math.max(0, viewportHeight - triggerRect.bottom - anchorGapPx - viewportGutterPx);
    const opensAbove = tooltipHeight <= above || above >= below;
    const maxHeight = opensAbove ? above : below;
    const centred = triggerRect.left + (triggerRect.width - width) / 2;
    return {
      left: Math.max(viewportGutterPx, Math.min(centred, viewportWidth - width - viewportGutterPx)),
      maxHeight,
      maxWidth: Math.max(0, viewportWidth - viewportGutterPx * 2),
      top: opensAbove
        ? triggerRect.top - anchorGapPx - Math.min(Math.max(tooltipHeight, 0), maxHeight)
        : triggerRect.bottom + anchorGapPx,
    };
  }
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
