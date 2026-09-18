/*
 * Exports:
 * - WorkbenchAppServer/WorkbenchAppLease/WorkbenchAppRuntime/WorkbenchAppPortControl: app-owned lifecycle and listener notification ports.
 * - WorkbenchAppOptions/WorkbenchAppStartResult: foreground startup configuration and result.
 * - default WorkbenchApp: own listener readiness, moves and reload runtime behind one launch lease.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import type { HttpServerAddress } from "workbench-shared/http/HttpServer";
import type { WorkbenchAppPortSnapshot } from "workbench-shared/http/workbench-app-port";

import WorkbenchProcessLease from "workbench-shared/process/WorkbenchProcessLease";
import resolveWorkbenchDataRoot from "workbench-shared/workbench-data-root";

export interface WorkbenchAppServer {
  close(): Promise<void>;
  moveToPort(port: number, beforeActivate: () => Promise<void>): Promise<HttpServerAddress>;
  start(): Promise<HttpServerAddress>;
}

export interface WorkbenchAppLease {
  dispose(): Promise<void>;
}

export interface WorkbenchAppRuntime {
  close(): Promise<void>;
  handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void>;
  readAppPort(): number | null;
  start(): Promise<void>;
  stopNetwork?(): Promise<void>;
  writeAppPort(port: number): Promise<void>;
}

export interface WorkbenchAppPortControl {
  read(): WorkbenchAppPortSnapshot;
  current?(): WorkbenchAppPortSnapshot | null;
  subscribe?(listener: () => Promise<void>): () => void;
  update(port: number): Promise<WorkbenchAppPortSnapshot>;
}

export interface WorkbenchAppOptions {
  acquireLaunchLease?: () => Promise<WorkbenchAppLease | null>;
  callerThreadId?: string | null;
  createRuntime(appPort: WorkbenchAppPortControl): WorkbenchAppRuntime;
  createServer(runtime: WorkbenchAppRuntime, port: number): WorkbenchAppServer;
  environmentPort?: number | null;
  onAddressChange?: (address: HttpServerAddress) => void;
  onDiagnostic?: (message: string) => void;
}

export type WorkbenchAppStartResult =
  | { kind: "already-running" }
  | { address: HttpServerAddress; kind: "started"; portSource: WorkbenchAppPortSnapshot["source"] };

function currentThreadId() {
  return process.env.WORKBENCH_THREAD_ID?.trim()
    || process.env.CODEX_THREAD_ID?.trim()
    || null;
}

function throwFailures(message: string, failures: unknown[]) {
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, message);
}

export default class WorkbenchApp {
  private readonly acquireLaunchLease: () => Promise<WorkbenchAppLease | null>;
  private readonly callerThreadId: string | null;
  private readonly createRuntime: (appPort: WorkbenchAppPortControl) => WorkbenchAppRuntime;
  private readonly createServer: (runtime: WorkbenchAppRuntime, port: number) => WorkbenchAppServer;
  private readonly environmentPort: number | null;
  private readonly onAddressChange: (address: HttpServerAddress) => void;
  private readonly onDiagnostic: (message: string) => void;
  private address: HttpServerAddress | null = null;
  private closing = false;
  private closeTask: Promise<void> | null = null;
  private startup: Promise<WorkbenchAppStartResult> | null = null;
  private lease: WorkbenchAppLease | null = null;
  private portChangeQueue = Promise.resolve();
  private portSource: WorkbenchAppPortSnapshot["source"] = "random";
  private runtime: WorkbenchAppRuntime | null = null;
  private server: WorkbenchAppServer | null = null;
  private readonly portListeners = new Set<() => Promise<void>>();

  constructor(options: WorkbenchAppOptions) {
    this.acquireLaunchLease = options.acquireLaunchLease
      ?? (() => WorkbenchProcessLease.acquire(path.join(resolveWorkbenchDataRoot(), "app", "app-launch.sqlite3")));
    this.callerThreadId = Object.hasOwn(options, "callerThreadId")
      ? options.callerThreadId?.trim() || null
      : currentThreadId();
    this.createRuntime = options.createRuntime;
    this.createServer = options.createServer;
    this.environmentPort = options.environmentPort ?? null;
    this.onAddressChange = options.onAddressChange ?? (() => {});
    this.onDiagnostic = options.onDiagnostic ?? (() => {});
  }

  async start(): Promise<WorkbenchAppStartResult> {
    if (this.startup || this.server || this.lease || this.runtime) throw new Error("Workbench app has already started.");
    if (this.closing) throw new Error("Workbench app has already closed.");
    if (this.callerThreadId) throw new Error("Managed agent threads cannot start the Workbench app.");
    this.startup = this.startResources();
    try {
      return await this.startup;
    } catch (error) {
      const failures = [error];
      try { await this.close(); } catch (closeError) { failures.push(closeError); }
      throwFailures("Workbench app startup and cleanup failed.", failures);
      throw error;
    }
  }

  private async startResources(): Promise<WorkbenchAppStartResult> {
    const assertStarting = () => {
      if (this.closing) throw new Error("Workbench app closed during startup.");
    };
    this.lease = await this.acquireLaunchLease();
    assertStarting();
    if (!this.lease) return { kind: "already-running" };
    const runtime = this.createRuntime({
      read: () => this.readPort(),
      current: () => this.address ? this.readPort() : null,
      subscribe: listener => {
        this.portListeners.add(listener);
        return () => { this.portListeners.delete(listener); };
      },
      update: async (port) => await this.updatePort(port),
    });
    this.runtime = runtime;
    await runtime.start();
    assertStarting();
    const savedPort = this.savedPort(runtime.readAppPort());
    const initialPort = this.environmentPort ?? savedPort ?? 0;
    this.server = this.createServer(runtime, initialPort);
    const address = await this.server.start();
    assertStarting();
    this.address = address;
    const portSource = this.environmentPort !== null ? "environment" : savedPort !== null ? "setting" : "random";
    this.portSource = portSource;
    await this.publishPort();
    return { address, kind: "started", portSource };
  }

  close() {
    if (this.closeTask) return this.closeTask;
    this.closing = true;
    this.closeTask = (async () => {
      const failures: unknown[] = [];
      // Forwarding may be awaiting an external Tailscale service during a port
      // notification. Cancel that owner before waiting for port work to settle.
      if (this.address) {
        try { await this.runtime?.stopNetwork?.(); }
        catch (error) { failures.push(error); }
      }
      await this.portChangeQueue;
      const closures: Promise<void>[] = [];
      for (const owner of [this.server, this.runtime]) {
        try { if (owner) closures.push(owner.close()); }
        catch (error) { failures.push(error); }
      }
      for (const result of await Promise.allSettled(closures)) {
        if (result.status === "rejected") failures.push(result.reason);
      }
      // Startup owns and propagates its error. Closure waits only to collect a late lease.
      await this.startup?.then(() => undefined, () => undefined);
      try { await this.lease?.dispose(); } catch (error) { failures.push(error); }
      throwFailures("Workbench app shutdown failed.", failures);
      this.server = null;
      this.runtime = null;
      this.lease = null;
      this.address = null;
      this.portListeners.clear();
    })();
    return this.closeTask;
  }

  private readPort(): WorkbenchAppPortSnapshot {
    const address = this.address;
    if (!address || !this.server || !this.runtime) throw new Error("Workbench app listener is not ready.");
    return {
      appOrigin: address.url,
      currentPort: address.port,
      editable: this.environmentPort === null,
      source: this.portSource,
    };
  }

  private savedPort(value: number | null) {
    if (value === null) return null;
    if (Number.isSafeInteger(value) && value >= 1 && value <= 65_535) return value;
    this.onDiagnostic("Ignored an invalid saved Workbench app port.");
    return null;
  }

  private async publishPort() {
    for (const listener of this.portListeners) {
      try { await listener(); }
      catch {
        this.onDiagnostic("A Workbench listener subscriber failed; check networking status.");
      }
    }
  }

  private updatePort(port: number): Promise<WorkbenchAppPortSnapshot> {
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
      return Promise.reject(new Error("Workbench app port must be an integer from 1 through 65535."));
    }
    if (this.environmentPort !== null) {
      return Promise.reject(new Error("Workbench app port is controlled by WORKBENCH_APP_PORT."));
    }
    if (this.closing) return Promise.reject(new Error("Workbench app is shutting down."));
    const operation = this.portChangeQueue.then(async () => {
      const server = this.server;
      const runtime = this.runtime;
      if (!server || !runtime) throw new Error("Workbench app listener is not ready.");
      const address = await server.moveToPort(port, async () => {
        await runtime.writeAppPort(port);
      });
      this.address = address;
      this.portSource = "setting";
      this.onAddressChange(address);
      await this.publishPort();
      return this.readPort();
    });
    this.portChangeQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }
}
