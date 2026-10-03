/*
 * Exports:
 * - default ReloadRetentionTracker: report retired reload generations and node instances that stay reachable.
 */

interface RetainedEntry {
  label: string;
  /** Reload count when nothing live should reference the target anymore; null while still in use. */
  retiredAt: number | null;
}

/** Garbage collection is lazy; only report targets that survived this many later reloads. */
const REPORT_AFTER_RELOADS = 2;

export default class ReloadRetentionTracker {
  readonly #entries = new Map<number, RetainedEntry>();
  readonly #generationTokens = new Map<number, number>();
  readonly #registry = new FinalizationRegistry<number>(token => { this.#entries.delete(token); });
  #nextToken = 0;
  #reloads = 0;

  /** Track a module-owned object whose lifetime matches one loaded module generation. */
  trackGeneration(generation: number, target: object) {
    const token = this.#track(target, `module generation ${generation}`, null);
    this.#generationTokens.set(generation, token);
  }

  /** Mark loaded generations that no live node or current definition references anymore. */
  retireUnusedGenerations(used: ReadonlySet<number>) {
    for (const [generation, token] of this.#generationTokens) {
      if (used.has(generation)) continue;
      this.#generationTokens.delete(generation);
      const entry = this.#entries.get(token);
      if (entry) entry.retiredAt = this.#reloads;
    }
  }

  trackRetiredNode(id: string, generation: number, instance: object) {
    this.#track(instance, `${id} node (generation ${generation})`, this.#reloads);
  }

  /** Count one completed reload attempt and describe retired targets that outlived the collection grace. */
  completeReload() {
    this.#reloads += 1;
    const retained = [...this.#entries.values()].filter(entry =>
      entry.retiredAt !== null && this.#reloads - entry.retiredAt >= REPORT_AFTER_RELOADS);
    if (!retained.length) return null;
    const heap = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
    const labels = retained.slice(0, 6).map(entry => entry.label).join(", ");
    return `${retained.length} retired reload object(s) still reachable ${REPORT_AFTER_RELOADS}+ reloads after retirement `
      + `(heap ${heap}MB): ${labels}${retained.length > 6 ? ", ..." : ""}. `
      + "Something outside the live graph still references old modules or node objects.";
  }

  #track(target: object, label: string, retiredAt: number | null) {
    const token = this.#nextToken++;
    this.#entries.set(token, { label, retiredAt });
    this.#registry.register(target, token);
    return token;
  }
}
