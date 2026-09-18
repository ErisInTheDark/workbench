/*
 * Exports:
 * - default WorkbenchNetworkClient: own validated network settings, progress subscription and request cancellation.
 * - WorkbenchNetworkClientContext/useWorkbenchNetwork: share the settings owner without transporting app state through props.
 */
import { createContext, useContext, useSyncExternalStore } from "react";
import {
  WORKBENCH_NETWORK_PATH, WorkbenchNetworkActionSchema, WorkbenchNetworkResultSchema, WorkbenchNetworkSnapshotSchema, WorkbenchNetworkVerificationSchema,
  type WorkbenchNetworkAction, type WorkbenchNetworkResult, type WorkbenchNetworkSnapshot, type WorkbenchNetworkSettings,
} from "workbench-shared/http/workbench-network";
import reportClientSchemaError from "workbench-shared/workbench/report-client-schema-error";
import { z } from "zod";
import { consumeNetworkHandoff, networkNavigationUrl, type NetworkHandoff } from "./workbench-network-navigation";
import { readWorkbenchBrowserStateTransferId } from "../state/workbench-browser-state-identity";

const actionError = z.object({ error: z.string().max(512) }).strict();

export default class WorkbenchNetworkClient {
  private state: {
    snapshot: WorkbenchNetworkSnapshot | null; error: string | null; loading: boolean;
    verified: { hostname: string; nodeId: string; rootFingerprint: string | null } | null;
    handoff: NetworkHandoff | null;
  } = {
    snapshot: null, error: null, loading: true, verified: null, handoff: null,
  };
  private readonly listeners = new Set<() => void>();
  private readonly requests = new Set<AbortController>();
  private events: Pick<EventSource, "close" | "onmessage" | "onerror"> | null = null;
  private closed = false;

  constructor(private readonly options: {
    fetcher?: typeof fetch;
    events?: (url: string) => Pick<EventSource, "close" | "onmessage" | "onerror">;
  } = {}) {}

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  readonly snapshot = () => this.state;

  async start() {
    if (this.closed) return;
    const controller = new AbortController();
    this.requests.add(controller);
    try {
      const response = await (this.options.fetcher ?? fetch)(`${WORKBENCH_NETWORK_PATH}?capabilities=3`, { cache: "no-store", signal: controller.signal });
      if (this.closed) return;
      if (response.status === 404) throw new Error("Restart the Workbench app to load network settings.");
      if (!response.ok) throw new Error(`Network settings could not be read (HTTP ${response.status}).`);
      const value: unknown = await response.json();
      if (this.closed) return;
      this.receive(value);
      const eventsUrl = `${WORKBENCH_NETWORK_PATH}/events?capabilities=3`;
      const events = this.options.events?.(eventsUrl) ?? new EventSource(eventsUrl);
      this.events?.close();
      this.events = events;
      events.onmessage = event => {
        if (this.closed || this.events !== events) return;
        try { this.receive(JSON.parse(event.data)); }
        catch {
          this.update({ ...this.state, error: "Network progress data was invalid." });
        }
      };
      events.onerror = () => {
        if (this.closed || this.events !== events) return;
        this.update({ ...this.state, error: "Network progress disconnected; the browser is reconnecting." });
      };
      if (typeof window !== "undefined") {
        const consumed = consumeNetworkHandoff(window.location.href);
        if (consumed.receipt) {
          window.history.replaceState(window.history.state, "", consumed.href);
          this.update({ ...this.state, handoff: consumed.receipt });
          if (!consumed.receipt.manual) await this.finishSettings(consumed.receipt.returning);
        }
      }
      if (typeof window !== "undefined" && window.location.protocol === "https:"
        && window.location.hostname === this.state.snapshot?.runtime.privateAccess.hostname) await this.verify();
    } catch (error) {
      if (!this.closed) this.update({
        ...this.state, loading: false,
        error: error instanceof Error ? error.message.slice(0, 512) : "Network settings could not be read.",
      });
    } finally { this.requests.delete(controller); }
  }

  async action(input: WorkbenchNetworkAction): Promise<WorkbenchNetworkResult> {
    if (this.closed) throw new Error("Network settings have closed.");
    const action = WorkbenchNetworkActionSchema.parse(input);
    const controller = new AbortController();
    this.requests.add(controller);
    try {
      const response = await (this.options.fetcher ?? fetch)(WORKBENCH_NETWORK_PATH, {
        method: "POST", cache: "no-store", signal: controller.signal,
        headers: { "Content-Type": "application/json", "X-Workbench-Network-Request": "1" },
        body: JSON.stringify(action),
      });
      if (!response.ok) {
        const rejected = actionError.safeParse(await response.json().catch(() => null));
        if (!rejected.success) reportClientSchemaError("Rejected Workbench network error response", rejected.error);
        throw new Error(rejected.success ? rejected.data.error
          : this.state.snapshot?.failure ?? `Network action failed (HTTP ${response.status}); check setup status.`);
      }
      const result = WorkbenchNetworkResultSchema.safeParse(await response.json());
      if (!result.success) {
        reportClientSchemaError("Rejected Workbench network action response", result.error);
        throw new Error("Network action returned invalid data.");
      }
      if (this.closed) throw new Error("Network settings have closed.");
      return result.data;
    } finally { this.requests.delete(controller); }
  }

  async changeSettings(settings: WorkbenchNetworkSettings) {
    const result = await this.action({ action: "settings-prepare", settings });
    if (result.kind !== "handoff") throw new Error("Settings did not return a connection handoff.");
    this.update({ ...this.state, handoff: { token: result.token, returning: false } });
    if (result.origin !== window.location.origin) this.navigate(result.origin, this.state.handoff!);
    else await this.finishSettings();
  }

  canAccessFromAnotherDevice() {
    const snapshot = this.state.snapshot;
    if (!snapshot) return false;
    const group = snapshot.configuration.group;
    if (!group || group.access === "all") return true;
    const app = snapshot.runtime.privateAccess.nodeId;
    const host = snapshot.runtime.host?.nodeId;
    return Boolean(app && host && group.grants.some(grant => grant.appNodeId === app && grant.deviceNodeId !== host));
  }

  async changeAccess(policy: Omit<Extract<WorkbenchNetworkAction, { action: "access" }>, "action">) {
    const result = await this.action({ action: "access-prepare", ...policy });
    if (result.kind === "ok") return;
    if (result.kind !== "handoff") throw new Error("Access settings did not return a connection handoff.");
    const receipt: NetworkHandoff = { token: result.token, returning: false, panel: "access" };
    this.update({ ...this.state, handoff: receipt });
    if (result.origin !== window.location.origin) this.navigate(result.origin, receipt);
    else await this.finishSettings();
  }

  async finishSettings(cancel = false) {
    const receipt = this.state.handoff;
    if (!receipt) throw new Error("No settings change is pending in this browser.");
    try {
      const result = await this.action({ action: cancel ? "settings-cancel" : "settings-finish", token: receipt.token });
      if (result.kind === "handoff") {
        const next = { ...receipt, token: result.token, returning: result.returning, manual: false };
        this.update({ ...this.state, handoff: next });
        this.navigate(result.origin, next);
      } else if (result.kind === "settings-pending") {
        const next = { ...receipt, token: result.token, returning: false, manual: true };
        this.update({ ...this.state, handoff: next, error: result.message });
        if (result.origin !== window.location.origin) this.navigate(result.origin, next);
      } else if (result.kind === "settings-saved") {
        this.update({ ...this.state, handoff: null, error: null });
        if (result.origin !== window.location.origin) this.navigate(result.origin);
      } else throw new Error("Settings returned an unexpected completion response.");
    } catch (error) {
      this.update({ ...this.state, handoff: receipt.panel === "access" ? null : this.state.handoff,
        error: error instanceof Error ? error.message : "Settings could not finish." });
      throw error;
    }
  }

  private navigate(origin: string, receipt?: NetworkHandoff) {
    window.location.assign(networkNavigationUrl(window.location.href, origin, receipt,
      readWorkbenchBrowserStateTransferId(this.state.snapshot?.localPort ?? null)));
  }

  async resumeSettings() {
    const result = await this.action({ action: "settings-resume" });
    if (result.kind !== "handoff") throw new Error("Settings did not return a connection handoff.");
    const receipt: NetworkHandoff = { token: result.token, returning: result.returning, manual: true,
      ...(new URL(window.location.href).searchParams.get("workbenchNetworkPanel") === "access" ? { panel: "access" } : {}) };
    this.update({ ...this.state, handoff: receipt });
    if (result.origin !== window.location.origin) this.navigate(result.origin, receipt);
  }

  close() {
    this.closed = true;
    this.events?.close();
    this.events = null;
    for (const controller of this.requests) controller.abort();
    this.requests.clear();
    this.listeners.clear();
  }

  async verify() {
    if (this.closed) throw new Error("Network settings have closed.");
    const node = this.state.snapshot?.runtime.privateAccess;
    if (!node?.hostname || !node.nodeId || !node.rootCertificate) throw new Error("Finish certificate setup before verifying this device.");
    const controller = new AbortController();
    this.requests.add(controller);
    try {
      const response = await (this.options.fetcher ?? fetch)(`https://${node.hostname}/_workbench-network/verify`, {
        cache: "no-store", credentials: "omit", signal: controller.signal,
      }).catch((error: unknown) => {
        if (controller.signal.aborted) throw error;
        throw new Error("This browser could not open the HTTPS address. Check that this device is connected to Tailscale, the DNS entry is saved, and the certificate is installed and trusted. The browser cannot tell us which check failed.");
      });
      if (!response.ok) throw new Error("Private HTTPS verification failed.");
      const parsed = WorkbenchNetworkVerificationSchema.safeParse(await response.json());
      if (!parsed.success) {
        reportClientSchemaError("Rejected Workbench private HTTPS verification", parsed.error);
        throw new Error("Private HTTPS verification returned invalid data.");
      }
      if (parsed.data.hostname !== node.hostname || parsed.data.nodeId !== node.nodeId) {
        throw new Error("Private DNS reached a different Workbench installation.");
      }
      const current = this.state.snapshot?.runtime.privateAccess;
      if (this.closed || current?.hostname !== node.hostname || current.nodeId !== node.nodeId || current.rootFingerprint !== node.rootFingerprint) {
        throw new Error("The private address changed during verification; verify its current identity.");
      }
      const verified = { hostname: node.hostname, nodeId: node.nodeId, rootFingerprint: node.rootFingerprint };
      this.update({ ...this.state, verified });
      return verified;
    } finally { this.requests.delete(controller); }
  }

  private receive(value: unknown) {
    const result = WorkbenchNetworkSnapshotSchema.safeParse(value);
    if (!result.success) {
      reportClientSchemaError("Rejected Workbench network settings response", result.error);
      throw new Error("Network settings returned invalid data.");
    }
    const node = result.data.runtime.privateAccess;
    const verified = this.state.verified;
    this.update({ ...this.state, snapshot: result.data, error: null, loading: false,
      verified: verified?.hostname === node.hostname && verified.nodeId === node.nodeId && verified.rootFingerprint === node.rootFingerprint ? verified : null });
  }

  private update(state: typeof this.state) {
    if (this.closed) return;
    this.state = state;
    for (const listener of this.listeners) listener();
  }
}

export const WorkbenchNetworkClientContext = createContext<WorkbenchNetworkClient | null>(null);

export function useWorkbenchNetwork() {
  const client = useContext(WorkbenchNetworkClientContext);
  if (!client) throw new Error("Network settings owner is unavailable.");
  const state = useSyncExternalStore(client.subscribe, client.snapshot, client.snapshot);
  return { ...state, client };
}
