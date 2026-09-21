/*
 * Exports:
 * - ServiceControlSocket/WorkbenchServiceClientOptions: private transport and observation boundaries.
 * - WorkbenchServiceIntent: named control request before correlation assignment.
 * - WorkbenchServiceClient (default): owns one private control session and its pending requests.
 */
import { randomUUID } from "node:crypto";
import { watch } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  WorkbenchServiceResponseSchema,
  type WorkbenchServiceEndpoint, type WorkbenchServiceRequest,
  type WorkbenchServiceResponse, type WorkbenchServiceSnapshot,
} from "../http/workbench-service.ts";
import { readServiceEndpoint, verifyServiceEndpoint } from "./workbench-service-endpoint.ts";

export interface ServiceControlSocket extends EventTarget {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
}
export interface WorkbenchServiceClientOptions {
  endpointPath: string;
  warn(message: string): void;
  read?: () => Promise<WorkbenchServiceEndpoint | null>;
  verify?: (endpoint: WorkbenchServiceEndpoint, signal: AbortSignal) => Promise<void>;
  createSocket?: (endpoint: WorkbenchServiceEndpoint) => ServiceControlSocket;
  observe?: (changed: () => void, failed: (error: Error) => void) => () => void;
}
export type WorkbenchServiceIntent = {
  [Method in WorkbenchServiceRequest["method"]]: Omit<Extract<WorkbenchServiceRequest, { method: Method }>, "id">;
}[WorkbenchServiceRequest["method"]];
type Reply = Exclude<WorkbenchServiceResponse, { kind: "snapshot" }>;
type Pending = { resolve(value: Reply): void; reject(error: Error): void; detach(): void };

export default class WorkbenchServiceClient {
  private phase: "idle" | "connecting" | "ready" | "failed" | "closed" = "idle";
  private socket: ServiceControlSocket | null = null;
  private detachSocket: ((error: Error) => void) | null = null;
  private endpointId: string | null = null;
  private observation: (() => void) | null = null;
  private refreshTask: Promise<void> | null = null;
  private refreshAbort: AbortController | null = null;
  private invalidated = false;
  private readonly pending = new Map<string, Pending>();
  private readonly listeners = new Set<() => void>();
  private current: WorkbenchServiceSnapshot | null = null;
  private failure: string | null = null;

  constructor(private readonly options: WorkbenchServiceClientOptions) {}

  getSnapshot = () => ({ phase: this.phase, snapshot: this.current, failure: this.failure });
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  async start() {
    if (this.phase !== "idle") throw new Error("Service client has already started.");
    this.phase = "connecting";
    const changed = () => { void this.reconnect().catch(error => this.report(error)); };
    const failed = (error: Error) => {
      this.observation?.();
      this.observation = null;
      this.refreshAbort?.abort(error);
      this.disconnect(error);
      this.report(error);
    };
    if (this.options.observe) this.observation = this.options.observe(changed, failed);
    else {
      await fs.mkdir(path.dirname(this.options.endpointPath), { recursive: true });
      const watcher = watch(path.dirname(this.options.endpointPath), (_event, file) => {
        if (!file || file.toString() === path.basename(this.options.endpointPath)) changed();
      });
      watcher.on("error", failed);
      this.observation = () => watcher.close();
    }
    await this.reconnect();
  }

  reconnect() {
    if (this.phase === "closed") return Promise.reject(new Error("Service client is closed."));
    this.invalidated = true;
    this.refreshAbort?.abort(new Error("Service endpoint observation was superseded."));
    if (!this.refreshTask) {
      this.refreshTask = this.refresh().finally(() => { this.refreshTask = null; });
    }
    return this.refreshTask;
  }

  private async refresh() {
    while (this.invalidated && this.phase !== "closed") {
      this.invalidated = false;
      const abort = new AbortController();
      this.refreshAbort = abort;
      try {
        const endpoint = await (this.options.read?.() ?? readServiceEndpoint(this.options.endpointPath));
        abort.signal.throwIfAborted();
        if (!endpoint) throw new Error("The Workbench service has no published endpoint.");
        await (this.options.verify ?? verifyServiceEndpoint)(endpoint, abort.signal);
        abort.signal.throwIfAborted();
        if (this.endpointId === endpoint.instanceId && this.socket?.readyState === 1 && this.phase === "ready") continue;
        this.disconnect(new Error("Service connection was replaced."));
        this.phase = "connecting";
        this.endpointId = endpoint.instanceId;
        await this.connect(endpoint, abort.signal);
      } catch (error) {
        if (abort.signal.aborted && this.invalidated) continue;
        if (this.getSnapshot().phase !== "closed") this.report(error);
        throw error;
      } finally {
        if (this.refreshAbort === abort) this.refreshAbort = null;
      }
    }
  }

  private connect(endpoint: WorkbenchServiceEndpoint, signal: AbortSignal) {
    const socket = this.options.createSocket?.(endpoint)
      ?? new WebSocket(`${endpoint.origin.replace("http:", "ws:")}/control`, ["workbench-service", endpoint.token]);
    this.socket = socket;
    return new Promise<void>((resolve, reject) => {
      const failed = (error: Error) => {
        if (this.socket !== socket) return;
        this.disconnect(error);
        if (this.phase !== "closed") this.report(error);
        reject(error);
      };
      const abort = () => failed(signal.reason instanceof Error ? signal.reason : new Error("Service connection cancelled."));
      const closed = () => failed(new Error("Service connection closed; pending requests were not replayed."));
      const socketError = () => failed(new Error("Service control connection failed."));
      const message = (event: Event) => {
        const data = (event as MessageEvent).data;
        if (typeof data !== "string" || Buffer.byteLength(data) > 8_388_608) {
          failed(new Error("Service response exceeded the text message boundary."));
          return;
        }
        let response: WorkbenchServiceResponse;
        try { response = WorkbenchServiceResponseSchema.parse(JSON.parse(data)); }
        catch { failed(new Error("Service returned an invalid control response.")); return; }
        if (response.kind === "snapshot") {
          this.current = response.snapshot;
          this.failure = null;
          this.phase = "ready";
          this.publish();
          resolve();
          return;
        }
        const pending = this.pending.get(response.id);
        if (!pending) return; // A cancelled request may complete after its caller detached.
        this.pending.delete(response.id);
        pending.detach();
        if (response.kind === "error") pending.reject(new Error(response.message));
        else pending.resolve(response);
      };
      socket.addEventListener("message", message);
      socket.addEventListener("close", closed);
      socket.addEventListener("error", socketError);
      signal.addEventListener("abort", abort, { once: true });
      this.detachSocket = error => {
        socket.removeEventListener("message", message);
        socket.removeEventListener("close", closed);
        socket.removeEventListener("error", socketError);
        signal.removeEventListener("abort", abort);
        reject(error);
      };
      if (signal.aborted) abort();
    });
  }

  request(intent: WorkbenchServiceIntent, signal?: AbortSignal): Promise<Reply> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    const socket = this.socket;
    if (this.phase !== "ready" || !socket || socket.readyState !== 1) {
      return Promise.reject(new Error("Service connection is not ready."));
    }
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.pending.delete(id);
        signal?.removeEventListener("abort", abort);
        reject(signal?.reason);
        if (this.socket === socket && socket.readyState === 1) {
          try { socket.send(JSON.stringify({ id: randomUUID(), method: "service/request/cancel", requestId: id })); }
          catch (error) { this.report(error); }
        }
      };
      this.pending.set(id, { resolve, reject, detach: () => signal?.removeEventListener("abort", abort) });
      signal?.addEventListener("abort", abort, { once: true });
      try { socket.send(JSON.stringify({ ...intent, id })); }
      catch (error) {
        this.pending.delete(id);
        signal?.removeEventListener("abort", abort);
        reject(error);
      }
    });
  }

  async close() {
    if (this.phase === "closed") return;
    this.phase = "closed";
    this.observation?.();
    this.observation = null;
    this.invalidated = false;
    const cancellation = new Error("Service client closed.");
    this.refreshAbort?.abort(cancellation);
    this.disconnect(cancellation);
    // Await owned verification work; its cancellation is the expected close path.
    if (this.refreshTask) {
      try { await this.refreshTask; }
      catch (error) { if (error !== cancellation) throw error; }
    }
    this.listeners.clear();
  }

  private disconnect(error: Error) {
    const socket = this.socket;
    this.socket = null;
    this.endpointId = null;
    this.detachSocket?.(error);
    this.detachSocket = null;
    socket?.close();
    for (const pending of this.pending.values()) { pending.detach(); pending.reject(error); }
    this.pending.clear();
  }

  private report(error: unknown) {
    if (this.phase === "closed") return;
    this.phase = "failed";
    this.failure = (error instanceof Error ? error.message : String(error)).replace(/[\r\n]/gu, " ").slice(0, 512);
    this.options.warn(this.failure);
    this.publish();
  }

  private publish() { for (const listener of this.listeners) listener(); }
}
