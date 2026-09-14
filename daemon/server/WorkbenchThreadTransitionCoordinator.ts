/*
 * Exports:
 * - default WorkbenchThreadTransitionCoordinator: coordinate fair shared reads and exclusive writes by stable keys across reload generations.
 * - readMany/runMany: acquire several transition keys in stable order for deadlock-free workspace operations.
 */

interface TransitionWaiter {
  kind: "read" | "write";
  resolve(release: () => void): void;
}

interface TransitionState {
  activeReaders: number;
  queue: TransitionWaiter[];
  writerActive: boolean;
}

export default class WorkbenchThreadTransitionCoordinator {
  private readonly states = new Map<string, TransitionState>();

  async read<TValue>(key: string, operation: () => Promise<TValue>): Promise<TValue> {
    return await this.withLease(key, "read", operation);
  }

  async run<TValue>(key: string, operation: () => Promise<TValue>): Promise<TValue> {
    return await this.withLease(key, "write", operation);
  }

  async readMany<TValue>(keys: readonly string[], operation: () => Promise<TValue>): Promise<TValue> {
    return await this.withMany(keys, (key, next) => this.read(key, next), operation);
  }

  async runMany<TValue>(keys: readonly string[], operation: () => Promise<TValue>): Promise<TValue> {
    return await this.withMany(keys, (key, next) => this.run(key, next), operation);
  }

  private acquire(key: string, kind: TransitionWaiter["kind"]) {
    const normalizedKey = key.trim();
    if (!normalizedKey) throw new Error("A transition coordination key is required.");
    const state = this.states.get(normalizedKey) ?? {
      activeReaders: 0,
      queue: [],
      writerActive: false,
    };
    this.states.set(normalizedKey, state);
    return new Promise<() => void>((resolve) => {
      state.queue.push({ kind, resolve });
      this.drain(normalizedKey, state);
    });
  }

  private drain(key: string, state: TransitionState) {
    if (state.writerActive) return;
    while (state.queue[0]?.kind === "read") {
      const waiter = state.queue.shift()!;
      state.activeReaders += 1;
      waiter.resolve(this.release(key, state, "read"));
    }
    if (state.activeReaders > 0) return;
    const writer = state.queue.shift();
    if (writer) {
      state.writerActive = true;
      writer.resolve(this.release(key, state, "write"));
      return;
    }
    this.states.delete(key);
  }

  private release(key: string, state: TransitionState, kind: TransitionWaiter["kind"]) {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (kind === "read") state.activeReaders -= 1;
      else state.writerActive = false;
      this.drain(key, state);
    };
  }

  private async withLease<TValue>(key: string, kind: TransitionWaiter["kind"], operation: () => Promise<TValue>) {
    const release = await this.acquire(key, kind);
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async withMany<TValue>(
    keys: readonly string[],
    withKey: (key: string, operation: () => Promise<TValue>) => Promise<TValue>,
    operation: () => Promise<TValue>,
  ): Promise<TValue> {
    const orderedKeys = [...new Set(keys.map((key) => key.trim()).filter(Boolean))].sort((left, right) => left.localeCompare(right));
    if (!orderedKeys.length) throw new Error("At least one transition coordination key is required.");
    const acquireAt = async (index: number): Promise<TValue> => index >= orderedKeys.length
      ? await operation()
      : await withKey(orderedKeys[index]!, async () => await acquireAt(index + 1));
    return await acquireAt(0);
  }
}
