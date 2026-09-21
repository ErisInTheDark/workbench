/*
 * Exports:
 * - default WorkbenchNetworkClient: own validated network settings, progress subscription and request cancellation.
 * - WorkbenchNetworkClientContext/useWorkbenchNetwork: share the settings owner without transporting app state through props.
 * - WorkbenchHttpsVerification: current browser proof, progress or failure for one service identity.
 */
import { createContext, useContext, useSyncExternalStore } from "react";
import {
  WORKBENCH_NETWORK_PATH, WorkbenchNetworkActionSchema, WorkbenchNetworkResultSchema, WorkbenchNetworkSnapshotSchema, WorkbenchNetworkVerificationSchema, workbenchNetworkMode,
  type WorkbenchNetworkAction, type WorkbenchNetworkResult, type WorkbenchNetworkSnapshot, type WorkbenchNetworkSettings,
} from "workbench-shared/http/workbench-network";
import reportClientSchemaError from "workbench-shared/workbench/report-client-schema-error";
import { z } from "zod";
import { consumeNetworkHandoff, networkNavigationUrl, type NetworkHandoff, type NetworkUpgrade } from "./workbench-network-navigation";
import { readWorkbenchBrowserStateTransferId } from "../state/workbench-browser-state-identity";

const actionError = z.object({ error: z.string().max(512) }).strict();
type HttpsIdentity = { hostname: string; nodeId: string; rootFingerprint: string | null };
export type WorkbenchHttpsVerification =
  | { phase: "idle" }
  | { phase: "checking" | "verified"; identity: HttpsIdentity }
  | { phase: "failed"; identity: HttpsIdentity; message: string };

export default class WorkbenchNetworkClient {
  private state: {
    snapshot: WorkbenchNetworkSnapshot | null; error: string | null; loading: boolean;
    verification: WorkbenchHttpsVerification;
    handoff: NetworkHandoff | null;
  } = {
    snapshot: null, error: null, loading: true, verification: { phase: "idle" }, handoff: null,
  };
  private readonly listeners = new Set<() => void>();
  private readonly requests = new Set<AbortController>();
  private events: Pick<EventSource, "close" | "onmessage" | "onerror"> | null = null;
  private closed = false;
  private upgrade: NetworkUpgrade | null = null;
  private verificationRequest: AbortController | null = null;

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
      const response = await (this.options.fetcher ?? fetch)(`${WORKBENCH_NETWORK_PATH}?capabilities=4`, { cache: "no-store", signal: controller.signal });
      if (this.closed) return;
      if (response.status === 404) throw new Error("Restart the Workbench app to load network settings.");
      if (!response.ok) throw new Error(`Network settings could not be read (HTTP ${response.status}).`);
      const value: unknown = await response.json();
      if (this.closed) return;
      this.receive(value);
      const eventsUrl = `${WORKBENCH_NETWORK_PATH}/events?capabilities=4`;
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
        if (consumed.receipt || consumed.upgrade) {
          window.history.replaceState(window.history.state, "", consumed.href);
        }
        if (consumed.receipt) {
          this.update({ ...this.state, handoff: consumed.receipt });
          if (!consumed.receipt.manual) await this.finishSettings(consumed.receipt.returning);
        } else if (consumed.upgrade && this.state.snapshot && workbenchNetworkMode(this.state.snapshot.configuration) === consumed.upgrade) {
          this.beginUpgrade(consumed.upgrade);
        }
      }
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
      if (action.action === "trust-host") await this.verify();
      return result.data;
    } finally { this.requests.delete(controller); }
  }

  async changeSettings(settings: WorkbenchNetworkSettings) {
    this.cancelUpgrade();
    const modes = ["localhost", "tailnet-ip", "tailnet-service"] as const;
    const previous = this.state.snapshot ? workbenchNetworkMode(this.state.snapshot.configuration) : settings.mode;
    const upgrade = settings.mode !== "localhost" && modes.indexOf(settings.mode) > modes.indexOf(previous) ? settings.mode : undefined;
    const result = await this.action({ action: "settings-prepare", settings });
    if (result.kind !== "handoff") throw new Error("Settings did not return a connection handoff.");
    this.update({ ...this.state, handoff: { token: result.token, returning: false, ...(upgrade ? { upgrade } : {}) } });
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
        const upgrade = !cancel && !receipt.returning ? receipt.upgrade : undefined;
        if (result.origin !== window.location.origin) this.navigate(result.origin, undefined, upgrade);
        else if (upgrade) this.beginUpgrade(upgrade);
      } else throw new Error("Settings returned an unexpected completion response.");
    } catch (error) {
      this.update({ ...this.state, error: error instanceof Error ? error.message : "Settings could not finish." });
      throw error;
    }
  }

  private navigate(origin: string, receipt?: NetworkHandoff, upgrade?: NetworkUpgrade) {
    window.location.assign(networkNavigationUrl(window.location.href, origin, receipt,
      readWorkbenchBrowserStateTransferId(this.state.snapshot?.localPort ?? null), upgrade));
  }

  async resumeSettings() {
    const result = await this.action({ action: "settings-resume" });
    if (result.kind !== "handoff") throw new Error("Settings did not return a connection handoff.");
    const receipt: NetworkHandoff = { token: result.token, returning: result.returning, manual: true };
    this.update({ ...this.state, handoff: receipt });
    if (result.origin !== window.location.origin) this.navigate(result.origin, receipt);
  }

  close() {
    this.closed = true;
    this.cancelUpgrade();
    this.verificationRequest?.abort();
    this.verificationRequest = null;
    this.events?.close();
    this.events = null;
    for (const controller of this.requests) controller.abort();
    this.requests.clear();
    this.listeners.clear();
  }

  async verify() {
    if (this.closed) return;
    const node = this.state.snapshot?.runtime.privateAccess;
    if (!node?.hostname || !node.nodeId || !node.rootCertificate) {
      this.update({ ...this.state, error: "Finish certificate setup before verifying this device." });
      return;
    }
    const identity = { hostname: node.hostname, nodeId: node.nodeId, rootFingerprint: node.rootFingerprint };
    this.verificationRequest?.abort();
    const controller = new AbortController();
    this.verificationRequest = controller;
    this.requests.add(controller);
    this.update({ ...this.state, verification: { phase: "checking", identity } });
    try {
      const response = await (this.options.fetcher ?? fetch)(`https://${node.hostname}/_workbench-network/verify`, {
        cache: "no-store", credentials: "omit", signal: controller.signal,
      }).catch((error: unknown) => {
        if (controller.signal.aborted) throw error;
        throw new Error("This browser could not verify HTTPS. Check Tailscale connectivity, DNS and certificate trust.");
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
      controller.signal.throwIfAborted();
      if (this.closed || current?.hostname !== node.hostname || current.nodeId !== node.nodeId || current.rootFingerprint !== node.rootFingerprint) {
        throw new Error("The private address changed during verification; verify its current identity.");
      }
      this.update({ ...this.state, verification: { phase: "verified", identity } });
      this.tryUpgrade();
    } catch (error) {
      if (this.closed || controller.signal.aborted || this.verificationRequest !== controller) return;
      this.update({ ...this.state, verification: { phase: "failed", identity,
        message: error instanceof Error ? error.message.slice(0, 512) : "HTTPS could not be verified." } });
    } finally {
      this.requests.delete(controller);
      if (this.verificationRequest === controller) this.verificationRequest = null;
    }
  }

  private cancelUpgrade() {
    this.upgrade = null;
  }

  private beginUpgrade(mode: NetworkUpgrade) {
    this.cancelUpgrade();
    this.upgrade = mode;
    this.tryUpgrade();
  }

  private tryUpgrade() {
    const upgrade = this.upgrade;
    const snapshot = this.state.snapshot;
    if (!upgrade || !snapshot || workbenchNetworkMode(snapshot.configuration) !== upgrade) return;
    try {
      const status = upgrade === "tailnet-service" ? snapshot.runtime.privateAccess : snapshot.runtime.hostServe;
      if (status.phase !== "ready" || !status.url) return;
      if (upgrade === "tailnet-service" && this.state.verification.phase !== "verified") return;
      const origin = new URL(status.url).origin;
      this.cancelUpgrade();
      if (origin !== window.location.origin) this.navigate(origin);
    } catch (error) {
      this.cancelUpgrade();
      this.update({ ...this.state, error: error instanceof Error ? error.message : "The enabled address could not be opened." });
    }
  }

  private receive(value: unknown) {
    const result = WorkbenchNetworkSnapshotSchema.safeParse(value);
    if (!result.success) {
      reportClientSchemaError("Rejected Workbench network settings response", result.error);
      throw new Error("Network settings returned invalid data.");
    }
    const node = result.data.runtime.privateAccess;
    const mode = workbenchNetworkMode(result.data.configuration);
    const eligible = mode === "tailnet-service" && node.phase === "ready" && node.hostname && node.nodeId && node.rootCertificate && node.url;
    let verification = this.state.verification;
    if (!eligible || verification.phase !== "idle" && (verification.identity.hostname !== node.hostname
      || verification.identity.nodeId !== node.nodeId || verification.identity.rootFingerprint !== node.rootFingerprint)) {
      this.verificationRequest?.abort();
      this.verificationRequest = null;
      verification = { phase: "idle" };
    }
    if (this.upgrade && this.state.snapshot && workbenchNetworkMode(this.state.snapshot.configuration) === this.upgrade
      && mode !== this.upgrade) this.cancelUpgrade();
    this.update({ ...this.state, snapshot: result.data, error: null, loading: false, verification });
    if (eligible && verification.phase === "idle") void this.verify();
    this.tryUpgrade();
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
