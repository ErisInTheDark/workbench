/*
 * Exports:
 * - default WorkbenchThreadTransitionCoordinator: serialize cross-feature thread transitions by stable worktree and thread keys across reload generations. Keywords: orchestrator, transition, coordinator, thread, reload.
 * - runMany: acquire several transition keys in stable order for deadlock-free workspace operations. Keywords: transition, multi-root, lock, ordering.
 */

export default class WorkbenchThreadTransitionCoordinator {
  private readonly tails = new Map<string, Promise<unknown>>();

  async run<TValue>(key: string, operation: () => Promise<TValue>): Promise<TValue> {
    const normalizedKey = key.trim();
    if (!normalizedKey) throw new Error("A transition coordination key is required.");

    const previous = this.tails.get(normalizedKey) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    const tail = current.catch(() => undefined);
    this.tails.set(normalizedKey, tail);
    try {
      return await current;
    } finally {
      if (this.tails.get(normalizedKey) === tail) this.tails.delete(normalizedKey);
    }
  }

  async runMany<TValue>(keys: readonly string[], operation: () => Promise<TValue>): Promise<TValue> {
    const orderedKeys = [...new Set(keys.map((key) => key.trim()).filter(Boolean))].sort((left, right) => left.localeCompare(right));
    if (!orderedKeys.length) throw new Error("At least one transition coordination key is required.");
    const acquire = async (index: number): Promise<TValue> => index >= orderedKeys.length
      ? await operation()
      : await this.run(orderedKeys[index]!, async () => await acquire(index + 1));
    return await acquire(0);
  }
}
