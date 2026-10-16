/*
 * Exports:
 * - SvgParsedDocument: a well-formed parse result.
 * - topLevelSelection: selected elements, dropping those inside another selected element, last in the source first (safe splice order).
 * - moveSvgSelection: move selected segments, or whole elements (shapes translate, others gain a translate transform).
 * - deleteSvgSelection: remove selected segments and elements.
 * - duplicateSvgSelection: copy the selection to the end of the root, returning the copies' element indices.
 * - transformSvgSelection: map every point of the selected (or all) elements, e.g. flips and canvas scaling.
 */
import { getSvgShape } from "./svg-geometry";
import { formatSvgNumber, type SvgPoint } from "./svg-path-data";
import { insertSvgMarkup, svgSelectionMarkup, type SvgSelectionByElement } from "./svg-clipboard";
import { applySvgAttributeEdits, removeSvgElement } from "./svg-source-edits";
import { deleteSvgSegments, getSvgSegments, moveSvgSegments, transformSvgElement } from "./svg-segments";
import { getSvgAttribute, parseSvgSource, type SvgSourceElement } from "./svg-source";

export type SvgParsedDocument = Extract<ReturnType<typeof parseSvgSource>, { ok: true }>;

export function topLevelSelection(document: SvgParsedDocument, selection: SvgSelectionByElement) {
  const isSelectedAncestor = (element: SvgSourceElement): boolean => {
    for (let parent = element.parentIndex; parent !== null; parent = document.elements[parent]?.parentIndex ?? null) {
      if (selection.has(parent) && selection.get(parent) === null) return true;
    }
    return false;
  };
  return document.elements
    .filter(element => element.index > 0 && selection.has(element.index) && !isSelectedAncestor(element))
    .sort((left, right) => right.start - left.start);
}

function isWhole(element: SvgSourceElement, indices: ReadonlySet<number> | null | undefined) {
  if (!indices) return true;
  const segments = getSvgSegments(element);
  return !segments.length || segments.every(segment => indices.has(segment.index));
}

export function moveSvgSelection(
  text: string,
  document: SvgParsedDocument,
  selection: SvgSelectionByElement,
  localDelta: (element: SvgSourceElement) => SvgPoint,
) {
  let next = text;
  for (const element of topLevelSelection(document, selection)) {
    const indices = selection.get(element.index);
    const delta = localDelta(element);
    if (!delta.x && !delta.y) continue;
    if (!isWhole(element, indices)) {
      next = applySvgAttributeEdits(next, element, moveSvgSegments(element, indices!, delta));
      continue;
    }
    const shape = getSvgShape(element);
    const edits = shape?.translate(delta)
      ?? [{ name: "transform", value: `translate(${formatSvgNumber(delta.x)} ${formatSvgNumber(delta.y)}) ${getSvgAttribute(element, "transform") ?? ""}`.trim() }];
    next = applySvgAttributeEdits(next, element, edits);
  }
  return next;
}

export function deleteSvgSelection(text: string, document: SvgParsedDocument, selection: SvgSelectionByElement) {
  let next = text;
  for (const element of topLevelSelection(document, selection)) {
    const indices = selection.get(element.index);
    next = isWhole(element, indices) ? removeSvgElement(next, element) : deleteSvgSegments(next, element, indices!);
  }
  return next;
}

export function duplicateSvgSelection(text: string, document: SvgParsedDocument, selection: SvgSelectionByElement) {
  return insertSvgMarkup(text, document, svgSelectionMarkup(text, document, selection));
}

export function transformSvgSelection(
  text: string,
  document: SvgParsedDocument,
  selection: SvgSelectionByElement | null,
  map: (point: SvgPoint) => SvgPoint,
  options: { mirrored: boolean; scale: number },
) {
  const targets = selection
    ? topLevelSelection(document, selection)
    : document.elements.filter(element => element.index > 0).sort((left, right) => right.start - left.start);
  let next = text;
  for (const element of targets) next = applySvgAttributeEdits(next, element, transformSvgElement(element, map, options));
  return next;
}
