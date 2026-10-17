/*
 * Exports:
 * - EditorHighlightName: CSS custom highlights the markdown editor paints without touching editable DOM.
 * - EditorHighlightScope: one editor's share of the page-global highlight registry.
 * - createEditorHighlightScope: claim a share; panels painting the same highlight never overwrite each other.
 */

export type EditorHighlightName = "comment-active" | "comment-draft" | "suggest-del" | "suggest-ins";

export interface EditorHighlightScope {
  clear: () => void;
  set: (name: EditorHighlightName, ranges: readonly Range[]) => void;
}

const contributions = new Map<EditorHighlightName, Map<symbol, readonly Range[]>>();

function getRegistry() {
  return typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight !== "undefined" ? CSS.highlights : null;
}

function publish(name: EditorHighlightName) {
  const registry = getRegistry();
  if (!registry) {
    return;
  }

  const ranges = [...(contributions.get(name)?.values() ?? [])].flat();
  if (ranges.length) {
    registry.set(name, new Highlight(...ranges));
  } else {
    registry.delete(name);
  }
}

export function createEditorHighlightScope(): EditorHighlightScope {
  const owner = Symbol("editor-highlights");
  return {
    clear: () => {
      for (const [name, byOwner] of contributions) {
        if (byOwner.delete(owner)) publish(name);
      }
    },
    set: (name, ranges) => {
      const byOwner = contributions.get(name) ?? new Map<symbol, readonly Range[]>();
      contributions.set(name, byOwner);
      if (ranges.length) byOwner.set(owner, ranges);
      else if (!byOwner.delete(owner)) return;
      publish(name);
    },
  };
}
