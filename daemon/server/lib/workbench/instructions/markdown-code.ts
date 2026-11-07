/*
 * Exports:
 * - MarkdownFence: an open fenced code block's marker and run length.
 * - readMarkdownFence: the fence a line opens, or null.
 * - closesMarkdownFence: whether a line closes an open fence.
 * - skipMarkdownCodeSpan: the index after an inline code span starting at a backtick run, so markup scanners leave examples alone.
 */

export interface MarkdownFence { marker: "`" | "~"; size: number }

export function readMarkdownFence(line: string): MarkdownFence | null {
  const match = /^(?: {0,3})(`{3,}|~{3,})/u.exec(line);
  return match?.[1] ? { marker: match[1][0] as MarkdownFence["marker"], size: match[1].length } : null;
}

export function closesMarkdownFence(line: string, fence: MarkdownFence) {
  const marker = fence.marker === "`" ? "`" : "~";
  return new RegExp(`^(?: {0,3})${marker}{${fence.size},}\\s*$`, "u").test(line);
}

/** `index` must sit on a backtick; an unclosed run skips only itself. */
export function skipMarkdownCodeSpan(line: string, index: number) {
  let runEnd = index + 1;
  while (line[runEnd] === "`") runEnd += 1;
  let close = runEnd;
  while (close < line.length) {
    close = line.indexOf("`", close);
    if (close < 0) break;
    let closeEnd = close + 1;
    while (line[closeEnd] === "`") closeEnd += 1;
    if (closeEnd - close === runEnd - index) return closeEnd;
    close = closeEnd;
  }
  return runEnd;
}
