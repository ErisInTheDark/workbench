/*
 * Exports:
 * - SourceText: markdown source text with a selection inside it.
 * - SourceFormats: the block and inline formats the toolbar shows as active at a source selection.
 * - SourceCommandContext: the file's writing habits and the comment author source commands write with.
 * - applySourceCommand: run a toolbar format or comment command on markdown source text.
 * - readSourceFormats: the formats a source selection sits in.
 * - continueSourceBlock: Enter inside a list item or quote line starts the next one, or ends an empty one.
 * - indentSourceLines: Tab and Shift+Tab: indent or outdent the touched lines, or indent at a collapsed caret.
 * - forkSourceSuggestion: in suggest mode, turn the blocks an edit touches into a suggestion whose new side the edit lands in.
 */

import { normalizeCommentAuthor } from "./comment-markdown";
import { parseSourcedBlocks } from "./markdown-parse";
import type { MarkdownStyle } from "./markdown-style";
import { formatSuggestion } from "./markdown-suggestion";

export interface SourceText {
  end: number;
  start: number;
  text: string;
}

export type SourceBlockFormat = "paragraph" | "h1" | "h2" | "h3" | "blockquote" | "ul" | "ol" | "code" | "table";

export interface SourceFormats {
  block: SourceBlockFormat;
  inline: { bold: boolean; code: boolean; del: boolean; ins: boolean; italic: boolean };
}

export interface SourceCommandContext {
  author: string | null;
  style: MarkdownStyle;
}

export type SourceCommand =
  | "bold" | "italic" | "inline-code" | "del" | "ins"
  | "h1" | "h2" | "h3" | "quote" | "unordered-list" | "ordered-list"
  | "code-block" | "table" | "comment";

const HEADING = /^ {0,3}(#{1,6})[ \t]+/u;
const QUOTE = /^ {0,3}>[ \t]?/u;
const BULLET = /^([ \t]*)([-*+])[ \t]+/u;
const ORDERED = /^([ \t]*)(\d+)([.)])[ \t]+/u;
const FENCE = /^ {0,3}(`{3,}|~{3,})/u;
const TABLE_LINE = /^ {0,3}\|/u;

function lineStartOf(text: string, offset: number) {
  return text.lastIndexOf("\n", offset - 1) + 1;
}

function lineEndOf(text: string, offset: number) {
  const end = text.indexOf("\n", offset);
  return end === -1 ? text.length : end;
}

/** The whole lines a selection touches; a selection ending at a line start leaves that line out. */
function touchedLines(source: SourceText) {
  const from = lineStartOf(source.text, source.start);
  const lastOffset = source.end > source.start && source.text[source.end - 1] === "\n" ? source.end - 1 : source.end;
  const to = lineEndOf(source.text, lastOffset);
  return { from, lines: source.text.slice(from, to).split("\n"), to };
}

/** Replace the touched lines, keeping the selection over the same text as the lines' starts shift. */
function rewriteLines(source: SourceText, rewrite: (line: string, index: number, lines: readonly string[]) => string): SourceText {
  const { from, lines, to } = touchedLines(source);
  const nextLines = lines.map(rewrite);
  const firstShift = nextLines[0]!.length - lines[0]!.length;
  const totalShift = nextLines.join("\n").length - lines.join("\n").length;
  const text = `${source.text.slice(0, from)}${nextLines.join("\n")}${source.text.slice(to)}`;
  return {
    end: Math.max(from, source.end + totalShift),
    start: Math.max(from, source.start + firstShift),
    text,
  };
}

function toggleWrap(source: SourceText, open: string, close: string): SourceText {
  const { end, start, text } = source;
  const selected = text.slice(start, end);
  if (selected.length >= open.length + close.length && selected.startsWith(open) && selected.endsWith(close)) {
    const inner = selected.slice(open.length, selected.length - close.length);
    return { end: start + inner.length, start, text: `${text.slice(0, start)}${inner}${text.slice(end)}` };
  }
  if (text.slice(0, start).endsWith(open) && text.slice(end).startsWith(close)) {
    return {
      end: end - open.length,
      start: start - open.length,
      text: `${text.slice(0, start - open.length)}${selected}${text.slice(end + close.length)}`,
    };
  }
  return {
    end: end + open.length,
    start: start + open.length,
    text: `${text.slice(0, start)}${open}${selected}${close}${text.slice(end)}`,
  };
}

function stripBlockPrefix(line: string) {
  return line.replace(HEADING, "").replace(QUOTE, "");
}

function toggleHeading(source: SourceText, level: number) {
  const { lines } = touchedLines(source);
  const content = lines.filter((line) => line.trim());
  const allAtLevel = content.length > 0 && content.every((line) => line.match(HEADING)?.[1]!.length === level);
  return rewriteLines(source, (line) => {
    if (!line.trim()) return line;
    const stripped = stripBlockPrefix(line);
    return allAtLevel ? stripped : `${"#".repeat(level)} ${stripped}`;
  });
}

function toggleQuote(source: SourceText) {
  const { lines } = touchedLines(source);
  const quoted = lines.filter((line) => line.trim()).every((line) => QUOTE.test(line));
  return rewriteLines(source, (line) => quoted ? line.replace(QUOTE, "") : line.trim() ? `> ${line}` : ">");
}

function stripListMarker(line: string) {
  return line.replace(BULLET, "$1").replace(ORDERED, "$1");
}

function toggleList(source: SourceText, ordered: boolean, style: MarkdownStyle) {
  const { lines } = touchedLines(source);
  const content = lines.filter((line) => line.trim());
  const pattern = ordered ? ORDERED : BULLET;
  const already = content.length > 0 && content.every((line) => pattern.test(line));
  let ordinal = 0;
  return rewriteLines(source, (line) => {
    if (!line.trim()) return line;
    const bare = stripListMarker(line);
    if (already) return bare;
    const indent = bare.match(/^[ \t]*/u)![0];
    ordinal += 1;
    const marker = ordered ? `${ordinal}${style.orderedDelimiter}` : style.bullet;
    return `${indent}${marker} ${bare.slice(indent.length)}`;
  });
}

function toggleCodeFence(source: SourceText): SourceText {
  const { from, lines, to } = touchedLines(source);
  const fenced = lines.length >= 2 && FENCE.test(lines[0]!) && FENCE.test(lines.at(-1)!);
  if (fenced) {
    const inner = lines.slice(1, -1).join("\n");
    const text = `${source.text.slice(0, from)}${inner}${source.text.slice(to)}`;
    return { end: from + inner.length, start: from, text };
  }
  const body = lines.join("\n");
  const text = `${source.text.slice(0, from)}\`\`\`\n${body}\n\`\`\`${source.text.slice(to)}`;
  const caret = from + 4 + body.length;
  return { end: caret, start: body ? from + 4 : caret, text };
}

/** A two-column table under the touched lines, set off by blank lines, with the caret in its first header cell. */
function insertTable(source: SourceText): SourceText {
  const { to } = touchedLines(source);
  const before = source.text.slice(0, to);
  const after = source.text.slice(to);
  const lead = before.trim() ? (before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n") : "";
  const table = "|  |  |\n| --- | --- |\n|  |  |";
  const trail = after.replace(/^\n/u, "").trim() ? "\n" : "";
  const caret = before.length + lead.length + 2;
  return { end: caret, start: caret, text: `${before}${lead}${table}${trail}${after}` };
}

function insertComment(source: SourceText, author: string | null): SourceText {
  const name = normalizeCommentAuthor(author);
  const open = `<!-- ${name ? `[${name}]: ` : ""}`;
  const selected = source.text.slice(source.start, source.end);
  const anchor = selected ? `<mark>${selected}</mark>` : "";
  const before = `${source.text.slice(0, source.start)}${anchor}${open}`;
  const caret = before.length;
  return { end: caret, start: caret, text: `${before} -->${source.text.slice(source.end)}` };
}

export function applySourceCommand(source: SourceText, command: SourceCommand, context: SourceCommandContext): SourceText {
  switch (command) {
    case "bold":
      return toggleWrap(source, context.style.strong, context.style.strong);
    case "italic":
      return toggleWrap(source, context.style.emphasis, context.style.emphasis);
    case "inline-code":
      return toggleWrap(source, "`", "`");
    case "del":
      return toggleWrap(source, "<del>", "</del>");
    case "ins":
      return toggleWrap(source, "<ins>", "</ins>");
    case "h1":
      return toggleHeading(source, 1);
    case "h2":
      return toggleHeading(source, 2);
    case "h3":
      return toggleHeading(source, 3);
    case "quote":
      return toggleQuote(source);
    case "unordered-list":
      return toggleList(source, false, context.style);
    case "ordered-list":
      return toggleList(source, true, context.style);
    case "code-block":
      return toggleCodeFence(source);
    case "table":
      return insertTable(source);
    case "comment":
      return insertComment(source, context.author);
  }
}

function isInsideFence(text: string, lineStart: number) {
  let open = false;
  for (const line of text.slice(0, lineStart).split("\n")) {
    if (FENCE.test(line)) open = !open;
  }
  return open;
}

function countOutside(prefix: string, token: string) {
  return prefix.split(token).length - 1;
}

export function readSourceFormats(source: SourceText, style: MarkdownStyle): SourceFormats {
  const lineStart = lineStartOf(source.text, source.start);
  const line = source.text.slice(lineStart, lineEndOf(source.text, source.start));
  const prefix = source.text.slice(lineStart, source.start);
  const inCode = isInsideFence(source.text, lineStart) || FENCE.test(line);
  const heading = line.match(HEADING)?.[1]!.length;
  const block: SourceBlockFormat = inCode ? "code"
    : heading === 1 ? "h1" : heading === 2 ? "h2" : heading === 3 ? "h3"
      : QUOTE.test(line) ? "blockquote"
        : BULLET.test(line) ? "ul"
          : ORDERED.test(line) ? "ol"
            : TABLE_LINE.test(line) ? "table"
              : "paragraph";
  const outsideCode = prefix.replace(/`[^`]*`/gu, "");
  const strongCount = countOutside(outsideCode, style.strong);
  const withoutStrong = outsideCode.replaceAll(style.strong, "");
  const lastOpen = (tag: string) => prefix.lastIndexOf(`<${tag}>`) > prefix.lastIndexOf(`</${tag}>`);
  return {
    block,
    inline: {
      bold: !inCode && strongCount % 2 === 1,
      code: !inCode && countOutside(prefix, "`") % 2 === 1,
      del: !inCode && lastOpen("del"),
      ins: !inCode && lastOpen("ins"),
      italic: !inCode && countOutside(withoutStrong, style.emphasis) % 2 === 1,
    },
  };
}

/** Enter in a list item or quote line: the next line continues it, or an empty one ends. Null leaves Enter alone. */
export function continueSourceBlock(source: SourceText): SourceText | null {
  if (source.start !== source.end) return null;
  const lineStart = lineStartOf(source.text, source.start);
  if (isInsideFence(source.text, lineStart)) return null;
  const line = source.text.slice(lineStart, lineEndOf(source.text, source.start));
  const bullet = line.match(BULLET);
  const ordered = line.match(ORDERED);
  const quote = line.match(QUOTE);
  const marker = bullet?.[0] ?? ordered?.[0] ?? quote?.[0];
  if (!marker || source.start - lineStart < marker.length) return null;

  if (!line.slice(marker.length).trim()) {
    const text = `${source.text.slice(0, lineStart)}${source.text.slice(lineStart + line.length)}`;
    return { end: lineStart, start: lineStart, text };
  }

  const next = ordered
    ? `${ordered[1]}${Number(ordered[2]) + 1}${ordered[3]}${marker.slice(ordered[1]!.length + ordered[2]!.length + 1)}`
    : marker;
  const text = `${source.text.slice(0, source.start)}\n${next}${source.text.slice(source.end)}`;
  const caret = source.start + 1 + next.length;
  return { end: caret, start: caret, text };
}

export function indentSourceLines(source: SourceText, outdent: boolean, step: number): SourceText {
  const indent = " ".repeat(step);
  const lineStart = lineStartOf(source.text, source.start);
  const onListLine = BULLET.test(source.text.slice(lineStart)) || ORDERED.test(source.text.slice(lineStart));
  const spansLines = source.text.slice(source.start, source.end).includes("\n");
  if (!outdent && !spansLines && !onListLine) {
    const caret = source.start + indent.length;
    return { end: caret, start: caret, text: `${source.text.slice(0, source.start)}${indent}${source.text.slice(source.end)}` };
  }
  return rewriteLines(source, (line) => {
    if (!outdent) return line ? `${indent}${line}` : line;
    const strip = Math.min(step, line.match(/^ */u)![0].length);
    return line.slice(strip);
  });
}

interface SourceBlockSpan {
  end: number;
  start: number;
  suggestion: boolean;
}

function sourceBlockSpans(text: string): SourceBlockSpan[] {
  const spans: SourceBlockSpan[] = [];
  let cursor = 0;
  for (const entry of parseSourcedBlocks(text)) {
    if (entry.source === null) continue;
    const start = text.indexOf(entry.source, cursor);
    if (start < 0) continue;
    spans.push({ end: start + entry.source.length, start, suggestion: entry.block.type === "suggestion" });
    cursor = start + entry.source.length;
  }
  return spans;
}

/**
 * Suggest mode keeps the text it edits: the blocks an edit touches become a suggestion holding them on both sides,
 * and the selection moves to the same place in the new side. Null when the edit already sits in a suggestion.
 */
export function forkSourceSuggestion(source: SourceText): (SourceText & { bounds: { end: number; start: number } }) | null {
  const spans = sourceBlockSpans(source.text);
  const touched = spans.filter((span) => span.start <= source.end && source.start <= span.end);
  if (touched.some((span) => span.suggestion)) return null;

  if (!touched.length) {
    const lineStart = lineStartOf(source.text, source.start);
    const lineEnd = lineEndOf(source.text, source.end);
    const opening = "<ins>\n\n";
    const text = `${source.text.slice(0, lineStart)}${opening}\n\n</ins>${source.text.slice(lineEnd)}`;
    const caret = lineStart + opening.length;
    return { bounds: { end: caret, start: caret }, end: caret, start: caret, text };
  }

  const start = touched[0]!.start;
  const end = touched.at(-1)!.end;
  const old = source.text.slice(start, end);
  const newSide = start + `<del>\n\n${old}\n\n</del>\n<ins>\n\n`.length;
  const clamp = (offset: number) => newSide + Math.max(0, Math.min(old.length, offset - start));
  return {
    bounds: { end: newSide + old.length, start: newSide },
    end: clamp(source.end),
    start: clamp(source.start),
    text: `${source.text.slice(0, start)}${formatSuggestion({ new: old, old })}${source.text.slice(end)}`,
  };
}
