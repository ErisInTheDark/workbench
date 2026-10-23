/*
 * Exports:
 * - RipgrepOutputEntry: one printed line, flagged when it counts toward --max-results.
 * - formatRipgrepFile: render one scanned file in rg-compatible heading or flat output, windowing lines over --max-columns.
 * - formatRipgrepSize: render a byte size the way --max-filesize accepts it.
 */
import type { RipgrepQuery } from "workbench-shared/workbench/ripgrep/ripgrep-arguments";
import type { RipgrepFileScan, RipgrepLineMatch } from "./ripgrep-matcher";

export interface RipgrepOutputEntry {
  text: string;
  result: boolean;
}

export function formatRipgrepSize(bytes: number) {
  for (const [unit, size] of [["G", 1024 ** 3], ["M", 1024 ** 2], ["K", 1024]] as const) {
    if (bytes >= size && bytes % size === 0) return `${bytes / size}${unit}`;
  }
  return `${bytes}`;
}

function result(text: string): RipgrepOutputEntry {
  return { text, result: true };
}

/** A long matching line shows a window around its first match, so minified files still explain why they matched. */
function displayLine(query: RipgrepQuery, content: string, match: RipgrepLineMatch | null, firstIndex: (line: string) => number) {
  const text = query.trim ? content.trimStart() : content;
  const width = query.maxColumns;
  if (width === null || text.length <= width) return text;
  if (!match) return `[Omitted long context line of ${text.length.toLocaleString("en-US")} chars]`;
  const at = Math.max(0, firstIndex(text));
  const start = Math.max(0, Math.min(at - Math.floor(width / 3), text.length - width));
  const end = start + width;
  const before = start ? `[… ${start.toLocaleString("en-US")} chars] ` : "";
  const after = end < text.length ? ` [… ${(text.length - end).toLocaleString("en-US")} more chars on this line]` : "";
  return `${before}${text.slice(start, end)}${after}`;
}

export function formatRipgrepFile(
  query: RipgrepQuery,
  displayPath: string,
  scan: RipgrepFileScan,
  firstIndex: (line: string) => number,
): RipgrepOutputEntry[] {
  const filePrefix = query.withFilename ? `${displayPath}:` : "";
  switch (query.mode) {
    case "files-with-matches":
      return scan.matches.length ? [result(displayPath)] : [];
    case "files-without-match":
      return scan.matches.length ? [] : [result(displayPath)];
    case "count":
      return scan.matches.length ? [result(`${filePrefix}${scan.matches.length}`)] : [];
    case "count-matches": {
      const total = scan.matches.reduce((sum, match) => sum + match.count, 0);
      return total ? [result(`${filePrefix}${total}`)] : [];
    }
    default:
      break;
  }
  if (!scan.matches.length) return [];

  const heading = query.heading && query.withFilename;
  const location = (line: number, column: number | null, separator: ":" | "-") => [
    !heading && query.withFilename ? `${displayPath}${separator}` : "",
    query.lineNumbers ? `${line + 1}${separator}` : "",
    query.column && column !== null ? `${column}${separator}` : "",
  ].join("");

  const entries: RipgrepOutputEntry[] = heading ? [{ text: displayPath, result: false }] : [];
  if (query.onlyMatching) {
    if (query.invertMatch) return [];
    for (const match of scan.matches) {
      for (const text of match.texts) entries.push(result(`${location(match.line, match.column, ":")}${text}`));
    }
    return entries.length > (heading ? 1 : 0) ? entries : [];
  }

  const matchByLine = new Map(scan.matches.map(match => [match.line, match]));
  let previous = -1;
  for (const match of scan.matches) {
    const from = Math.max(0, match.line - query.beforeContext, previous + 1);
    const to = Math.min(scan.lines.length - 1, match.line + query.afterContext);
    if (previous >= 0 && from > previous + 1 && (query.beforeContext || query.afterContext)) {
      entries.push({ text: "--", result: false });
    }
    for (let line = from; line <= to; line += 1) {
      if (line <= previous) continue;
      const lineMatch = matchByLine.get(line) ?? null;
      const separator = lineMatch ? ":" : "-";
      entries.push(result(`${location(line, lineMatch?.column ?? null, separator)}${displayLine(query, scan.lines[line]!, lineMatch, firstIndex)}`));
      previous = line;
    }
  }
  return entries;
}
