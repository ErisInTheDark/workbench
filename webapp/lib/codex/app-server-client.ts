/*
 * Exports:
 * - CodexAppServerClient: persistent typed WebSocket client for the local stdio bridge and app-server notifications. Keywords: codex, websocket, stdio, notifications.
 */
import type { WorkbenchHarness } from "../types";
import type {
    CodexAppServerNotification,
    CodexAppServerNotificationHandling,
} from "./app-server-notifications";
import {
    classifyCodexAppServerNotification,
    isCodexAppServerNotification,
} from "./app-server-notifications";
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
type WorkbenchNotification = { method: "workbench/thread-state/reset" | "workbench/thread-state/updated"; params: unknown };

function isCodexJsonRpcResponse(message: unknown): message is CodexJsonRpcResponse<unknown> {
  return !!message && typeof message === "object" && "id" in message && ("result" in message || "error" in message);
}

export class CodexAppServerClient {
  private readonly notificationListeners = new Set<(
    notification: CodexAppServerNotification,
    handling: CodexAppServerNotificationHandling,
    harness: WorkbenchHarness,
  ) => void>();
  private readonly pendingResponses = new Map<number, PendingResponseHandler>();
  private readonly workbenchNotificationListeners = new Set<(notification: WorkbenchNotification) => void>();
  private readonly nextRequestId = createRequestIdGenerator();
  private connectPromise: Promise<void> | null = null;
  private socketPromise: Promise<void> | null = null;
  private initialized = false;
  private disposed = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private url = getCodexAppServerUrl();
  private socket: WebSocket | null = null;

  async connect(url = getCodexAppServerUrl()) {
    if (this.socket && this.socket.readyState === WebSocket.OPEN && this.initialized) {
      return;
    }

    if (this.connectPromise) {
      await this.connectPromise;
      return;
    }

    this.url = url;
    this.connectPromise = this.initializeProvider();
    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  async connectSocket(url = this.url) {
    if (this.disposed) throw new Error("Codex app-server client is disposed.");
    this.url = url;
    if (this.socket?.readyState === WebSocket.OPEN) return;
    if (this.socketPromise) return await this.socketPromise;
    this.socketPromise = this.openSocket(url);
    try { await this.socketPromise; } finally { this.socketPromise = null; }
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
      this.handleIncomingMessage(event.data);
    });

    socket.addEventListener("close", () => {
      for (const pending of this.pendingResponses.values()) {
        pending.reject(new Error("Codex app-server connection closed."));
      }
      this.pendingResponses.clear();
      this.initialized = false;
      if (this.socket === socket) this.socket = null;
      if (!this.disposed) this.scheduleReconnect();
    });

    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => {
        if (this.socket === socket) this.socket = null;
        socket.close();
        reject(new Error("Failed to connect to Codex app-server."));
      }, {
        once: true,
      });
    });

    this.reconnectAttempt = 0;
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
    this.socket?.close(code, reason);
  }

  dispose() {
    this.disposed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.socket?.close();
    for (const pending of this.pendingResponses.values()) pending.reject(new Error("Codex app-server client disposed."));
    this.pendingResponses.clear();
  }

  onWorkbenchNotification(listener: (notification: WorkbenchNotification) => void) {
    this.workbenchNotificationListeners.add(listener);
    return () => this.workbenchNotificationListeners.delete(listener);
  }

  onNotification(listener: (
    notification: CodexAppServerNotification,
    handling: CodexAppServerNotificationHandling,
    harness: WorkbenchHarness,
  ) => void) {
    this.notificationListeners.add(listener);
    return () => {
      this.notificationListeners.delete(listener);
    };
  }

  send(message: CodexClientRequest | CodexClientNotification) {
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
    if (workbenchMessage.method === "workbench/thread-state/updated" || workbenchMessage.method === "workbench/thread-state/reset") {
      for (const listener of this.workbenchNotificationListeners) listener(parsed as unknown as WorkbenchNotification);
      return;
    }

    if (isCodexAppServerNotification(parsed)) {
      const handling = classifyCodexAppServerNotification(parsed);
      const rawHarness = (parsed as CodexAppServerNotification & { workbenchHarness?: WorkbenchHarness }).workbenchHarness;
      const harness = rawHarness === "copilot" || rawHarness === "opencode" ? rawHarness : "codex";
      for (const listener of this.notificationListeners) {
        listener(parsed, handling, harness);
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
}
