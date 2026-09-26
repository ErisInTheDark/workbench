/*
 * Exports:
 * - default WorkbenchRpcSocketClient: own browser WebSocket connection, reconnect and pending RPC lifetimes.
 */
import { createWorkbenchRequestIdGenerator, type WorkbenchRpcResponse } from "./workbench-rpc.ts";

type Pending = {
  resolve(value: WorkbenchRpcResponse<unknown>): void;
  reject(reason: Error): void;
};

export default class WorkbenchRpcSocketClient {
  private socket: WebSocket | null = null;
  private opening: Promise<void> | null = null;
  private readonly pending = new Map<number, Pending>();
  private readonly nextId = createWorkbenchRequestIdGenerator();
  private readonly messages = new Set<(message: unknown) => void>();
  private readonly opened = new Set<(reconnected: boolean) => void>();
  private readonly closed = new Set<() => void>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private generation = 0;
  private hasOpened = false;
  private disposed = false;
  private suspended = false;
  private explicitUrl: string | null = null;

  constructor(
    private readonly resolveUrl: () => Promise<string>,
    private readonly label = "Workbench",
    private readonly createSocket: (url: string) => WebSocket = url => new WebSocket(url),
  ) {}

  get isOpen() { return this.socket?.readyState === WebSocket.OPEN; }

  onMessage(listener: (message: unknown) => void) {
    this.messages.add(listener);
    return () => this.messages.delete(listener);
  }

  onOpen(listener: (reconnected: boolean) => void) {
    this.opened.add(listener);
    return () => this.opened.delete(listener);
  }

  onClose(listener: () => void) {
    this.closed.add(listener);
    return () => this.closed.delete(listener);
  }

  async connect(url?: string) {
    if (this.disposed) throw new Error(`${this.label} socket client is disposed.`);
    if (this.suspended) throw new Error("Workbench app is unavailable.");
    if (url !== undefined) this.explicitUrl = url;
    if (this.socket?.readyState === WebSocket.OPEN) return;
    if (this.opening) return await this.opening;
    const opening = this.open();
    this.opening = opening;
    try {
      await opening;
    } catch (error) {
      if (!this.disposed && !this.suspended && this.opening === opening) this.scheduleReconnect();
      throw error;
    } finally {
      if (this.opening === opening) this.opening = null;
    }
  }

  private async open() {
    const generation = this.generation;
    const url = this.explicitUrl ?? await this.resolveUrl();
    if (this.disposed || this.suspended || generation !== this.generation) {
      throw new Error(`${this.label} connection was suspended.`);
    }
    const socket = this.createSocket(url);
    this.socket = socket;
    socket.addEventListener("message", event => {
      if (this.socket !== socket) return;
      if (typeof event.data !== "string") {
        console.error(`${this.label} socket rejected a non-text message.`);
        return;
      }
      let value: unknown;
      try {
        value = JSON.parse(event.data);
      } catch {
        console.error(`${this.label} socket rejected malformed JSON.`);
        return;
      }
      if (value && typeof value === "object" && "id" in value
        && typeof value.id === "number" && ("result" in value || "error" in value)) {
        const pending = this.pending.get(value.id);
        if (pending) {
          this.pending.delete(value.id);
          pending.resolve(value as WorkbenchRpcResponse<unknown>);
        }
      }
      for (const listener of this.messages) listener(value);
    });
    socket.addEventListener("close", () => {
      if (!this.retire(socket, new Error(`${this.label} connection closed.`))) return;
      if (!this.disposed) this.scheduleReconnect();
    });
    await new Promise<void>((resolve, reject) => {
      let ready = false;
      socket.addEventListener("open", () => { ready = true; resolve(); }, { once: true });
      socket.addEventListener("error", () => {
        if (ready) return;
        if (this.socket === socket) this.socket = null;
        socket.close();
        reject(new Error(`Failed to connect to ${this.label}.`));
      }, { once: true });
      socket.addEventListener("close", () => {
        if (!ready) reject(new Error(`Failed to connect to ${this.label}.`));
      }, { once: true });
    });
    if (this.socket !== socket) throw new Error(`${this.label} connection was replaced before opening.`);
    const reconnected = this.hasOpened;
    this.hasOpened = true;
    this.reconnectAttempt = 0;
    for (const listener of this.opened) listener(reconnected);
  }

  private scheduleReconnect() {
    if (this.reconnectTimer || this.disposed || this.suspended) return;
    const delay = Math.min(30_000, 250 * 2 ** Math.min(this.reconnectAttempt++, 7));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect().catch(() => this.scheduleReconnect());
    }, delay);
  }

  setSuspended(suspended: boolean) {
    if (this.disposed || this.suspended === suspended) return;
    this.suspended = suspended;
    if (!suspended) {
      void this.connect().catch(() => this.scheduleReconnect());
      return;
    }
    this.generation++;
    this.opening = null;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const socket = this.socket;
    if (socket) {
      this.retire(socket, new Error("Workbench app is unavailable."));
      socket.close();
    }
  }

  send(message: object) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error(`${this.label} socket is not connected.`);
    }
    this.socket.send(JSON.stringify(message));
  }

  async sendRequest<TResponse>(
    message: { id?: number; method: string; params?: unknown } & Record<string, unknown>,
  ): Promise<WorkbenchRpcResponse<TResponse>> {
    if (this.socket?.readyState !== WebSocket.OPEN) await this.connect();
    const id = message.id ?? this.nextId();
    const response = new Promise<WorkbenchRpcResponse<TResponse>>((resolve, reject) => {
      this.pending.set(id, {
        resolve: value => resolve(value as WorkbenchRpcResponse<TResponse>),
        reject,
      });
    });
    try { this.send({ ...message, id }); }
    catch (error) {
      this.pending.delete(id);
      throw error;
    }
    return response;
  }

  close(code?: number, reason?: string) {
    this.shutdown("closed", code, reason);
  }

  dispose() {
    this.shutdown("disposed");
  }

  private shutdown(state: "closed" | "disposed", code?: number, reason?: string) {
    if (this.disposed) return;
    this.disposed = true;
    this.generation++;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const socket = this.socket;
    if (socket) {
      this.retire(socket, new Error(`${this.label} socket client ${state}.`));
      socket.close(code, reason);
    } else this.rejectPending(new Error(`${this.label} socket client ${state}.`));
    this.messages.clear();
    this.opened.clear();
    this.closed.clear();
  }

  private retire(socket: WebSocket, error: Error) {
    if (this.socket !== socket) return false;
    this.socket = null;
    this.rejectPending(error);
    for (const listener of this.closed) listener();
    return true;
  }

  private rejectPending(error: Error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}
