/*
 * Exports:
 * - ThreadComponentMarkup: a component invocation and its span in markdown.
 * - readThreadComponentMarkup: read one complete component invocation at an offset.
 * - ThreadComponentSource/resolveThreadComponentSource: identify the original message owning a displayed invocation.
 * - mapThreadComponentSources: locate original message text within a combined message.
 */
import { createCodeFenceTracker } from "./markdown-code-fences";

export interface ThreadComponentMarkup {
  name: string;
  source: string;
  end: number;
  opening: string;
  body: string | null;
}

export interface ThreadComponentSource {
  itemId: string;
  sourceText: string;
  start: number;
  end: number;
}

export function mapThreadComponentSources(
  combined: string, sources: readonly Pick<ThreadComponentSource, "itemId" | "sourceText">[],
): ThreadComponentSource[] {
  const text = combined.replaceAll("\r\n", "\n");
  const result: ThreadComponentSource[] = [];
  let offset = 0;
  for (const source of sources) {
    const normalized = source.sourceText.replaceAll("\r\n", "\n");
    if (!normalized) continue;
    const start = text.indexOf(normalized, offset);
    if (start < 0) continue;
    result.push({ ...source, start, end: start + normalized.length });
    offset = start + normalized.length;
  }
  return result;
}

export function resolveThreadComponentSource(
  sources: readonly ThreadComponentSource[], start: number, end: number,
): ThreadComponentSource | null {
  return sources.find(source => source.start <= start && end <= source.end) ?? null;
}

interface Tag {
  name: string;
  closing: boolean;
  selfClosing: boolean;
  end: number;
}

function readTag(source: string, start: number): Tag | null {
  const match = /^<(\/?)([A-Za-z][A-Za-z0-9_.-]*)\b/u.exec(source.slice(start));
  if (!match) return null;
  let braces = 0;
  let quote = "";
  for (let index = start + match[0].length; index < source.length; index += 1) {
    const character = source[index]!;
    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === "\"" || character === "'" || character === "`") quote = character;
    else if (character === "{") braces += 1;
    else if (character === "}") {
      if (!braces) return null;
      braces -= 1;
    } else if (character === ">" && !braces) {
      return {
        name: match[2]!,
        closing: match[1] === "/",
        selfClosing: !match[1] && /\/\s*>$/u.test(source.slice(start, index + 1)),
        end: index + 1,
      };
    }
  }
  return null;
}

export function readThreadComponentMarkup(source: string, start = 0): ThreadComponentMarkup | null {
  const first = readTag(source, start);
  if (!first || first.closing || !/^[A-Z]/u.test(first.name)) return null;
  const opening = source.slice(start, first.end);
  if (first.selfClosing) return { name: first.name, source: opening, end: first.end, opening, body: null };
  const open = [first.name];
  const fence = createCodeFenceTracker();
  let index = first.end;
  while (index < source.length) {
    if (index === 0 || source[index - 1] === "\n") {
      const end = source.indexOf("\n", index);
      const lineEnd = end < 0 ? source.length : end;
      if (fence(source.slice(index, lineEnd))) {
        index = end < 0 ? source.length : end + 1;
        continue;
      }
    }
    if (source[index] === "`") {
      const run = /^`+/u.exec(source.slice(index))![0];
      const close = source.indexOf(run, index + run.length);
      if (close >= 0 && !source.slice(index, close).includes("\n")) {
        index = close + run.length;
        continue;
      }
    }
    if (source[index] !== "<") {
      index += 1;
      continue;
    }
    const tag = readTag(source, index);
    if (!tag || !/^[A-Z]/u.test(tag.name)) {
      index += 1;
      continue;
    }
    if (tag.closing) {
      if (open.pop() !== tag.name) return null;
      if (!open.length) return {
        name: first.name, source: source.slice(start, tag.end), end: tag.end,
        opening, body: source.slice(first.end, index),
      };
    } else if (!tag.selfClosing) open.push(tag.name);
    index = tag.end;
  }
  return null;
}
