/*
 * Exports:
 * - WorkbenchAppControlSnapshot: live app-control readiness and process identity.
 * - WorkbenchAppControlClientOptions: publication, transport and test seams.
 * - default WorkbenchAppControlClient: follow the private app publication, report its verified origin and admit process-bound Quit.
 */
import { watch, type FSWatcher } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { WorkbenchServiceEndpoint } from "../shared/http/workbench-service.ts";
import { readServiceEndpoint, verifyServiceEndpoint } from "../shared/process/workbench-service-endpoint.ts";

export interface WorkbenchAppControlSnapshot {
  ready: boolean;
  instanceId: string | null;
}

export interface WorkbenchAppControlClientOptions {
  endpointPath: string;
  warn(message: string): void;
  read?: () => Promise<WorkbenchServiceEndpoint | null>;
  verify?: (endpoint: WorkbenchServiceEndpoint, signal: AbortSignal) => Promise<void>;
  fetcher?: typeof fetch;
  observe?: (changed: () => void, failed: (error: Error) => void) => () => void;
}

export default class WorkbenchAppControlClient {
  private readonly lifetime = new AbortController();
  private readonly listeners = new Set<() => void>();
  private watcher: FSWatcher | null = null;
  private stopObserving: (() => void) | null = null;
  private queue: Promise<void> = Promise.resolve();
  private started = false;
  private closed = false;
  private value: WorkbenchAppControlSnapshot = { ready: false, instanceId: null };

  constructor(private readonly options: WorkbenchAppControlClientOptions) {}

  getSnapshot = (): WorkbenchAppControlSnapshot => this.value;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  async start() {
    if (this.started || this.closed) throw new Error("App control client has already started or closed.");
    this.started = true;
    if (this.options.observe) {
      this.stopObserving = this.options.observe(() => { void this.refresh(); }, error => this.report(error));
    } else {
      // The app directory may not exist yet when the view starts before any process.
      await fs.mkdir(path.dirname(this.options.endpointPath), { recursive: true });
      this.watcher = watch(path.dirname(this.options.endpointPath), (_event, file) => {
        if (file && file.toString() !== path.basename(this.options.endpointPath)) return;
        void this.refresh();
      });
      this.watcher.on("error", error => this.report(error));
      this.stopObserving = () => { this.watcher?.close(); };
    }
    await this.refresh();
  }

  refresh(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.queue = this.queue
      .then(() => this.read())
      .catch(error => { if (!this.closed) this.report(error); });
    return this.queue;
  }

  /** The live app's verified browser origin. */
  async origin(): Promise<string> {
    return (await this.current()).origin;
  }

  async quit(): Promise<void> {
    const endpoint = await this.current();
    const fetcher = this.options.fetcher ?? fetch;
    const response = await fetcher(`${endpoint.origin}/_workbench-control/quit/${endpoint.instanceId}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${endpoint.token}` },
      redirect: "error",
      signal: this.lifetime.signal,
    });
    await response.body?.cancel();
    if (!response.ok) throw new Error("App Quit was rejected.");
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.lifetime.abort(new Error("App control client closed."));
    this.stopObserving?.();
    this.stopObserving = null;
    this.watcher = null;
    this.listeners.clear();
    await this.queue;
  }

  private async read() {
    if (this.closed) return;
    const endpoint = await (this.options.read ?? (() => readServiceEndpoint(this.options.endpointPath)))();
    if (!endpoint) {
      this.publish(null);
      return;
    }
    try {
      await this.verify(endpoint);
      this.publish(endpoint.instanceId);
    } catch (error) {
      const wasReady = this.value.ready;
      this.publish(null);
      if (wasReady && !this.closed) {
        this.options.warn(`Viewed app is no longer reachable: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private verify(endpoint: WorkbenchServiceEndpoint) {
    if (this.options.verify) return this.options.verify(endpoint, this.lifetime.signal);
    const fetcher = this.options.fetcher ?? fetch;
    return verifyServiceEndpoint(endpoint, this.lifetime.signal, (_input, init) =>
      fetcher(`${endpoint.origin}/_workbench-control/health`, init));
  }

  private async current(): Promise<WorkbenchServiceEndpoint> {
    const endpoint = await (this.options.read ?? (() => readServiceEndpoint(this.options.endpointPath)))();
    if (!endpoint) throw new Error("The Workbench app is not running.");
    await this.verify(endpoint);
    return endpoint;
  }

  private publish(instanceId: string | null) {
    const ready = instanceId !== null;
    if (ready === this.value.ready && instanceId === this.value.instanceId) return;
    this.value = { ready, instanceId };
    for (const listener of this.listeners) listener();
  }

  private report(error: unknown) {
    this.options.warn(`App control observation failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
