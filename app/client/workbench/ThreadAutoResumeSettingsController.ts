/*
 * Exports:
 * - default ThreadAutoResumeSettingsController: own one daemon's auto resume settings load/save state, ordered edits and their optimistic display.
 */
import type { ThreadAutoResumePatch, ThreadAutoResumeSettings } from "workbench-shared/workbench/settings/thread-auto-resume";

export default class ThreadAutoResumeSettingsController {
  private snapshot = { settings: null as ThreadAutoResumeSettings | null, error: "" };
  private readonly listeners = new Set<() => void>();
  private tail = Promise.resolve();
  private active = true;

  constructor(private readonly daemon: {
    read(): Promise<{ settings: ThreadAutoResumeSettings }>;
    update(input: ThreadAutoResumePatch): Promise<{ settings: ThreadAutoResumeSettings }>;
  }) {}

  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.snapshot;

  load() {
    this.active = true;
    return this.enqueue(() => this.daemon.read());
  }

  update(patch: ThreadAutoResumePatch) {
    if (!this.active || !this.snapshot.settings) return Promise.resolve();
    const confirmed = this.snapshot.settings;
    this.publish({ settings: { ...confirmed, ...patch }, error: "" });
    return this.enqueue(() => this.daemon.update(patch), confirmed);
  }

  dispose() { this.active = false; }

  private enqueue(request: () => Promise<{ settings: ThreadAutoResumeSettings }>, rollback?: ThreadAutoResumeSettings) {
    this.tail = this.tail.then(async () => {
      if (!this.active) return;
      try {
        const { settings } = await request();
        if (this.active) this.publish({ settings, error: "" });
      } catch (error) {
        if (!this.active) return;
        this.publish({
          settings: rollback ?? this.snapshot.settings,
          error: error instanceof Error ? error.message : "Unable to save auto-resume settings.",
        });
      }
    });
    return this.tail;
  }

  private publish(snapshot: typeof this.snapshot) {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
}
