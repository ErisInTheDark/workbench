/*
 * Exports:
 * - default WorkbenchSocketClient: persistent WB WebSocket transport with fenced reconnects.
 * - WorkbenchClientNotification: provider-translated WB transcript messages.
 */
import type { WorkbenchHarness } from "../types.ts";
import { ProviderKeySchema } from "../workbench/provider/provider-key.ts";
import reportClientSchemaError from "../workbench/report-client-schema-error.ts";
import { WORKBENCH_RELOAD_DIRT_UPDATED_METHOD } from "../workbench/daemon-reload.ts";
import { WORKBENCH_STATS_IMPORT_UPDATED_METHOD } from "../workbench/stats/workbench-stats-contract.ts";
import { workbenchTranscriptNotifications } from "../workbench/database/transcript/workbench-transcript-contract.ts";
import {
  WORKBENCH_EVENT_STREAM_ACK_METHOD,
  WORKBENCH_EVENT_STREAM_SEQUENCE_FIELD,
} from "../workbench/websocket-stream.ts";
import type { WorkbenchTranscriptNotification } from "../workbench/provider/provider-observation.ts";
import { getWorkbenchDaemonUrl } from "./workbench-connection.ts";
import { createWorkbenchRequestIdGenerator, type WorkbenchRpcResponse } from "./workbench-rpc.ts";

type PendingResponseHandler = {
  reject: (reason?: unknown) => void;
  resolve: (value: WorkbenchRpcResponse<unknown>) => void;
};

export type WorkbenchClientNotification = WorkbenchTranscriptNotification;
type WorkbenchIncomingMessage = WorkbenchRpcResponse<unknown> | WorkbenchClientNotification;
type WorkbenchNotification = {
  method:
    | "workbench/thread-state/reset"
    | "workbench/thread-state/updated"
    | typeof WORKBENCH_RELOAD_DIRT_UPDATED_METHOD
    | (typeof workbenchTranscriptNotifications)[keyof typeof workbenchTranscriptNotifications]["method"]
    | typeof WORKBENCH_STATS_IMPORT_UPDATED_METHOD;
  params: unknown;
};
type Timer = ReturnType<typeof setTimeout>;

const EVENT_STREAM_ACK_BATCH_MS = 50;
const publicMethods = new Set<string>([
  "thread/started", "thread/status/changed", "thread/name/updated", "thread/tokenUsage/updated",
  "thread/goal/updated", "thread/goal/cleared", "account/updated", "account/rateLimits/updated",
  "turn/started", "turn/completed", "item/started", "item/completed",
  "item/agentMessage/delta", "item/plan/delta", "item/commandExecution/outputDelta",
  "item/fileChange/outputDelta", "item/fileChange/patchUpdated", "item/reasoning/summaryTextDelta",
  "item/reasoning/summaryPartAdded", "item/reasoning/textDelta",
  "questionnaire/requested", "questionnaire/resolved", "browse/result/recorded",
] satisfies WorkbenchClientNotification["method"][]);

function isWorkbenchPublicNotification(message: unknown): message is WorkbenchClientNotification {
  return !!message && typeof message === "object"
    && "method" in message && typeof message.method === "string" && publicMethods.has(message.method)
    && "params" in message && !!message.params && typeof message.params === "object"
    && !("id" in message);
}

function isWorkbenchRpcResponse(message: unknown): message is WorkbenchRpcResponse<unknown> {
  return !!message && typeof message === "object" && "id" in message && ("result" in message || "error" in message);
}

export default class WorkbenchSocketClient {
  private readonly cancelEventStreamAck: (timer: Timer) => void;
  private readonly notificationListeners = new Set<(
    notification: WorkbenchClientNotification,
    harness: WorkbenchHarness,
  ) => void>();
  private readonly pendingResponses = new Map<number, PendingResponseHandler>();
  private readonly workbenchNotificationListeners = new Set<(notification: WorkbenchNotification) => void>();
  private readonly connectionCloseListeners = new Set<() => void>();
  private readonly reconnectListeners = new Set<() => void>();
  private readonly nextRequestId = createWorkbenchRequestIdGenerator();
  private socketPromise: Promise<void> | null = null;
  private hasOpenedSocket = false;
  private lastConsumedEventStreamSequence = 0;
  private disposed = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private eventStreamAckTimer: Timer | null = null;
  private pendingEventStreamAckSequence: number | null = null;
  private readonly scheduleEventStreamAck: (callback: () => void, delayMs: number) => Timer;
  private url = getWorkbenchDaemonUrl();
  private socket: WebSocket | null = null;

  constructor({
    clearEventStreamAckTimeout: cancelEventStreamAck = (timer) => globalThis.clearTimeout(timer),
    setEventStreamAckTimeout: scheduleEventStreamAck = (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  }: {
    clearEventStreamAckTimeout?: (timer: Timer) => void;
    setEventStreamAckTimeout?: (callback: () => void, delayMs: number) => Timer;
  } = {}) {
    this.cancelEventStreamAck = cancelEventStreamAck;
    this.scheduleEventStreamAck = scheduleEventStreamAck;
  }

  async connect(url = getWorkbenchDaemonUrl()) {
    await this.connectSocket(url);
  }

  async connectSocket(url = this.url) {
    if (this.disposed) throw new Error("Workbench socket client is disposed.");
    this.url = url;
    if (this.socket?.readyState === WebSocket.OPEN) return;
    if (this.socketPromise) return await this.socketPromise;
    const socketPromise = this.openSocket(url);
    this.socketPromise = socketPromise;
    try {
      await socketPromise;
    } finally {
      if (this.socketPromise === socketPromise) this.socketPromise = null;
    }
  }

  private async openSocket(url: string) {
    const socket = new WebSocket(url);
    this.socket = socket;

    socket.addEventListener("message", (event) => {
      if (this.socket !== socket) return;
      this.handleIncomingMessage(event.data);
    });

    socket.addEventListener("close", () => {
      if (!this.retireSocket(socket, new Error("Workbench connection closed."))) return;
      if (!this.disposed) this.scheduleReconnect();
    });

    await new Promise<void>((resolve, reject) => {
      let opened = false;
      socket.addEventListener("open", () => {
        opened = true;
        resolve();
      }, { once: true });
      socket.addEventListener("error", () => {
        if (opened) return;
        if (this.socket === socket) this.socket = null;
        socket.close();
        reject(new Error("Failed to connect to Workbench."));
      }, {
        once: true,
      });
      socket.addEventListener("close", () => {
        if (!opened) reject(new Error("Failed to connect to Workbench."));
      }, { once: true });
    });

    if (this.socket !== socket) {
      throw new Error("Workbench connection was replaced before opening.");
    }
    const reconnected = this.hasOpenedSocket;
    this.hasOpenedSocket = true;
    this.reconnectAttempt = 0;
    if (reconnected) {
      for (const listener of this.reconnectListeners) listener();
    }
  }

  private scheduleReconnect() {
    if (this.reconnectTimer || this.disposed) return;
    const delay = Math.min(30_000, 250 * 2 ** Math.min(this.reconnectAttempt, 7));
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connectSocket(this.url).catch(() => this.scheduleReconnect());
    }, delay);
  }

  close(code?: number, reason?: string) {
    this.disposed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const socket = this.socket;
    if (socket) {
      this.retireSocket(socket, new Error("Workbench socket client closed."));
      socket.close(code, reason);
    } else {
      for (const pending of this.pendingResponses.values()) pending.reject(new Error("Workbench socket client closed."));
      this.pendingResponses.clear();
      this.clearEventStreamReceiptState();
    }
  }

  dispose() {
    this.disposed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const socket = this.socket;
    if (socket) {
      this.retireSocket(socket, new Error("Workbench socket client disposed."));
      socket.close();
    } else {
      for (const pending of this.pendingResponses.values()) pending.reject(new Error("Workbench socket client disposed."));
      this.pendingResponses.clear();
      this.clearEventStreamReceiptState();
    }
  }

  onWorkbenchNotification(listener: (notification: WorkbenchNotification) => void) {
    this.workbenchNotificationListeners.add(listener);
    return () => this.workbenchNotificationListeners.delete(listener);
  }

  onConnectionClose(listener: () => void) {
    this.connectionCloseListeners.add(listener);
    return () => this.connectionCloseListeners.delete(listener);
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
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("Workbench socket is not connected.");
    }

    this.socket.send(JSON.stringify(message));
  }

  async sendRequest<TResponse = unknown>(
    message: { id?: number; method: string; params?: unknown } & Record<string, unknown>,
    options: { socketOnly?: boolean } = {},
  ): Promise<WorkbenchRpcResponse<TResponse>> {
    if (this.socket?.readyState !== WebSocket.OPEN) await this.connectSocket();
    const requestId = message.id ?? this.nextRequestId();
    const request = {
      ...message,
      id: requestId,
    };

    const responsePromise = new Promise<WorkbenchRpcResponse<TResponse>>((resolve, reject) => {
      this.pendingResponses.set(requestId, {
        resolve: (value) => resolve(value as WorkbenchRpcResponse<TResponse>),
        reject,
      });
    });

    try {
      this.send(request);
    } catch (error) {
      this.pendingResponses.delete(requestId);
      throw error;
    }
    return responsePromise;
  }

  private handleIncomingMessage(payload: string | ArrayBufferLike | Blob | ArrayBufferView) {
    if (typeof payload !== "string") {
      return;
    }

    const parsed = JSON.parse(payload) as WorkbenchIncomingMessage;

    const workbenchMessage = parsed as unknown as { method?: string };
    if (workbenchMessage.method === "workbench/thread-state/updated"
      || workbenchMessage.method === "workbench/thread-state/reset"
      || workbenchMessage.method === WORKBENCH_RELOAD_DIRT_UPDATED_METHOD
      || Object.values(workbenchTranscriptNotifications).some(notification => notification.method === workbenchMessage.method)
      || workbenchMessage.method === WORKBENCH_STATS_IMPORT_UPDATED_METHOD) {
      for (const listener of this.workbenchNotificationListeners) listener(parsed as unknown as WorkbenchNotification);
      return;
    }

    if (isWorkbenchPublicNotification(parsed)) {
      const rawHarness = (parsed as WorkbenchClientNotification & { workbenchHarness?: WorkbenchHarness }).workbenchHarness;
      const provider = ProviderKeySchema.safeParse(rawHarness ?? "codex");
      if (!provider.success) {
        reportClientSchemaError("provider notification identity", provider.error);
        return;
      }
      const harness = provider.data;
      for (const listener of this.notificationListeners) {
        listener(parsed, harness);
      }
    }

    if (isWorkbenchRpcResponse(parsed) && typeof parsed.id === "number") {
      const handler = this.pendingResponses.get(parsed.id);
      if (!handler) {
        return;
      }

      this.pendingResponses.delete(parsed.id);
      handler.resolve(parsed);
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
      if (pendingSequence === null || !this.socket || this.socket.readyState !== WebSocket.OPEN) return;
      this.send({ method: WORKBENCH_EVENT_STREAM_ACK_METHOD, params: { sequence: pendingSequence } });
    }, EVENT_STREAM_ACK_BATCH_MS);
  }

  private clearEventStreamReceiptState() {
    if (this.eventStreamAckTimer !== null) this.cancelEventStreamAck(this.eventStreamAckTimer);
    this.eventStreamAckTimer = null;
    this.lastConsumedEventStreamSequence = 0;
    this.pendingEventStreamAckSequence = null;
  }

  private retireSocket(socket: WebSocket, error: Error) {
    if (this.socket !== socket) return false;
    this.socket = null;
    this.clearEventStreamReceiptState();
    for (const pending of this.pendingResponses.values()) pending.reject(error);
    this.pendingResponses.clear();
    for (const listener of this.connectionCloseListeners) listener();
    return true;
  }
}
