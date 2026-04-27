/*
 * Exports:
 * - VisualViewportMetrics: viewport offset and size values normalized across visualViewport-aware and fallback browsers. Keywords: workbench, viewport, metrics, geometry, mobile.
 * - getEditorLineHeight: read the rendered editor line height with a font-size fallback for caret and gutter layout. Keywords: workbench, editor, line height, geometry, caret.
 * - getExpandedRangeRect: resolve a non-empty DOMRect for a range using client rect fallbacks when the primary rect collapses. Keywords: workbench, range, rect, geometry, selection.
 * - getVisualViewportMetrics: read viewport offsets and dimensions with visualViewport fallbacks. Keywords: workbench, viewport, visualViewport, geometry, toolbar.
 */

export interface VisualViewportMetrics {
  height: number;
  left: number;
  top: number;
  width: number;
}

export function getEditorLineHeight(editor: HTMLElement) {
  const computedStyle = window.getComputedStyle(editor);
  const parsedLineHeight = Number.parseFloat(computedStyle.lineHeight);
  if (Number.isFinite(parsedLineHeight)) {
    return parsedLineHeight;
  }

  const parsedFontSize = Number.parseFloat(computedStyle.fontSize);
  if (Number.isFinite(parsedFontSize)) {
    return parsedFontSize * 1.72;
  }

  return 24;
}

export function getExpandedRangeRect(range: Range) {
  const directRect = range.getBoundingClientRect();
  if (directRect.width > 0 || directRect.height > 0) {
    return directRect;
  }

  const rects = Array.from(range.getClientRects()).filter((rect) => rect.width > 0 || rect.height > 0);
  if (rects.length > 0) {
    return rects[0];
  }

  return directRect;
}

export function getVisualViewportMetrics(): VisualViewportMetrics {
  const viewport = window.visualViewport;
  return {
    height: viewport?.height ?? window.innerHeight,
    left: viewport?.offsetLeft ?? 0,
    top: viewport?.offsetTop ?? 0,
    width: viewport?.width ?? window.innerWidth,
  };
}