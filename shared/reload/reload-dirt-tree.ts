/*
 * Exports:
 * - ReloadDirtNode: one dirty scope with the dirty scopes its reload already covers nested beneath it.
 * - buildReloadDirtTree: nest dirty scopes under their nearest dirty ancestor, riskiest roots first.
 */
import type { ReloadDirtScope } from "./reload-dirt-scope.ts";

export interface ReloadDirtNode {
  scope: ReloadDirtScope;
  children: ReloadDirtNode[];
  /** Every scope in this subtree, itself included. */
  size: number;
}

const risk = (scope: ReloadDirtScope) => scope.destructive ? 0 : scope.migration ? 1 : 2;

/**
 * A scope's parent is the dirty scope with the smallest dependant closure that contains it: the smallest reload that
 * already covers it. Mutually covering scopes resolve by name so the result is always a forest.
 */
export function buildReloadDirtTree(scopes: readonly ReloadDirtScope[]): ReloadDirtNode[] {
  const closures = new Map(scopes.map(scope => [scope.scope, new Set(scope.dependantScopes ?? [])]));
  const covers = (parent: string, child: string) => {
    if (parent === child || !closures.get(parent)?.has(child)) return false;
    return !closures.get(child)?.has(parent) || parent < child;
  };
  const parents = new Map<string, string>();
  for (const { scope } of scopes) {
    let best: string | null = null;
    for (const candidate of closures.keys()) {
      if (!covers(candidate, scope)) continue;
      const size = closures.get(candidate)!.size;
      const bestSize = best === null ? Infinity : closures.get(best)!.size;
      if (size < bestSize || (size === bestSize && best !== null && covers(best, candidate))) best = candidate;
    }
    if (best) parents.set(scope, best);
  }
  const build = (scope: ReloadDirtScope): ReloadDirtNode => {
    const children = scopes.filter(candidate => parents.get(candidate.scope) === scope.scope).map(build);
    return { scope, children, size: 1 + children.reduce((total, child) => total + child.size, 0) };
  };
  return scopes.filter(scope => !parents.has(scope.scope)).map(build)
    .sort((left, right) => risk(left.scope) - risk(right.scope));
}
