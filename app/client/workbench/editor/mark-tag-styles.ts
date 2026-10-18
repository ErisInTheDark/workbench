/*
 * Exports:
 * - MARK_TAG_SCOPE_ATTRIBUTE: marks the element whose descendants draw mark tags in one tag list's colours.
 * - markTagColorValue: the CSS colour a palette entry paints with, in light and dark schemes.
 * - markTagStyleSheet: rules giving each configured tag its colour inside one scope.
 */
import type { MarkTag, MarkTagColor } from "workbench-shared/workbench/settings/mark-tags";

export const MARK_TAG_SCOPE_ATTRIBUTE = "data-mark-tag-scope";

export function markTagColorValue(color: MarkTagColor) {
  return `var(--mark-tag-${color})`;
}

function cssString(value: string) {
  return value.replace(/["\\<]/gu, character => `\\${character.codePointAt(0)!.toString(16)} `);
}

/** Colours live in settings rather than the document, so they are styled by tag name instead of written into the DOM. */
export function markTagStyleSheet(scope: string, tags: readonly MarkTag[]) {
  return tags.map(tag => `[${MARK_TAG_SCOPE_ATTRIBUTE}="${cssString(scope)}"] u[data-mark="${cssString(tag.name)}"]`
    + ` { --mark-tag-color: ${markTagColorValue(tag.color)}; }`).join("\n");
}
