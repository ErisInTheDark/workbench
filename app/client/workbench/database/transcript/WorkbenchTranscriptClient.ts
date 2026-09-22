/*
 * Exports:
 * - WorkbenchTranscriptTransport: WebSocket request and notification boundary.
 * - WorkbenchTranscriptConformanceReport: bounded transcript conformance evidence.
 * - default WorkbenchTranscriptClient: typed transcript operations and subscriptions.
 */
import {
  conformWorkbenchTranscriptCapabilities,
  conformWorkbenchTranscriptUpdated,
  conformWorkbenchTranscriptStreamed,
  type WorkbenchTranscriptConformanceReport,
  type WorkbenchTranscriptOperation,
  type WorkbenchTranscriptReadRequest,
  type WorkbenchTranscriptSnapshot,
  type WorkbenchTranscriptSubscribeParams,
  type WorkbenchTranscriptUnsubscribeParams,
  workbenchTranscriptNotifications,
  workbenchTranscriptOperations,
} from "workbench-shared/workbench/database/transcript/workbench-transcript-contract";
import type { TranscriptStreamUpdate } from "workbench-shared/workbench/transcript/thread-transcript-stream";
import type { DatabaseConformancePath } from "workbench-shared/database/schema/schema-conformance";

export type { WorkbenchTranscriptConformanceReport } from "workbench-shared/workbench/database/transcript/workbench-transcript-contract";

export interface WorkbenchTranscriptTransport {
  onDisconnect?: (listener: () => void) => () => void;
  onNotification: (listener: (notification: { method: string; params: unknown }) => void) => () => void;
  request: (method: string, params: unknown) => Promise<unknown>;
}

interface WorkbenchTranscriptClientOptions {
  reportConformance?: (report: WorkbenchTranscriptConformanceReport) => void;
  transport: WorkbenchTranscriptTransport;
}

function conformancePathSignature(path: DatabaseConformancePath) {
  return path.map((part) => `${typeof part === "number" ? "n" : "s"}:${part}`).join("/");
}

function conformanceReportSignature(report: WorkbenchTranscriptConformanceReport) {
  const issues = report.issues
    .map((issue) => `${issue.code}:${conformancePathSignature(issue.path)}`)
    .sort()
    .join(",");
  const repairedPaths = report.repairedPaths
    .map(conformancePathSignature)
    .sort()
    .join(",");
  return `${report.method}|issues=${issues}|repaired=${repairedPaths}`;
}

export default class WorkbenchTranscriptClient {
  private protocolVersion: 1 | 2 | 3 | 4 | null = null;
  private readonly availabilityListeners = new Set<(available: boolean) => void>();
  private readonly listeners = new Map<string, (snapshot: WorkbenchTranscriptSnapshot | null) => void>();
  private readonly streamListeners = new Map<string, {
    failed: boolean;
    onFailure?: (error: Error) => void;
    onUpdate: (update: TranscriptStreamUpdate) => void;
  }>();
  private readonly reportedConformanceSignatures = new Set<string>();
  private readonly reportConformance: NonNullable<WorkbenchTranscriptClientOptions["reportConformance"]>;
  private readonly stopDisconnect: () => void;
  private readonly stopNotifications: () => void;
  private readonly transport: WorkbenchTranscriptTransport;

  private get available() {
    return this.protocolVersion !== null;
  }

  get incremental() {
    return this.protocolVersion !== null && this.protocolVersion >= 3;
  }

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
    this.streamListeners.clear();
    this.stopDisconnect();
    this.stopNotifications();
  }

  onAvailabilityChange(listener: (available: boolean) => void) {
    this.availabilityListeners.add(listener);
    listener(this.available);
    return () => this.availabilityListeners.delete(listener);
  }

  async read(params: WorkbenchTranscriptReadRequest) {
    return (await this.request(workbenchTranscriptOperations.read, {
      ...params, ...(this.protocolVersion !== null && this.protocolVersion >= 4
        ? { protocolVersion: 4 as const }
        : this.protocolVersion !== null && this.protocolVersion >= 2
          ? { protocolVersion: 2 as const }
          : {}),
    })).snapshot;
  }

  async subscribe(
    params: WorkbenchTranscriptSubscribeParams,
    listener: (snapshot: WorkbenchTranscriptSnapshot | null) => void,
    streamListener?: (update: TranscriptStreamUpdate) => void,
    streamFailure?: (error: Error) => void,
  ) {
    this.listeners.set(params.subscriptionId, listener);
    const stream = streamListener ? { failed: false, onFailure: streamFailure, onUpdate: streamListener } : null;
    if (stream) this.streamListeners.set(params.subscriptionId, stream);
    try {
      await this.request(workbenchTranscriptOperations.subscribe, {
        ...params, ...(streamListener && this.protocolVersion !== null && this.protocolVersion >= 4
          ? { protocolVersion: 4 as const }
          : streamListener && this.protocolVersion === 3
            ? { protocolVersion: 3 as const }
          : this.protocolVersion !== 1 ? { protocolVersion: 2 as const } : {}),
      });
    } catch (error) {
      if (this.listeners.get(params.subscriptionId) === listener) this.listeners.delete(params.subscriptionId);
      if (this.streamListeners.get(params.subscriptionId) === stream) this.streamListeners.delete(params.subscriptionId);
      throw error;
    }
  }

  async unsubscribe(params: WorkbenchTranscriptUnsubscribeParams) {
    await this.request(workbenchTranscriptOperations.unsubscribe, params);
    this.listeners.delete(params.subscriptionId);
    this.streamListeners.delete(params.subscriptionId);
  }

  private async request<Kind extends string, Method extends string, Params, Result>(
    operation: WorkbenchTranscriptOperation<Kind, Method, Params, Result>,
    params: Params,
  ): Promise<Result> {
    if (!this.available) throw new Error("Workbench transcript protocol is unavailable.");
    const value = await this.transport.request(operation.method, params);
    const conformed = operation.conformResult(value);
    if (conformed.repairedPaths.length || !conformed.success) {
      this.reportConformanceOnce({
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
        this.reportConformanceOnce({
          method: workbenchTranscriptNotifications.capabilities.method,
          repairedPaths: conformed.repairedPaths,
          issues: "data" in conformed ? [] : conformed.issues,
        });
      }
      if ("data" in conformed) {
        this.setProtocolVersion(conformed.data.protocolVersion >= 4
          ? 4
          : conformed.data.protocolVersion >= 3 ? 3 : conformed.data.protocolVersion >= 2 ? 2 : 1);
      }
      return;
    }
    if (notification.method === workbenchTranscriptNotifications.streamed.method) {
      const conformed = conformWorkbenchTranscriptStreamed(notification.params);
      if (!conformed.success || conformed.repairedPaths.length) {
        this.reportConformanceOnce({
          method: notification.method, repairedPaths: conformed.repairedPaths,
          issues: "data" in conformed ? [] : conformed.issues,
        });
      }
      if (!conformed.success) {
        const params = notification.params;
        if (params && typeof params === "object" && "subscriptionId" in params
          && typeof params.subscriptionId === "string" && "update" in params
          && params.update && typeof params.update === "object" && "kind" in params.update
          && params.update.kind === "structure") {
          const stream = this.streamListeners.get(params.subscriptionId);
          if (stream && !stream.failed) {
            stream.failed = true;
            stream.onFailure?.(new Error("The SQLite transcript structure was rejected."));
          }
        }
        return;
      }
      const stream = this.streamListeners.get(conformed.data.subscriptionId);
      if (!stream?.failed) stream?.onUpdate(conformed.data.update);
      return;
    }
    if (notification.method !== workbenchTranscriptNotifications.updated.method) return;
    const conformed = conformWorkbenchTranscriptUpdated(notification.params);
    if (conformed.repairedPaths.length || !conformed.success) {
      this.reportConformanceOnce({
        method: workbenchTranscriptNotifications.updated.method,
        repairedPaths: conformed.repairedPaths,
        issues: "data" in conformed ? [] : conformed.issues,
      });
    }
    if (!("data" in conformed)) return;
    this.listeners.get(conformed.data.subscriptionId)?.(conformed.data.snapshot);
  }

  private setProtocolVersion(version: 1 | 2 | 3 | 4 | null) {
    const wasAvailable = this.available;
    this.protocolVersion = version;
    if (wasAvailable === this.available) return;
    for (const listener of this.availabilityListeners) listener(this.available);
  }

  private resetConnectionState() {
    this.listeners.clear();
    this.streamListeners.clear();
    this.reportedConformanceSignatures.clear();
    this.setProtocolVersion(null);
  }

  private reportConformanceOnce(report: WorkbenchTranscriptConformanceReport) {
    const signature = conformanceReportSignature(report);
    if (this.reportedConformanceSignatures.has(signature)) return;
    this.reportedConformanceSignatures.add(signature);
    this.reportConformance(report);
  }
}
