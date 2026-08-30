/*
 * Exports:
 * - WorkbenchAppReloadControllerState: transferable active reload batch. Keywords: reload, state, handoff.
 * - default WorkbenchAppReloadController: validate and serialize app-node replacement. Keywords: app, reload, lifecycle.
 */
import type { WorkbenchReloadResponse, WorkbenchReloadScope } from "workbench-shared/reload/workbench-reload";

import type WorkbenchAppReloadDirtController from "./WorkbenchAppReloadDirtController.ts";

export interface WorkbenchAppReloadControllerState {
  activeScopes: WorkbenchReloadScope[] | null;
}

export default class WorkbenchAppReloadController {
  private attached = true;
  private tail = Promise.resolve();
  private readonly state: WorkbenchAppReloadControllerState;

  constructor(private readonly options: {
    dirt: WorkbenchAppReloadDirtController;
    execute(scopes: WorkbenchReloadScope[]): Promise<WorkbenchReloadScope[]>;
    now?: () => number;
    processScope?: WorkbenchReloadScope;
    schedule?: (callback: () => void) => void;
  }, state?: WorkbenchAppReloadControllerState) {
    this.state = state ?? { activeScopes: null };
  }

  admit(scopes: readonly WorkbenchReloadScope[]): WorkbenchReloadResponse {
    const selected = [...new Set(scopes)];
    if (!selected.length) throw new Error("At least one app reload scope is required.");
    if (this.options.processScope && selected.includes(this.options.processScope)) {
      throw new Error(`${this.options.processScope} requires a full Workbench app restart.`);
    }
    if (this.state.activeScopes) throw new Error("An app reload batch is already active.");
    const startedAt = (this.options.now ?? Date.now)();
    this.state.activeScopes = selected;
    this.options.dirt.beginReload(selected);
    (this.options.schedule ?? setImmediate)(() => {
      const run = this.tail.then(async () => {
        try {
          const applied = await this.options.execute(selected);
          if (this.attached) this.options.dirt.completeReload(applied);
        } catch (error) {
          if (this.attached) this.options.dirt.failReload(error);
        } finally {
          if (this.state.activeScopes === selected) this.state.activeScopes = null;
        }
      });
      this.tail = run.catch(() => undefined);
    });
    return {
      appliedScopes: [],
      completedAt: null,
      error: null,
      ok: true,
      queuedScopes: selected,
      requestedScopes: selected,
      startedAt,
      state: "running",
    };
  }

  detachForReload() {
    this.attached = false;
    return this.state;
  }

  completeTransferredBatchIfPresent(appliedScopes: readonly WorkbenchReloadScope[]) {
    const scopes = this.state.activeScopes;
    if (!scopes) return;
    this.state.activeScopes = null;
    this.options.dirt.completeReload(appliedScopes);
  }

  failTransferredBatch(error: unknown) {
    if (!this.state.activeScopes) return;
    this.state.activeScopes = null;
    this.options.dirt.failReload(error);
  }

  dispose() {
    this.attached = false;
  }
}
