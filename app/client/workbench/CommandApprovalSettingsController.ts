/*
 * Exports:
 * - CommandApprovalSettingsState: saved-rule presentation state.
 * - default CommandApprovalSettingsController: own settings reads and exact-workdir save intent.
 */
import type { CommandApprovalRule, CommandApprovalSnapshot } from "workbench-shared/workbench/settings/command-approvals";

export interface CommandApprovalSettingsState {
  rules: CommandApprovalRule[];
  loading: boolean;
  error: string;
}

export default class CommandApprovalSettingsController {
  private snapshot: CommandApprovalSettingsState = { rules: [], loading: false, error: "" };
  private listeners = new Set<() => void>();
  private generation = 0;
  private disposed = false;
  private saving = false;
  constructor(private readonly port: {
    read(): Promise<CommandApprovalSnapshot>;
    patch(workdir: string, add: string[], removeIds: string[]): Promise<CommandApprovalSnapshot>;
  }) {}

  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  async refresh(): Promise<void> {
    if (this.saving) return;
    await this.perform(() => this.port.read());
  }
  async save(workdir: string, add: string[], removeIds: string[]): Promise<void> {
    if (this.saving || this.disposed) return;
    this.saving = true;
    try { await this.perform(() => this.port.patch(workdir, add, removeIds)); }
    finally { this.saving = false; }
  }
  dispose() {
    this.disposed = true;
    this.generation += 1;
    this.listeners.clear();
  }

  private async perform(operation: () => Promise<CommandApprovalSnapshot>) {
    if (this.disposed) return;
    const generation = ++this.generation;
    this.publish({ ...this.snapshot, loading: true, error: "" });
    try {
      const result = await operation();
      if (!this.disposed && generation === this.generation) this.publish({ rules: result.rules, loading: false, error: "" });
    } catch (error) {
      if (!this.disposed && generation === this.generation) {
        this.publish({ ...this.snapshot, loading: false, error: error instanceof Error ? error.message : "Unable to update command approvals." });
      }
    }
  }

  private publish(snapshot: CommandApprovalSettingsState) {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
}
