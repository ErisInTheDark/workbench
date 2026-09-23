/*
 * Exports:
 * - default WorkbenchNetworkController: own independent network configuration, native identity and journals.
 */
import { randomUUID } from "node:crypto";
import {
  WorkbenchNetworkConfigurationSchema, workbenchNetworkMode,
  type WorkbenchNetworkAction, type WorkbenchNetworkConfiguration, type WorkbenchNetworkMember,
  type WorkbenchNetworkResult, type WorkbenchNetworkRuntime, type WorkbenchNetworkSnapshot,
  type WorkbenchNetworkSidecarConfiguration,
} from "../../../shared/http/workbench-network.ts";
import { WORKBENCH_DAEMON_TAILNET_PORT } from "../../../shared/http/workbench-daemon-endpoint.ts";
import { areDeeplyEqual } from "../../../shared/workbench/deep-equality.ts";
import WorkbenchNetworkProcess from "../../../shared/network/WorkbenchNetworkProcess.ts";
import type WorkbenchNetworkRepository from "./WorkbenchNetworkRepository.ts";
import type { WorkbenchDaemonDiscovery } from "../../../shared/http/workbench-daemon-discovery.ts";
import type { WorkbenchDaemonBrowserEndpoints } from "../../../shared/http/workbench-daemon-discovery.ts";

export default class WorkbenchNetworkController {
  private configuration!: WorkbenchNetworkConfiguration;
  private runtime: WorkbenchNetworkRuntime = {
    hostServe: { phase: "off", message: null, url: null },
    privateAccess: {
      phase: "off", message: null, url: null, hostname: null, loginUrl: null, nodeId: null,
      keyFingerprint: null, addresses: [], rootCertificate: null, rootFingerprint: null,
      certificateExpiresAt: null, pending: [],
    },
  };
  private executable: WorkbenchNetworkSnapshot["executable"] = { available: false, message: null };
  private process: Pick<WorkbenchNetworkProcess, "request" | "close" | "cancelPending"> | null = null;
  private operation: Promise<WorkbenchNetworkResult> | null = null;
  private preparing = false;
  private closed = false;
  private failure: string | null = null;
  private readonly listeners = new Set<() => void>();
  private discovery: WorkbenchDaemonDiscovery = { refreshing: false, peers: [] };

  constructor(private readonly options: {
    repository: Pick<WorkbenchNetworkRepository, "read" | "write">;
    root: string;
    stateDirectory: string;
    target(): Omit<WorkbenchNetworkSidecarConfiguration, "configuration" | "preparing">;
    preview(): { port: number | null; retainedPort: number | null };
    keepPublication(): boolean;
    warn(message: string): void;
    inspect?: () => Promise<string>;
    createProcess?: (options: ConstructorParameters<typeof WorkbenchNetworkProcess>[0]) => Pick<WorkbenchNetworkProcess, "request" | "close" | "cancelPending">;
  }) {}

  async start() {
    this.closed = false;
    this.configuration = this.options.repository.read();
    await this.inspect();
    try {
      await this.synchronise();
      if (this.configuration.rename && workbenchNetworkMode(this.configuration) === "tailnet-service") {
        await this.action({ action: "machine-name", label: this.configuration.rename.to });
      }
    } catch (error) { this.report(error); }
  }

  snapshot(): WorkbenchNetworkSnapshot {
    const target = this.options.target();
    return structuredClone({
      configuration: this.configuration, runtime: this.runtime, executable: this.executable,
      hostPlatform: process.platform, busy: this.operation !== null, failure: this.failure,
      localUrl: target.appOrigin ? new URL("/launch", target.appOrigin).href : null,
      change: null,
    });
  }

  browserEndpoints(): WorkbenchDaemonBrowserEndpoints | null {
    const httpOrigin = this.runtime.daemonServe?.phase === "ready" ? this.runtime.daemonServe.url : null;
    if (!httpOrigin) return null;
    const secureOrigin = this.configuration.privateAccess?.enabled
      && this.runtime.privateAccess.phase === "ready"
      ? this.runtime.privateAccess.daemonUrl ?? null : null;
    return { httpOrigin, secureOrigin };
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  discoverySnapshot() { return structuredClone(this.discovery); }

  async refreshDiscovery() {
    if (!this.process) await this.synchronise();
    if (!this.process) throw new Error("Enable Tailscale networking before discovering daemons.");
    await this.process.request({ action: "daemon-discovery-refresh" });
  }

  async targetChanged() {
    if (this.closed) return;
    await this.process?.cancelPending();
    if (this.operation) await Promise.allSettled([this.operation]);
    if (!this.closed) await this.synchronise();
  }

  async settings(mode: WorkbenchNetworkConfiguration["mode"], port: number) {
    if (port === WORKBENCH_DAEMON_TAILNET_PORT) throw new Error("That port is reserved for daemon discovery.");
    return this.own(async () => {
      this.preparing = mode === "tailnet-service" && this.configuration.privateAccess !== null;
      this.save({ ...this.configuration, mode, hostServe: { enabled: mode !== "localhost", port } });
      await this.synchronise();
      return { kind: "ok" };
    });
  }

  action(action: WorkbenchNetworkAction) {
    if (action.action === "cancel") {
      return this.process?.cancelPending().then(() => ({ kind: "ok" as const })) ?? Promise.resolve({ kind: "ok" as const });
    }
    if (action.action.startsWith("settings-") || action.action === "access-prepare") {
      return Promise.reject(new Error("App interaction must be completed by the app settings owner."));
    }
    return this.own(() => this.apply(action));
  }

  async close() {
    this.closed = true;
    this.listeners.clear();
    const child = this.process;
    this.process = null;
    await child?.close();
    if (this.operation) await Promise.allSettled([this.operation]);
  }

  private own(run: () => Promise<WorkbenchNetworkResult>) {
    if (this.closed) return Promise.reject(new Error("Network owner is closed."));
    if (this.operation) return Promise.reject(new Error("Finish or cancel the current network action first."));
    this.failure = null;
    const operation = run().catch(error => { this.report(error); throw error; }).finally(() => {
      if (this.operation === operation) this.operation = null;
      this.publish();
    });
    this.operation = operation;
    this.publish();
    return operation;
  }

  private async inspect() {
    try {
      await (this.options.inspect?.() ?? WorkbenchNetworkProcess.inspect(this.options.root));
      this.executable = { available: true, message: null };
    } catch (error) {
      this.executable = { available: false, message: error instanceof Error ? error.message.slice(0, 512) : "Network executable unavailable." };
    }
  }

  private save(next: WorkbenchNetworkConfiguration) {
    const mode = workbenchNetworkMode(next);
    const privateAccess = next.privateAccess;
    const configuration = WorkbenchNetworkConfigurationSchema.parse({
      ...next, mode, hostServe: { ...next.hostServe, enabled: mode !== "localhost" },
      privateAccess: privateAccess ? {
        ...privateAccess, enabled: mode === "tailnet-service" && privateAccess.role !== "unconfigured",
        nodeLabel: privateAccess.nodeLabel ?? this.configuration.privateAccess?.nodeLabel ?? privateAccess.label,
      } : null,
    });
    this.options.repository.write(configuration);
    this.configuration = configuration;
    this.publish();
  }

  private async synchronise() {
    if (this.closed) throw new Error("Network owner is closed.");
    const preview = this.options.preview();
    const configuration = preview.port ? {
      ...this.configuration,
      mode: workbenchNetworkMode(this.configuration) === "localhost" ? "tailnet-ip" as const : this.configuration.mode,
      hostServe: { enabled: true, port: preview.port },
    } : this.configuration;
    const target = this.options.target();
    const publishDaemon = target.publishDaemon || this.runtime.daemonServe?.phase === "ready" && this.options.keepPublication();
    const active = configuration.hostServe.enabled || configuration.privateAccess?.enabled || this.preparing || publishDaemon;
    if (!this.process && !active) return null;
    if (!this.executable.available) throw new Error(this.executable.message ?? "Network executable unavailable.");
    if (!this.process) this.process = (this.options.createProcess ?? (options => new WorkbenchNetworkProcess(options)))({
      root: this.options.root, stateDirectory: this.options.stateDirectory,
      status: runtime => {
        if (this.closed) return;
        for (const key of ["hostServe", "privateAccess"] as const) {
          const next = runtime[key];
          if (next.phase === "failed" && next.message && next.message !== this.runtime[key].message) this.options.warn(next.message);
        }
        this.runtime = runtime;
        this.publish();
      },
      persistMember: (previous, member) => this.persistMember(previous, member),
      persistNetwork: (revision, next) => this.persistNetwork(revision, next),
      warn: message => this.report(new Error(message)),
      diagnostic: message => this.options.warn(message),
      discovery: snapshot => { this.discovery = snapshot; this.publish(); },
      failed: message => {
        if (this.closed) return;
        this.runtime = {
          ...this.runtime,
          hostServe: { phase: "failed", message, url: null },
          privateAccess: { ...this.runtime.privateAccess, phase: "failed", message, url: null },
        };
        this.report(new Error(message));
      },
    });
    const child = this.process;
    try {
      await child.request({
        action: "configure", configuration, ...target, publishDaemon, preparing: this.preparing,
        ...(preview.retainedPort && preview.retainedPort !== preview.port ? { retainedHostPort: preview.retainedPort } : {}),
      });
    } finally {
      if (!active) { this.process = null; await child.close(); }
    }
    return this.process;
  }

  private async apply(action: WorkbenchNetworkAction): Promise<WorkbenchNetworkResult> {
    const transfer = this.configuration.group?.transfer;
    if (transfer && transfer.phase !== "activated" && ["machine-name", "access", "dns-app", "create-setup", "remove-registration"].includes(action.action)) {
      throw new Error("Complete the pending ownership handover before changing network identity or policy.");
    }
    switch (action.action) {
      case "mode":
        this.preparing = action.mode === "tailnet-service" && this.configuration.privateAccess !== null;
        this.save({ ...this.configuration, mode: action.mode });
        await this.synchronise();
        if (action.mode === "tailnet-service" && this.configuration.rename) await this.resumeRename();
        return { kind: "ok" };
      case "tailnet-port":
        if (action.port === WORKBENCH_DAEMON_TAILNET_PORT) throw new Error("That port is reserved for daemon discovery.");
        this.save({ ...this.configuration, hostServe: { ...this.configuration.hostServe, port: action.port } });
        await this.synchronise();
        return { kind: "ok" };
      case "machine-name": {
        const current = this.configuration.privateAccess;
        if (!current) return this.apply({ action: "prepare", label: action.label });
        if (this.configuration.rename && this.configuration.rename.to !== action.label) throw new Error("Finish the pending URL rename before selecting another name.");
        if (!this.configuration.rename && current.label === action.label) return { kind: "ok" };
        if (!this.configuration.rename) this.save({
          ...this.configuration, rename: { id: randomUUID(), from: current.label, to: action.label, phase: "prepare" },
        });
        await this.resumeRename();
        return { kind: "ok" };
      }
      case "host-serve":
        if (action.port === WORKBENCH_DAEMON_TAILNET_PORT) throw new Error("That port is reserved for daemon discovery.");
        this.preparing = false;
        this.save({ ...this.configuration, mode: action.enabled ? "tailnet-ip" : "localhost", hostServe: { enabled: action.enabled, port: action.port } });
        await this.synchronise();
        return { kind: "ok" };
      case "prepare": {
        const current = this.configuration.privateAccess;
        if (current && current.label !== action.label) throw new Error("Use the machine name control to rename an existing address.");
        this.save({ ...this.configuration, privateAccess: current ?? { role: "unconfigured", enabled: false, label: action.label } });
        this.preparing = true;
        await this.inspect();
        await this.synchronise();
        return { kind: "ok" };
      }
      case "private-access": {
        const current = this.configuration.privateAccess;
        if (!current || current.role === "unconfigured" && action.enabled) throw new Error("Complete private setup before enabling it.");
        this.preparing = false;
        this.save({ ...this.configuration, mode: action.enabled ? "tailnet-service" : "tailnet-ip",
          privateAccess: current.role === "unconfigured" ? current : { ...current, enabled: action.enabled } });
        await this.synchronise();
        return { kind: "ok" };
      }
      case "retry": {
        await this.process?.close();
        this.process = null;
        await this.inspect();
        this.preparing = this.configuration.privateAccess !== null;
        if (this.configuration.rename) { await this.resumeRename(); return { kind: "ok" }; }
        const child = await this.synchronise();
        if (child && this.configuration.privateAccess && this.configuration.privateAccess.role !== "unconfigured") await child.request({ action: "retry" });
        return { kind: "ok" };
      }
      case "approve": {
        if (this.configuration.privateAccess?.role !== "authority") throw new Error("Only the setup installation can approve pairing.");
        const pending = this.runtime.privateAccess.pending.find(item => item.id === action.requestId);
        if (!pending || !this.process) throw new Error("That pairing request is no longer pending.");
        if (action.approved) {
          if (this.configuration.members.some(member => member.label === pending.member.label && member.nodeId !== pending.member.nodeId)) {
            throw new Error("That machine label belongs to another installation.");
          }
          this.save({ ...this.configuration, members: [...this.configuration.members.filter(member => member.nodeId !== pending.member.nodeId), pending.member] });
          await this.synchronise();
        }
        return this.process.request({ action: "approve-member", requestId: action.requestId, member: action.approved ? pending.member : null });
      }
      default: {
        if (this.configuration.rename && ["create-setup", "join", "reconnect", "remove-registration"].includes(action.action)) {
          throw new Error("Finish the pending URL rename before changing its setup or registration.");
        }
        if (!this.process) { this.preparing = this.configuration.privateAccess !== null; await this.synchronise(); }
        if (!this.process) throw new Error("Prepare private access first.");
        const result = await this.process.request(action);
        if (result.kind === "setup") {
          this.save({ ...this.configuration, privateAccess: result.privateAccess, members: result.members, ...(result.group ? { group: result.group } : {}) });
          await this.synchronise();
        }
        if (action.action === "remove-registration") {
          this.preparing = false;
          const current = this.configuration.privateAccess;
          if (current) this.save({ ...this.configuration, mode: "tailnet-ip", privateAccess: { ...current, enabled: false } });
          await this.synchronise();
        }
        return result;
      }
    }
  }

  private async resumeRename() {
    this.preparing = true;
    const child = await this.synchronise();
    if (!child) throw new Error("The private node is unavailable for URL renaming.");
    let rename = this.configuration.rename;
    if (!rename) return;
    const command = { id: rename.id, from: rename.from, to: rename.to };
    if (rename.phase === "prepare") {
      await child.request({ action: "rename-prepare", ...command });
      this.save({ ...this.configuration, rename: { ...rename, phase: "activate" } });
      rename = this.configuration.rename!;
    }
    if (rename.phase === "activate") {
      await child.request({ action: "rename-activate", ...command });
      const current = this.configuration.privateAccess;
      if (!current) throw new Error("Private configuration disappeared during URL rename.");
      this.save({ ...this.configuration, privateAccess: { ...current, label: rename.to }, rename: { ...rename, phase: "retire" } });
    }
    await child.request({ action: "rename-retire", ...command });
    const { rename: _completed, ...configuration } = this.configuration;
    this.save(configuration);
    await this.synchronise();
  }

  private persistMember(previous: WorkbenchNetworkMember | null, member: WorkbenchNetworkMember) {
    if (this.closed || this.configuration.privateAccess?.role !== "authority") throw new Error("Membership persistence requires an active setup authority.");
    const existing = this.configuration.members.find(candidate => candidate.nodeId === member.nodeId) ?? null;
    if (areDeeplyEqual(existing, member)) return;
    if (!areDeeplyEqual(existing, previous)) throw new Error("Membership changed before the native update could be persisted.");
    if (previous && (previous.nodeId !== member.nodeId || previous.keyFingerprint !== member.keyFingerprint)) throw new Error("URL renaming cannot replace an enrolled node or key.");
    this.save({
      ...this.configuration, members: [...this.configuration.members.filter(candidate => candidate.nodeId !== member.nodeId), member],
      ...(this.configuration.group ? { group: { ...this.configuration.group, revision: this.configuration.group.revision + 1 } } : {}),
    });
  }

  private persistNetwork(previousRevision: number | null, next: WorkbenchNetworkConfiguration) {
    if (this.closed) throw new Error("Network persistence requires an active controller.");
    if ((this.configuration.group?.revision ?? null) !== previousRevision) throw new Error("Network state changed before the native update could be persisted.");
    this.save({ ...this.configuration, privateAccess: next.privateAccess, members: next.members, ...(next.group ? { group: next.group } : {}) });
  }

  private publish() { if (!this.closed) for (const listener of this.listeners) listener(); }
  private report(error: unknown) {
    const message = error instanceof Error ? error.message.slice(0, 512) : "Network operation failed.";
    if (message !== this.failure) this.options.warn(message);
    this.failure = message;
    this.publish();
  }
}
