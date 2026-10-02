/*
 * Exports:
 * - RipgrepPatternError: invalid pattern reported to the caller as a rejected search.
 * - RipgrepLineMatch/RipgrepFileScan: matched (or inverted) lines found in one file.
 * - RipgrepMatcher/compileRipgrepMatcher: compile rg-style patterns into JavaScript regex and scan file text.
 */
import type { RipgrepQuery } from "./ripgrep-arguments";

export class RipgrepPatternError extends Error {
  override readonly name = "RipgrepPatternError";
}

export interface RipgrepLineMatch {
  /** 0-based line index. */
  line: number;
  /** 1-based column of the first match, or 1 when columns were not requested. */
  column: number;
  /** Matched texts, filled only when match ranges were requested. */
  texts: string[];
  /** Number of matches on the line (1 when ranges were not requested). */
  count: number;
}

export interface RipgrepFileScan {
  lines: string[];
  matches: RipgrepLineMatch[];
}

export interface RipgrepMatcher {
  scan(text: string): RipgrepFileScan;
}

function escapeRegExp(value: string) {
  return value.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&");
}

/** Translate the common Rust-regex spellings agents use into JavaScript syntax. */
function translatePattern(pattern: string) {
  let source = pattern.replace(/\(\?P</gu, "(?<");
  const leading = /^\(\?([a-zA-Z]+)\)/u.exec(source);
  if (leading) {
    const flags = leading[1]!;
    if (/[^ims]/u.test(flags)) throw new RipgrepPatternError(`Unsupported inline flags (?${flags}); only i, m and s are available.`);
    source = `(?${flags}:${source.slice(leading[0].length)})`;
  }
  return source;
}

function hasUppercaseLiteral(pattern: string) {
  return /\p{Lu}/u.test(pattern.replace(/\\./gu, ""));
}

function splitLines(text: string) {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.map(line => line.endsWith("\r") ? line.slice(0, -1) : line);
}

function lineStartOffsets(text: string) {
  const starts = [0];
  for (let index = text.indexOf("\n"); index >= 0; index = text.indexOf("\n", index + 1)) starts.push(index + 1);
  return starts;
}

function lineAt(starts: readonly number[], offset: number) {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (starts[middle]! <= offset) low = middle;
    else high = middle - 1;
  }
  return low;
}

function buildExpression(query: RipgrepQuery, unicode: boolean) {
  const word = unicode ? "[\\p{L}\\p{N}_]" : "[A-Za-z0-9_]";
  let body = query.patterns
    .map(pattern => query.fixedStrings ? escapeRegExp(pattern) : translatePattern(pattern))
    .map(pattern => `(?:${pattern})`)
    .join("|");
  if (query.wordRegexp) body = `(?<!${word})(?:${body})(?!${word})`;
  if (query.lineRegexp) body = `^(?:${body})$`;
  const insensitive = query.caseMode === "insensitive"
    || (query.caseMode === "smart" && !query.patterns.some(hasUppercaseLiteral));
  const flags = `m${insensitive ? "i" : ""}${query.multilineDotall ? "s" : ""}${unicode ? "u" : ""}`;
  return { source: body, flags };
}

function compileExpression(query: RipgrepQuery) {
  // Prefer Unicode semantics; fall back for patterns that only legacy mode accepts (like "\-" or "\:").
  let unicodeError: unknown;
  for (const unicode of [true, false]) {
    const { source, flags } = buildExpression(query, unicode);
    try {
      return { test: new RegExp(source, flags), global: new RegExp(source, `${flags}g`) };
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      unicodeError ??= error;
    }
  }
  throw new RipgrepPatternError(`Invalid regex: ${(unicodeError as SyntaxError).message}`);
}

export function compileRipgrepMatcher(query: RipgrepQuery): RipgrepMatcher {
  const expression = compileExpression(query);
  const wantRanges = query.onlyMatching || query.column || query.mode === "count-matches";
  const limit = query.maxCount ?? Number.POSITIVE_INFINITY;

  const scanLines = (text: string): RipgrepFileScan => {
    const lines = splitLines(text);
    const matches: RipgrepLineMatch[] = [];
    // A per-line match implies a whole-text match under the m flag, so this skips most files cheaply.
    if (!query.invertMatch && !expression.test.test(text)) return { lines, matches };
    for (let line = 0; line < lines.length && matches.length < limit; line += 1) {
      const content = lines[line]!;
      if (query.invertMatch) {
        if (!expression.test.test(content)) matches.push({ line, column: 1, texts: [], count: 1 });
        continue;
      }
      if (!wantRanges) {
        if (expression.test.test(content)) matches.push({ line, column: 1, texts: [], count: 1 });
        continue;
      }
      const found = [...content.matchAll(expression.global)];
      if (!found.length) continue;
      matches.push({ line, column: found[0]!.index + 1, texts: found.map(match => match[0]), count: found.length });
    }
    return { lines, matches };
  };

  const scanMultiline = (text: string): RipgrepFileScan => {
    const lines = splitLines(text);
    const starts = lineStartOffsets(text);
    const byLine = new Map<number, RipgrepLineMatch>();
    for (const match of text.matchAll(expression.global)) {
      const start = match.index;
      const end = start + match[0].length;
      const first = lineAt(starts, start);
      const last = lineAt(starts, Math.max(start, end - 1));
      const existing = byLine.get(first);
      if (existing) {
        existing.texts.push(match[0]);
        existing.count += 1;
      } else {
        if (byLine.size >= limit) break;
        byLine.set(first, { line: first, column: start - starts[first]! + 1, texts: [match[0]], count: 1 });
      }
      for (let line = first + 1; line <= last && line < lines.length; line += 1) {
        if (!byLine.has(line)) byLine.set(line, { line, column: 1, texts: [], count: 0 });
      }
    }
    if (!query.invertMatch) {
      return { lines, matches: [...byLine.values()].filter(match => match.line < lines.length).sort((a, b) => a.line - b.line) };
    }
    const matches: RipgrepLineMatch[] = [];
    for (let line = 0; line < lines.length && matches.length < limit; line += 1) {
      if (!byLine.has(line)) matches.push({ line, column: 1, texts: [], count: 1 });
    }
    return { lines, matches };
  };

  return { scan: query.multiline ? scanMultiline : scanLines };
}
