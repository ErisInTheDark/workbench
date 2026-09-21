/*
 * Exports:
 * - default WorkbenchNetworkController: own app settings handoff and a private service session.
 */
import {
  WorkbenchNetworkActionSchema, workbenchNetworkMode,
  type WorkbenchNetworkAction, type WorkbenchNetworkConfiguration,
  type WorkbenchNetworkResult, type WorkbenchNetworkRuntime, type WorkbenchNetworkSnapshot, type WorkbenchNetworkSettings,
} from "workbench-shared/http/workbench-network";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import WorkbenchServiceClient from "workbench-shared/process/WorkbenchServiceClient";
import type { WorkbenchServiceIntent } from "workbench-shared/process/WorkbenchServiceClient";
import { WORKBENCH_DAEMON_TAILNET_PORT } from "workbench-shared/http/workbench-daemon-endpoint";
import type { WorkbenchAppPortControl } from "../WorkbenchApp.ts";

type SettingsCaller = { deviceNodeId: string | null; origin: string };
type ServiceClient = Pick<WorkbenchServiceClient, "start" | "close" | "request" | "subscribe" | "getSnapshot">;
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
  private operation: Promise<WorkbenchNetworkResult> | null = null;
  private phase: "active" | "suspended" | "closed" = "suspended";
  private failure: string | null = null;
  private ingressToken: string | null = null;
  private change: PendingSettings | null = null;
  private readonly listeners = new Set<() => void>();
  private client: ServiceClient | null = null;
  private unsubscribe: (() => void) | null = null;
  private readonly lifetime = new AbortController();
  private registered = false;

  constructor(private readonly options: {
    endpointPath: string;
    ensure(signal: AbortSignal): Promise<void>;
    readTarget: () => { appOrigin: string } | null;
    wakeLocal: boolean;
    appPort?: Pick<WorkbenchAppPortControl, "read" | "update">;
    warn: (message: string) => void;
    privateIssue?: () => string | null;
    createClient?: () => ServiceClient;
  }) {}

  async start() {
    if (this.phase === "closed") throw new Error("Network settings have closed.");
    this.phase = "active";
    await this.options.ensure(this.lifetime.signal);
    this.ingressToken = randomBytes(32).toString("hex");
    this.client = this.options.createClient?.() ?? new WorkbenchServiceClient({ endpointPath: this.options.endpointPath, warn: this.options.warn });
    await this.client.start();
    this.registered = true;
    this.unsubscribe = this.client.subscribe(() => {
      const state = this.client?.getSnapshot();
      const network = state?.snapshot?.network;
      if (network) {
        this.configuration = network.configuration;
        this.runtime = network.runtime;
        this.executable = network.executable;
        this.failure = state?.failure ?? network.failure;
      }
      if (state?.phase !== "ready") this.registered = false;
      else if (!this.registered && this.configuration) {
        this.registered = true;
        void this.synchronise().catch(error => { this.registered = false; this.report(error); });
      }
      this.publish();
    });
    const network = this.client.getSnapshot().snapshot?.network;
    if (!network) throw new Error("Service did not provide network state.");
    this.configuration = network.configuration;
    this.runtime = network.runtime;
    this.executable = network.executable;
    await this.synchronise();
    if (this.options.wakeLocal) {
      void this.client.request({ method: "service/daemon/wake", retry: false }, this.lifetime.signal).catch(error => {
        if (!this.lifetime.signal.aborted && this.phase === "active") this.report(error);
      });
    }
  }

  snapshot(): WorkbenchNetworkSnapshot {
    const target = this.options.readTarget();
    return structuredClone({
      configuration: this.configuration, runtime: this.runtime, executable: this.executable,
      hostPlatform: process.platform, busy: this.operation !== null, failure: this.failure,
      localUrl: target ? new URL("/launch", target.appOrigin).href : null,
      ...(this.options.appPort ? { localPort: this.options.appPort.read() } : {}),
      change: this.change ? {
        phase: this.change.phase, sourceOrigin: this.change.sourceOrigin, destinationOrigin: this.change.destinationOrigin,
      } : null,
      daemon: this.client?.getSnapshot().snapshot?.identity,
    });
  }

  discovery(deviceNodeId: string | null) {
    const discovery = this.client?.getSnapshot().snapshot?.discovery ?? { refreshing: false, peers: [] };
    const group = this.configuration.group;
    if (!group || group.access === "all") return discovery;
    const viewer = deviceNodeId ?? this.runtime.host?.nodeId;
    if (!viewer) return { refreshing: discovery.refreshing, error: discovery.error, peers: [] };
    return {
      refreshing: discovery.refreshing,
      error: discovery.error,
      peers: discovery.peers.filter(peer => {
        const member = this.configuration.members.find(member => member.hostNodeId === peer.peerId);
        return member && (member.hostNodeId === viewer
          || group.grants.some(grant => grant.deviceNodeId === viewer && grant.appNodeId === member.nodeId));
      }),
    };
  }

  hostReloadDirt() { return this.client?.getSnapshot().snapshot?.reloadDirt ?? null; }

  async reloadHost(scopes: readonly string[]) {
    const selected = scopes.map(scope => {
      if (scope !== "host:database" && scope !== "host:network" && scope !== "host:http" && scope !== "host:process") {
        throw new Error("Unknown host reload scope.");
      }
      return scope;
    });
    await this.send({ method: "service/reload", scopes: selected });
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  connection() {
    const origin = this.client?.getSnapshot().snapshot?.daemonOrigin;
    return {
      localPort: origin ? Number(new URL(origin).port) : null,
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
        await this.send({ method: "service/network/action", action: { action: "cancel" } });
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
    await this.send({ method: "service/network/action", action: { action: "cancel" } });
    if (this.operation) await Promise.allSettled([this.operation]);
    if (this.phase !== "active") return;
    try { await this.synchronise(); }
    catch (error) { this.report(error); }
  }

  async close() {
    this.phase = "closed";
    this.lifetime.abort(new Error("App network owner closed."));
    this.listeners.clear();
    await this.stopProcess();
  }

  async suspend() {
    if (this.phase === "closed") return;
    this.phase = "suspended";
    await this.stopProcess();
  }

  private async stopProcess() {
    const child = this.client;
    this.client = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.registered = false;
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

  private async synchronise() {
    const target = this.options.readTarget();
    if (!target || this.phase !== "active") return;
    if (!this.ingressToken) throw new Error("App ingress session is unavailable.");
    await this.send({
      method: "service/app/register",
      registration: {
        appOrigin: target.appOrigin, previewOrigin: null, ingressToken: this.ingressToken,
        previewHostPort: this.change?.previewPort ?? null,
        privateAppAllowed: !this.options.privateIssue?.(),
        retainedHostPort: this.change?.phase !== "finalising" && this.change?.retainedPort ? this.change.retainedPort : null,
      },
    });
    this.registered = true;
  }

  private async send(intent: WorkbenchServiceIntent): Promise<WorkbenchNetworkResult> {
    if (!this.client) throw new Error("The service connection is unavailable.");
    const response = await this.client.request(intent, this.lifetime.signal);
    return response.kind === "network-result" ? response.result : { kind: "ok" };
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
      await this.send({ method: "service/network/settings", mode: settings.mode, port: settings.tailnetPort });
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
    if (action.action === "daemon-discovery-refresh") return this.send({ method: "service/discovery/refresh" });
    if (action.action === "daemon-wake-retry") return this.send({ method: "service/daemon/wake", retry: true });
    const privateChange = action.action === "prepare" || action.action === "mode" && action.mode === "tailnet-service"
      || action.action === "private-access" && action.enabled;
    const issue = privateChange ? this.options.privateIssue?.() : null;
    if (issue) throw new Error(issue);
    return this.send({ method: "service/network/action", action });
  }
}
