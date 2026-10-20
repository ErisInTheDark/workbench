/*
 * Exports:
 * - findHeldInlineFrontierStart: where trailing streamed inline text must stay hidden because its meaning is not locked in yet.
 * - isHeldFrontierLine: whether a streamed final line shows nothing yet, so its block must not render.
 */

import { THREAD_INLINE_HTML_TAG_NAMES } from "./inline-html-tags";

const FRONTIER_TAG_NAMES = [
  ...THREAD_INLINE_HTML_TAG_NAMES,
  "color",
  "colour",
  "details",
  "icon",
  "notice",
  "plan",
  "set-state",
  "summary",
];
const PARTIAL_TAG = /^<\/?([a-z-]*)(\s[^<>\n]*)?$/i;
const PARTIAL_COMMENT = /^<!-{0,2}$/;
const PARTIAL_LINK = /^\[[^\]\n]*(?:\](?:\([^)\n]*)?)?$/;
const PARTIAL_MENTION = /^#(?:\[[^\]\n]*)?$/;
/** Block prefixes that render before any content: quote, heading, list markers. */
const BLOCK_LINE_PREFIX = /^\s*(?:(?:>\s?)|(?:#{1,6}(?:\s+|$))|(?:(?:[-*+]|\d+[.)])(?:\s+|$)))*/;
const PARTIAL_FENCE_OPENER = /^\s*(?:(?:[-*+]|\d+[.)])\s+)?`{3,}[^`]*$/;

function couldBecomeTag(rest: string) {
  if (PARTIAL_COMMENT.test(rest)) return true;
  const match = PARTIAL_TAG.exec(rest);
  if (!match) return false;
  const name = match[1]!.toLowerCase();
  return match[2] === undefined
    ? FRONTIER_TAG_NAMES.some(tag => tag.startsWith(name))
    : FRONTIER_TAG_NAMES.includes(name);
}

function firstMatchingStart(text: string, marker: string, from: number, matches: (rest: string) => boolean) {
  for (let index = text.indexOf(marker, from); index !== -1; index = text.indexOf(marker, index + 1)) {
    if (matches(text.slice(index))) return index;
  }
  return null;
}

/**
 * Streamed text ends mid-token; a partial tag, link, mention or word could still turn into something else.
 * Hiding it until it is locked in means nothing ever flips from raw text into a chip, icon or link.
 */
export function findHeldInlineFrontierStart(text: string) {
  const lineStart = text.lastIndexOf("\n") + 1;
  const wordStart = Math.max(lineStart, ...[" ", "\t"].map(space => text.lastIndexOf(space) + 1));
  const candidates = [
    wordStart < text.length ? wordStart : null,
    firstMatchingStart(text, "<", lineStart, couldBecomeTag),
    firstMatchingStart(text, "[", lineStart, rest => PARTIAL_LINK.test(rest)),
    firstMatchingStart(text, "#", lineStart, rest => PARTIAL_MENTION.test(rest)),
  ].filter((candidate): candidate is number => candidate !== null);
  return candidates.length ? Math.min(...candidates) : null;
}

export function isHeldFrontierLine(line: string) {
  if (PARTIAL_FENCE_OPENER.test(line)) return true;
  const content = line.slice(BLOCK_LINE_PREFIX.exec(line)![0].length);
  return !content || findHeldInlineFrontierStart(content) === 0;
}
