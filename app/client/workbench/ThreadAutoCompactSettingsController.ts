/*
 * Exports:
 * - default ThreadAutoCompactSettingsController: own daemon settings load/save state and ordered edits.
 */
import type { ThreadAutoCompactSettings } from "workbench-shared/workbench/settings/thread-auto-compact";

export default class ThreadAutoCompactSettingsController {
  private snapshot = { settings: null as ThreadAutoCompactSettings | null, pending: true, error: "" };
  private readonly listeners = new Set<() => void>();
  private tail = Promise.resolve();
  private revision = 0;
  private active = true;
  private readonly pending = new Set<Promise<void>>();
  constructor(private readonly daemon: {
    read(): Promise<{ settings: ThreadAutoCompactSettings }>;
    update(input: { settings: Partial<ThreadAutoCompactSettings> }): Promise<{ settings: ThreadAutoCompactSettings }>;
  }) {}
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.snapshot;
  load() {
    this.active = true;
    const revision = ++this.revision;
    return this.enqueue(revision, () => this.daemon.read());
  }
  update(settings: Partial<ThreadAutoCompactSettings>) {
    if (!this.active) return Promise.resolve();
    return this.enqueue(this.revision, () => this.daemon.update({ settings }));
  }
  dispose() { this.active = false; this.revision++; }

  private enqueue(revision: number, request: () => Promise<{ settings: ThreadAutoCompactSettings }>) {
    const current = () => this.active && this.revision === revision;
    const operation = this.tail.then(async () => {
      if (!current()) return;
      try {
        const response = await request();
        if (current()) this.snapshot = { ...this.snapshot, settings: response.settings, error: "" };
      } catch (error) {
        if (current()) this.snapshot = { ...this.snapshot, error: error instanceof Error ? error.message : "Unable to save auto-compact settings." };
      }
    }).finally(() => {
      this.pending.delete(operation);
      if (current()) this.publish();
    });
    this.pending.add(operation);
    this.tail = operation;
    this.publish();
    return operation;
  }

  private publish() {
    this.snapshot = { ...this.snapshot, pending: this.pending.size > 0 };
    for (const listener of this.listeners) listener();
  }
}
