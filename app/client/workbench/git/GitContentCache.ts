/*
 * Exports:
 * - default GitContentCache: bound and coalesce immutable Git file content (diffs and previews) by an identity key the
 *   caller builds from everything the content depends on.
 */
import type { WorkingTreeDiff, WorkingTreePreview } from "workbench-shared/workbench/git/working-tree-contracts";

type Values = { diff: WorkingTreeDiff; preview: WorkingTreePreview };
type Entry = { value: Values[keyof Values]; expires: number; bytes: number };

export default class GitContentCache {
  private readonly entries = new Map<string, Entry>();
  private readonly pending = new Map<string, Promise<Values[keyof Values]>>();
  private generation = {};
  private readonly now: () => number;
  private readonly ttl: number;
  private readonly maxEntries: number;
  private readonly maxBytes: number;

  constructor(options: { now?: () => number; ttl?: number; maxEntries?: number; maxBytes?: number } = {}) {
    this.now = options.now ?? Date.now;
    this.ttl = options.ttl ?? 60 * 60 * 1000;
    this.maxEntries = options.maxEntries ?? 64;
    this.maxBytes = options.maxBytes ?? 32 * 1024 * 1024;
  }

  peek<K extends keyof Values>(kind: K, identity: string): Values[K] | null {
    const key = `${kind}\0${identity}`;
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expires <= this.now()) { this.entries.delete(key); return null; }
    this.entries.delete(key);
    this.entries.set(key, entry);
    // The kind is part of the key and is also the only writer's fetch discriminator.
    return entry.value as Values[K];
  }

  async read<K extends keyof Values>(kind: K, identity: string, fetch: () => Promise<Values[K]>): Promise<Values[K]> {
    const cached = this.peek(kind, identity);
    if (cached) return cached;
    const key = `${kind}\0${identity}`;
    const existing = this.pending.get(key);
    if (existing) return await existing as Values[K];
    const generation = this.generation;
    const pending = fetch().then(value => {
      if (generation !== this.generation) return value;
      const bytes = Object.values(value).reduce<number>((total, field) => total + (typeof field === "string" ? field.length * 2 : 0), key.length * 2);
      if (bytes <= this.maxBytes) {
        const now = this.now();
        for (const [key, entry] of this.entries) if (entry.expires <= now) this.entries.delete(key);
        this.entries.set(key, { value, bytes, expires: now + this.ttl });
        let total = [...this.entries.values()].reduce((sum, entry) => sum + entry.bytes, 0);
        for (const [oldKey, entry] of this.entries) {
          if (total <= this.maxBytes && this.entries.size <= this.maxEntries) break;
          this.entries.delete(oldKey);
          total -= entry.bytes;
        }
      }
      return value;
    }).finally(() => { if (this.pending.get(key) === pending) this.pending.delete(key); });
    this.pending.set(key, pending);
    return await pending;
  }

  clear() {
    this.generation = {};
    this.entries.clear();
    this.pending.clear();
  }
}
