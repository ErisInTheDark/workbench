/*
 * Exports:
 * - WorkbenchAppReloadControllerState: transferable active reload batch.
 * - WorkbenchAppReloadAdmission: response-first reload or restart execution controls.
 * - default WorkbenchAppReloadController: serialize node replacement, dependency repair and process restart.
 */
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type { WorkbenchReloadResponse, WorkbenchReloadScope } from "workbench-shared/reload/workbench-reload";
import { InstallationRepairJournalSchema } from "workbench-shared/workbench/installation-update";
import { readJournal, writeJournal, resolveDataRoot, isRepairPending } from "../../../installation/update-journal.mjs";

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
    repositoryRootPath?: string;
    repairInstall?(fromSha?: string): Promise<void>;
    prepareInstall?(fromSha?: string): Promise<void>;
    schedule?: (callback: () => void) => void;
  }, state?: WorkbenchAppReloadControllerState) {
    this.state = state ?? { activeScopes: null };
  }

  admit(
    scopes: readonly WorkbenchReloadScope[],
    restartProcess?: () => Promise<void> | void,
    options?: { installFromSha?: string },
  ): WorkbenchAppReloadAdmission {
    const selected = [...new Set(scopes)];
    if (!selected.length) throw new Error("At least one app reload scope is required.");
    const install = selected.includes("client:install");
    const restartScope = install ? "client:install" : this.options.processScope;
    if (restartScope && selected.includes(restartScope)) {
      if (selected.length !== 1) throw new Error(`${restartScope} must be requested by itself.`);
      if (!restartProcess) throw new Error(`${restartScope} requires the Workbench desktop tray.`);
    }
    if (install) {
      if (!this.options.repairInstall || !this.options.repositoryRootPath) throw new Error("Dependency install repair is unavailable.");
      if (options?.installFromSha && !/^[0-9a-f]{40,64}$/u.test(options.installFromSha)) throw new Error("Invalid dependency rollback commit.");
    }
    if (this.reservedScopes || this.state.activeScopes) throw new Error("An app reload batch is already active.");
    const startedAt = (this.options.now ?? Date.now)();
    this.reservedScopes = selected;
    const processRestart = install || Boolean(this.options.processScope && selected[0] === this.options.processScope);
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
          if (processRestart) {
            try {
              if (install) {
                await (this.options.prepareInstall?.(options?.installFromSha) ?? this.prepareInstall(options?.installFromSha));
                await this.options.repairInstall!(options?.installFromSha);
              }
              await restartProcess!();
            } finally {
              if (this.reservedScopes === selected) this.reservedScopes = null;
            }
            return;
          }
          this.reservedScopes = null;
          await this.execute(selected);
        });
      },
    };
  }

  private async prepareInstall(fromSha?: string) {
    const root = this.options.repositoryRootPath!;
    const dataRoot = resolveDataRoot();
    if (isRepairPending(await readJournal(dataRoot))) throw new Error("A dependency update repair is already pending.");
    const { stdout } = await promisify(execFile)("git", ["rev-parse", "HEAD"], { cwd: root, windowsHide: true });
    const at = (this.options.now ?? Date.now)();
    const journal = InstallationRepairJournalSchema.parse({
      version: 1, id: randomUUID(), phase: "pending", fromSha: fromSha ?? null, toSha: stdout.trim(),
      logPath: path.join(root, ".workbench", "logs", `workbench-update-${at}.log`),
      lastError: null, createdAt: at, updatedAt: at, failure: null,
    });
    await writeJournal(journal, dataRoot);
  }

  detachForReload() {
    this.attached = false;
    return this.state;
  }

  resumeAfterFailedReload() {
    this.attached = true;
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
