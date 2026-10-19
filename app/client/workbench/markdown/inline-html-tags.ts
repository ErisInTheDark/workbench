/*
 * Exports:
 * - InlineHtmlFormat: inline node formats that html formatting tags map onto.
 * - readInlineHtmlTag: read one attribute-free inline html formatting tag and its matching closer for a markdown profile.
 */

export type InlineHtmlFormat =
  | "break"
  | "code"
  | "delete"
  | "em"
  | "insert"
  | "mark"
  | "strong"
  | "subscript"
  | "superscript"
  | "underline";

/** Agents write html formatting in thread markdown; thread display reads every tag case-insensitively. */
const THREAD_TAG_FORMATS = new Map<string, InlineHtmlFormat>([
  ["b", "strong"], ["strong", "strong"],
  ["i", "em"], ["em", "em"],
  ["s", "delete"], ["strike", "delete"], ["del", "delete"],
  ["ins", "insert"],
  ["mark", "mark"],
  ["u", "underline"],
  ["sub", "subscript"],
  ["sup", "superscript"],
  ["code", "code"], ["kbd", "code"],
  ["br", "break"],
]);

/** Editor markdown saves only review markup as html, so other tags must stay literal to survive a save. */
const EDITOR_TAG_FORMATS = new Map<string, InlineHtmlFormat>([
  ["del", "delete"],
  ["ins", "insert"],
  ["mark", "mark"],
]);

const THREAD_OPENING_TAG = /^<([a-z]+)\s*(\/?)>/iu;
const EDITOR_OPENING_TAG = /^<([a-z]+)()>/u;

function findMatchingClose(markdown: string, tag: string, from: number, caseInsensitive: boolean) {
  const source = caseInsensitive ? markdown.toLowerCase() : markdown;
  const opener = new RegExp(`<${tag}>|</${tag}>`, "gu");
  opener.lastIndex = from;
  let depth = 1;
  for (let match = opener.exec(source); match; match = opener.exec(source)) {
    depth += match[0].startsWith("</") ? -1 : 1;
    if (depth === 0) return match.index;
  }
  return -1;
}

export function readInlineHtmlTag(markdown: string, index: number, profile: "editor" | "thread") {
  if (markdown[index] !== "<") return null;
  const thread = profile === "thread";
  const opening = (thread ? THREAD_OPENING_TAG : EDITOR_OPENING_TAG).exec(markdown.slice(index));
  const tag = opening?.[1]!.toLowerCase();
  const format = tag && (thread ? THREAD_TAG_FORMATS : EDITOR_TAG_FORMATS).get(tag);
  if (!opening || !tag || !format) return null;

  const contentStart = index + opening[0].length;
  if (format === "break") return { content: "", end: contentStart, format };
  if (opening[2]) return null;

  const closeIndex = findMatchingClose(markdown, tag, contentStart, thread);
  if (closeIndex === -1) return null;
  return { content: markdown.slice(contentStart, closeIndex), end: closeIndex + tag.length + 3, format };
}
