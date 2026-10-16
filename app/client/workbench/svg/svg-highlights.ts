/*
 * Exports:
 * - SVG_SELECTED_SOURCE_CLASS: marker class on highlight runs inside the selection, for scrolling it into view.
 * - SVG_SEGMENT_PALETTE: per-segment colours shared by the canvas overlay and the source tints.
 * - SVG_SELECTED_EMPHASIS_CLASS/SVG_SELECTED_TINT_CLASS: selection outline, and the tint used when segment colours are off.
 * - SvgSourceEmphasis: one emphasised source range; overlapping ranges combine their classes in order.
 * - buildSvgHighlights: theme classes for source tokens, split around emphasis ranges so segment colours and selection layer over them.
 */
import type { SvgSourceToken, SvgSourceTokenKind } from "./svg-source";

interface SvgHighlight {
  start: number;
  end: number;
  className: string;
}

export interface SvgSourceEmphasis {
  start: number;
  end: number;
  className: string;
}

export const SVG_SELECTED_SOURCE_CLASS = "svg-source-selected";

export const SVG_SEGMENT_PALETTE = [
  { stroke: "#1982c4", sourceClass: "bg-[#1982c4] !text-white" },
  { stroke: "#4267ac", sourceClass: "bg-[#4267ac] !text-white" },
  { stroke: "#6a4c93", sourceClass: "bg-[#6a4c93] !text-white" },
  { stroke: "#b55379", sourceClass: "bg-[#b55379] !text-white" },
  { stroke: "#ff595e", sourceClass: "bg-[#ff595e] !text-white" },
  { stroke: "#ff7655", sourceClass: "bg-[#ff7655] !text-white" },
  { stroke: "#ff924c", sourceClass: "bg-[#ff924c] !text-white" },
  { stroke: "#ffae43", sourceClass: "bg-[#ffae43] !text-white" },
  { stroke: "#ffca3a", sourceClass: "bg-[#ffca3a] !text-[#3a2a00]" },
  { stroke: "#c5ca30", sourceClass: "bg-[#c5ca30] !text-[#2c2e00]" },
  { stroke: "#8ac926", sourceClass: "bg-[#8ac926] !text-white" },
  { stroke: "#52a675", sourceClass: "bg-[#52a675] !text-white" },
] as const;

/** Selection outline; combine with the tint when segment colours are off. */
// Top and bottom rules only, so adjacent highlight runs read as one band instead of a row of boxes.
export const SVG_SELECTED_EMPHASIS_CLASS = `${SVG_SELECTED_SOURCE_CLASS} shadow-[0_2px_0_var(--text),0_-2px_0_var(--text)]`;
export const SVG_SELECTED_TINT_CLASS = "bg-accent/25";

const TOKEN_CLASS_NAMES: Record<SvgSourceTokenKind, string> = {
  attribute: "text-[var(--attention)]",
  comment: "text-fg/muted italic",
  declaration: "text-fg/muted",
  error: "underline decoration-wavy decoration-danger",
  punctuation: "text-fg/muted",
  tag: "text-accent",
  value: "text-success",
};

export function buildSvgHighlights(
  text: string,
  tokens: readonly SvgSourceToken[],
  emphases: readonly SvgSourceEmphasis[],
): SvgHighlight[] {
  const boundaries = new Set<number>([0, text.length]);
  for (const token of tokens) { boundaries.add(token.start); boundaries.add(token.end); }
  for (const emphasis of emphases) { boundaries.add(emphasis.start); boundaries.add(emphasis.end); }
  const points = [...boundaries].filter(point => point >= 0 && point <= text.length).sort((left, right) => left - right);
  const highlights: SvgHighlight[] = [];
  let tokenIndex = 0;
  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index]!;
    const end = points[index + 1]!;
    while (tokens[tokenIndex] && tokens[tokenIndex]!.end <= start) tokenIndex += 1;
    const token = tokens[tokenIndex];
    const tokenClass = token && token.start <= start && end <= token.end ? TOKEN_CLASS_NAMES[token.kind] : "";
    const emphasisClasses = emphases.filter(emphasis => emphasis.start <= start && end <= emphasis.end).map(emphasis => emphasis.className);
    const className = [tokenClass, ...emphasisClasses].filter(Boolean).join(" ");
    if (!className) continue;
    const previous = highlights.at(-1);
    if (previous && previous.end === start && previous.className === className) previous.end = end;
    else highlights.push({ start, end, className });
  }
  return highlights;
}
