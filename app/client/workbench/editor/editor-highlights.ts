/*
 * Exports:
 * - EditorHighlightName: CSS custom highlights the markdown editor paints without touching editable DOM.
 * - EditorHighlightScope: one editor's share of the page-global highlight registry.
 * - createEditorHighlightScope: claim a share; panels painting the same highlight never overwrite each other.
 */
import { createHighlightScope, type HighlightScope } from "../dom/css-highlights";

export type EditorHighlightName = "comment-active" | "comment-draft" | "suggest-del" | "suggest-ins";

export type EditorHighlightScope = HighlightScope<EditorHighlightName>;

export function createEditorHighlightScope(): EditorHighlightScope {
  return createHighlightScope<EditorHighlightName>();
}
