/*
 * Exports:
 * - default WorkbenchNetworkClient: own validated network settings, progress subscription and request cancellation.
 * - WorkbenchNetworkClientContext/useWorkbenchNetwork: share the settings owner without transporting app state through props.
 */
import { createContext, useContext, useSyncExternalStore } from "react";
import {
  WORKBENCH_NETWORK_PATH, WorkbenchNetworkActionSchema, WorkbenchNetworkResultSchema, WorkbenchNetworkSnapshotSchema, WorkbenchNetworkVerificationSchema,
  type WorkbenchNetworkAction, type WorkbenchNetworkResult, type WorkbenchNetworkSnapshot,
} from "workbench-shared/http/workbench-network";
import reportClientSchemaError from "workbench-shared/workbench/report-client-schema-error";

export default class WorkbenchNetworkClient {
  private state: { snapshot: WorkbenchNetworkSnapshot | null; error: string | null; loading: boolean } = {
    snapshot: null, error: null, loading: true,
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
      const response = await (this.options.fetcher ?? fetch)(WORKBENCH_NETWORK_PATH, { cache: "no-store", signal: controller.signal });
      if (this.closed) return;
      if (response.status === 404) throw new Error("Restart the Workbench app to load network settings.");
      if (!response.ok) throw new Error(`Network settings could not be read (HTTP ${response.status}).`);
      const value: unknown = await response.json();
      if (this.closed) return;
      this.receive(value);
      const events = this.options.events?.(`${WORKBENCH_NETWORK_PATH}/events`) ?? new EventSource(`${WORKBENCH_NETWORK_PATH}/events`);
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
      if (!response.ok) throw new Error(this.state.snapshot?.failure ?? `Network action failed (HTTP ${response.status}); check setup status.`);
      const result = WorkbenchNetworkResultSchema.safeParse(await response.json());
      if (!result.success) {
        reportClientSchemaError("Rejected Workbench network action response", result.error);
        throw new Error("Network action returned invalid data.");
      }
      return result.data;
    } finally { this.requests.delete(controller); }
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
    const node = this.state.snapshot?.runtime.privateAccess;
    if (!node?.hostname || !node.nodeId || !node.rootCertificate) throw new Error("Finish certificate setup before verifying this device.");
    const controller = new AbortController();
    this.requests.add(controller);
    try {
      const response = await (this.options.fetcher ?? fetch)(`https://${node.hostname}/_workbench-network/verify`, {
        cache: "no-store", credentials: "omit", signal: controller.signal,
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
      return { hostname: node.hostname, nodeId: node.nodeId, rootFingerprint: node.rootFingerprint };
    } finally { this.requests.delete(controller); }
  }

  private receive(value: unknown) {
    const result = WorkbenchNetworkSnapshotSchema.safeParse(value);
    if (!result.success) {
      reportClientSchemaError("Rejected Workbench network settings response", result.error);
      throw new Error("Network settings returned invalid data.");
    }
    this.update({ snapshot: result.data, error: null, loading: false });
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
