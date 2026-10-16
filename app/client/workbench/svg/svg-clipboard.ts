/*
 * Exports:
 * - SvgSelectionByElement: selected segment indices per element index.
 * - svgSelectionMarkup: standalone `<svg>` text for the selection (whole elements verbatim, partial paths extracted).
 * - insertSvgMarkup: insert pasted or drawn elements before the root's closing tag, returning the new element indices.
 * - svgInsertIndent: indentation used for new top-level children.
 */
import { extractSvgSegmentsPath, getSvgSegments } from "./svg-segments";
import { parseSvgSource, type SvgSourceElement } from "./svg-source";

/** Selected segment indices per element; null selects a whole element without segments. */
export type SvgSelectionByElement = ReadonlyMap<number, ReadonlySet<number> | null>;

type ParsedSvg = Extract<ReturnType<typeof parseSvgSource>, { ok: true }>;

const GEOMETRY_ATTRIBUTES = new Set(["x", "y", "width", "height", "rx", "ry", "cx", "cy", "r", "x1", "y1", "x2", "y2", "points", "d"]);

function rootOpenTag(text: string, root: SvgSourceElement) {
  return root.selfClosing ? `${text.slice(root.start, root.openTagClose).trimEnd()}>` : text.slice(root.start, root.openTagEnd);
}

export function svgSelectionMarkup(text: string, document: ParsedSvg, selection: SvgSelectionByElement) {
  const children: string[] = [];
  for (const element of document.elements) {
    const indices = selection.get(element.index);
    if (indices === undefined || (element.parentIndex !== null && selection.has(element.parentIndex))) continue;
    const segments = getSvgSegments(element);
    if (indices === null || !segments.length || segments.every(segment => indices.has(segment.index))) {
      children.push(text.slice(element.start, element.end));
      continue;
    }
    const attributes = element.attributes.filter(attribute => !GEOMETRY_ATTRIBUTES.has(attribute.name))
      .map(attribute => ` ${text.slice(attribute.start, attribute.end).trim()}`).join("");
    children.push(`<path d="${extractSvgSegmentsPath(element, indices)}"${attributes} />`);
  }
  return `${rootOpenTag(text, document.root)}\n${children.map(child => `  ${child}`).join("\n")}\n</svg>\n`;
}

export function svgInsertIndent(text: string, root: SvgSourceElement) {
  const firstChild = root.children.find(child => child.kind === "element");
  if (firstChild?.kind !== "element") return "  ";
  const lineStart = text.lastIndexOf("\n", firstChild.element.start - 1) + 1;
  const before = text.slice(lineStart, firstChild.element.start);
  return before.trim() ? "  " : before;
}

/** `markup` may be a whole `<svg>` (its children are inserted) or bare elements. */
export function insertSvgMarkup(text: string, document: ParsedSvg, markup: string): { text: string; indices: number[] } | null {
  const trimmed = markup.trim();
  const sourceText = parseSvgSource(trimmed).ok ? trimmed : `<svg>${trimmed}</svg>`;
  const wrapped = parseSvgSource(sourceText);
  if (!wrapped.ok) return null;
  const pieces = wrapped.root.children.flatMap(child =>
    child.kind === "element" ? [sourceText.slice(child.element.start, child.element.end)] : []);
  if (!pieces.length) return null;
  const root = document.root;
  const indent = svgInsertIndent(text, root);
  const block = pieces.map(piece => `${indent}${piece}`).join("\n");
  let next: string;
  let insertAt: number;
  if (root.selfClosing) {
    const open = `${text.slice(root.start, root.openTagClose).trimEnd()}>\n`;
    insertAt = root.start + open.length;
    next = `${text.slice(0, root.start)}${open}${block}\n</svg>${text.slice(root.end)}`;
  } else {
    const close = text.lastIndexOf("</", root.end - 1);
    const lineStart = text.lastIndexOf("\n", close - 1) + 1;
    const onOwnLine = !text.slice(lineStart, close).trim();
    insertAt = onOwnLine ? lineStart : close;
    const inserted = onOwnLine ? `${block}\n` : `\n${block}\n`;
    next = text.slice(0, insertAt) + inserted + text.slice(insertAt);
  }
  const reparsed = parseSvgSource(next);
  if (!reparsed.ok) return null;
  const end = insertAt + block.length + 2;
  const indices = reparsed.elements
    .filter(element => element.start >= insertAt && element.start <= end && element.parentIndex === reparsed.root.index)
    .map(element => element.index);
  return { text: next, indices };
}
