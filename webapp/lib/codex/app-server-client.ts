/*
 * Exports:
 * - CodexAppServerClient: persistent typed WebSocket client with fenced reconnects for the local stdio bridge and app-server notifications. Keywords: codex, websocket, reconnect, stdio, notifications.
 */
import type { WorkbenchHarness } from "../types";
import { WORKBENCH_RELOAD_DIRT_UPDATED_METHOD } from "../workbench/orchestrator-reload";
import { workbenchTranscriptNotifications } from "../workbench/database/transcript/workbench-transcript-contract";
import {
  WORKBENCH_EVENT_STREAM_ACK_METHOD,
  WORKBENCH_EVENT_STREAM_SEQUENCE_FIELD,
  type WorkbenchEventStreamAck,
} from "../workbench/websocket-stream";
import type { CodexAppServerNotification } from "./app-server-notifications";
import { isCodexAppServerNotification } from "./app-server-notifications";
import { getCodexAppServerUrl } from "./config";
import type {
    CodexClientNotification,
    CodexClientRequest,
    CodexInitializeResponse,
    CodexJsonRpcResponse,
} from "./protocol";
import {
    createInitializeCapabilities,
    createInitializeRequest,
    createInitializedNotification,
    createRequestIdGenerator,
    isCodexJsonRpcFailure,
} from "./protocol";

type PendingResponseHandler = {
  reject: (reason?: unknown) => void;
  resolve: (value: CodexJsonRpcResponse<unknown>) => void;
};

type CodexIncomingMessage = CodexJsonRpcResponse<unknown> | CodexAppServerNotification;
type WorkbenchNotification = {
  method:
    | "workbench/thread-state/reset"
    | "workbench/thread-state/updated"
    | typeof WORKBENCH_RELOAD_DIRT_UPDATED_METHOD
    | typeof workbenchTranscriptNotifications.capabilities.method
    | typeof workbenchTranscriptNotifications.updated.method;
  params: unknown;
};
type Timer = ReturnType<typeof setTimeout>;

const EVENT_STREAM_ACK_BATCH_MS = 50;

function isCodexJsonRpcResponse(message: unknown): message is CodexJsonRpcResponse<unknown> {
  return !!message && typeof message === "object" && "id" in message && ("result" in message || "error" in message);
}

export class CodexAppServerClient {
  private readonly cancelEventStreamAck: (timer: Timer) => void;
  private readonly notificationListeners = new Set<(
    notification: CodexAppServerNotification,
    harness: WorkbenchHarness,
  ) => void>();
  private readonly pendingResponses = new Map<number, PendingResponseHandler>();
  private readonly workbenchNotificationListeners = new Set<(notification: WorkbenchNotification) => void>();
  private readonly connectionCloseListeners = new Set<() => void>();
  private readonly reconnectListeners = new Set<() => void>();
  private readonly nextRequestId = createRequestIdGenerator();
  private connectPromise: Promise<void> | null = null;
  private socketPromise: Promise<void> | null = null;
  private hasOpenedSocket = false;
  private initialized = false;
  private lastConsumedEventStreamSequence = 0;
  private disposed = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private eventStreamAckTimer: Timer | null = null;
  private pendingEventStreamAckSequence: number | null = null;
  private readonly scheduleEventStreamAck: (callback: () => void, delayMs: number) => Timer;
  private url = getCodexAppServerUrl();
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

  async connect(url = getCodexAppServerUrl()) {
    if (this.socket && this.socket.readyState === WebSocket.OPEN && this.initialized) {
      return;
    }

    if (this.connectPromise) {
      await this.connectPromise;
      return;
    }

    this.url = url;
    const connectPromise = this.initializeProvider();
    this.connectPromise = connectPromise;
    try {
      await connectPromise;
    } finally {
      if (this.connectPromise === connectPromise) this.connectPromise = null;
    }
  }

  async connectSocket(url = this.url) {
    if (this.disposed) throw new Error("Codex app-server client is disposed.");
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

  private async initializeProvider() {
    await this.connectSocket(this.url);
    if (this.initialized) return;
    const initializeRequest = createInitializeRequest(0, {
      capabilities: createInitializeCapabilities({ experimentalApi: true }),
    });
    const response = await this.sendRequest<CodexInitializeResponse>({ id: 0, method: initializeRequest.method, params: initializeRequest.params }, { socketOnly: true });
    if (isCodexJsonRpcFailure(response)) throw new Error(response.error.message);
    this.send(createInitializedNotification());
    this.initialized = true;
  }

  private async openSocket(url: string) {
    const socket = new WebSocket(url);
    this.socket = socket;

    socket.addEventListener("message", (event) => {
      if (this.socket !== socket) return;
      this.handleIncomingMessage(event.data);
    });

    socket.addEventListener("close", () => {
      if (!this.retireSocket(socket, new Error("Codex app-server connection closed."))) return;
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
        reject(new Error("Failed to connect to Codex app-server."));
      }, {
        once: true,
      });
      socket.addEventListener("close", () => {
        if (!opened) reject(new Error("Failed to connect to Codex app-server."));
      }, { once: true });
    });

    if (this.socket !== socket) {
      throw new Error("Codex app-server connection was replaced before opening.");
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
      this.retireSocket(socket, new Error("Codex app-server client closed."));
      socket.close(code, reason);
    } else {
      for (const pending of this.pendingResponses.values()) pending.reject(new Error("Codex app-server client closed."));
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
      this.retireSocket(socket, new Error("Codex app-server client disposed."));
      socket.close();
    } else {
      for (const pending of this.pendingResponses.values()) pending.reject(new Error("Codex app-server client disposed."));
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
    notification: CodexAppServerNotification,
    harness: WorkbenchHarness,
  ) => void) {
    this.notificationListeners.add(listener);
    return () => {
      this.notificationListeners.delete(listener);
    };
  }

  send(message: CodexClientRequest | CodexClientNotification | WorkbenchEventStreamAck) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("Codex app-server socket is not connected.");
    }

    this.socket.send(JSON.stringify(message));
  }

  async sendRequest<TResponse = unknown>(
    message: { id?: number; method: string; params?: unknown } & Record<string, unknown>,
    options: { socketOnly?: boolean } = {},
  ): Promise<CodexJsonRpcResponse<TResponse>> {
    if (options.socketOnly) await this.connectSocket();
    else if (!this.initialized && message.method !== "initialize") await this.connect();
    const requestId = message.id ?? this.nextRequestId();
    const request = {
      ...message,
      id: requestId,
    } as CodexClientRequest & Record<string, unknown>;

    const responsePromise = new Promise<CodexJsonRpcResponse<TResponse>>((resolve, reject) => {
      this.pendingResponses.set(requestId, {
        resolve: (value) => resolve(value as CodexJsonRpcResponse<TResponse>),
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

    const parsed = JSON.parse(payload) as CodexIncomingMessage;

    const workbenchMessage = parsed as unknown as { method?: string };
    if (workbenchMessage.method === "workbench/thread-state/updated"
      || workbenchMessage.method === "workbench/thread-state/reset"
      || workbenchMessage.method === WORKBENCH_RELOAD_DIRT_UPDATED_METHOD
      || workbenchMessage.method === workbenchTranscriptNotifications.capabilities.method
      || workbenchMessage.method === workbenchTranscriptNotifications.updated.method) {
      for (const listener of this.workbenchNotificationListeners) listener(parsed as unknown as WorkbenchNotification);
      return;
    }

    if (isCodexAppServerNotification(parsed)) {
      const rawHarness = (parsed as CodexAppServerNotification & { workbenchHarness?: WorkbenchHarness }).workbenchHarness;
      const harness = rawHarness === "copilot" || rawHarness === "opencode" ? rawHarness : "codex";
      for (const listener of this.notificationListeners) {
        listener(parsed, harness);
      }
      const sequence = (parsed as unknown as Record<string, unknown>)[WORKBENCH_EVENT_STREAM_SEQUENCE_FIELD];
      if (typeof sequence === "number" && Number.isSafeInteger(sequence) && sequence > 0) {
        this.consumeEventStreamSequence(sequence);
      }
      return;
    }

    if (isCodexJsonRpcResponse(parsed) && typeof parsed.id === "number") {
      const handler = this.pendingResponses.get(parsed.id);
      if (!handler) {
        return;
      }

      this.pendingResponses.delete(parsed.id);
      handler.resolve(parsed);
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
    this.initialized = false;
    this.clearEventStreamReceiptState();
    for (const pending of this.pendingResponses.values()) pending.reject(error);
    this.pendingResponses.clear();
    for (const listener of this.connectionCloseListeners) listener();
    return true;
  }
}
