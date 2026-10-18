/*
 * Exports:
 * - HighlightScope: one painter's share of the page-global CSS custom highlight registry.
 * - createHighlightScope: claim a share; painters of the same highlight name never overwrite each other.
 */

export interface HighlightScope<Name extends string> {
  clear: () => void;
  set: (name: Name, ranges: readonly Range[]) => void;
}

const contributions = new Map<string, Map<symbol, readonly Range[]>>();

function getRegistry() {
  return typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight !== "undefined" ? CSS.highlights : null;
}

function publish(name: string) {
  const registry = getRegistry();
  if (!registry) return;
  const ranges = [...(contributions.get(name)?.values() ?? [])].flat();
  if (ranges.length) registry.set(name, new Highlight(...ranges));
  else registry.delete(name);
}

export function createHighlightScope<Name extends string>(): HighlightScope<Name> {
  const owner = Symbol("highlight-scope");
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
