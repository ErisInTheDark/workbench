/*
 * Exports:
 * - SVG_SELECTED_SOURCE_CLASS: marker class on highlight runs inside the selected element, for scrolling it into view.
 * - buildSvgHighlights: theme classes for source tokens, split so the selected element's range also gets a tint.
 */
import type { SvgSourceToken, SvgSourceTokenKind } from "./svg-source";

interface SvgHighlight {
  start: number;
  end: number;
  className: string;
}

export const SVG_SELECTED_SOURCE_CLASS = "svg-source-selected";

const TOKEN_CLASS_NAMES: Record<SvgSourceTokenKind, string> = {
  attribute: "text-[var(--attention)]",
  comment: "text-fg/muted italic",
  declaration: "text-fg/muted",
  error: "underline decoration-wavy decoration-danger",
  punctuation: "text-fg/muted",
  tag: "text-accent",
  value: "text-success",
};

const SELECTED_CLASS_NAME = `${SVG_SELECTED_SOURCE_CLASS} bg-accent/12`;

export function buildSvgHighlights(
  text: string,
  tokens: readonly SvgSourceToken[],
  selection: { start: number; end: number } | null,
): SvgHighlight[] {
  const boundaries = new Set<number>([0, text.length]);
  for (const token of tokens) { boundaries.add(token.start); boundaries.add(token.end); }
  if (selection) { boundaries.add(selection.start); boundaries.add(selection.end); }
  const points = [...boundaries].filter(point => point >= 0 && point <= text.length).sort((left, right) => left - right);
  const highlights: SvgHighlight[] = [];
  let tokenIndex = 0;
  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index]!;
    const end = points[index + 1]!;
    while (tokens[tokenIndex] && tokens[tokenIndex]!.end <= start) tokenIndex += 1;
    const token = tokens[tokenIndex];
    const tokenClass = token && token.start <= start && end <= token.end ? TOKEN_CLASS_NAMES[token.kind] : "";
    const selected = selection !== null && selection.start <= start && end <= selection.end;
    const className = [tokenClass, selected ? SELECTED_CLASS_NAME : ""].filter(Boolean).join(" ");
    if (!className) continue;
    const previous = highlights.at(-1);
    if (previous && previous.end === start && previous.className === className) previous.end = end;
    else highlights.push({ start, end, className });
  }
  return highlights;
}
