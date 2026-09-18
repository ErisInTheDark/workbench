/*
 * Exports:
 * - default WorkbenchNetworkController: own optional networking intent, persisted configuration and sidecar disposal.
 */
import {
  WorkbenchNetworkActionSchema, WorkbenchNetworkConfigurationSchema, workbenchNetworkMode,
  type WorkbenchNetworkAction, type WorkbenchNetworkConfiguration, type WorkbenchNetworkMember,
  type WorkbenchNetworkResult, type WorkbenchNetworkRuntime, type WorkbenchNetworkSnapshot, type WorkbenchNetworkSettings,
} from "workbench-shared/http/workbench-network";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import type WorkbenchNetworkRepository from "./WorkbenchNetworkRepository.ts";
import WorkbenchNetworkProcess from "./WorkbenchNetworkProcess.ts";
import type WorkbenchLocalDaemon from "./WorkbenchLocalDaemon.ts";
import { WORKBENCH_DAEMON_TAILNET_PORT } from "workbench-shared/http/workbench-daemon-endpoint";
import { areDeeplyEqual } from "workbench-shared/workbench/deep-equality";
import type { WorkbenchAppPortControl } from "../WorkbenchApp.ts";

type SettingsCaller = { deviceNodeId: string | null; origin: string };
type PendingSettings = {
  token: string;
  settings: WorkbenchNetworkSettings;
  caller: SettingsCaller;
  loopbackOrigin: string | null;
  sourceOrigin: string;
  destinationOrigin: string;
  phase: NonNullable<WorkbenchNetworkSnapshot["change"]>["phase"];
  retainedPort: number;
  previewPort: number | null;
};

export default class WorkbenchNetworkController {
  private configuration!: WorkbenchNetworkConfiguration;
  private runtime: WorkbenchNetworkRuntime = {
    hostServe: { phase: "off", message: null, url: null },
    privateAccess: {
      phase: "off", message: null, url: null, hostname: null, loginUrl: null, nodeId: null, keyFingerprint: null, addresses: [],
      rootCertificate: null, rootFingerprint: null, certificateExpiresAt: null, pending: [],
    },
  };
  private executable: WorkbenchNetworkSnapshot["executable"] = { available: false, message: null };
  private process: Pick<WorkbenchNetworkProcess, "request" | "close" | "cancelPending"> | null = null;
  private operation: Promise<WorkbenchNetworkResult> | null = null;
  private preparing = false;
  private phase: "active" | "suspended" | "closed" = "suspended";
  private failure: string | null = null;
  private ingressToken: string | null = null;
  private change: PendingSettings | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly options: {
    repository: Pick<WorkbenchNetworkRepository, "read" | "write">;
    root: string;
    stateDirectory: string;
    readTarget: (configuration: WorkbenchNetworkConfiguration) => { appOrigin: string; daemonOrigin: string | null; daemonPort: number | null } | null;
    localDaemon?: Pick<WorkbenchLocalDaemon, "getSnapshot">;
    appPort?: Pick<WorkbenchAppPortControl, "read" | "update">;
    warn: (message: string) => void;
    privateIssue?: () => string | null;
    inspect?: () => Promise<string>;
    createProcess?: (status: (runtime: WorkbenchNetworkRuntime) => void) => Pick<WorkbenchNetworkProcess, "request" | "close" | "cancelPending">;
  }) {}

  async start() {
    if (this.phase === "closed") throw new Error("Network settings have closed.");
    this.phase = "active";
    this.configuration = this.options.repository.read();
    await this.inspect();
    try { await this.synchronise(); }
    catch (error) { this.report(error); }
    void this.resumeAvailableRename().catch(error => this.report(error));
  }

  snapshot(): WorkbenchNetworkSnapshot {
    const target = this.options.readTarget(this.configuration);
    return structuredClone({
      configuration: this.configuration, runtime: this.runtime, executable: this.executable,
      hostPlatform: process.platform, busy: this.operation !== null, failure: this.failure,
      localUrl: target ? new URL("/launch", target.appOrigin).href : null,
      ...(this.options.appPort ? { localPort: this.options.appPort.read() } : {}),
      change: this.change ? {
        phase: this.change.phase, sourceOrigin: this.change.sourceOrigin, destinationOrigin: this.change.destinationOrigin,
      } : null,
    });
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  connection() {
    const endpoint = this.options.localDaemon?.getSnapshot().endpoint;
    return {
      localPort: endpoint ? Number(new URL(endpoint.origin).port) : null,
      tailnetPort: WORKBENCH_DAEMON_TAILNET_PORT,
    };
  }

  ingress(headers: IncomingHttpHeaders): { deviceNodeId: string | null; manageApp: boolean; manageNetwork: boolean; trustHost: boolean } | null {
    const token = headers["x-workbench-network-token"];
    const device = headers["x-workbench-network-device"];
    const forwarded = Object.keys(headers).some(key => key.startsWith("x-workbench-network-")
      && key !== "x-workbench-network-request");
    if (forwarded) {
      if (!this.ingressToken || typeof token !== "string" || typeof device !== "string"
        || !device || device.length > 256 || !/^[a-f0-9]{64}$/u.test(token)
        || !timingSafeEqual(Buffer.from(token), Buffer.from(this.ingressToken))) return null;
    }
    const group = this.configuration.group;
    const owner = group && this.configuration.members.find(member => member.nodeId === group.ownerNodeId);
    const localOwner = !group || (this.runtime.privateAccess.nodeId
      ? group.ownerNodeId === this.runtime.privateAccess.nodeId
      : this.configuration.privateAccess?.role === "authority");
    const ownerDevice = forwarded && owner?.hostNodeId === device;
    return {
      deviceNodeId: forwarded ? device as string : null,
      manageApp: !forwarded || Boolean(ownerDevice),
      manageNetwork: Boolean(localOwner && (!forwarded || ownerDevice)),
      trustHost: !forwarded || Boolean(this.runtime.host?.nodeId && this.runtime.host.nodeId === device),
    };
  }

  stableOrigin(origin: string): string | null {
    let parsed: URL;
    try { parsed = new URL(origin); } catch { return null; }
    if (parsed.origin !== origin) return null;
    const privateAccess = this.configuration.privateAccess;
    if (privateAccess?.enabled && parsed.protocol === "https:" && parsed.port === ""
      && parsed.hostname === `${privateAccess.label}.wb.inthedark.boo`) return origin;
    if (this.configuration.hostServe.enabled && this.runtime.hostServe.phase === "ready"
      && parsed.origin === this.runtime.hostServe.url) return origin;
    return null;
  }

  canChangePort() { return this.change === null && this.operation === null; }

  async updateLocalPort(port: number) {
    const appPort = this.options.appPort;
    if (!appPort) throw new Error("The local listener owner is unavailable.");
    const caller = { deviceNodeId: null, origin: appPort.read().appOrigin };
    const prepared = await this.action({ action: "settings-prepare", settings: {
      mode: workbenchNetworkMode(this.configuration), localPort: port, tailnetPort: this.configuration.hostServe.port,
    } }, caller);
    if (prepared.kind !== "handoff") throw new Error("The local port change could not be prepared.");
    const finished = await this.action({ action: "settings-finish", token: prepared.token }, caller);
    if (finished.kind === "settings-pending") throw new Error(finished.message);
    return appPort.read();
  }

  action(input: WorkbenchNetworkAction, caller?: SettingsCaller): Promise<WorkbenchNetworkResult> {
    if (this.phase !== "active") return Promise.reject(new Error("Network settings are closing or reloading."));
    const action = WorkbenchNetworkActionSchema.parse(input);
    if (action.action === "cancel") {
      return (async () => {
        await this.process?.cancelPending();
        return { kind: "ok" };
      })();
    }
    if (this.operation) return Promise.reject(new Error("Finish or cancel the current network action first."));
    if (this.change && action.action !== "settings-finish" && action.action !== "settings-cancel" && action.action !== "settings-resume") {
      return Promise.reject(new Error("Finish or cancel the pending settings change first."));
    }
    this.failure = null;
    const operation = (action.action.startsWith("settings-")
      ? this.applySettings(action, caller)
      : action.action === "access" || action.action === "access-prepare"
        ? this.applyAccess(action, caller) : this.apply(action)).catch((error: unknown) => {
      this.report(error);
      throw error;
    }).finally(() => {
      if (this.operation === operation) this.operation = null;
      this.publish();
    });
    this.operation = operation;
    this.publish();
    return operation;
  }

  async targetChanged() {
    if (this.phase !== "active") return;
    // The local-port owner awaits this subscriber. Its initiating settings
    // operation reconciles forwarding after update() returns.
    if (this.change?.phase === "applying" || this.change?.phase === "finalising") return;
    // Changing the bound listener must not wait indefinitely behind enrolment
    // or remote pairing. Cancellation is explicit and reaches the pending caller.
    await this.process?.cancelPending();
    if (this.operation) await Promise.allSettled([this.operation]);
    if (this.phase !== "active") return;
    try { await this.synchronise(); }
    catch (error) { this.report(error); }
    await this.resumeAvailableRename();
  }

  private async resumeAvailableRename() {
    const rename = this.configuration.rename;
    if (this.phase !== "active" || this.operation || !rename
      || workbenchNetworkMode(this.configuration) !== "tailnet-service"
      || !this.options.readTarget(this.configuration)) return;
    await this.action({ action: "machine-name", label: rename.to });
  }

  async close() {
    this.phase = "closed";
    this.listeners.clear();
    await this.stopProcess();
  }

  async suspend() {
    if (this.phase === "closed") return;
    this.phase = "suspended";
    await this.stopProcess();
  }

  private async stopProcess() {
    const child = this.process;
    this.process = null;
    this.ingressToken = null;
    try { await child?.close(); }
    finally {
      if (this.operation) await Promise.allSettled([this.operation]);
      this.change = null;
    }
  }

  private publish() {
    if (this.phase !== "closed") for (const listener of this.listeners) listener();
  }

  private report(error: unknown) {
    const message = error instanceof Error ? error.message.slice(0, 512) : "Network action failed.";
    if (this.failure !== message) this.options.warn(message);
    this.failure = message;
    this.publish();
  }

  private async inspect() {
    try {
      await (this.options.inspect?.() ?? WorkbenchNetworkProcess.inspect(this.options.root));
      this.executable = { available: true, message: null };
    } catch (error) {
      this.executable = {
        available: false,
        message: error instanceof Error ? error.message.slice(0, 512) : "Network executable is unavailable.",
      };
    }
    this.publish();
  }

  private save(next: WorkbenchNetworkConfiguration) {
    const mode = workbenchNetworkMode(next);
    const privateAccess = next.privateAccess;
    const configuration = WorkbenchNetworkConfigurationSchema.parse({
      ...next, mode,
      hostServe: { ...next.hostServe, enabled: mode !== "localhost" },
      privateAccess: privateAccess ? {
        ...privateAccess,
        enabled: mode === "tailnet-service" && privateAccess.role !== "unconfigured",
        nodeLabel: privateAccess.nodeLabel ?? this.configuration.privateAccess?.nodeLabel ?? privateAccess.label,
      } : null,
    });
    this.options.repository.write(configuration);
    this.configuration = configuration;
    this.publish();
  }

  private async synchronise() {
    const target = this.options.readTarget(this.configuration);
    if (!target || this.phase !== "active") return;
    const issue = this.configuration.privateAccess ? this.options.privateIssue?.() : null;
    const privateAccess = this.configuration.privateAccess;
    const committed = issue && privateAccess
      ? { ...this.configuration, mode: this.configuration.hostServe.enabled ? "tailnet-ip" as const : "localhost" as const,
        privateAccess: { ...privateAccess, enabled: false as const } }
      : this.configuration;
    const preview = this.change?.previewPort;
    const configuration = preview ? {
      ...committed, mode: workbenchNetworkMode(committed) === "localhost" ? "tailnet-ip" as const : committed.mode,
      hostServe: { enabled: true, port: preview },
    } : committed;
    const preparing = this.preparing && !issue;
    if (issue) {
      this.runtime = { ...this.runtime, privateAccess: { ...this.runtime.privateAccess, phase: "failed", message: issue, url: null } };
      this.publish();
    }
    const active = configuration.hostServe.enabled || configuration.privateAccess?.enabled || preparing;
    if (!this.process && !active) return;
    if (!this.executable.available) throw new Error(this.executable.message ?? "Network executable is unavailable.");
    if (!this.process) {
      this.ingressToken = randomBytes(32).toString("hex");
      const status = (runtime: WorkbenchNetworkRuntime) => {
        if (this.phase !== "active") return;
        for (const key of ["hostServe", "privateAccess"] as const) {
          const next = runtime[key];
          if (next.phase === "failed" && next.message && next.message !== this.runtime[key].message) this.options.warn(next.message);
        }
        const problem = this.configuration.privateAccess ? this.options.privateIssue?.() : null;
        this.runtime = problem
          ? { ...runtime, privateAccess: { ...runtime.privateAccess, phase: "failed", message: problem, url: null } }
          : runtime;
        this.publish();
      };
      this.process = this.options.createProcess?.(status) ?? new WorkbenchNetworkProcess({
        root: this.options.root, stateDirectory: this.options.stateDirectory, status,
        persistMember: (previous, member) => this.persistMember(previous, member),
        persistNetwork: (previousRevision, configuration) => this.persistNetwork(previousRevision, configuration),
        warn: message => { this.failure = message; this.options.warn(message); this.publish(); },
        diagnostic: message => this.options.warn(message),
        failed: message => {
          if (this.phase !== "active") return;
          this.ingressToken = null;
          this.runtime = {
            hostServe: this.configuration.hostServe.enabled
              ? { phase: "failed", message, url: null } : this.runtime.hostServe,
            privateAccess: this.configuration.privateAccess?.enabled || this.preparing
              ? { ...this.runtime.privateAccess, phase: "failed", message, url: null } : this.runtime.privateAccess,
          };
          this.publish();
        },
      });
    }
    const child = this.process;
    try {
      await child.request({ action: "configure", configuration, ...target, preparing,
        ...(preview && this.change && this.change.retainedPort > 0 && this.change.phase !== "finalising" && this.change.retainedPort !== preview
          ? { retainedHostPort: this.change.retainedPort } : {}),
        ...(this.ingressToken ? { ingressToken: this.ingressToken } : {}) });
    } finally {
      if (!active) {
        if (this.process === child) {
          this.process = null;
          this.ingressToken = null;
        }
        await child.close();
      }
    }
    return this.process;
  }

  private isHost(caller: SettingsCaller) {
    return caller.deviceNodeId === null || caller.deviceNodeId === this.runtime.host?.nodeId;
  }

  private pendingCaller(change: PendingSettings, caller: SettingsCaller) {
    return change.caller.deviceNodeId === caller.deviceNodeId
      || caller.deviceNodeId === null && change.loopbackOrigin !== null && caller.origin === change.destinationOrigin;
  }

  private async applyAccess(
    action: Extract<WorkbenchNetworkAction, { action: "access" | "access-prepare" }>, caller?: SettingsCaller,
  ): Promise<WorkbenchNetworkResult> {
    if (action.action === "access-prepare" && !caller) throw new Error("Access changes require an authenticated browser connection.");
    const policy = { ...action, action: "access" as const };
    const revokesCaller = caller?.deviceNodeId && !this.isHost(caller) && policy.access === "selected"
      && !policy.grants.some(grant => grant.deviceNodeId === caller.deviceNodeId && grant.appNodeId === this.runtime.privateAccess.nodeId);
    if (revokesCaller) throw new Error("Use this app's local host to remove access for your current device.");
    return await this.apply(policy);
  }

  private async applySettings(action: WorkbenchNetworkAction, caller?: SettingsCaller): Promise<WorkbenchNetworkResult> {
    if (!caller) throw new Error("Settings changes require an authenticated browser connection.");
    if (action.action === "settings-resume") {
      const change = this.change;
      if (!change) throw new Error("This settings change is no longer pending.");
      if (!this.pendingCaller(change, caller)) throw new Error("Continue from the device that started this change.");
      return { kind: "handoff", token: change.token,
        origin: change.phase === "returning" ? change.sourceOrigin : change.destinationOrigin, returning: change.phase === "returning" };
    }
    if (action.action === "settings-prepare") {
      const settings = action.settings;
      const local = this.options.appPort;
      if (!local) throw new Error("Connection settings are unavailable until the app reloads.");
      if (!this.isHost(caller) && settings.mode === "localhost") throw new Error("Use this app's local host to disable remote access.");
      if (settings.tailnetPort === WORKBENCH_DAEMON_TAILNET_PORT) throw new Error("That port is reserved for daemon discovery.");
      if (!local.read().editable && settings.localPort !== local.read().currentPort) throw new Error("The local port is controlled by the environment.");
      if (settings.mode === "tailnet-service") {
        const issue = this.options.privateIssue?.();
        if (issue) throw new Error(issue);
        if (!settings.label && !this.configuration.privateAccess) throw new Error("Choose a machine name first.");
      }
      const transfer = this.configuration.group?.transfer;
      if (this.configuration.rename || transfer && transfer.phase !== "activated") throw new Error("Finish the pending identity change first.");
      const source = new URL(caller.origin);
      const localOrigin = local.read().appOrigin;
      const localAddress = source.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(source.hostname)
        && source.port === new URL(localOrigin).port && source.origin === caller.origin;
      if (caller.deviceNodeId ? !this.stableOrigin(caller.origin) : !localAddress) {
        throw new Error("Use the app's current address to change connection settings.");
      }
      const loopback = caller.deviceNodeId !== null && settings.mode === "localhost";
      const redirect = !loopback && caller.deviceNodeId !== null && (
        source.protocol === "https:" && (settings.mode !== "tailnet-service"
          || settings.removeRegistration || settings.label && settings.label !== this.configuration.privateAccess?.label)
        || source.protocol === "http:" && Number(source.port) !== settings.tailnetPort
      );
      const change: PendingSettings = {
        token: randomUUID(), settings, caller,
        loopbackOrigin: loopback ? localOrigin : null,
        sourceOrigin: caller.origin, destinationOrigin: loopback ? localOrigin : caller.origin,
        phase: "preparing", retainedPort: this.configuration.hostServe.enabled ? this.configuration.hostServe.port : 0,
        previewPort: redirect || settings.mode !== "localhost" && (
          !this.configuration.hostServe.enabled || settings.tailnetPort !== this.configuration.hostServe.port
        ) ? settings.tailnetPort : null,
      };
      this.change = change;
      try {
        if (change.previewPort) {
          await this.synchronise();
          if (this.runtime.hostServe.phase !== "ready" || !this.runtime.hostServe.url) {
            throw new Error(this.runtime.hostServe.message ?? "The replacement tailnet address is not ready.");
          }
          if (redirect) change.destinationOrigin = new URL(this.runtime.hostServe.url).origin;
        }
        change.phase = "prepared";
        return { kind: "handoff", token: change.token, origin: change.destinationOrigin, returning: false };
      } catch (error) {
        this.change = null;
        try { await this.synchronise(); } catch (restoreError) { this.report(restoreError); }
        throw error;
      }
    }
    if (action.action !== "settings-finish" && action.action !== "settings-cancel") throw new Error("Invalid settings action.");
    const change = this.change;
    if (!change || change.token !== action.token) throw new Error("This settings change is no longer pending.");
    if (!this.pendingCaller(change, caller)) throw new Error("Continue from the device that started this change.");
    if (action.action === "settings-cancel") {
      if (change.phase === "failed") throw new Error("Some settings may already be applied. Retry Apply from the surviving address.");
      if (caller.origin !== change.sourceOrigin) {
        change.phase = "returning";
        return { kind: "handoff", token: change.token, origin: change.sourceOrigin, returning: true };
      }
      this.change = null;
      await this.synchronise();
      return { kind: "settings-saved", origin: change.sourceOrigin };
    }
    if (caller.origin !== change.destinationOrigin) throw new Error("Open the destination address before finishing this change.");
    const settings = change.settings;
    change.phase = "applying";
    try {
      if (settings.localPort !== this.options.appPort!.read().currentPort) await this.options.appPort!.update(settings.localPort);
      // Repoint forwarding immediately after the existing bind-first owner moves.
      await this.synchronise();
      if (settings.label && settings.label !== this.configuration.privateAccess?.label) {
        await this.apply({ action: "machine-name", label: settings.label });
      }
      if (settings.removeRegistration) await this.apply({ action: "remove-registration" });
      this.preparing = settings.mode === "tailnet-service" && this.configuration.privateAccess !== null;
      this.save({ ...this.configuration, mode: settings.mode, hostServe: { enabled: settings.mode !== "localhost", port: settings.tailnetPort } });
      change.phase = "finalising";
      change.previewPort = null;
      await this.synchronise();
      if (settings.mode !== "localhost" && this.runtime.hostServe.phase === "failed") {
        throw new Error(this.runtime.hostServe.message ?? "Tailnet forwarding could not be applied.");
      }
      const origin = this.settingsOrigin(change);
      this.change = null;
      return { kind: "settings-saved", origin };
    } catch (error) {
      change.phase = "failed";
      change.destinationOrigin = this.settingsOrigin(change);
      try { await this.synchronise(); } catch (forwardError) { this.report(forwardError); }
      this.report(error);
      return { kind: "settings-pending", token: change.token, origin: change.destinationOrigin,
        message: this.failure ?? "Some settings could not be applied." };
    }
  }

  private settingsOrigin(change: PendingSettings) {
    if (change.caller.deviceNodeId && !change.loopbackOrigin) return change.destinationOrigin;
    const origin = new URL(change.loopbackOrigin ?? change.sourceOrigin);
    origin.port = String(this.options.appPort!.read().currentPort);
    return origin.origin;
  }

  private async apply(action: WorkbenchNetworkAction): Promise<WorkbenchNetworkResult> {
    const transfer = this.configuration.group?.transfer;
    if (transfer && transfer.phase !== "activated"
      && ["machine-name", "access", "dns-app", "create-setup", "remove-registration"].includes(action.action)) {
      throw new Error("Complete the pending ownership handover before changing network identity or policy.");
    }
    switch (action.action) {
      case "mode": {
        const issue = action.mode === "tailnet-service" ? this.options.privateIssue?.() : null;
        if (issue) throw new Error(issue);
        this.preparing = action.mode === "tailnet-service" && this.configuration.privateAccess !== null;
        this.save({ ...this.configuration, mode: action.mode });
        await this.synchronise();
        if (action.mode === "tailnet-service" && this.configuration.rename) await this.resumeRename();
        return { kind: "ok" };
      }
      case "tailnet-port":
        if (action.port === WORKBENCH_DAEMON_TAILNET_PORT) throw new Error("That port is reserved for daemon discovery.");
        this.save({ ...this.configuration, hostServe: { ...this.configuration.hostServe, port: action.port } });
        await this.synchronise();
        return { kind: "ok" };
      case "machine-name": {
        const current = this.configuration.privateAccess;
        if (!current) return await this.apply({ action: "prepare", label: action.label });
        if (this.configuration.rename && this.configuration.rename.to !== action.label) throw new Error("Finish the pending URL rename before selecting another name.");
        if (!this.configuration.rename && current.label === action.label) return { kind: "ok" };
        if (!this.configuration.rename) this.save({
          ...this.configuration,
          rename: { id: randomUUID(), from: current.label, to: action.label, phase: "prepare" },
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
        const issue = this.options.privateIssue?.();
        if (issue) throw new Error(issue);
        const current = this.configuration.privateAccess;
        if (current && current.label !== action.label) throw new Error("Use the machine name control to rename an existing address.");
        this.save({
          ...this.configuration,
          privateAccess: current ?? { role: "unconfigured", enabled: false, label: action.label },
        });
        this.preparing = true;
        await this.inspect();
        await this.synchronise();
        return { kind: "ok" };
      }
      case "private-access": {
        const issue = action.enabled ? this.options.privateIssue?.() : null;
        if (issue) throw new Error(issue);
        const current = this.configuration.privateAccess;
        if (!current || (current.role === "unconfigured" && action.enabled)) throw new Error("Complete private setup before enabling it.");
        this.preparing = false;
        const privateAccess = current.role === "unconfigured" ? current : { ...current, enabled: action.enabled };
        this.save({ ...this.configuration, mode: action.enabled ? "tailnet-service" : "tailnet-ip", privateAccess });
        await this.synchronise();
        return { kind: "ok" };
      }
      case "retry": {
        this.ingressToken = null;
        await this.process?.close();
        this.process = null;
        await this.inspect();
        this.preparing = this.configuration.privateAccess !== null;
        if (this.configuration.rename) {
          await this.resumeRename();
          return { kind: "ok" };
        }
        const child = await this.synchronise();
        if (child && this.configuration.privateAccess?.role !== "unconfigured" && this.configuration.privateAccess) {
          await child.request({ action: "retry" });
        }
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
          this.save({
            ...this.configuration,
            members: [...this.configuration.members.filter(member => member.nodeId !== pending.member.nodeId), pending.member],
          });
          await this.synchronise();
        }
        return await this.process.request({
          action: "approve-member", requestId: action.requestId, member: action.approved ? pending.member : null,
        });
      }
      default: {
        if (this.configuration.rename && ["create-setup", "join", "reconnect", "remove-registration"].includes(action.action)) {
          throw new Error("Finish the pending URL rename before changing its setup or registration.");
        }
        if (!this.process) {
          this.preparing = this.configuration.privateAccess !== null;
          await this.synchronise();
        }
        if (!this.process) throw new Error("Prepare private access first.");
        const result = await this.process.request(action);
        if (result.kind === "setup") {
          this.save({ ...this.configuration, privateAccess: result.privateAccess, members: result.members,
            ...(result.group ? { group: result.group } : {}) });
          await this.synchronise();
        }
        if (action.action === "remove-registration") {
          const current = this.configuration.privateAccess;
          this.preparing = false;
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
    if (this.phase !== "active" || this.configuration.privateAccess?.role !== "authority") {
      throw new Error("Membership persistence requires an active setup authority.");
    }
    const existing = this.configuration.members.find(candidate => candidate.nodeId === member.nodeId) ?? null;
    if (areDeeplyEqual(existing, member)) return;
    if (!areDeeplyEqual(existing, previous)) throw new Error("Membership changed before the native update could be persisted.");
    if (previous && (previous.nodeId !== member.nodeId || previous.keyFingerprint !== member.keyFingerprint)) {
      throw new Error("URL renaming cannot replace an enrolled node or key.");
    }
    this.save({
      ...this.configuration,
      members: [...this.configuration.members.filter(candidate => candidate.nodeId !== member.nodeId), member],
      ...(this.configuration.group ? { group: { ...this.configuration.group, revision: this.configuration.group.revision + 1 } } : {}),
    });
  }

  private persistNetwork(previousRevision: number | null, next: WorkbenchNetworkConfiguration) {
    if (this.phase !== "active") throw new Error("Network persistence requires an active controller.");
    if ((this.configuration.group?.revision ?? null) !== previousRevision) {
      throw new Error("Network state changed before the native update could be persisted.");
    }
    this.save({
      ...this.configuration,
      privateAccess: next.privateAccess,
      members: next.members,
      ...(next.group ? { group: next.group } : {}),
    });
  }
}
