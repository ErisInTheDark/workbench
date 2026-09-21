/*
 * Exports:
 * - WorkbenchLocalDaemonSnapshot: verified ready endpoint or bounded unavailable/failure state.
 * - default WorkbenchLocalDaemon: observe and verify the daemon's current process publication.
 */
import { watch } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { WorkbenchDaemonEndpointSchema, type WorkbenchDaemonEndpoint } from "workbench-shared/http/workbench-daemon-endpoint";
import { readDaemonEndpoint } from "workbench-shared/process/workbench-daemon-endpoint";

export type WorkbenchLocalDaemonSnapshot = {
  endpoint: WorkbenchDaemonEndpoint | null;
  failure: string | null;
};

export default class WorkbenchLocalDaemon {
  private snapshot: WorkbenchLocalDaemonSnapshot = { endpoint: null, failure: null };
  private readonly listeners = new Set<() => void>();
  private observation: (() => void) | null = null;
  private refreshTask: Promise<void> | null = null;
  private request: AbortController | null = null;
  private invalidated = false;
  private phase: "idle" | "active" | "failed" | "closed" = "idle";

  constructor(private readonly options: {
    endpointPath: string;
    warn: (message: string) => void;
    read?: () => Promise<WorkbenchDaemonEndpoint | null>;
    fetcher?: typeof fetch;
    observe?: (changed: () => void, failed: () => void) => () => void;
  }) {}

  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  async start() {
    if (this.phase !== "idle") throw new Error("Local daemon observation has already started or closed.");
    this.phase = "active";
    const changed = () => { void this.refresh(); };
    const failed = () => {
      if (this.phase === "closed" || this.phase === "failed") return;
      this.phase = "failed";
      this.request?.abort(new Error("Local daemon observation failed."));
      this.observation?.();
      this.observation = null;
      this.publish({ endpoint: null, failure: "Local daemon endpoint observation failed; reload networking to recover." });
    };
    try {
      if (this.options.observe) this.observation = this.options.observe(changed, failed);
      else {
        await fs.mkdir(path.dirname(this.options.endpointPath), { recursive: true });
        if (!this.active()) return;
        const watcher = watch(path.dirname(this.options.endpointPath), (_event, filename) => {
          if (!filename || filename.toString() === path.basename(this.options.endpointPath)) changed();
        });
        watcher.on("error", failed);
        this.observation = () => watcher.close();
      }
    } catch {
      failed();
      return;
    }
    void this.refresh();
  }

  refresh(): Promise<void> {
    if (!this.active()) return Promise.resolve();
    this.invalidated = true;
    this.request?.abort(new Error("Local daemon endpoint observation was superseded."));
    if (!this.refreshTask) {
      this.refreshTask = this.refreshUntilCurrent().finally(() => { this.refreshTask = null; });
    }
    return this.refreshTask;
  }

  private async refreshUntilCurrent() {
    while (this.invalidated && this.active()) {
      this.invalidated = false;
      const request = new AbortController();
      this.request = request;
      try {
        const endpoint = await (this.options.read?.() ?? readDaemonEndpoint(this.options.endpointPath));
        request.signal.throwIfAborted();
        const previous = this.snapshot.endpoint;
        if (previous && (previous.instanceId !== endpoint?.instanceId
          || previous.origin !== endpoint?.origin || previous.pid !== endpoint?.pid)) {
          this.publish({ endpoint: null, failure: null });
        }
        if (endpoint) await this.verify(endpoint, request.signal);
        if (this.active() && !this.invalidated) this.publish({ endpoint, failure: null });
      } catch {
        if (!request.signal.aborted && this.active()) {
          this.publish({ endpoint: null, failure: "Published local daemon endpoint could not be verified." });
        }
      } finally {
        if (this.request === request) this.request = null;
      }
    }
  }

  private async verify(endpoint: WorkbenchDaemonEndpoint, signal: AbortSignal) {
    const response = await (this.options.fetcher ?? fetch)(`${endpoint.origin}/healthz`, {
      cache: "no-store", redirect: "error", signal,
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error("Daemon health endpoint is unavailable.");
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > 16_384) {
          await reader.cancel();
          throw new Error("Daemon health response exceeds its size limit.");
        }
        chunks.push(next.value);
      }
    } finally { reader.releaseLock(); }
    const actual = WorkbenchDaemonEndpointSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    if (actual.instanceId !== endpoint.instanceId || actual.pid !== endpoint.pid || actual.origin !== endpoint.origin) {
      throw new Error("Daemon health identity does not match its publication.");
    }
  }

  private publish(snapshot: WorkbenchLocalDaemonSnapshot) {
    if (this.phase === "closed") return;
    if (snapshot.failure && snapshot.failure !== this.snapshot.failure) this.options.warn(snapshot.failure);
    const previous = this.snapshot;
    if (previous.failure === snapshot.failure
      && previous.endpoint?.instanceId === snapshot.endpoint?.instanceId
      && previous.endpoint?.origin === snapshot.endpoint?.origin
      && previous.endpoint?.pid === snapshot.endpoint?.pid) return;
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }

  async close() {
    this.phase = "closed";
    this.observation?.();
    this.observation = null;
    this.request?.abort(new Error("Local daemon observation closed."));
    await this.refreshTask;
    this.listeners.clear();
  }

  private active() { return this.phase === "active"; }
}
