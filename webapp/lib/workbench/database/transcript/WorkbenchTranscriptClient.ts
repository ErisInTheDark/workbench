/*
 * WorkbenchTranscriptTransport: minimal unknown-data WebSocket boundary used by the transcript client. Keywords: transcript, websocket, transport.
 * WorkbenchTranscriptConformanceReport: bounded repair or rejection evidence without received values. Keywords: transcript, conformance, diagnostics.
 * default WorkbenchTranscriptClient: typed operation caller and conformed transcript subscription owner. Keywords: transcript, browser, client.
 */
import {
  conformWorkbenchTranscriptCapabilities,
  conformWorkbenchTranscriptUpdated,
  type WorkbenchTranscriptOperation,
  type WorkbenchTranscriptParityDiagnostic,
  type WorkbenchTranscriptReadRequest,
  type WorkbenchTranscriptSnapshot,
  type WorkbenchTranscriptSubscribeParams,
  type WorkbenchTranscriptUnsubscribeParams,
  workbenchTranscriptNotifications,
  workbenchTranscriptOperations,
} from "./workbench-transcript-contract.ts";
import type {
  DatabaseConformanceIssue,
  DatabaseConformancePath,
} from "../schema/schema-conformance.ts";

export interface WorkbenchTranscriptTransport {
  onDisconnect?: (listener: () => void) => () => void;
  onNotification: (listener: (notification: { method: string; params: unknown }) => void) => () => void;
  request: (method: string, params: unknown) => Promise<unknown>;
}

export interface WorkbenchTranscriptConformanceReport {
  issues: DatabaseConformanceIssue[];
  method: string;
  repairedPaths: DatabaseConformancePath[];
}

interface WorkbenchTranscriptClientOptions {
  reportConformance?: (report: WorkbenchTranscriptConformanceReport) => void;
  transport: WorkbenchTranscriptTransport;
}

export default class WorkbenchTranscriptClient {
  private available = false;
  private readonly availabilityListeners = new Set<(available: boolean) => void>();
  private readonly listeners = new Map<string, (snapshot: WorkbenchTranscriptSnapshot | null) => void>();
  private readonly reportConformance: NonNullable<WorkbenchTranscriptClientOptions["reportConformance"]>;
  private readonly stopDisconnect: () => void;
  private readonly stopNotifications: () => void;
  private readonly transport: WorkbenchTranscriptTransport;

  constructor({
    reportConformance = () => undefined,
    transport,
  }: WorkbenchTranscriptClientOptions) {
    this.reportConformance = reportConformance;
    this.transport = transport;
    this.stopNotifications = transport.onNotification((notification) => this.receiveNotification(notification));
    this.stopDisconnect = transport.onDisconnect?.(() => this.resetConnectionState()) ?? (() => undefined);
  }

  dispose() {
    this.availabilityListeners.clear();
    this.listeners.clear();
    this.stopDisconnect();
    this.stopNotifications();
  }

  onAvailabilityChange(listener: (available: boolean) => void) {
    this.availabilityListeners.add(listener);
    listener(this.available);
    return () => this.availabilityListeners.delete(listener);
  }

  async read(params: WorkbenchTranscriptReadRequest) {
    return (await this.request(workbenchTranscriptOperations.read, params)).snapshot;
  }

  async reportParity(params: WorkbenchTranscriptParityDiagnostic) {
    await this.request(workbenchTranscriptOperations.reportParity, params);
  }

  async subscribe(
    params: WorkbenchTranscriptSubscribeParams,
    listener: (snapshot: WorkbenchTranscriptSnapshot | null) => void,
  ) {
    this.listeners.set(params.subscriptionId, listener);
    try {
      await this.request(workbenchTranscriptOperations.subscribe, params);
    } catch (error) {
      if (this.listeners.get(params.subscriptionId) === listener) this.listeners.delete(params.subscriptionId);
      throw error;
    }
  }

  async unsubscribe(params: WorkbenchTranscriptUnsubscribeParams) {
    await this.request(workbenchTranscriptOperations.unsubscribe, params);
    this.listeners.delete(params.subscriptionId);
  }

  private async request<Kind extends string, Method extends string, Params, Result>(
    operation: WorkbenchTranscriptOperation<Kind, Method, Params, Result>,
    params: Params,
  ): Promise<Result> {
    if (!this.available) throw new Error("Workbench transcript protocol is unavailable.");
    const value = await this.transport.request(operation.method, params);
    const conformed = operation.conformResult(value);
    if (conformed.repairedPaths.length || !conformed.success) {
      this.reportConformance({
        method: operation.method,
        repairedPaths: conformed.repairedPaths,
        issues: "data" in conformed ? [] : conformed.issues,
      });
    }
    if (!("data" in conformed)) throw new Error(`Incompatible ${operation.method} response.`);
    return conformed.data;
  }

  private receiveNotification(notification: { method: string; params: unknown }) {
    if (notification.method === "workbench/thread-state/reset") {
      this.resetConnectionState();
      return;
    }
    if (notification.method === workbenchTranscriptNotifications.capabilities.method) {
      const conformed = conformWorkbenchTranscriptCapabilities(notification.params);
      if (conformed.repairedPaths.length || !conformed.success) {
        this.reportConformance({
          method: workbenchTranscriptNotifications.capabilities.method,
          repairedPaths: conformed.repairedPaths,
          issues: "data" in conformed ? [] : conformed.issues,
        });
      }
      if ("data" in conformed) this.setAvailable(true);
      return;
    }
    if (notification.method !== workbenchTranscriptNotifications.updated.method) return;
    const conformed = conformWorkbenchTranscriptUpdated(notification.params);
    if (conformed.repairedPaths.length || !conformed.success) {
      this.reportConformance({
        method: workbenchTranscriptNotifications.updated.method,
        repairedPaths: conformed.repairedPaths,
        issues: "data" in conformed ? [] : conformed.issues,
      });
    }
    if (!("data" in conformed)) return;
    this.listeners.get(conformed.data.subscriptionId)?.(conformed.data.snapshot);
  }

  private setAvailable(available: boolean) {
    if (this.available === available) return;
    this.available = available;
    for (const listener of this.availabilityListeners) listener(available);
  }

  private resetConnectionState() {
    this.listeners.clear();
    this.setAvailable(false);
  }
}
