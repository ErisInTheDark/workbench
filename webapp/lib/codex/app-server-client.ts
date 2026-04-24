/*
 * Exports:
 * - CodexAppServerClient: persistent typed WebSocket client for the local stdio bridge and app-server notifications. Keywords: codex, websocket, stdio, notifications.
 */
import { getCodexAppServerUrl } from "./config";
import type {
  CodexAppServerNotification,
  CodexAppServerNotificationHandling,
} from "./app-server-notifications";
import {
  classifyCodexAppServerNotification,
  isCodexAppServerNotification,
} from "./app-server-notifications";
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

function isCodexJsonRpcResponse(message: unknown): message is CodexJsonRpcResponse<unknown> {
  return !!message && typeof message === "object" && "id" in message && ("result" in message || "error" in message);
}

export class CodexAppServerClient {
  private readonly notificationListeners = new Set<(
    notification: CodexAppServerNotification,
    handling: CodexAppServerNotificationHandling,
  ) => void>();
  private readonly pendingResponses = new Map<number, PendingResponseHandler>();
  private readonly nextRequestId = createRequestIdGenerator();
  private connectPromise: Promise<void> | null = null;
  private initialized = false;
  private socket: WebSocket | null = null;

  async connect(url = getCodexAppServerUrl()) {
    if (this.socket && this.socket.readyState === WebSocket.OPEN && this.initialized) {
      return;
    }

    if (this.connectPromise) {
      await this.connectPromise;
      return;
    }

    this.connectPromise = this.openAndInitialize(url);
    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  private async openAndInitialize(url: string) {
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
      this.socket = null;
    });

    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("Failed to connect to Codex app-server.")), {
        once: true,
      });
    });

    const initializeRequest = createInitializeRequest(0, {
      capabilities: createInitializeCapabilities({
        experimentalApi: true,
      }),
    });
    const response = await this.sendRequest<CodexInitializeResponse>({
      method: initializeRequest.method,
      id: 0,
      params: initializeRequest.params,
    });

    if (isCodexJsonRpcFailure(response)) {
      throw new Error(response.error.message);
    }

    this.send(createInitializedNotification());
    this.initialized = true;
  }

  close(code?: number, reason?: string) {
    this.socket?.close(code, reason);
  }

  onNotification(listener: (
    notification: CodexAppServerNotification,
    handling: CodexAppServerNotificationHandling,
  ) => void) {
    this.notificationListeners.add(listener);
    return () => {
      this.notificationListeners.delete(listener);
    };
  }

  onEvent(listener: (
    notification: CodexAppServerNotification,
    handling: CodexAppServerNotificationHandling,
  ) => void) {
    return this.onNotification(listener);
  }

  send(message: CodexClientRequest | CodexClientNotification) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("Codex app-server socket is not connected.");
    }

    this.socket.send(JSON.stringify(message));
  }

  async sendRequest<TResponse = unknown>(
    message: Omit<CodexClientRequest, "id"> & { id?: number },
  ): Promise<CodexJsonRpcResponse<TResponse>> {
    const requestId = message.id ?? this.nextRequestId();
    const request = {
      ...message,
      id: requestId,
    } as CodexClientRequest;

    const responsePromise = new Promise<CodexJsonRpcResponse<TResponse>>((resolve, reject) => {
      this.pendingResponses.set(requestId, {
        resolve: (value) => resolve(value as CodexJsonRpcResponse<TResponse>),
        reject,
      });
    });

    this.send(request);
    return responsePromise;
  }

  private handleIncomingMessage(payload: string | ArrayBufferLike | Blob | ArrayBufferView) {
    if (typeof payload !== "string") {
      return;
    }

    const parsed = JSON.parse(payload) as CodexIncomingMessage;

    if (isCodexAppServerNotification(parsed)) {
      const handling = classifyCodexAppServerNotification(parsed);
      for (const listener of this.notificationListeners) {
        listener(parsed, handling);
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
