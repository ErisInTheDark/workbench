/*
 * Exports:
 * - WorkbenchAppReloadControllerState: transferable active reload batch. Keywords: reload, state, handoff.
 * - WorkbenchAppReloadAdmission: response-first reload or restart execution controls. Keywords: HTTP, admission, lifecycle.
 * - default WorkbenchAppReloadController: validate and serialize app-node replacement and full-process restart admission. Keywords: app, reload, lifecycle.
 */
import type { WorkbenchReloadResponse, WorkbenchReloadScope } from "workbench-shared/reload/workbench-reload";

import type WorkbenchAppReloadDirtController from "./WorkbenchAppReloadDirtController.ts";

export interface WorkbenchAppReloadControllerState {
  activeScopes: WorkbenchReloadScope[] | null;
}

export interface WorkbenchAppReloadAdmission {
  cancel(): void;
  response: WorkbenchReloadResponse;
  start(): Promise<void>;
}

export default class WorkbenchAppReloadController {
  private attached = true;
  private reservedScopes: WorkbenchReloadScope[] | null = null;
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

  admit(
    scopes: readonly WorkbenchReloadScope[],
    restartProcess?: () => Promise<void> | void,
  ): WorkbenchAppReloadAdmission {
    const selected = [...new Set(scopes)];
    if (!selected.length) throw new Error("At least one app reload scope is required.");
    if (this.options.processScope && selected.includes(this.options.processScope)) {
      if (selected.length !== 1) throw new Error(`${this.options.processScope} must be requested by itself.`);
      if (!restartProcess) throw new Error(`${this.options.processScope} requires the Workbench desktop tray.`);
    }
    if (this.reservedScopes || this.state.activeScopes) throw new Error("An app reload batch is already active.");
    const startedAt = (this.options.now ?? Date.now)();
    this.reservedScopes = selected;
    const processRestart = Boolean(this.options.processScope && selected[0] === this.options.processScope);
    let active = true;
    return {
      cancel: () => {
        if (!active) return;
        active = false;
        if (this.reservedScopes === selected) this.reservedScopes = null;
      },
      response: {
        appliedScopes: [],
        completedAt: processRestart ? startedAt : null,
        error: null,
        ok: true,
        queuedScopes: selected,
        requestedScopes: selected,
        startedAt,
        state: processRestart ? "succeeded" : "running",
      },
      start: () => {
        if (!active || this.reservedScopes !== selected) {
          return Promise.reject(new Error("The app reload admission is no longer active."));
        }
        active = false;
        return this.scheduleCompletion(async () => {
          if (this.reservedScopes !== selected) throw new Error("The app reload admission was replaced before execution.");
          this.reservedScopes = null;
          if (processRestart) {
            await restartProcess!();
            return;
          }
          await this.execute(selected);
        });
      },
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
    this.reservedScopes = null;
  }

  private async execute(scopes: WorkbenchReloadScope[]) {
    const run = this.tail.then(async () => {
      this.state.activeScopes = scopes;
      this.options.dirt.beginReload(scopes);
      try {
        const applied = await this.options.execute(scopes);
        if (this.attached) await this.options.dirt.completeReload(applied);
      } catch (error) {
        if (this.attached) this.options.dirt.failReload(error);
        throw error;
      } finally {
        if (this.state.activeScopes === scopes) this.state.activeScopes = null;
      }
    });
    this.tail = run.catch(() => undefined);
    await run;
  }

  private scheduleCompletion(operation: () => Promise<void>) {
    return new Promise<void>((resolve, reject) => {
      (this.options.schedule ?? setImmediate)(() => {
        void operation().then(resolve, reject);
      });
    });
  }
}
