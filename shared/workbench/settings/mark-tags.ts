/*
 * Exports:
 * - MARK_TAG_COLORS: the palette a mark tag can be drawn in.
 * - MarkTagColor: one palette colour.
 * - MARK_TAG_LIMIT: most tags a list holds, one per Alt+digit keybind.
 * - MARK_TAG_NAME_MAX_LENGTH: longest stored tag name.
 * - MarkTag: one configured tag: the name saved into markdown and the colour it is drawn in.
 * - DEFAULT_MARK_TAGS: the tags a fresh install starts with.
 * - MarkTag (namespace): normalise names and lists, and label a list position with its keybind digit.
 */

export const MARK_TAG_COLORS = ["red", "orange", "yellow", "green", "teal", "blue", "purple", "pink", "white"] as const;
export type MarkTagColor = typeof MARK_TAG_COLORS[number];

export const MARK_TAG_LIMIT = 10;
export const MARK_TAG_NAME_MAX_LENGTH = 32;

export interface MarkTag {
  color: MarkTagColor;
  name: string;
}

export const DEFAULT_MARK_TAGS: readonly MarkTag[] = Object.freeze([
  { color: "red", name: "bad" },
  { color: "yellow", name: "rethink" },
  { color: "white", name: "important" },
  { color: "green", name: "good" },
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const MarkTag = {
  isColor(value: unknown): value is MarkTagColor {
    return MARK_TAG_COLORS.some(color => color === value);
  },

  /** Names are single-spaced, trimmed and bounded; control characters never reach markdown. */
  normalizeName(value: string) {
    return value.replace(/\p{Cc}/gu, "").replace(/\s+/gu, " ").trim().slice(0, MARK_TAG_NAME_MAX_LENGTH).trim();
  },

  /** The best usable list from stored or edited data: named, unique by name, within the limit. */
  normalizeList(value: unknown): MarkTag[] {
    if (!Array.isArray(value)) return [];
    const tags: MarkTag[] = [];
    for (const candidate of value) {
      if (!isRecord(candidate) || typeof candidate.name !== "string") continue;
      const name = MarkTag.normalizeName(candidate.name);
      if (!name || tags.some(tag => tag.name === name)) continue;
      tags.push({ color: MarkTag.isColor(candidate.color) ? candidate.color : MARK_TAG_COLORS[0], name });
      if (tags.length === MARK_TAG_LIMIT) break;
    }
    return tags;
  },

  /** The digit whose Alt chord applies the tag at this list position: 1-9, then 0. */
  keyDigit(position: number) {
    return String((position + 1) % 10);
  },

  /** The palette colour least used by the list, for a newly added tag. */
  nextColor(tags: readonly Pick<MarkTag, "color">[]): MarkTagColor {
    const uses = (color: MarkTagColor) => tags.filter(tag => tag.color === color).length;
    return MARK_TAG_COLORS.reduce((best, color) => uses(color) < uses(best) ? color : best);
  },
};
