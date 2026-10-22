/*
 * Exports:
 * - WorkbenchAppReloadOrchestratorPorts: graph-resolved ports for ordered reload and update work.
 * - WorkbenchAppReloadOrchestratorState: operation state shared across runtime-owner handoff.
 * - default WorkbenchAppReloadOrchestrator: own one response-first update or reload sequence.
 */
import type { WorkbenchReloadDirtSnapshot } from "workbench-shared/reload/workbench-reload";
import {
  IDLE_DEVICE_RELOAD_OPERATION, toBaseReloadOperation, type DeviceReloadOperation,
} from "workbench-shared/reload/device-reload-operation";
import { partitionReloadScopes } from "workbench-shared/reload/reload-scope-partition";
import type { InstallationPullResult } from "workbench-shared/workbench/installation-update";
import {
  toBaseInstallationUpdate, type InstallationPullOptions, type PredictedInstallationUpdate,
} from "workbench-shared/workbench/installation-update-prediction";
import type { DaemonId } from "workbench-shared/workbench/identity";
import type { WorkbenchAppControlRuntime } from "workbench-shared/http/workbench-app-control";
import type { WorkbenchAppReloadAdmission } from "./WorkbenchAppReloadController";

export interface WorkbenchAppReloadOrchestratorPorts {
  readAppDirt(): Pick<WorkbenchReloadDirtSnapshot, "error" | "pendingScopes"> & {
    dirtyScopes: ReadonlyArray<{ scope: string; destructive: boolean }>;
  };
  readDaemonDirt(daemonId?: DaemonId, signal?: AbortSignal): Promise<WorkbenchReloadDirtSnapshot | null>;
  isLocalDaemon(daemonId: DaemonId): boolean;
  readControlDaemon(): { dirt: WorkbenchReloadDirtSnapshot | null; update: PredictedInstallationUpdate | null };
  pullDaemon(daemonId: DaemonId | undefined, request: InstallationPullOptions, signal?: AbortSignal): Promise<InstallationPullResult>;
  prepareInstallationRuntime(signal?: AbortSignal): Promise<void>;
  /** Whether installing must stop the host and daemon because their dependencies changed. */
  installRestartsHost(): Promise<boolean>;
  refreshAppDirt(signal?: AbortSignal): Promise<void>;
  reloadDaemon(scopes: string[], daemonId?: DaemonId, signal?: AbortSignal): Promise<void>;
  reloadHost(scopes: string[], signal?: AbortSignal): Promise<void>;
  admitClient(scopes: string[], options?: { installFromSha?: string }): WorkbenchAppReloadAdmission;
  /** The process busy reason this orchestrator owns; null when no operation runs. */
  holdBusy(reason: string | null): void;
  warn(message: string): void;
}

export interface WorkbenchAppReloadOrchestratorState {
  operation: DeviceReloadOperation;
  running: boolean;
  listeners: Set<() => void>;
  cancellation: AbortController | null;
}

export default class WorkbenchAppReloadOrchestrator {
  private readonly state: WorkbenchAppReloadOrchestratorState;

  constructor(private readonly ports: WorkbenchAppReloadOrchestratorPorts, state?: WorkbenchAppReloadOrchestratorState) {
    this.state = state ?? { operation: { ...IDLE_DEVICE_RELOAD_OPERATION }, running: false, listeners: new Set(), cancellation: null };
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
    // The local viewer's strict schema is process-owned, so it receives the shapes it predates.
    return {
      dirty: scopes.length > 0,
      destructive: scopes.some(scope => scope.destructive),
      update: update && toBaseInstallationUpdate(update),
      operation: toBaseReloadOperation(this.read()),
    };
  }

  /** A remote daemon reloads only its own scopes; this device's app and host belong to the local reload. */
  admitReloadAll(daemonId?: DaemonId) {
    const remote = this.isRemote(daemonId);
    return this.admit("reloadAll", signal => this.reloadAll(daemonId, undefined, signal, remote), daemonId);
  }

  /**
   * A remote checkout pulls only when its update installs nothing: dependency installs run inside that device's own app.
   */
  admitPull(daemonId: DaemonId | undefined, reload: boolean) {
    const remote = this.isRemote(daemonId);
    return this.admit(reload ? "pullAndReload" : "pull", async signal => {
      this.phase("pulling");
      const pulled = await this.ports.pullDaemon(daemonId, remote ? { withoutInstall: true } : {}, signal);
      if (!remote) await this.ports.prepareInstallationRuntime(signal);
      if (!reload) return;
      this.phase("waiting");
      // The daemon pull response guarantees its dirt refresh completed. Refresh the app
      // explicitly as filesystem notifications can lag or produce an unchanged projection.
      if (!remote) await this.ports.refreshAppDirt(signal);
      await this.reloadAll(daemonId, pulled, signal, remote);
    }, daemonId);
  }

  private isRemote(daemonId: DaemonId | undefined) {
    return Boolean(daemonId && !this.ports.isLocalDaemon(daemonId));
  }

  private admit(
    action: NonNullable<DeviceReloadOperation["action"]>,
    execute: (signal: AbortSignal) => Promise<void>,
    daemonId?: DaemonId,
  ) {
    if (this.state.running) throw new Error("A reload or update is already running.");
    this.state.running = true;
    const cancellation = new AbortController();
    this.state.cancellation = cancellation;
    this.publish({
      action, phase: action === "reloadAll" ? "reloading" : "pulling", error: null, startedAt: Date.now(),
      daemonId: daemonId ?? null,
    });
    let active = true;
    return {
      cancel: () => {
        if (!active) return;
        active = false;
        this.state.running = false;
        this.publish({ ...IDLE_DEVICE_RELOAD_OPERATION });
      },
      start: async () => {
        if (!active) throw new Error("The reload or update admission is no longer active.");
        active = false;
        try {
          cancellation.signal.throwIfAborted();
          await execute(cancellation.signal);
          if (this.state.operation.phase !== "restarting") this.publish({ ...IDLE_DEVICE_RELOAD_OPERATION });
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

  private async reloadAll(daemonId?: DaemonId, pulled?: InstallationPullResult, signal?: AbortSignal, remote = false) {
    this.phase("reloading");
    const daemon = await this.ports.readDaemonDirt(daemonId, signal);
    signal?.throwIfAborted();
    const app = remote ? [] : this.ports.readAppDirt().dirtyScopes;
    const scopes = [...app, ...daemon?.dirtyScopes ?? []].map(item => item.scope);
    if (pulled?.lockfileChanged && !remote) scopes.push("client:install");
    const partition = partitionReloadScopes(scopes, {
      installRestartsHost: scopes.includes("client:install") && await this.ports.installRestartsHost(),
    });
    signal?.throwIfAborted();
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

  private phase(phase: DeviceReloadOperation["phase"]) { this.publish({ ...this.state.operation, phase }); }
  private publish(operation: DeviceReloadOperation) {
    this.state.operation = operation;
    const running = operation.phase !== "idle" && operation.phase !== "failed";
    this.ports.holdBusy(running ? `${operation.action ?? "reload"} ${operation.phase}` : null);
    for (const listener of [...this.state.listeners]) {
      try { listener(); }
      catch (error) {
        this.ports.warn(`Reload operation observer failed: ${error instanceof Error ? error.message.slice(0, 500) : "Unexpected failure."}`);
      }
    }
  }
}
