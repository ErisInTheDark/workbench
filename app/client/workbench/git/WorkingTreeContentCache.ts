/*
 * Exports:
 * - default WorkingTreeContentCache: bound and coalesce immutable working-tree content.
 */
import type WorkbenchDaemonClient from "workbench-shared/workbench/daemon/WorkbenchDaemonClient";
import type { WorkingTreeDiff, WorkingTreeFileRequest, WorkingTreePreview } from "workbench-shared/workbench/git/working-tree-contracts";
type Port = Pick<WorkbenchDaemonClient["git"]["workingTree"], "diff" | "preview">;
type Values = { diff: WorkingTreeDiff; preview: WorkingTreePreview };
type Entry = { value: Values[keyof Values]; expires: number; bytes: number };

export default class WorkingTreeContentCache {
  private readonly entries = new Map<string, Entry>();
  private readonly pending = new Map<string, Promise<Values[keyof Values]>>();
  private generation = {};
  private readonly now: () => number;
  private readonly ttl: number;
  private readonly maxEntries: number;
  private readonly maxBytes: number;

  constructor(private readonly port: Port, options: { now?: () => number; ttl?: number; maxEntries?: number; maxBytes?: number } = {}) {
    this.now = options.now ?? Date.now;
    this.ttl = options.ttl ?? 60 * 60 * 1000;
    this.maxEntries = options.maxEntries ?? 64;
    this.maxBytes = options.maxBytes ?? 32 * 1024 * 1024;
  }

  private key(kind: keyof Values, request: WorkingTreeFileRequest, cwd: string) {
    return JSON.stringify([kind, request.projectId, request.rootId, cwd, request.path, request.identity]);
  }

  private peek<K extends keyof Values>(kind: K, request: WorkingTreeFileRequest, cwd: string): Values[K] | null {
    const key = this.key(kind, request, cwd);
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expires <= this.now()) { this.entries.delete(key); return null; }
    this.entries.delete(key);
    this.entries.set(key, entry);
    // The kind is part of the key and is also the only writer's fetch discriminator.
    return entry.value as Values[K];
  }

  peekDiff(request: WorkingTreeFileRequest, cwd: string) { return this.peek("diff", request, cwd); }
  peekPreview(request: WorkingTreeFileRequest, cwd: string) { return this.peek("preview", request, cwd); }
  readDiff(request: WorkingTreeFileRequest, cwd: string) { return this.read("diff", request, cwd, () => this.port.diff(request)); }
  readPreview(request: WorkingTreeFileRequest, cwd: string) { return this.read("preview", request, cwd, () => this.port.preview(request)); }

  private async read<K extends keyof Values>(kind: K, request: WorkingTreeFileRequest, cwd: string, fetch: () => Promise<Values[K]>): Promise<Values[K]> {
    const cached = this.peek(kind, request, cwd);
    if (cached) return cached;
    const key = this.key(kind, request, cwd);
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
