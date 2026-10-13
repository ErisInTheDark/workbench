/*
 * Exports:
 * - ThreadStableChunk: one chunk's identity and entry range within its group.
 * - default ThreadStableChunkIdentities: keep one turn's group and chunk identities, and chunk boundaries, stable while
 *   history lands above and live entries land below.
 */

export interface ThreadStableChunk {
  readonly end: number;
  readonly identity: string;
  readonly start: number;
}

/** Newest-first, so a growing range keeps the identity of the entries it already showed. */
function resolveIdentities(ranges: readonly (readonly string[])[], owners: Map<string, string>, used: Set<string>) {
  const identities = new Array<string>(ranges.length);
  for (let index = ranges.length - 1; index >= 0; index -= 1) {
    const keys = ranges[index]!;
    let identity: string | undefined;
    for (let keyIndex = keys.length - 1; keyIndex >= 0 && identity === undefined; keyIndex -= 1) {
      const known = owners.get(keys[keyIndex]!);
      if (known !== undefined && !used.has(known)) identity = known;
    }
    if (identity === undefined) {
      const base = keys[0] ?? `empty:${index}`;
      identity = base;
      for (let suffix = 2; used.has(identity); suffix += 1) identity = `${base}#${suffix}`;
    }
    used.add(identity);
    for (const key of keys) owners.set(key, identity);
    identities[index] = identity;
  }
  return identities;
}

export default class ThreadStableChunkIdentities {
  #groupOwners = new Map<string, string>();
  readonly #chunkOwners = new Map<string, string>();
  readonly #anchors = new Map<string, string>();
  #usedChunks = new Set<string>();

  /** Call once per render with every group's entry keys, before `chunks`. */
  groups(groups: readonly (readonly string[])[]): string[] {
    const owners = new Map<string, string>();
    for (const keys of groups) for (const key of keys) {
      const known = this.#groupOwners.get(key);
      if (known !== undefined) owners.set(key, known);
    }
    const identities = resolveIdentities(groups, owners, new Set());
    this.#groupOwners = owners;
    const live = new Set(identities);
    for (const identity of [...this.#anchors.keys()]) if (!live.has(identity)) this.#anchors.delete(identity);
    for (const key of [...this.#chunkOwners.keys()]) if (!owners.has(key)) this.#chunkOwners.delete(key);
    this.#usedChunks = new Set();
    return identities;
  }

  /** Boundaries stay where the group's first-seen entry put them, so entries landing above only add chunks above. */
  chunks(group: string, keys: readonly string[], size: number): ThreadStableChunk[] {
    const anchor = this.#anchors.get(group);
    let anchorIndex = anchor === undefined ? -1 : keys.indexOf(anchor);
    if (anchorIndex < 0) {
      anchorIndex = 0;
      if (keys[0] !== undefined) this.#anchors.set(group, keys[0]);
    }
    const ranges: Array<{ start: number; end: number }> = [];
    let start = anchorIndex % size;
    if (start > 0) ranges.push({ start: 0, end: start });
    for (; start < keys.length; start += size) ranges.push({ start, end: Math.min(start + size, keys.length) });
    const identities = resolveIdentities(
      ranges.map(range => keys.slice(range.start, range.end)),
      this.#chunkOwners,
      this.#usedChunks,
    );
    return ranges.map((range, index) => ({ ...range, identity: identities[index]! }));
  }
}
