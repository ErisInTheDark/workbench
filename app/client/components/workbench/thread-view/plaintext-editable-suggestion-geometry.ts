/*
 * Exports:
 * - InlineMentionSuggestionsPortalStyle: fixed-position geometry for the inline mention popup.
 * - getInlineMentionSuggestionsPortalStyle: size and place the inline mention popup within the viewport.
 */

export interface InlineMentionSuggestionsPortalStyle {
  left: number;
  top: number;
  transform: "translateY(-100%)" | undefined;
  width: number;
}

interface Rect {
  bottom: number;
  left: number;
  top: number;
  width: number;
}

const VIEWPORT_GUTTER_PX = 8;
const ANCHOR_GAP_PX = 8;

export function getInlineMentionSuggestionsPortalStyle (
  fieldRect: Rect,
  caretRect: Rect,
  placement: "above" | "below",
  viewportWidth: number,
): InlineMentionSuggestionsPortalStyle {
  const availableWidth = Math.max(0, viewportWidth - VIEWPORT_GUTTER_PX * 2);
  const width = Math.min(Math.max(fieldRect.width, 0), availableWidth);
  const maxLeft = Math.max(VIEWPORT_GUTTER_PX, viewportWidth - width - VIEWPORT_GUTTER_PX);
  const left = Math.min(Math.max(fieldRect.left, VIEWPORT_GUTTER_PX), maxLeft);
  const top = placement === "above"
    ? caretRect.top - ANCHOR_GAP_PX
    : caretRect.bottom + ANCHOR_GAP_PX;

  return {
    left,
    top,
    transform: placement === "above" ? "translateY(-100%)" : undefined,
    width,
  };
}
