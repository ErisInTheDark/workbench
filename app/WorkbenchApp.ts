/*
 * Exports:
 * - WorkbenchAppServer/WorkbenchAppLease/WorkbenchAppRuntime: app-owned lifecycle ports. Keywords: app, server, lease, runtime.
 * - WorkbenchAppOptions/WorkbenchAppStartResult: foreground app startup configuration and result. Keywords: app, lifecycle, singleton.
 * - default WorkbenchApp: own one foreground listener and reload runtime behind one machine launch lease. Keywords: app, controller, process.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { HttpServerAddress } from "workbench-shared/http/HttpServer";

import WorkbenchAppLaunchLease from "./WorkbenchAppLaunchLease.ts";

export interface WorkbenchAppServer {
  close(): Promise<void>;
  start(): Promise<HttpServerAddress>;
}

export interface WorkbenchAppLease {
  dispose(): Promise<void>;
}

export interface WorkbenchAppRuntime {
  close(): Promise<void>;
  handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void>;
  start(): Promise<void>;
}

export interface WorkbenchAppOptions {
  acquireLaunchLease?: () => Promise<WorkbenchAppLease | null>;
  callerThreadId?: string | null;
  createRuntime(): WorkbenchAppRuntime;
  createServer(runtime: WorkbenchAppRuntime): WorkbenchAppServer;
}

export type WorkbenchAppStartResult =
  | { kind: "already-running" }
  | { address: HttpServerAddress; kind: "started" };

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
  private readonly createRuntime: () => WorkbenchAppRuntime;
  private readonly createServer: (runtime: WorkbenchAppRuntime) => WorkbenchAppServer;
  private lease: WorkbenchAppLease | null = null;
  private runtime: WorkbenchAppRuntime | null = null;
  private server: WorkbenchAppServer | null = null;

  constructor(options: WorkbenchAppOptions) {
    this.acquireLaunchLease = options.acquireLaunchLease ?? (() => WorkbenchAppLaunchLease.acquire());
    this.callerThreadId = Object.hasOwn(options, "callerThreadId")
      ? options.callerThreadId?.trim() || null
      : currentThreadId();
    this.createRuntime = options.createRuntime;
    this.createServer = options.createServer;
  }

  async start(): Promise<WorkbenchAppStartResult> {
    if (this.server || this.lease || this.runtime) throw new Error("Workbench app has already started.");
    if (this.callerThreadId) throw new Error("Managed agent threads cannot start the Workbench app.");
    const lease = await this.acquireLaunchLease();
    if (!lease) return { kind: "already-running" };
    const runtime = this.createRuntime();
    const server = this.createServer(runtime);
    try {
      await runtime.start();
      const address = await server.start();
      this.lease = lease;
      this.runtime = runtime;
      this.server = server;
      return { address, kind: "started" };
    } catch (error) {
      const failures = [error];
      try { await server.close(); } catch (closeError) { failures.push(closeError); }
      try { await runtime.close(); } catch (runtimeError) { failures.push(runtimeError); }
      try { await lease.dispose(); } catch (leaseError) { failures.push(leaseError); }
      throwFailures("Workbench app startup and cleanup failed.", failures);
      throw error;
    }
  }

  async close() {
    const server = this.server;
    const runtime = this.runtime;
    const lease = this.lease;
    if (!server || !runtime || !lease) return;
    this.server = null;
    this.runtime = null;
    this.lease = null;
    const failures: unknown[] = [];
    try { await server.close(); } catch (error) { failures.push(error); }
    try { await runtime.close(); } catch (error) { failures.push(error); }
    try { await lease.dispose(); } catch (error) { failures.push(error); }
    throwFailures("Workbench app shutdown failed.", failures);
  }
}
