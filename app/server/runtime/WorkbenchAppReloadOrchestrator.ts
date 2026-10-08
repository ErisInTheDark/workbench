/*
 * Exports:
 * - WorkbenchAppReloadOrchestratorPorts: graph-resolved ports for ordered reload and update work.
 * - WorkbenchAppReloadOrchestratorState: operation state shared across runtime-owner handoff.
 * - default WorkbenchAppReloadOrchestrator: own one response-first update or reload sequence.
 */
import {
  IDLE_RELOAD_OPERATION, type WorkbenchReloadDirtSnapshot, type WorkbenchReloadOperation,
} from "workbench-shared/reload/workbench-reload";
import { partitionReloadScopes } from "workbench-shared/reload/reload-scope-partition";
import type { InstallationPullResult, InstallationUpdate } from "workbench-shared/workbench/installation-update";
import type { DaemonId } from "workbench-shared/workbench/identity";
import type { WorkbenchAppControlRuntime } from "workbench-shared/http/workbench-app-control";
import type { WorkbenchAppReloadAdmission } from "./WorkbenchAppReloadController";

export interface WorkbenchAppReloadOrchestratorPorts {
  readAppDirt(): Pick<WorkbenchReloadDirtSnapshot, "error" | "pendingScopes"> & {
    dirtyScopes: ReadonlyArray<{ scope: string; destructive: boolean }>;
  };
  readDaemonDirt(daemonId?: DaemonId, signal?: AbortSignal): Promise<WorkbenchReloadDirtSnapshot | null>;
  isLocalDaemon(daemonId: DaemonId): boolean;
  readControlDaemon(): { dirt: WorkbenchReloadDirtSnapshot | null; update: InstallationUpdate | null };
  pullDaemon(daemonId?: DaemonId, signal?: AbortSignal): Promise<InstallationPullResult>;
  refreshAppDirt(signal?: AbortSignal): Promise<void>;
  reloadDaemon(scopes: string[], daemonId?: DaemonId, signal?: AbortSignal): Promise<void>;
  reloadHost(scopes: string[], signal?: AbortSignal): Promise<void>;
  admitClient(scopes: string[], options?: { installFromSha?: string }): WorkbenchAppReloadAdmission;
  warn(message: string): void;
}

export interface WorkbenchAppReloadOrchestratorState {
  operation: WorkbenchReloadOperation;
  running: boolean;
  listeners: Set<() => void>;
  cancellation: AbortController | null;
}

export default class WorkbenchAppReloadOrchestrator {
  private readonly state: WorkbenchAppReloadOrchestratorState;

  constructor(private readonly ports: WorkbenchAppReloadOrchestratorPorts, state?: WorkbenchAppReloadOrchestratorState) {
    this.state = state ?? { operation: { ...IDLE_RELOAD_OPERATION }, running: false, listeners: new Set(), cancellation: null };
  }

  read = () => this.state.operation;
  subscribe = (listener: () => void) => {
    this.state.listeners.add(listener);
    return () => { this.state.listeners.delete(listener); };
  };

  detachForReload() {
    this.state.listeners.clear();
    return this.state;
  }

  cancelPending() { this.state.cancellation?.abort(new Error("Reload operation owner was retired.")); }
  dispose() { this.cancelPending(); this.state.listeners.clear(); }

  async readControlRuntime(): Promise<WorkbenchAppControlRuntime> {
    const { dirt, update } = this.ports.readControlDaemon();
    const scopes = [...this.ports.readAppDirt().dirtyScopes, ...dirt?.dirtyScopes ?? []];
    return {
      dirty: scopes.length > 0,
      destructive: scopes.some(scope => scope.destructive),
      update,
      operation: this.read(),
    };
  }

  admitReloadAll(daemonId?: DaemonId) {
    return this.admit("reloadAll", signal => this.reloadAll(daemonId, undefined, signal));
  }

  admitPull(daemonId: DaemonId | undefined, reload: boolean) {
    return this.admit(reload ? "pullAndReload" : "pull", async signal => {
      this.phase("pulling");
      const pulled = await this.ports.pullDaemon(daemonId, signal);
      if (!reload) return;
      this.phase("waiting");
      // The daemon pull response guarantees its dirt refresh completed. Refresh the app
      // explicitly as filesystem notifications can lag or produce an unchanged projection.
      await this.ports.refreshAppDirt(signal);
      await this.reloadAll(daemonId, pulled, signal);
    }, daemonId);
  }

  private admit(
    action: NonNullable<WorkbenchReloadOperation["action"]>,
    execute: (signal: AbortSignal) => Promise<void>,
    updateDaemonId?: DaemonId,
  ) {
    if (this.state.running) throw new Error("A reload or update is already running.");
    if (updateDaemonId && !this.ports.isLocalDaemon(updateDaemonId)) throw new Error("Updates apply only to this device's Workbench.");
    this.state.running = true;
    const cancellation = new AbortController();
    this.state.cancellation = cancellation;
    this.publish({ action, phase: action === "reloadAll" ? "reloading" : "pulling", error: null, startedAt: Date.now() });
    let active = true;
    return {
      cancel: () => {
        if (!active) return;
        active = false;
        this.state.running = false;
        this.publish({ ...IDLE_RELOAD_OPERATION });
      },
      start: async () => {
        if (!active) throw new Error("The reload or update admission is no longer active.");
        active = false;
        try {
          cancellation.signal.throwIfAborted();
          await execute(cancellation.signal);
          if (this.state.operation.phase !== "restarting") this.publish({ ...IDLE_RELOAD_OPERATION });
        } catch (error) {
          const message = (error instanceof Error ? error.message : "Reload or update failed.")
            .replace(/[\u0000-\u001f\u007f-\u009f]/gu, "").slice(0, 500);
          this.publish({ ...this.state.operation, phase: "failed", error: message });
          this.ports.warn(`Reload or update failed: ${message}`);
        } finally {
          this.state.running = this.state.operation.phase === "restarting";
        }
      },
    };
  }

  private async reloadAll(daemonId?: DaemonId, pulled?: InstallationPullResult, signal?: AbortSignal) {
    this.phase("reloading");
    const daemon = await this.ports.readDaemonDirt(daemonId, signal);
    signal?.throwIfAborted();
    const app = this.ports.readAppDirt();
    const scopes = [...app.dirtyScopes, ...daemon?.dirtyScopes ?? []].map(item => item.scope);
    if (pulled?.lockfileChanged) scopes.push("client:install");
    const partition = partitionReloadScopes(scopes);
    if (partition.server.length) await this.ports.reloadDaemon(partition.server, daemonId, signal);
    const host = partition.client.filter(scope => scope.startsWith("host:"));
    if (host.length) await this.ports.reloadHost(host, signal);
    signal?.throwIfAborted();
    const client = partition.client.filter(scope => scope.startsWith("client:"));
    if (!client.length) return;
    const admission = this.ports.admitClient(client, pulled?.lockfileChanged ? { installFromSha: pulled.fromSha } : undefined);
    if (client.includes("client:process") || client.includes("client:install")) this.phase("restarting");
    await admission.start();
  }

  private phase(phase: WorkbenchReloadOperation["phase"]) { this.publish({ ...this.state.operation, phase }); }
  private publish(operation: WorkbenchReloadOperation) {
    this.state.operation = operation;
    for (const listener of [...this.state.listeners]) {
      try { listener(); }
      catch (error) {
        this.ports.warn(`Reload operation observer failed: ${error instanceof Error ? error.message.slice(0, 500) : "Unexpected failure."}`);
      }
    }
  }
}
