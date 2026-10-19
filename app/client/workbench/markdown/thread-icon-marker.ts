/*
 * Exports:
 * - ThreadIconType: inline icon kinds agents may mark thread markdown with.
 * - ThreadEmphasisColor: authored colours shared by thread icons and notices.
 * - readThreadIconMarker: read one `<icon …>` marker leniently and resolve the icon and colour the agent meant.
 */

export type ThreadIconType = "alert" | "asterisk" | "check" | "x";
export type ThreadEmphasisColor = "blue" | "green" | "purple" | "red" | "yellow";

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
const OPENING_TAG = /^<icon(?=[\s/>])([^<>\r\n]*?)(\/?)>/iu;
const ATTRIBUTE = /([^\s=/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'/>]+)))?/gu;
const CLOSING_TAG = "</icon>";

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

function findLabelEnd(markdown: string, from: number) {
  const lowerSource = markdown.toLowerCase();
  const closeIndex = lowerSource.indexOf(CLOSING_TAG, from);
  if (closeIndex === -1) return -1;
  const nextOpenIndex = lowerSource.indexOf("<icon", from);
  return nextOpenIndex !== -1 && nextOpenIndex < closeIndex ? -1 : closeIndex;
}

export function readThreadIconMarker(markdown: string, index: number) {
  const opening = OPENING_TAG.exec(markdown.slice(index));
  if (!opening) return null;

  const { bareWords, colorValues, typeValues } = readAttributes(opening[1]!);
  const iconType = firstResolved([...typeValues, ...bareWords, ...colorValues], ICON_TYPES_BY_WORD);
  if (!iconType) return null;

  const requestedColor = firstResolved([...colorValues, ...bareWords], COLORS_BY_WORD);
  const color = requestedColor ?? (colorValues.length ? ICON_TYPE_DEFAULT_COLORS[iconType] : null);
  const labelStart = index + opening[0].length;
  const labelEnd = opening[2] ? -1 : findLabelEnd(markdown, labelStart);

  return {
    color,
    end: labelEnd === -1 ? labelStart : labelEnd + CLOSING_TAG.length,
    iconType,
    label: labelEnd === -1 ? null : markdown.slice(labelStart, labelEnd),
  };
}
