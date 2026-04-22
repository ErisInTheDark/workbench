import { getCodexAppServerUrl } from "./config";
import type {
  CodexClientNotification,
  CodexClientRequest,
  CodexJsonRpcResponse,
  CodexServerEvent,
} from "./protocol";
import { createRequestIdGenerator } from "./protocol";

type PendingResponseHandler = {
  reject: (reason?: unknown) => void;
  resolve: (value: CodexJsonRpcResponse<unknown>) => void;
};

type CodexIncomingMessage = CodexJsonRpcResponse<unknown> | CodexServerEvent;

function isCodexServerEvent(message: unknown): message is CodexServerEvent {
  return !!message && typeof message === "object" && "type" in message;
}

function isCodexJsonRpcResponse(message: unknown): message is CodexJsonRpcResponse<unknown> {
  return !!message && typeof message === "object" && "id" in message && ("result" in message || "error" in message);
}

export class CodexAppServerClient {
  private readonly eventListeners = new Set<(event: CodexServerEvent) => void>();
  private readonly pendingResponses = new Map<number, PendingResponseHandler>();
  private readonly nextRequestId = createRequestIdGenerator();
  private socket: WebSocket | null = null;

  async connect(url = getCodexAppServerUrl()) {
    if (this.socket && this.socket.readyState <= WebSocket.OPEN) {
      return;
    }

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
      this.socket = null;
    });

    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("Failed to connect to Codex app-server.")), {
        once: true,
      });
    });
  }

  close(code?: number, reason?: string) {
    this.socket?.close(code, reason);
  }

  onEvent(listener: (event: CodexServerEvent) => void) {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
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

    if (isCodexServerEvent(parsed)) {
      for (const listener of this.eventListeners) {
        listener(parsed);
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
