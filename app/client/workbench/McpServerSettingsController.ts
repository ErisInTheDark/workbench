/*
 * Exports:
 * - McpServerSettingsState: MCP server settings presentation state.
 * - default McpServerSettingsController: own one daemon's MCP server settings reads and fenced writes.
 */
import type { McpServerSettingsSnapshot, McpServerSettingsUpdate } from "workbench-shared/workbench/mcp/mcp-server-settings";

export interface McpServerSettingsState {
  settings: McpServerSettingsSnapshot | null;
  busy: boolean;
  error: string;
}

export default class McpServerSettingsController {
  private snapshot: McpServerSettingsState = { settings: null, busy: false, error: "" };
  private readonly listeners = new Set<() => void>();
  private generation = 0;
  private disposed = false;

  constructor(private readonly port: {
    read(): Promise<McpServerSettingsSnapshot>;
    update(update: McpServerSettingsUpdate): Promise<McpServerSettingsSnapshot>;
  }) {}

  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };

  refresh() { return this.perform(() => this.port.read()); }
  /** Resolves true when the daemon accepted the change. */
  update(update: McpServerSettingsUpdate) { return this.perform(() => this.port.update(update)); }

  dispose() {
    this.disposed = true;
    this.generation += 1;
    this.listeners.clear();
  }

  private async perform(operation: () => Promise<McpServerSettingsSnapshot>) {
    if (this.disposed) return false;
    // The newest request owns the snapshot; an older reply never overwrites it.
    const generation = ++this.generation;
    this.publish({ ...this.snapshot, busy: true, error: "" });
    try {
      const settings = await operation();
      if (!this.disposed && generation === this.generation) this.publish({ settings, busy: false, error: "" });
      return true;
    } catch (error) {
      if (!this.disposed && generation === this.generation) {
        this.publish({ ...this.snapshot, busy: false, error: error instanceof Error ? error.message.slice(0, 300) : "MCP server settings failed." });
      }
      return false;
    }
  }

  private publish(snapshot: McpServerSettingsState) {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
}
