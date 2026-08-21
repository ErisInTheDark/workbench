/*
 * Exports:
 * - gitArcPathsOverlap: compare normalized Git arc scope entries using exact and ancestor/descendant semantics. Keywords: git, arc, paths, overlap.
 */

export function gitArcPathsOverlap(left: string, right: string) {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}
