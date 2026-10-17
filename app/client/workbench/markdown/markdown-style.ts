/*
 * Exports:
 * - MarkdownStyle: the writing habits of one file that rewritten blocks keep.
 * - DEFAULT_MARKDOWN_STYLE: habits for new files and files with no evidence.
 * - detectMarkdownStyle: read a file's delimiter, bullet and line-ending habits.
 * - applyDocumentLineStyle: give editor markdown (LF, final newline) the file's line endings and final-newline habit.
 */

export interface MarkdownStyle {
  bullet: "-" | "*" | "+";
  emphasis: "*" | "_";
  finalNewline: boolean;
  lineEnding: "\n" | "\r\n";
  strong: "**" | "__";
}

export const DEFAULT_MARKDOWN_STYLE: MarkdownStyle = {
  bullet: "-",
  emphasis: "*",
  finalNewline: true,
  lineEnding: "\n",
  strong: "**",
};

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

  return {
    bullet: prefer(DEFAULT_MARKDOWN_STYLE.bullet, [
      ["-", count(prose, /^[ \t]*-[ \t]+\S/gmu)],
      ["*", count(prose, /^[ \t]*\*[ \t]+\S/gmu)],
      ["+", count(prose, /^[ \t]*\+[ \t]+\S/gmu)],
    ]),
    emphasis: prefer(DEFAULT_MARKDOWN_STYLE.emphasis, [["*", starEmphasis], ["_", underscoreEmphasis]]),
    finalNewline: source.length === 0 || /\n$/u.test(source),
    lineEnding: lineEndings > 0 && lineEndings * 2 >= count(source, /\n/gu) ? "\r\n" : "\n",
    strong: prefer(DEFAULT_MARKDOWN_STYLE.strong, [["**", starStrong], ["__", underscoreStrong]]),
  };
}

export function applyDocumentLineStyle(markdown: string, style: MarkdownStyle) {
  const body = style.finalNewline ? markdown : markdown.replace(/\n$/u, "");
  return style.lineEnding === "\n" ? body : body.replaceAll("\n", "\r\n");
}
