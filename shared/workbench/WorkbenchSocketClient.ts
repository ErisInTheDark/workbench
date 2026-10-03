/*
 * Exports:
 * - default WorkbenchSocketClient: daemon notification and receipt adapter over shared WebSocket transport.
 * - WorkbenchClientNotification: provider-translated WB transcript messages.
 */
import type { WorkbenchHarness } from "../types.ts";
import { ProviderKeySchema } from "../workbench/provider/provider-key.ts";
import { defaultProviderKey } from "./provider/provider-registrations.ts";
import reportClientSchemaError from "../workbench/report-client-schema-error.ts";
import { WORKBENCH_RELOAD_DIRT_UPDATED_METHOD } from "../workbench/daemon-reload.ts";
import { WORKBENCH_STATS_IMPORT_UPDATED_METHOD } from "../workbench/stats/workbench-stats-contract.ts";
import { workbenchTranscriptNotifications } from "../workbench/database/transcript/workbench-transcript-contract.ts";
import {
  WORKBENCH_EVENT_STREAM_ACK_METHOD,
  WORKBENCH_EVENT_STREAM_SEQUENCE_FIELD,
} from "../workbench/websocket-stream.ts";
import { isWorkbenchPublicNotification, type WorkbenchTranscriptNotification } from "../workbench/provider/provider-observation.ts";
import { WORKSPACE_DELTA_METHOD, WORKSPACE_UPDATED_METHOD } from "./workspace/workspace-observation";
import { WEBSOCKET_SPY_QUERY_METHOD } from "../process/WebSocketTrafficBuffer.ts";
import type { WorkbenchRpcResponse } from "./workbench-rpc.ts";
import WorkbenchRpcSocketClient from "./WorkbenchRpcSocketClient.ts";

export type WorkbenchClientNotification = WorkbenchTranscriptNotification;
type WorkbenchNotification = {
  method:
    | "voice/event"
    | "workbench/thread-state/reset"
    | "workbench/thread-state/updated"
    | typeof WORKSPACE_UPDATED_METHOD
    | typeof WORKSPACE_DELTA_METHOD
    | typeof WORKBENCH_RELOAD_DIRT_UPDATED_METHOD
    | (typeof workbenchTranscriptNotifications)[keyof typeof workbenchTranscriptNotifications]["method"]
    | typeof WORKBENCH_STATS_IMPORT_UPDATED_METHOD
    | typeof WEBSOCKET_SPY_QUERY_METHOD;
  params: unknown;
};
type Timer = ReturnType<typeof setTimeout>;

const EVENT_STREAM_ACK_BATCH_MS = 50;
export default class WorkbenchSocketClient {
  private readonly cancelEventStreamAck: (timer: Timer) => void;
  private readonly notificationListeners = new Set<(
    notification: WorkbenchClientNotification,
    harness: WorkbenchHarness,
  ) => void>();
  private readonly workbenchNotificationListeners = new Set<(notification: WorkbenchNotification) => void>();
  private readonly connectionCloseListeners = new Set<() => void>();
  private readonly connectionOpenListeners = new Set<() => void>();
  private readonly reconnectListeners = new Set<() => void>();
  private readonly transport: WorkbenchRpcSocketClient;
  private lastConsumedEventStreamSequence = 0;
  private eventStreamAckTimer: Timer | null = null;
  private pendingEventStreamAckSequence: number | null = null;
  private readonly scheduleEventStreamAck: (callback: () => void, delayMs: number) => Timer;
  constructor({
    clearEventStreamAckTimeout: cancelEventStreamAck = (timer) => globalThis.clearTimeout(timer),
    setEventStreamAckTimeout: scheduleEventStreamAck = (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
    resolveUrl = async () => { throw new Error("An explicit daemon endpoint is required."); },
    createSocket,
  }: {
    clearEventStreamAckTimeout?: (timer: Timer) => void;
    setEventStreamAckTimeout?: (callback: () => void, delayMs: number) => Timer;
    resolveUrl?: (signal: AbortSignal) => Promise<string>;
    createSocket?: (url: string) => WebSocket;
  } = {}) {
    this.cancelEventStreamAck = cancelEventStreamAck;
    this.scheduleEventStreamAck = scheduleEventStreamAck;
    this.transport = new WorkbenchRpcSocketClient(resolveUrl, "Workbench", createSocket);
    this.transport.onMessage(message => this.handleIncomingMessage(message));
    this.transport.onOpen(reconnected => {
      for (const listener of this.connectionOpenListeners) listener();
      if (reconnected) for (const listener of this.reconnectListeners) listener();
    });
    this.transport.onClose(() => {
      this.clearEventStreamReceiptState();
      for (const listener of this.connectionCloseListeners) listener();
    });
  }

  async connect(url?: string) {
    await this.transport.connect(url);
  }

  get isOpen() { return this.transport.isOpen; }
  get url() { return this.transport.url; }
  getSnapshot = () => this.transport.getSnapshot();
  subscribeConnection = (listener: () => void) => this.transport.subscribe(listener);

  async connectSocket(url?: string) {
    await this.transport.connect(url);
  }

  setSuspended(suspended: boolean) {
    this.transport.setSuspended(suspended);
  }

  close(code?: number, reason?: string) {
    this.transport.close(code, reason);
    this.clearEventStreamReceiptState();
  }

  dispose() {
    this.transport.dispose();
    this.clearEventStreamReceiptState();
  }

  onWorkbenchNotification(listener: (notification: WorkbenchNotification) => void) {
    this.workbenchNotificationListeners.add(listener);
    return () => this.workbenchNotificationListeners.delete(listener);
  }

  onConnectionClose(listener: () => void) {
    this.connectionCloseListeners.add(listener);
    return () => this.connectionCloseListeners.delete(listener);
  }

  onConnectionOpen(listener: () => void) {
    this.connectionOpenListeners.add(listener);
    return () => this.connectionOpenListeners.delete(listener);
  }

  onReconnect(listener: () => void) {
    this.reconnectListeners.add(listener);
    return () => this.reconnectListeners.delete(listener);
  }

  onNotification(listener: (
    notification: WorkbenchClientNotification,
    harness: WorkbenchHarness,
  ) => void) {
    this.notificationListeners.add(listener);
    return () => {
      this.notificationListeners.delete(listener);
    };
  }

  send(message: object) {
    this.transport.send(message);
  }

  async sendRequest<TResponse = unknown>(
    message: { id?: number; method: string; params?: unknown } & Record<string, unknown>,
    options: { socketOnly?: boolean; requireOpen?: boolean; signal?: AbortSignal } = {},
  ): Promise<WorkbenchRpcResponse<TResponse>> {
    return this.transport.sendRequest<TResponse>(message, { requireOpen: options.requireOpen, signal: options.signal });
  }

  private handleIncomingMessage(parsed: unknown) {
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      console.error("Rejected daemon message envelope.");
      return;
    }
    const workbenchMessage = parsed as { method?: string };
    if (workbenchMessage.method === "workbench/thread-state/updated"
      || workbenchMessage.method === "voice/event"
      || workbenchMessage.method === "workbench/thread-state/reset"
      || workbenchMessage.method === WORKSPACE_UPDATED_METHOD
      || workbenchMessage.method === WORKSPACE_DELTA_METHOD
      || workbenchMessage.method === WORKBENCH_RELOAD_DIRT_UPDATED_METHOD
      || Object.values(workbenchTranscriptNotifications).some(notification => notification.method === workbenchMessage.method)
      || workbenchMessage.method === WORKBENCH_STATS_IMPORT_UPDATED_METHOD
      || workbenchMessage.method === WEBSOCKET_SPY_QUERY_METHOD) {
      for (const listener of this.workbenchNotificationListeners) listener(parsed as unknown as WorkbenchNotification);
      return;
    }

    if (isWorkbenchPublicNotification(parsed)) {
      const rawHarness = (parsed as WorkbenchClientNotification & { workbenchHarness?: WorkbenchHarness }).workbenchHarness;
      const provider = ProviderKeySchema.safeParse(rawHarness ?? defaultProviderKey);
      if (!provider.success) {
        reportClientSchemaError("provider notification identity", provider.error);
        return;
      }
      const harness = provider.data;
      for (const listener of this.notificationListeners) {
        listener(parsed, harness);
      }
    }

    // Unused provider notifications still consume their shared transport sequence.
    const sequence = (parsed as unknown as Record<string, unknown>)[WORKBENCH_EVENT_STREAM_SEQUENCE_FIELD];
    if (typeof sequence === "number" && Number.isSafeInteger(sequence) && sequence > 0) {
      this.consumeEventStreamSequence(sequence);
    }
  }

  private consumeEventStreamSequence(sequence: number) {
    if (sequence <= this.lastConsumedEventStreamSequence) return;
    if (sequence !== this.lastConsumedEventStreamSequence + 1) return;
    this.lastConsumedEventStreamSequence = sequence;
    this.queueEventStreamAck(sequence);
  }

  private queueEventStreamAck(sequence: number) {
    this.pendingEventStreamAckSequence = Math.max(this.pendingEventStreamAckSequence ?? 0, sequence);
    if (this.eventStreamAckTimer !== null) return;
    this.eventStreamAckTimer = this.scheduleEventStreamAck(() => {
      this.eventStreamAckTimer = null;
      const pendingSequence = this.pendingEventStreamAckSequence;
      this.pendingEventStreamAckSequence = null;
      if (pendingSequence === null || !this.transport.isOpen) return;
      this.send({ method: WORKBENCH_EVENT_STREAM_ACK_METHOD, params: { sequence: pendingSequence } });
    }, EVENT_STREAM_ACK_BATCH_MS);
  }

  private clearEventStreamReceiptState() {
    if (this.eventStreamAckTimer !== null) this.cancelEventStreamAck(this.eventStreamAckTimer);
    this.eventStreamAckTimer = null;
    this.lastConsumedEventStreamSequence = 0;
    this.pendingEventStreamAckSequence = null;
  }

}
