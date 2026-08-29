/*
 * Exports:
 * - WorkbenchAppServer/WorkbenchAppLease: app-owned lifecycle ports. Keywords: app, server, lease, test seam.
 * - WorkbenchAppOptions/WorkbenchAppStartResult: foreground app startup configuration and result. Keywords: app, lifecycle, singleton.
 * - default WorkbenchApp: own one foreground frontend server behind one machine launch lease. Keywords: app, controller, process.
 */
import type { StaticHttpServerAddress } from "workbench-shared/http/StaticHttpServer";

import WorkbenchAppLaunchLease from "./WorkbenchAppLaunchLease.ts";

export interface WorkbenchAppServer {
  close(): Promise<void>;
  start(): Promise<StaticHttpServerAddress>;
}

export interface WorkbenchAppLease {
  dispose(): Promise<void>;
}

export interface WorkbenchAppOptions {
  acquireLaunchLease?: () => Promise<WorkbenchAppLease | null>;
  callerThreadId?: string | null;
  createServer: () => WorkbenchAppServer;
}

export type WorkbenchAppStartResult =
  | { kind: "already-running" }
  | { address: StaticHttpServerAddress; kind: "started" };

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
  private readonly createServer: () => WorkbenchAppServer;
  private lease: WorkbenchAppLease | null = null;
  private server: WorkbenchAppServer | null = null;

  constructor(options: WorkbenchAppOptions) {
    this.acquireLaunchLease = options.acquireLaunchLease ?? (() => WorkbenchAppLaunchLease.acquire());
    this.callerThreadId = Object.hasOwn(options, "callerThreadId")
      ? options.callerThreadId?.trim() || null
      : currentThreadId();
    this.createServer = options.createServer;
  }

  async start(): Promise<WorkbenchAppStartResult> {
    if (this.server || this.lease) throw new Error("Workbench app has already started.");
    if (this.callerThreadId) {
      throw new Error("Managed agent threads cannot start the Workbench app.");
    }

    const lease = await this.acquireLaunchLease();
    if (!lease) return { kind: "already-running" };

    const server = this.createServer();
    try {
      const address = await server.start();
      this.lease = lease;
      this.server = server;
      return { address, kind: "started" };
    } catch (error) {
      const failures = [error];
      try {
        await server.close();
      } catch (closeError) {
        failures.push(closeError);
      }
      try {
        await lease.dispose();
      } catch (leaseError) {
        failures.push(leaseError);
      }
      throwFailures("Workbench app startup and cleanup failed.", failures);
      throw error;
    }
  }

  async close() {
    const server = this.server;
    const lease = this.lease;
    if (!server || !lease) return;

    await server.close();
    this.server = null;
    await lease.dispose();
    this.lease = null;
  }
}
