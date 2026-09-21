/*
 * Exports:
 * - default WorkbenchServiceReloadController: serialize host reload admission without leasing its own closure.
 */
import type ReloadDirtController from "../../../shared/reload/ReloadDirtController.ts";
import type { WorkbenchReloadScope } from "../../../shared/reload/workbench-reload.ts";

export default class WorkbenchServiceReloadController {
  private closed = false;

  constructor(private readonly options: {
    dirt: ReloadDirtController;
    execute(scopes: readonly WorkbenchReloadScope[]): Promise<void>;
    restart(): void;
    warn(message: string): void;
  }, private readonly state = { pending: false }) {}

  transfer() { return this.state; }

  admit(scopes: readonly WorkbenchReloadScope[]) {
    if (this.closed || this.state.pending) throw new Error("A host reload is already active or closing.");
    const selected = [...new Set(scopes)];
    const catalog = this.options.dirt.getCatalog();
    if (!selected.length || selected.some(scope => !catalog.some(item => item.scope === scope))) {
      throw new Error("Unknown host reload scope.");
    }
    if (selected.includes("host:process") && selected.length !== 1) throw new Error("host:process must be requested by itself.");
    this.state.pending = true;
    let admitted = true;
    return {
      cancel: () => { if (admitted) { admitted = false; this.state.pending = false; } },
      start: () => {
        if (!admitted) throw new Error("Host reload admission is no longer active.");
        admitted = false;
        // The control reply must leave before its graph-owned resources detach.
        setImmediate(() => {
          if (this.closed) { this.state.pending = false; return; }
          if (selected[0] === "host:process") { this.options.restart(); return; }
          this.options.dirt.beginReload(selected);
          void this.options.execute(selected).catch(error => {
            this.options.warn(error instanceof Error ? error.message.slice(0, 512) : "Host reload failed.");
          }).finally(() => { this.state.pending = false; });
        });
      },
    };
  }

  close() { this.closed = true; }
}
