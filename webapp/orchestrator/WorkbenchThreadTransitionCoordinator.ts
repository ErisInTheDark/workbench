/*
 * Exports:
 * - default WorkbenchThreadTransitionCoordinator: serialize cross-feature thread transitions by stable worktree and thread keys across reload generations. Keywords: orchestrator, transition, coordinator, thread, reload.
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
}
