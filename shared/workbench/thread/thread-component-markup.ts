/*
 * Exports:
 * - ThreadComponentMarkup: a component invocation and its span in markdown.
 * - readThreadComponentMarkup: read one complete component invocation at an offset.
 * - ThreadComponentSource/resolveThreadComponentSource: identify the original message owning a displayed invocation.
 * - mapThreadComponentSources: locate original message text within a combined message.
 * - ThreadComponentAttribute/readThreadComponentAttributes: an opening tag's attributes: quoted text, `{expression}`
 *   source for a sandbox to evaluate, or a bare flag.
 * - listThreadComponentResultNames: the kept MCP results an invocation (or its nested ones) names as `"@result:<name>"`.
 */
import { createCodeFenceTracker } from "./markdown-code-fences";

export type ThreadComponentAttribute =
  | { name: string; kind: "text"; value: string }
  | { name: string; kind: "expression"; source: string }
  | { name: string; kind: "flag" };

const ENTITIES: Readonly<Record<string, string>> = { amp: "&", apos: "'", gt: ">", lt: "<", quot: "\"" };

function decodeEntities(value: string) {
  return value.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/giu, (match, decimal?: string, hex?: string, name?: string) => {
    const code = decimal ? Number.parseInt(decimal, 10) : hex ? Number.parseInt(hex, 16) : null;
    if (code !== null) return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    return ENTITIES[name!.toLowerCase()] ?? match;
  });
}

/** Where a `{` expression's matching `}` sits, skipping braces inside quotes, as `readTag` reads them. */
function expressionEnd(source: string, open: number) {
  let braces = 0;
  let quote = "";
  for (let index = open; index < source.length; index += 1) {
    const character = source[index]!;
    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === "\"" || character === "'" || character === "`") quote = character;
    else if (character === "{") braces += 1;
    else if (character === "}" && --braces === 0) return index;
  }
  throw new Error("Unclosed component attribute expression.");
}

export function readThreadComponentAttributes(opening: string): ThreadComponentAttribute[] {
  const tag = /^<[A-Za-z][A-Za-z0-9_.-]*/u.exec(opening);
  if (!tag) throw new Error("Expected a component opening tag.");
  const attributes: ThreadComponentAttribute[] = [];
  let index = tag[0].length;
  const skipSpace = () => { while (index < opening.length && /\s/u.test(opening[index]!)) index += 1; };
  for (;;) {
    skipSpace();
    const rest = opening.slice(index);
    if (/^\/?>\s*$/u.test(rest)) return attributes;
    if (rest.startsWith("{")) throw new Error("Component spread attributes are not supported.");
    const name = /^[A-Za-z_][A-Za-z0-9_:.-]*/u.exec(rest)?.[0];
    if (!name) throw new Error("Invalid component attribute.");
    index += name.length;
    skipSpace();
    if (opening[index] !== "=") {
      attributes.push({ name, kind: "flag" });
      continue;
    }
    index += 1;
    skipSpace();
    const start = opening[index];
    if (start === "\"" || start === "'") {
      const end = opening.indexOf(start, index + 1);
      if (end < 0) throw new Error(`Unclosed component attribute: ${name}`);
      attributes.push({ name, kind: "text", value: decodeEntities(opening.slice(index + 1, end)) });
      index = end + 1;
    } else if (start === "{") {
      const end = expressionEnd(opening, index);
      const source = opening.slice(index + 1, end).trim();
      if (!source) throw new Error(`Empty component attribute expression: ${name}`);
      attributes.push({ name, kind: "expression", source });
      index = end + 1;
    } else {
      throw new Error(`Invalid component attribute value: ${name}`);
    }
  }
}

export function listThreadComponentResultNames(source: string): string[] {
  return [...new Set([...source.matchAll(/["']@result:([A-Za-z0-9_-]{1,64})["']/gu)].map(match => match[1]!))];
}

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
