/*
 * Exports:
 * - default WorkbenchDaemonListener: own the local random listener, singleton lease and ready endpoint publication.
 */
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import WorkbenchProcessLease from "../../shared/process/WorkbenchProcessLease.ts";
import { publishDaemonEndpoint, removeDaemonEndpoint } from "../../shared/process/workbench-daemon-endpoint.ts";
import type { WorkbenchDaemonEndpoint } from "../../shared/http/workbench-daemon-endpoint.ts";

export default class WorkbenchDaemonListener {
  private phase: "idle" | "binding" | "bound" | "ready" | "closing" | "closed" = "idle";
  private lease: WorkbenchProcessLease | null = null;
  private server: Server | null = null;
  private endpoint: WorkbenchDaemonEndpoint | null = null;
  private binding: Promise<WorkbenchDaemonEndpoint> | null = null;
  private publication: Promise<void> | null = null;
  private closing: Promise<void> | null = null;
  private readonly cancellation = new AbortController();

  constructor(private readonly options: { endpointPath: string; leasePath: string }) {}

  get current() { return this.endpoint; }
  get ready() { return this.phase === "ready"; }

  bind(server: Server): Promise<WorkbenchDaemonEndpoint> {
    if (this.phase !== "idle") return Promise.reject(new Error("Daemon listener has already started or closed."));
    this.phase = "binding";
    this.binding = this.bindListener(server);
    return this.binding;
  }

  private async bindListener(server: Server): Promise<WorkbenchDaemonEndpoint> {
    this.lease = await WorkbenchProcessLease.acquire(this.options.leasePath);
    if (!this.lease) throw new Error("A Workbench daemon is already running for this installation.");
    this.cancellation.signal.throwIfAborted();
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      const release = () => {
        server.off("error", failed);
        server.off("listening", ready);
        server.off("close", closed);
      };
      const failed = (error: Error) => { release(); reject(error); };
      const ready = () => { release(); resolve(); };
      const closed = () => failed(new Error("Daemon listener closed before binding."));
      server.once("error", failed);
      server.once("listening", ready);
      server.once("close", closed);
      server.listen({ host: "127.0.0.1", port: 0, signal: this.cancellation.signal });
    });
    this.cancellation.signal.throwIfAborted();
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Daemon listener did not return a TCP address.");
    this.endpoint = {
      version: 1, instanceId: randomUUID(), pid: process.pid,
      origin: `http://127.0.0.1:${address.port}`,
    };
    this.phase = "bound";
    return this.endpoint;
  }

  publish(): Promise<void> {
    if (this.publication) return this.publication;
    if (this.phase !== "bound" || !this.endpoint) return Promise.reject(new Error("Daemon listener is not bound."));
    const endpoint = this.endpoint;
    this.phase = "ready";
    this.publication = publishDaemonEndpoint(this.options.endpointPath, endpoint).catch(error => {
      if (this.phase !== "closing") this.phase = "bound";
      throw error;
    });
    return this.publication;
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.phase = "closing";
    this.cancellation.abort(new Error("Daemon listener is closing."));
    this.closing = this.closeResources();
    return this.closing;
  }

  private async closeResources() {
    const failures: unknown[] = [];
    // Startup errors belong to the startup caller. Wait so it cannot publish
    // an endpoint or acquire a lease after disposal has released its resources.
    if (this.binding) await Promise.allSettled([this.binding]);
    if (this.publication) {
      try { await this.publication; } catch (error) { failures.push(error); }
    }
    if (this.endpoint) {
      try { await removeDaemonEndpoint(this.options.endpointPath, this.endpoint.instanceId); }
      catch (error) { failures.push(error); }
    }
    if (this.server) {
      const server = this.server;
      try {
        await new Promise<void>((resolve, reject) => {
          server.close(error => {
            if (error && !("code" in error && error.code === "ERR_SERVER_NOT_RUNNING")) reject(error);
            else resolve();
          });
          server.closeAllConnections();
        });
      } catch (error) { failures.push(error); }
    }
    try { await this.lease?.dispose(); } catch (error) { failures.push(error); }
    this.phase = "closed";
    if (failures.length) throw new AggregateError(failures, "Daemon listener disposal failed.");
  }
}
