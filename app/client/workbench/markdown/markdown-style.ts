/*
 * Exports:
 * - MarkdownStyle: the writing habits of one file that rewritten blocks keep.
 * - DEFAULT_MARKDOWN_STYLE: habits for new files and files with no evidence.
 * - detectMarkdownStyle: read a file's delimiter, bullet, ordered marker, heading, nesting and line-ending habits.
 * - applyDocumentLineStyle: give editor markdown (LF, final newline) the file's line endings and final-newline habit.
 */

export interface MarkdownStyle {
  bullet: "-" | "*" | "+";
  emphasis: "*" | "_";
  finalNewline: boolean;
  lineEnding: "\n" | "\r\n";
  /** Spaces a nested block sits in from its parent item's marker. */
  listIndent: number;
  orderedDelimiter: "." | ")";
  /** Level 1 and 2 headings are underlined (`===`, `---`) instead of `#`-prefixed. */
  setextHeadings: boolean;
  strong: "**" | "__";
}

export const DEFAULT_MARKDOWN_STYLE: MarkdownStyle = {
  bullet: "-",
  emphasis: "*",
  finalNewline: true,
  lineEnding: "\n",
  listIndent: 2,
  orderedDelimiter: ".",
  setextHeadings: false,
  strong: "**",
};

const LIST_LINE = /^( *)(?:[-*+]|\d+[.)])[ \t]+\S/u;
const SETEXT_UNDERLINE = /^ {0,3}(?:=+|-+)[ \t]*$/u;

/** Underlines directly under a text line, which is how a setext heading is written. */
function countSetextHeadings(lines: readonly string[]) {
  return lines.filter((line, index) => index > 0 && SETEXT_UNDERLINE.test(line)
    && /\S/u.test(lines[index - 1]!) && !LIST_LINE.test(lines[index - 1]!) && !/^ {0,3}(?:#|>|[-*_]{3})/u.test(lines[index - 1]!))
    .length;
}

/** The most common step in from one list line to a deeper one directly under it. */
function detectListIndent(lines: readonly string[]) {
  const steps = new Map<number, number>();
  let previousIndent: number | null = null;
  for (const line of lines) {
    const match = line.match(LIST_LINE);
    if (!match) {
      if (line.trim()) previousIndent = null;
      continue;
    }
    const indent = match[1]!.length;
    if (previousIndent !== null && indent > previousIndent) {
      steps.set(indent - previousIndent, (steps.get(indent - previousIndent) ?? 0) + 1);
    }
    previousIndent = indent;
  }
  return prefer(DEFAULT_MARKDOWN_STYLE.listIndent, [...steps]);
}

/** Code never shows writing habits, and escaped delimiters are literal text. */
function stripCode(source: string) {
  return source
    .replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}\1[^\n]*$/gmu, "")
    .replace(/(`+)[\s\S]*?\1/gu, "")
    .replace(/\\[*_]/gu, "");
}

function count(source: string, pattern: RegExp) {
  return source.match(pattern)?.length ?? 0;
}

function prefer<T>(fallback: T, candidates: Array<[T, number]>) {
  let best = fallback;
  let bestCount = 0;
  for (const [value, total] of candidates) {
    if (total > bestCount) {
      best = value;
      bestCount = total;
    }
  }
  return best;
}

export function detectMarkdownStyle(source: string): MarkdownStyle {
  const prose = stripCode(source.replaceAll("\r\n", "\n"));
  const starStrong = count(prose, /(?<![*\w])\*\*(?=[^\s*])/gu);
  const underscoreStrong = count(prose, /(?<![_\w])__(?=[^\s_])/gu);
  const starEmphasis = count(prose, /(?<![*\w])\*(?=[^\s*])/gu);
  const underscoreEmphasis = count(prose, /(?<![_\w])_(?=[^\s_])/gu);
  const lineEndings = count(source, /\r\n/gu);
  const lines = prose.split("\n");

  return {
    bullet: prefer(DEFAULT_MARKDOWN_STYLE.bullet, [
      ["-", count(prose, /^[ \t]*-[ \t]+\S/gmu)],
      ["*", count(prose, /^[ \t]*\*[ \t]+\S/gmu)],
      ["+", count(prose, /^[ \t]*\+[ \t]+\S/gmu)],
    ]),
    emphasis: prefer(DEFAULT_MARKDOWN_STYLE.emphasis, [["*", starEmphasis], ["_", underscoreEmphasis]]),
    finalNewline: source.length === 0 || /\n$/u.test(source),
    lineEnding: lineEndings > 0 && lineEndings * 2 >= count(source, /\n/gu) ? "\r\n" : "\n",
    listIndent: detectListIndent(lines),
    orderedDelimiter: prefer(DEFAULT_MARKDOWN_STYLE.orderedDelimiter, [
      [".", count(prose, /^[ \t]*\d+\.[ \t]+\S/gmu)],
      [")", count(prose, /^[ \t]*\d+\)[ \t]+\S/gmu)],
    ]),
    setextHeadings: countSetextHeadings(lines) > count(prose, /^ {0,3}#{1,2}[ \t]+\S/gmu),
    strong: prefer(DEFAULT_MARKDOWN_STYLE.strong, [["**", starStrong], ["__", underscoreStrong]]),
  };
}

export function applyDocumentLineStyle(markdown: string, style: MarkdownStyle) {
  const body = style.finalNewline ? markdown : markdown.replace(/\n$/u, "");
  return style.lineEnding === "\n" ? body : body.replaceAll("\n", "\r\n");
}
