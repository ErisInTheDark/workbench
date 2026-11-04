/*
 * Exports:
 * - default ThreadAutoCompactSettingsController: own one daemon's per-provider settings load/save state, ordered edits and their optimistic display.
 */
import type { WorkbenchProviderKey } from "workbench-shared/workbench/provider/provider-registrations";
import {
  ThreadAutoCompactRules, type ThreadAutoCompactPatch, type ThreadAutoCompactSettings, type ThreadAutoCompactUpdate,
} from "workbench-shared/workbench/settings/thread-auto-compact";

export default class ThreadAutoCompactSettingsController {
  private snapshot = { settings: null as ThreadAutoCompactSettings | null, pending: true, error: "" };
  private readonly listeners = new Set<() => void>();
  private tail = Promise.resolve();
  private revision = 0;
  private active = true;
  private readonly pending = new Set<Promise<void>>();
  /** Last daemon-acknowledged settings; `snapshot.settings` layers queued edits over it. */
  private confirmed: ThreadAutoCompactSettings | null = null;
  private edits: ThreadAutoCompactUpdate[] = [];
  constructor(private readonly daemon: {
    read(): Promise<{ settings: ThreadAutoCompactSettings }>;
    update(input: ThreadAutoCompactUpdate): Promise<{ settings: ThreadAutoCompactSettings }>;
  }) {}
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.snapshot;
  load() {
    this.active = true;
    const revision = ++this.revision;
    this.edits = [];
    return this.enqueue(revision, () => this.daemon.read());
  }
  update(provider: WorkbenchProviderKey, settings: ThreadAutoCompactPatch) {
    if (!this.active || !this.confirmed) return Promise.resolve();
    const edit = { provider, settings: { ...settings } };
    this.edits.push(edit);
    return this.enqueue(this.revision, () => this.daemon.update(edit), edit);
  }
  dispose() { this.active = false; this.revision++; }

  private enqueue(revision: number, request: () => Promise<{ settings: ThreadAutoCompactSettings }>, edit?: object) {
    const current = () => this.active && this.revision === revision;
    const operation = this.tail.then(async () => {
      if (!current()) return;
      try {
        const response = await request();
        if (current()) { this.confirmed = response.settings; this.snapshot = { ...this.snapshot, error: "" }; }
      } catch (error) {
        if (current()) this.snapshot = { ...this.snapshot, error: error instanceof Error ? error.message : "Unable to save auto-compact settings." };
      } finally {
        if (edit) this.edits = this.edits.filter(item => item !== edit);
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
    // An edit the daemon would refuse shows nothing until its error arrives.
    const settings = this.confirmed && this.edits.reduce((shown, { provider, settings: patch }) => {
      try { return { ...shown, [provider]: ThreadAutoCompactRules.apply(shown[provider], patch) }; }
      catch { return shown; }
    }, this.confirmed);
    this.snapshot = { ...this.snapshot, settings, pending: this.pending.size > 0 };
    for (const listener of this.listeners) listener();
  }
}
