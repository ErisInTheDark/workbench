/*
 * Exports:
 * - WorkbenchDaemonReloadControllerState: transferable active-batch and hard-reload state.
 * - WorkbenchUserReloadAdmission: browser admission response plus post-send execution controls.
 * - WorkbenchHardReloadNotification/WorkbenchHardReloadOptions: impending-restart notification and force-exit ports.
 * - WorkbenchDaemonReloadControllerOptions: dirt selection and low-level execution ports.
 * - default WorkbenchDaemonReloadController: own user-requested reload execution, dirt observation, handoff completion, and hard reload.
 */
import type { WorkbenchReloadDirtSnapshot } from "workbench-shared/reload/workbench-reload";
import type { DaemonReloadRequest, DaemonReloadResponse, DaemonReloadScope } from "workbench-shared/types";
import {
  expandDaemonReloadScopes,
  resolveDaemonReloadSelections,
  validateDaemonReloadScopeCombination,
  type DaemonReloadScopeDescriptor,
} from "workbench-shared/workbench/daemon-reload";
import type WorkbenchReloadDirtController from "./WorkbenchReloadDirtController";

interface ReloadBatch { scopes: DaemonReloadScope[] }

export interface WorkbenchUserReloadAdmission {
  cancel(): void;
  response: DaemonReloadResponse;
  start(): Promise<void>;
}

export interface WorkbenchDaemonReloadControllerState {
  activeBatch: ReloadBatch | null;
  hardReloadPhase: "admitted" | "idle" | "stopping";
}

interface HardReloadDeadline {
  cancel(): void;
  expired: Promise<void>;
}

export interface WorkbenchHardReloadNotification {
  name: string;
  notify(): Promise<void> | void;
}

export interface WorkbenchHardReloadOptions {
  createDeadline?: (timeoutMs: number) => HardReloadDeadline;
  exitProcess(): void;
  logError?: (message: string) => void;
  notifications(): readonly WorkbenchHardReloadNotification[];
  timeoutMs?: number;
}

export interface WorkbenchDaemonReloadControllerOptions {
  dirt?: WorkbenchReloadDirtController;
  executeBatch(scopes: DaemonReloadScope[]): Promise<void>;
  getReloadScopeCatalog?: () => readonly DaemonReloadScopeDescriptor[];
  hardReload?: WorkbenchHardReloadOptions;
  initialState?: WorkbenchDaemonReloadControllerState;
  now?: () => number;
  schedule?: (callback: () => void) => void;
}

const DEFAULT_HARD_RELOAD_TIMEOUT_MS = 5_000;
const EMPTY_RELOAD_DIRT: WorkbenchReloadDirtSnapshot = {
  dirtyScopes: [],
  error: null,
  pendingScopes: [],
};

function createDeadline(timeoutMs: number): HardReloadDeadline {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const expired = new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); });
  return {
    cancel: () => {
      if (timer === null) return;
      clearTimeout(timer);
      timer = null;
    },
    expired,
  };
}

export default class WorkbenchDaemonReloadController {
  private attached = true;
  private executionTail = Promise.resolve();
  private hardReloadExitRequested = false;
  private readonly now: () => number;
  private reservedBatch: ReloadBatch | null = null;
  private readonly schedule: (callback: () => void) => void;
  private readonly state: WorkbenchDaemonReloadControllerState;

  constructor(private readonly options: WorkbenchDaemonReloadControllerOptions) {
    this.now = options.now ?? Date.now;
    this.schedule = options.schedule ?? setImmediate;
    this.state = options.initialState ?? { activeBatch: null, hardReloadPhase: "idle" };
  }

  resolveSelections(
    input: { all?: boolean; scopes?: unknown; unsafe?: boolean },
    access: DaemonReloadScopeDescriptor["access"],
  ) {
    const catalog = this.options.dirt?.getCatalog() ?? this.options.getReloadScopeCatalog?.() ?? [];
    if (!input.all) {
      const selected = resolveDaemonReloadSelections(input, catalog, access);
      return selected.includes("server:process") ? ["server:process"] : selected;
    }
    const explicit = input.scopes === undefined ? [] : expandDaemonReloadScopes(input.scopes);
    const dirt = (this.options.dirt?.getSnapshot().dirtyScopes ?? [])
      .filter((entry) => !entry.destructive || input.unsafe)
      .map(({ scope }) => scope);
    const selections = [...new Set([...dirt, ...explicit])];
    if (!selections.length) return [];
    const selected = resolveDaemonReloadSelections({ scopes: selections }, catalog, access);
    return selected.includes("server:process") ? ["server:process"] : selected;
  }

  validateCombination(scopes: readonly DaemonReloadScope[]) {
    return validateDaemonReloadScopeCombination(scopes);
  }

  getReloadDirtSnapshot() {
    return this.options.dirt?.getSnapshot() ?? EMPTY_RELOAD_DIRT;
  }

  subscribeReloadDirt(listener: () => void) {
    return this.options.dirt?.subscribe(listener) ?? (() => undefined);
  }

  admitUserReload(input: DaemonReloadRequest): WorkbenchUserReloadAdmission {
    const scopes = this.resolveSelections(input, "operator");
    if (!scopes.length) throw new Error("At least one supported reload scope is required.");
    const combinationError = this.validateCombination(scopes);
    if (combinationError) throw new Error(combinationError);
    if (scopes[0] === "server:process") {
      const response = this.admitHardReload();
      let active = true;
      return {
        cancel: () => {
          if (!active) return;
          active = false;
          this.cancelHardReloadAdmission();
        },
        response,
        start: () => {
          if (!active) return Promise.reject(new Error("The hard reload admission is no longer active."));
          active = false;
          return this.scheduleCompletion(async () => await this.beginHardReload());
        },
      };
    }
    if (this.reservedBatch || this.state.activeBatch) throw new Error("A reload batch is already active.");
    const batch = { scopes };
    this.reservedBatch = batch;
    const startedAt = this.now();
    let active = true;
    return {
      cancel: () => {
        if (!active) return;
        active = false;
        if (this.reservedBatch === batch) this.reservedBatch = null;
      },
      response: {
        appliedScopes: [],
        completedAt: null,
        error: null,
        ok: true,
        queuedScopes: [...scopes],
        requestedScopes: [...scopes],
        startedAt,
        state: "running",
      },
      start: () => {
        if (!active || this.reservedBatch !== batch) return Promise.reject(new Error("The reload admission is no longer active."));
        active = false;
        return this.scheduleCompletion(async () => {
          await this.runExclusive(async () => {
            if (this.reservedBatch !== batch) throw new Error("The reload admission was replaced before execution.");
            this.reservedBatch = null;
            await this.executeBatch(batch);
          });
        });
      },
    };
  }

  detachForReload() {
    this.attached = false;
    return this.state;
  }

  resumeAfterFailedReload() {
    this.attached = true;
    this.options.dirt?.resumeAfterFailedReload();
  }

  completeTransferredBatchIfPresent() {
    const batch = this.state.activeBatch;
    if (!batch) return;
    this.state.activeBatch = null;
    const completion = this.options.dirt?.completeReload(batch.scopes) ?? Promise.resolve();
    this.executionTail = completion.catch((error) => this.options.dirt?.failReload(error));
  }

  failTransferredBatch(error: unknown) {
    if (!this.state.activeBatch) return;
    this.state.activeBatch = null;
    this.options.dirt?.failReload(error);
  }

  async executeUnmanaged(scopes: DaemonReloadScope[]) {
    await this.runExclusive(async () => {
      if (this.reservedBatch || this.state.activeBatch) throw new Error("A reload batch is already active.");
      await this.executeBatch({ scopes: [...new Set(scopes)] });
    });
  }

  dispose() {
    this.attached = false;
    this.reservedBatch = null;
    this.state.activeBatch = null;
  }

  admitHardReload(): DaemonReloadResponse {
    if (!this.options.hardReload) throw new Error("Hard reload is not configured.");
    if (this.state.hardReloadPhase !== "idle") throw new Error("A hard reload is already pending.");
    const startedAt = this.now();
    this.state.hardReloadPhase = "admitted";
    return {
      appliedScopes: [], completedAt: startedAt, error: null, ok: true,
      queuedScopes: ["server:process"], requestedScopes: ["server:process"], startedAt, state: "succeeded",
    };
  }

  cancelHardReloadAdmission() {
    if (this.state.hardReloadPhase === "admitted") this.state.hardReloadPhase = "idle";
  }

  isHardReloadPending() {
    return this.state.hardReloadPhase !== "idle";
  }

  async beginHardReload() {
    const options = this.options.hardReload;
    if (!options) throw new Error("Hard reload is not configured.");
    if (this.state.hardReloadPhase === "stopping") return;
    if (this.state.hardReloadPhase !== "admitted") throw new Error("Hard reload was not admitted before shutdown began.");
    this.state.hardReloadPhase = "stopping";
    this.attached = false;
    const logError = options.logError ?? (() => undefined);
    const deadline = (options.createDeadline ?? createDeadline)(options.timeoutMs ?? DEFAULT_HARD_RELOAD_TIMEOUT_MS);
    const settlements = options.notifications().map(({ name, notify }) => {
      try {
        return Promise.resolve(notify()).catch((error: unknown) => {
          logError(`${name} hard-reload notification failed: ${error instanceof Error ? error.message : String(error)}`);
        });
      } catch (error) {
        logError(`${name} hard-reload notification failed: ${error instanceof Error ? error.message : String(error)}`);
        return Promise.resolve();
      }
    });
    const settled = Promise.all(settlements).then(() => undefined);
    const outcome = await Promise.race([settled.then(() => "settled" as const), deadline.expired.then(() => "deadline" as const)]);
    if (outcome === "settled") deadline.cancel();
    if (this.hardReloadExitRequested) return;
    this.hardReloadExitRequested = true;
    options.exitProcess();
  }

  private async runExclusive(operation: () => Promise<void>) {
    const run = this.executionTail.then(operation);
    this.executionTail = run.catch(() => undefined);
    await run;
  }

  private async executeBatch(batch: ReloadBatch) {
    this.state.activeBatch = batch;
    this.options.dirt?.beginReload(batch.scopes);
    try {
      await this.options.executeBatch(batch.scopes);
      if (!this.attached) return;
      this.state.activeBatch = null;
      await this.options.dirt?.completeReload(batch.scopes);
    } catch (error) {
      if (this.attached) {
        this.state.activeBatch = null;
        this.options.dirt?.failReload(error);
      }
      throw error;
    }
  }

  private scheduleCompletion(operation: () => Promise<void>) {
    return new Promise<void>((resolve, reject) => {
      this.schedule(() => {
        void operation().then(resolve, reject);
      });
    });
  }
}
