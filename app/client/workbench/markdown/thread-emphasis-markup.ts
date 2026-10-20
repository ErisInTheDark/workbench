/*
 * Exports:
 * - ThreadIconType: inline icon kinds agents may mark thread markdown with.
 * - ThreadEmphasisColor: authored palette colours shared by thread icons, colour tags and notices.
 * - ThreadTextColor: a palette colour or a lowercase hex colour a `<color>` tag paints text with.
 * - readThreadIconMarker: read one `<icon …>` marker leniently and resolve the icon and colour the agent meant.
 * - readThreadColorTag: read one `<color …>` tag and its matching closer leniently; partial text closes at its end.
 */

export type ThreadIconType = "alert" | "asterisk" | "check" | "x";
export type ThreadEmphasisColor = "blue" | "green" | "purple" | "red" | "yellow";
export type ThreadTextColor = ThreadEmphasisColor | `#${string}`;

const ICON_TYPE_ALIASES = {
  alert: ["alert", "warning", "warn", "caution", "attention", "important", "!"],
  asterisk: ["asterisk", "star", "changed", "partial", "modified", "*"],
  check: ["check", "tick", "checkmark", "done", "ok", "success", "pass", "resolved", "good"],
  x: ["x", "cross", "close", "fail", "failed", "error", "bad", "missing", "cancel", "×"],
} satisfies Record<ThreadIconType, string[]>;

const COLOR_ALIASES = {
  blue: ["blue", "sky", "cyan", "teal", "info"],
  green: ["green", "emerald", "lime", "success"],
  purple: ["purple", "violet", "magenta", "lavender"],
  red: ["red", "danger", "error", "crimson"],
  yellow: ["yellow", "amber", "orange", "gold", "warning"],
} satisfies Record<ThreadEmphasisColor, string[]>;

/** Colour used when the agent asked for one the palette cannot resolve. */
const ICON_TYPE_DEFAULT_COLORS = {
  alert: "yellow",
  asterisk: "blue",
  check: "green",
  x: "red",
} satisfies Record<ThreadIconType, ThreadEmphasisColor>;

function invertAliases<Key extends string>(aliases: Record<Key, string[]>) {
  return new Map(Object.entries<string[]>(aliases).flatMap(([key, words]) => words.map(word => [word, key as Key] as const)));
}

const ICON_TYPES_BY_WORD = invertAliases<ThreadIconType>(ICON_TYPE_ALIASES);
const COLORS_BY_WORD = invertAliases<ThreadEmphasisColor>(COLOR_ALIASES);
const TYPE_ATTRIBUTES = new Set(["type", "icon", "name"]);
const COLOR_ATTRIBUTES = new Set(["color", "colour"]);
const ATTRIBUTE = /([^\s=/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'/>]+)))?/gu;
const ICON_OPENING_TAG = /^<icon(?=[\s/>])([^<>\r\n]*?)(\/?)>/iu;
const ICON_CLOSING_TAG = "</icon>";
const COLOR_OPENING_TAG = /^<colou?r(?=[\s>])([^<>\r\n]*)>/iu;
const COLOR_TAG_BOUNDARY = /<colou?r(?=[\s>])[^<>\r\n]*>|<\/colou?r>/giu;
const HEX_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/u;

/** Attribute values and bare words, lowercased; agents mix `color="red"`, `colour=red` and `<icon red check>`. */
function readAttributes(source: string) {
  const typeValues: string[] = [];
  const colorValues: string[] = [];
  const bareWords: string[] = [];
  for (const match of source.matchAll(ATTRIBUTE)) {
    const name = match[1]!.toLowerCase();
    const value = match[2] ?? match[3] ?? match[4];
    if (value === undefined) bareWords.push(name);
    else if (TYPE_ATTRIBUTES.has(name)) typeValues.push(value.trim().toLowerCase());
    else if (COLOR_ATTRIBUTES.has(name)) colorValues.push(value.trim().toLowerCase());
  }
  return { bareWords, colorValues, typeValues };
}

function firstResolved<Value>(words: readonly string[], lookup: Map<string, Value>) {
  for (const word of words) {
    const value = lookup.get(word);
    if (value) return value;
  }
  return null;
}

function findIconLabelEnd(markdown: string, from: number) {
  const lowerSource = markdown.toLowerCase();
  const closeIndex = lowerSource.indexOf(ICON_CLOSING_TAG, from);
  if (closeIndex === -1) return -1;
  const nextOpenIndex = lowerSource.indexOf("<icon", from);
  return nextOpenIndex !== -1 && nextOpenIndex < closeIndex ? -1 : closeIndex;
}

export function readThreadIconMarker(markdown: string, index: number) {
  const opening = ICON_OPENING_TAG.exec(markdown.slice(index));
  if (!opening) return null;

  const { bareWords, colorValues, typeValues } = readAttributes(opening[1]!);
  const iconType = firstResolved([...typeValues, ...bareWords, ...colorValues], ICON_TYPES_BY_WORD);
  if (!iconType) return null;

  const requestedColor = firstResolved([...colorValues, ...bareWords], COLORS_BY_WORD);
  const color = requestedColor ?? (colorValues.length ? ICON_TYPE_DEFAULT_COLORS[iconType] : null);
  const labelStart = index + opening[0].length;
  const labelEnd = opening[2] ? -1 : findIconLabelEnd(markdown, labelStart);

  return {
    color,
    end: labelEnd === -1 ? labelStart : labelEnd + ICON_CLOSING_TAG.length,
    iconType,
    label: labelEnd === -1 ? null : markdown.slice(labelStart, labelEnd),
  };
}

function resolveTextColor(words: readonly string[]): ThreadTextColor | null {
  for (const word of words) {
    if (HEX_COLOR.test(word)) return word as `#${string}`;
    const color = COLORS_BY_WORD.get(word);
    if (color) return color;
  }
  return null;
}

/** Closer pairing counts nested `<color>` openers so an inner tag never closes its parent. */
function findColorTagClose(markdown: string, from: number) {
  COLOR_TAG_BOUNDARY.lastIndex = from;
  let depth = 1;
  for (let match = COLOR_TAG_BOUNDARY.exec(markdown); match; match = COLOR_TAG_BOUNDARY.exec(markdown)) {
    depth += match[0].startsWith("</") ? -1 : 1;
    if (depth === 0) return { index: match.index, length: match[0].length };
  }
  return null;
}

/** An unreadable colour still consumes the tag, so its text shows plain instead of as literal markup. */
export function readThreadColorTag(markdown: string, index: number, partial: boolean) {
  const opening = COLOR_OPENING_TAG.exec(markdown.slice(index));
  if (!opening) return null;

  const { bareWords, colorValues } = readAttributes(opening[1]!);
  const color = resolveTextColor([...colorValues, ...bareWords]);
  const contentStart = index + opening[0].length;
  const close = findColorTagClose(markdown, contentStart);
  if (!close) {
    return partial ? { closed: false, color, content: markdown.slice(contentStart), end: markdown.length } : null;
  }
  return { closed: true, color, content: markdown.slice(contentStart, close.index), end: close.index + close.length };
}
