/*
 * Exports:
 * - WorkbenchThreadBusyTrackerPorts: working-thread seed, lifecycle changes and the busy reason this tracker owns.
 * - default WorkbenchThreadBusyTracker: hold one busy reason while any thread is working (including long waits) or compacting.
 */

export interface WorkbenchThreadBusyTrackerPorts {
  readWorkingThreadIds(): Promise<readonly string[]>;
  /** Every published thread lifecycle change, as whether that thread is now working. */
  subscribe(listener: (threadId: string, working: boolean) => void): () => void;
  hold(reason: string | null): void;
  warn(message: string): void;
}

const count = (size: number, noun: string, verb: string) => `${size} ${noun}${size === 1 ? "" : "s"} ${verb}`;

export default class WorkbenchThreadBusyTracker {
  private readonly working = new Set<string>();
  private readonly compacting = new Set<string>();
  /** Threads changed while the seed read ran; their events are newer than the seed. */
  private observedDuringSeed: Set<string> | null = new Set();
  private readonly unsubscribe: () => void;
  private started = false;
  private disposed = false;

  constructor(private readonly ports: WorkbenchThreadBusyTrackerPorts) {
    this.unsubscribe = ports.subscribe((threadId, working) => {
      this.observedDuringSeed?.add(threadId);
      if (working) this.working.add(threadId);
      else this.working.delete(threadId);
      this.publish();
    });
  }

  setCompacting(threadId: string, compacting: boolean) {
    if (compacting) this.compacting.add(threadId);
    else this.compacting.delete(threadId);
    this.publish();
  }

  async start() {
    try {
      const seeded = await this.ports.readWorkingThreadIds();
      if (this.disposed) return;
      for (const threadId of seeded) if (!this.observedDuringSeed?.has(threadId)) this.working.add(threadId);
    } catch (error) {
      this.ports.warn(`Working threads could not be read for the busy lease: ${error instanceof Error ? error.message.slice(0, 300) : "unknown failure"}`);
    } finally {
      this.observedDuringSeed = null;
    }
    this.started = true;
    this.publish();
  }

  /** Leaves the reason held: the reload replacing this generation holds its own reason, and the next tracker republishes. */
  dispose() {
    this.disposed = true;
    this.unsubscribe();
  }

  private publish() {
    if (!this.started || this.disposed) return;
    const reasons = [
      ...this.working.size ? [count(this.working.size, "thread", "working")] : [],
      ...this.compacting.size ? [count(this.compacting.size, "thread", "compacting")] : [],
    ];
    this.ports.hold(reasons.length ? reasons.join(", ") : null);
  }
}
