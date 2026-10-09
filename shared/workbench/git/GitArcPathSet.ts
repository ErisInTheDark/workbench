/*
 * Exports:
 * - default GitArcPathSet: indexed set of Git arc scope entries answering exact, within/holding, cover, contain and overlap queries in
 *   O(path depth) instead of scanning every entry. Entries are `/`-separated: `a` covers `a/b`, never `ab`; `.` is
 *   an ordinary entry, so callers that treat it as "everything" check it first. This is the one owner of path-scope
 *   matching; match many paths through one set rather than pairwise loops.
 */

/** Every proper ancestor of `path`, nearest first: `a/b/c` yields `a/b`, then `a`. */
function* ancestorsOf(path: string) {
  let separator = path.lastIndexOf("/");
  while (separator > 0) {
    yield path.slice(0, separator);
    separator = path.lastIndexOf("/", separator - 1);
  }
}

export default class GitArcPathSet {
  /** Members mapped to their insertion order, so multi-member answers keep caller order. */
  private readonly members = new Map<string, number>();
  /** Every proper ancestor of every member: `contains(path)` is one lookup. */
  private readonly ancestors = new Set<string>();
  /** Members sorted by code unit, built on demand for descendant ranges; dropped by `add`. */
  private sorted: string[] | null = null;

  constructor(paths: Iterable<string> = []) {
    for (const path of paths) this.add(path);
  }

  get size() {
    return this.members.size;
  }

  add(path: string) {
    if (this.members.has(path)) return;
    this.members.set(path, this.members.size);
    this.sorted = null;
    for (const ancestor of ancestorsOf(path)) {
      // An ancestor already present had its own ancestors added with it.
      if (this.ancestors.has(ancestor)) break;
      this.ancestors.add(ancestor);
    }
  }

  /** `path` is a member. */
  has(path: string) {
    return this.members.has(path);
  }

  /** `path` lies strictly beneath a member. */
  within(path: string) {
    for (const ancestor of ancestorsOf(path)) if (this.members.has(ancestor)) return true;
    return false;
  }

  /** Members `path` lies strictly beneath, nearest first. */
  holding(path: string) {
    const found: string[] = [];
    for (const ancestor of ancestorsOf(path)) if (this.members.has(ancestor)) found.push(ancestor);
    return found;
  }

  /** `path` is a member or lies beneath one. */
  covers(path: string) {
    return this.members.has(path) || this.within(path);
  }

  /** Some member lies strictly beneath `path`. */
  contains(path: string) {
    return this.ancestors.has(path);
  }

  /** `path` equals, lies beneath, or holds a member. */
  overlaps(path: string) {
    return this.ancestors.has(path) || this.covers(path);
  }

  /** Members that overlap `path`, in insertion order. */
  overlapping(path: string) {
    const found: string[] = [];
    if (this.members.has(path)) found.push(path);
    for (const ancestor of ancestorsOf(path)) if (this.members.has(ancestor)) found.push(ancestor);
    if (this.ancestors.has(path)) {
      const sorted = this.sorted ??= [...this.members.keys()].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
      const prefix = `${path}/`;
      let low = 0;
      let high = sorted.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (sorted[middle]! < prefix) low = middle + 1;
        else high = middle;
      }
      for (let index = low; index < sorted.length && sorted[index]!.startsWith(prefix); index += 1) found.push(sorted[index]!);
    }
    return found.length > 1 ? found.sort((left, right) => this.members.get(left)! - this.members.get(right)!) : found;
  }

  values() {
    return this.members.keys();
  }
}
