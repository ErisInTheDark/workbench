/*
 * Exports:
 * - default ThreadHistoryReads: keep one thread-history read in flight per key; requests made during it fold into one trailing read covering every requested turn, or the whole thread.
 */

/** Wider scopes than this read the whole thread; it matches the daemon's per-request turn limit. */
const MAX_SCOPED_TURNS = 50;

type Scope = Set<string> | "thread";

function widen(current: Scope | null, turnIds: readonly string[] | null): Scope {
  if (current === "thread" || turnIds === null) return "thread";
  const next = new Set([...current ?? [], ...turnIds]);
  return next.size > MAX_SCOPED_TURNS ? "thread" : next;
}

/**
 * History changes arrive in bursts (each held steer, user message and turn end announces one), and every read
 * costs the daemon a transcript projection. One read per key runs at a time; whatever arrives meanwhile is read once more after it.
 */
export default class ThreadHistoryReads {
  readonly #runs = new Map<string, { pending: Scope | null; done: Promise<void> }>();

  /**
   * `turnIds` null asks for the whole thread. Resolves after a read that started no earlier than this call finishes.
   * `read` owns its failures; a rejection ends the run and reaches every caller waiting on it.
   */
  request(key: string, turnIds: readonly string[] | null, read: (turnIds: string[] | null) => Promise<void>) {
    const active = this.#runs.get(key);
    if (active) {
      active.pending = widen(active.pending, turnIds);
      return active.done;
    }
    const run: { pending: Scope | null; done: Promise<void> } = { pending: widen(null, turnIds), done: Promise.resolve() };
    this.#runs.set(key, run);
    run.done = (async () => {
      try {
        while (run.pending) {
          const scope = run.pending;
          run.pending = null;
          await read(scope === "thread" ? null : [...scope]);
        }
      } finally {
        this.#runs.delete(key);
      }
    })();
    return run.done;
  }
}
