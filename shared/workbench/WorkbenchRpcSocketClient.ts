/*
 * Exports:
 * - WorkbenchRpcSocketSnapshot: current connection health, generation and bounded failure.
 * - WorkbenchRpcRequestInterruptedError: distinguish requests never dispatched from uncertain delivery.
 * - default WorkbenchRpcSocketClient: own connection, reconnect, cancellation and pending RPC lifetimes.
 */
import { createWorkbenchRequestIdGenerator, type WorkbenchRpcResponse } from "./workbench-rpc.ts";

type Pending = {
  dispatched: boolean;
  resolve(value: WorkbenchRpcResponse<unknown>): void;
  reject(reason: Error): void;
};

export interface WorkbenchRpcSocketSnapshot {
  phase: "idle" | "connecting" | "current" | "reconnecting" | "suspended" | "closed";
  generation: number;
  failure: string | null;
}

export class WorkbenchRpcRequestInterruptedError extends Error {
  constructor(message: string, readonly dispatched: boolean) {
    super(message);
    this.name = "WorkbenchRpcRequestInterruptedError";
  }
}

function boundedFailure(error: unknown) {
  return (error instanceof Error ? error.message : "Connection failed.")
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, "").slice(0, 512);
}

export default class WorkbenchRpcSocketClient {
  private socket: WebSocket | null = null;
  private opening: Promise<void> | null = null;
  private openingCancellation: AbortController | null = null;
  private readonly pending = new Map<number, Pending>();
  private readonly nextId = createWorkbenchRequestIdGenerator();
  private readonly messages = new Set<(message: unknown) => void>();
  private readonly opened = new Set<(reconnected: boolean) => void>();
  private readonly closed = new Set<() => void>();
  private readonly observers = new Set<() => void>();
  private snapshot: WorkbenchRpcSocketSnapshot = { phase: "idle", generation: 0, failure: null };
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private generation = 0;
  private hasOpened = false;
  private disposed = false;
  private suspended = false;
  private explicitUrl: string | null = null;

  constructor(
    private readonly resolveUrl: (signal: AbortSignal) => Promise<string>,
    private readonly label = "Workbench",
    private readonly createSocket: (url: string) => WebSocket = url => new WebSocket(url),
  ) {}

  get isOpen() { return this.socket?.readyState === 1; }
  get url() { return this.socket?.url ?? null; }
  get pendingRequests() { return this.pending.size; }
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.observers.add(listener);
    return () => { this.observers.delete(listener); };
  };

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
    if (this.suspended) throw new Error(`${this.label} connection is suspended.`);
    if (url !== undefined) this.explicitUrl = url;
    if (this.isOpen) return;
    if (this.opening) return await this.opening;
    const opening = Promise.resolve().then(() => this.open());
    this.opening = opening;
    try {
      await opening;
    } catch (error) {
      if (!this.disposed && !this.suspended && this.opening === opening) {
        this.publish("reconnecting", boundedFailure(error));
        this.scheduleReconnect();
      }
      throw error;
    } finally {
      if (this.opening === opening) this.opening = null;
    }
  }

  private async open() {
    const generation = ++this.generation;
    const cancellation = new AbortController();
    this.openingCancellation = cancellation;
    this.publish("connecting", this.snapshot.failure);
    const url = this.explicitUrl ?? await this.resolveUrl(cancellation.signal);
    cancellation.signal.throwIfAborted();
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
      for (const listener of this.messages) this.deliver(() => listener(value));
    });
    socket.addEventListener("close", () => {
      if (!this.retire(socket, new Error(`${this.label} connection closed.`))) return;
      if (!this.disposed && !this.suspended) {
        this.publish("reconnecting", `${this.label} connection closed.`);
        this.scheduleReconnect();
      }
    });
    socket.addEventListener("error", () => {
      if (!this.retire(socket, new Error(`${this.label} socket failed.`))) return;
      socket.close();
      if (!this.disposed && !this.suspended) {
        this.publish("reconnecting", `${this.label} socket failed.`);
        this.scheduleReconnect();
      }
    });
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        socket.removeEventListener("open", opened);
        socket.removeEventListener("error", failed);
        socket.removeEventListener("close", failed);
        cancellation.signal.removeEventListener("abort", cancelled);
      };
      const opened = () => { cleanup(); resolve(); };
      const failed = () => {
        cleanup();
        if (this.retire(socket, new Error(`Failed to connect to ${this.label}.`))) socket.close();
        reject(new Error(`Failed to connect to ${this.label}.`));
      };
      const cancelled = () => {
        cleanup();
        if (this.retire(socket, new Error(`${this.label} connection cancelled.`))) socket.close();
        reject(cancellation.signal.reason);
      };
      socket.addEventListener("open", opened, { once: true });
      socket.addEventListener("error", failed, { once: true });
      socket.addEventListener("close", failed, { once: true });
      cancellation.signal.addEventListener("abort", cancelled, { once: true });
      if (cancellation.signal.aborted) cancelled();
    });
    if (this.socket !== socket) throw new Error(`${this.label} connection was replaced before opening.`);
    const reconnected = this.hasOpened || this.reconnectAttempt > 0;
    this.hasOpened = true;
    this.reconnectAttempt = 0;
    this.publish("current", null);
    for (const listener of this.opened) this.deliver(() => listener(reconnected));
  }

  private scheduleReconnect() {
    if (this.reconnectTimer || this.disposed || this.suspended) return;
    const delay = Math.min(30_000, 250 * 2 ** Math.min(this.reconnectAttempt++, 7));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnect();
    }, delay);
  }

  private reconnect() {
    void this.connect().catch(error => {
      if (!this.disposed && !this.suspended) this.publish("reconnecting", boundedFailure(error));
    });
  }

  setSuspended(suspended: boolean) {
    if (this.disposed || this.suspended === suspended) return;
    this.suspended = suspended;
    if (!suspended) {
      this.reconnect();
      return;
    }
    this.generation++;
    this.openingCancellation?.abort(new Error(`${this.label} connection suspended.`));
    this.opening = null;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const socket = this.socket;
    if (socket) {
      this.retire(socket, new Error(`${this.label} connection suspended.`));
      socket.close();
    }
    this.publish("suspended", null);
  }

  send(message: object) {
    if (!this.socket || !this.isOpen) {
      throw new Error(`${this.label} socket is not connected.`);
    }
    this.socket.send(JSON.stringify(message));
  }

  async sendRequest<TResponse>(
    message: { id?: number; method: string; params?: unknown } & Record<string, unknown>,
    options: { requireOpen?: boolean; signal?: AbortSignal } = {},
  ): Promise<WorkbenchRpcResponse<TResponse>> {
    const signal = options.signal;
    if (signal?.aborted) throw new WorkbenchRpcRequestInterruptedError("Request was cancelled before dispatch.", false);
    if (!this.isOpen) {
      if (options.requireOpen) {
        throw new WorkbenchRpcRequestInterruptedError(`${this.label} is not connected; request was not sent.`, false);
      }
      try {
        const connection = this.connect();
        if (!signal) await connection;
        else await new Promise<void>((resolve, reject) => {
          const cancelled = () => { reject(new WorkbenchRpcRequestInterruptedError("Request was cancelled before dispatch.", false)); };
          signal.addEventListener("abort", cancelled, { once: true });
          void connection.then(() => {
            signal.removeEventListener("abort", cancelled);
            resolve();
          }, error => {
            signal.removeEventListener("abort", cancelled);
            reject(error);
          });
          if (signal.aborted) cancelled();
        });
      }
      catch (error) { throw new WorkbenchRpcRequestInterruptedError(boundedFailure(error), false); }
    }
    if (signal?.aborted) throw new WorkbenchRpcRequestInterruptedError("Request was cancelled before dispatch.", false);
    const id = message.id ?? this.nextId();
    if (this.pending.has(id)) throw new Error(`${this.label} request identity is already pending.`);
    return new Promise<WorkbenchRpcResponse<TResponse>>((resolve, reject) => {
      const cancelled = () => {
        if (!this.pending.delete(id)) return;
        pending.reject(new WorkbenchRpcRequestInterruptedError("Request was cancelled.", pending.dispatched));
      };
      const cleanup = () => signal?.removeEventListener("abort", cancelled);
      const pending: Pending = {
        dispatched: false,
        resolve: value => { cleanup(); resolve(value as WorkbenchRpcResponse<TResponse>); },
        reject: error => { cleanup(); reject(error); },
      };
      this.pending.set(id, pending);
      signal?.addEventListener("abort", cancelled, { once: true });
      try {
        pending.dispatched = true;
        this.send({ ...message, id });
      } catch (error) {
        this.pending.delete(id);
        pending.reject(new WorkbenchRpcRequestInterruptedError(boundedFailure(error), false));
      }
    });
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
    this.openingCancellation?.abort(new Error(`${this.label} socket client ${state}.`));
    this.openingCancellation = null;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const socket = this.socket;
    if (socket) {
      this.retire(socket, new Error(`${this.label} socket client ${state}.`));
      socket.close(code, reason);
    } else this.rejectPending(new Error(`${this.label} socket client ${state}.`));
    this.publish("closed", null);
    this.messages.clear();
    this.opened.clear();
    this.closed.clear();
    this.observers.clear();
  }

  private retire(socket: WebSocket, error: Error) {
    if (this.socket !== socket) return false;
    this.socket = null;
    this.rejectPending(error);
    for (const listener of this.closed) this.deliver(listener);
    return true;
  }

  private rejectPending(error: Error) {
    for (const pending of this.pending.values()) {
      pending.reject(new WorkbenchRpcRequestInterruptedError(error.message, pending.dispatched));
    }
    this.pending.clear();
  }

  private publish(phase: WorkbenchRpcSocketSnapshot["phase"], failure: string | null) {
    if (this.snapshot.phase === phase && this.snapshot.generation === this.generation
      && this.snapshot.failure === failure) return;
    this.snapshot = { phase, generation: this.generation, failure };
    for (const listener of this.observers) this.deliver(listener);
  }

  private deliver(listener: () => void) {
    try { listener(); }
    catch (error) { console.error(`${this.label} connection observer failed: ${boundedFailure(error)}`); }
  }
}
