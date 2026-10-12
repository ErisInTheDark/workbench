/*
 * Exports:
 * - VisualViewportMetrics: viewport offset and size values normalized across visualViewport-aware and fallback browsers. Keywords: workbench, viewport, metrics, geometry, mobile.
 * - getCollapsedRangeRect: measure a caret range, inserting a temporary marker when the browser reports no box.
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

export function getCollapsedRangeRect(range: Range) {
  const directRect = range.getBoundingClientRect();
  if (directRect.height > 0) {
    return directRect;
  }

  const rects = range.getClientRects();
  if (rects.length > 0 && rects[0].height > 0) {
    return rects[0];
  }

  const marker = document.createElement("span");
  marker.textContent = "\u200b";
  marker.dataset.caretMeasure = "true";
  marker.style.position = "relative";
  marker.style.display = "inline-block";
  marker.style.width = "0";
  marker.style.overflow = "hidden";
  marker.style.pointerEvents = "none";
  marker.style.lineHeight = "inherit";

  const measurementRange = range.cloneRange();
  measurementRange.insertNode(marker);
  const markerRect = marker.getBoundingClientRect();
  marker.remove();
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  return markerRect;
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
