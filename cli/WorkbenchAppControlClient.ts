/*
 * Exports:
 * - WorkbenchAppControlSnapshot: live app-control readiness, process identity and pushed reload/update summary.
 * - WorkbenchAppControlClientOptions: publication, transport and test seams.
 * - default WorkbenchAppControlClient: follow the private app publication and its runtime events, report its launch URL and admit Quit, reload-all and pull.
 */
import { watch, type FSWatcher } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { WorkbenchServiceEndpoint } from "../shared/http/workbench-service.ts";
import {
  WorkbenchAppControlLaunchUrlSchema, WorkbenchAppControlPullRequestSchema, WorkbenchAppControlRuntimeSchema,
  type WorkbenchAppControlRuntime,
} from "../shared/http/workbench-app-control.ts";
import { readServiceEndpoint, verifyServiceEndpoint } from "../shared/process/workbench-service-endpoint.ts";

export interface WorkbenchAppControlSnapshot {
  ready: boolean;
  instanceId: string | null;
  /** Pushed reload/update summary of the ready app; null until its first event. */
  runtime: WorkbenchAppControlRuntime | null;
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
  private value: WorkbenchAppControlSnapshot = { ready: false, instanceId: null, runtime: null };
  private stream: AbortController | null = null;

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

  /** The browser address for the app's chosen connection mode, or its loopback launcher while that is still resolving. */
  async launchUrl(): Promise<string> {
    const endpoint = await this.current();
    const fetcher = this.options.fetcher ?? fetch;
    const response = await fetcher(`${endpoint.origin}/_workbench-control/launch-url`, {
      headers: { Authorization: `Bearer ${endpoint.token}` },
      redirect: "error",
      signal: this.lifetime.signal,
    });
    if (!response.ok) {
      const detail = (await response.text()).trim().slice(0, 500);
      throw new Error(`App launch URL was rejected${detail ? `: ${detail}` : ` (HTTP ${response.status}).`}`);
    }
    const { url } = WorkbenchAppControlLaunchUrlSchema.parse(await response.json());
    return url ?? new URL("/launch", endpoint.origin).href;
  }

  async quit(): Promise<void> {
    await this.post(endpoint => `/_workbench-control/quit/${endpoint.instanceId}`, null, "App Quit");
  }

  /** Admit the app's reload-all sequence; progress arrives through the runtime stream. */
  async reloadAll(): Promise<void> {
    await this.post(() => "/_workbench-control/reload-all", null, "Reload all");
  }

  /** Admit a pull, optionally followed by reload-all; progress arrives through the runtime stream. */
  async pull(reload: boolean): Promise<void> {
    await this.post(() => "/_workbench-control/pull", WorkbenchAppControlPullRequestSchema.parse({ reload }), "Pull");
  }

  private async post(route: (endpoint: WorkbenchServiceEndpoint) => string, body: object | null, action: string) {
    const endpoint = await this.current();
    const fetcher = this.options.fetcher ?? fetch;
    const response = await fetcher(`${endpoint.origin}${route(endpoint)}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${endpoint.token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      redirect: "error",
      signal: this.lifetime.signal,
    });
    const detail = response.ok ? "" : (await response.text()).trim().slice(0, 500);
    if (response.ok) await response.body?.cancel();
    if (!response.ok) throw new Error(`${action} was rejected${detail ? `: ${detail}` : "."}`);
  }

  /** Follow one app instance's runtime events until it is replaced, gone or this client closes. */
  private follow(endpoint: WorkbenchServiceEndpoint) {
    this.stream?.abort();
    const stream = new AbortController();
    this.stream = stream;
    const signal = AbortSignal.any([stream.signal, this.lifetime.signal]);
    void (async () => {
      const fetcher = this.options.fetcher ?? fetch;
      const response = await fetcher(`${endpoint.origin}/_workbench-control/runtime/events`, {
        headers: { Authorization: `Bearer ${endpoint.token}`, Accept: "text/event-stream" },
        redirect: "error",
        signal,
      });
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new Error(`HTTP ${response.status}`);
      }
      const decoder = new TextDecoder();
      let buffered = "";
      for await (const bytes of response.body) {
        buffered += decoder.decode(bytes, { stream: true });
        let boundary = buffered.indexOf("\n\n");
        while (boundary >= 0) {
          const frame = buffered.slice(0, boundary);
          buffered = buffered.slice(boundary + 2);
          const data = frame.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
          if (data) this.acceptRuntime(endpoint.instanceId, WorkbenchAppControlRuntimeSchema.parse(JSON.parse(data)));
          boundary = buffered.indexOf("\n\n");
        }
      }
    })().catch(error => {
      if (signal.aborted) return;
      // An app exiting ends its stream; the publication watcher reports the app as gone.
      if (this.value.instanceId === endpoint.instanceId) {
        this.options.warn(`App runtime events stopped: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  }

  private acceptRuntime(instanceId: string, runtime: WorkbenchAppControlRuntime) {
    if (this.value.instanceId !== instanceId) return;
    this.value = { ...this.value, runtime };
    for (const listener of this.listeners) listener();
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.lifetime.abort(new Error("App control client closed."));
    this.stream = null;
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
      this.publish(endpoint);
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

  private publish(endpoint: WorkbenchServiceEndpoint | null) {
    const instanceId = endpoint?.instanceId ?? null;
    const ready = instanceId !== null;
    if (ready === this.value.ready && instanceId === this.value.instanceId) return;
    this.value = { ready, instanceId, runtime: null };
    if (endpoint) this.follow(endpoint);
    else {
      this.stream?.abort();
      this.stream = null;
    }
    for (const listener of this.listeners) listener();
  }

  private report(error: unknown) {
    this.options.warn(`App control observation failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
