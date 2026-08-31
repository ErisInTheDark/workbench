/*
 * Exports:
 * - WorkbenchAppServer/WorkbenchAppLease/WorkbenchAppRuntime/WorkbenchAppPortControl: app-owned lifecycle ports. Keywords: app, server, lease, runtime, port.
 * - WorkbenchAppOptions/WorkbenchAppStartResult: foreground app startup configuration and result. Keywords: app, lifecycle, singleton.
 * - default WorkbenchApp: own foreground listener moves and reload runtime behind one machine launch lease. Keywords: app, controller, process, port.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { HttpServerAddress } from "workbench-shared/http/HttpServer";
import type { WorkbenchAppPortSnapshot } from "workbench-shared/http/workbench-app-port";

import WorkbenchAppLaunchLease from "./WorkbenchAppLaunchLease.ts";

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
  writeAppPort(port: number): Promise<void>;
}

export interface WorkbenchAppPortControl {
  read(): WorkbenchAppPortSnapshot;
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
  private lease: WorkbenchAppLease | null = null;
  private portChangeQueue = Promise.resolve();
  private portSource: WorkbenchAppPortSnapshot["source"] = "random";
  private runtime: WorkbenchAppRuntime | null = null;
  private server: WorkbenchAppServer | null = null;

  constructor(options: WorkbenchAppOptions) {
    this.acquireLaunchLease = options.acquireLaunchLease ?? (() => WorkbenchAppLaunchLease.acquire());
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
    if (this.server || this.lease || this.runtime) throw new Error("Workbench app has already started.");
    if (this.closing) throw new Error("Workbench app has already closed.");
    if (this.callerThreadId) throw new Error("Managed agent threads cannot start the Workbench app.");
    const lease = await this.acquireLaunchLease();
    if (!lease) return { kind: "already-running" };
    const runtime = this.createRuntime({
      read: () => this.readPort(),
      update: async (port) => await this.updatePort(port),
    });
    let server: WorkbenchAppServer | null = null;
    try {
      await runtime.start();
      const savedPort = this.savedPort(runtime.readAppPort());
      const initialPort = this.environmentPort ?? savedPort ?? 0;
      server = this.createServer(runtime, initialPort);
      const address = await server.start();
      this.lease = lease;
      this.runtime = runtime;
      this.server = server;
      this.address = address;
      const portSource = this.environmentPort !== null
        ? "environment"
        : savedPort !== null
          ? "setting"
          : "random";
      this.portSource = portSource;
      return { address, kind: "started", portSource };
    } catch (error) {
      const failures = [error];
      if (server) {
        try { await server.close(); } catch (closeError) { failures.push(closeError); }
      }
      try { await runtime.close(); } catch (runtimeError) { failures.push(runtimeError); }
      try { await lease.dispose(); } catch (leaseError) { failures.push(leaseError); }
      throwFailures("Workbench app startup and cleanup failed.", failures);
      throw error;
    }
  }

  async close() {
    this.closing = true;
    await this.portChangeQueue;
    const server = this.server;
    const runtime = this.runtime;
    const lease = this.lease;
    if (!server || !runtime || !lease) return;
    this.server = null;
    this.runtime = null;
    this.lease = null;
    this.address = null;
    const failures: unknown[] = [];
    try { await server.close(); } catch (error) { failures.push(error); }
    try { await runtime.close(); } catch (error) { failures.push(error); }
    try { await lease.dispose(); } catch (error) { failures.push(error); }
    throwFailures("Workbench app shutdown failed.", failures);
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
      return this.readPort();
    });
    this.portChangeQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }
}
