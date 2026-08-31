/*
 * Exports:
 * - WorkbenchFrontendRequestOwner: reload-host request port used by each app listener. Keywords: app, HTTP, lease.
 * - WorkbenchFrontendServerOptions/default WorkbenchFrontendServer: own bind-first app listener moves, draining, and disposal. Keywords: app, socket, port, lifecycle.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

import HttpServer, { type HttpServerAddress } from "workbench-shared/http/HttpServer";

export interface WorkbenchFrontendRequestOwner {
  handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void>;
}

export interface WorkbenchFrontendServerOptions {
  hostname?: string;
  onDiagnostic?: (message: string) => void;
  port?: number;
  requests: WorkbenchFrontendRequestOwner;
}

function throwFailures(message: string, failures: unknown[]) {
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, message);
}

export default class WorkbenchFrontendServer {
  private address: HttpServerAddress | null = null;
  private readonly onDiagnostic: (message: string) => void;
  private readonly options: WorkbenchFrontendServerOptions;
  private readonly retirementFailures: unknown[] = [];
  private readonly retirements = new Set<Promise<void>>();
  private server: HttpServer | null = null;

  constructor(options: WorkbenchFrontendServerOptions) {
    this.onDiagnostic = options.onDiagnostic ?? console.error;
    this.options = options;
  }

  private createServer(port: number | undefined) {
    return new HttpServer({
      handleRequest: async (request, response) => await this.options.requests.handleRequest(request, response),
      hostname: this.options.hostname,
      onError: (error) => this.onDiagnostic(`Workbench frontend HTTP failure: ${error.message}`),
      port,
    });
  }

  async start(): Promise<HttpServerAddress> {
    if (this.server) throw new Error("Workbench frontend server has already started.");
    const server = this.createServer(this.options.port);
    const address = await server.start();
    this.server = server;
    this.address = address;
    return address;
  }

  async moveToPort(port: number, beforeActivate: () => Promise<void>): Promise<HttpServerAddress> {
    const previous = this.server;
    const currentAddress = this.address;
    if (!previous || !currentAddress) throw new Error("Workbench frontend server is not running.");
    if (currentAddress.port === port) {
      await beforeActivate();
      return currentAddress;
    }

    const candidate = this.createServer(port);
    const candidateAddress = await candidate.start();
    try {
      await beforeActivate();
    } catch (error) {
      const failures = [error];
      try {
        await candidate.close();
      } catch (closeError) {
        failures.push(closeError);
      }
      throwFailures("Workbench app port persistence and candidate cleanup failed.", failures);
      throw error;
    }

    this.server = candidate;
    this.address = candidateAddress;
    this.retire(previous);
    return candidateAddress;
  }

  async close() {
    const server = this.server;
    this.server = null;
    this.address = null;
    const failures: unknown[] = [];
    if (server) {
      try {
        await server.close();
      } catch (error) {
        failures.push(error);
      }
    }
    await Promise.all(this.retirements);
    failures.push(...this.retirementFailures.splice(0));
    throwFailures("Workbench frontend listener cleanup failed.", failures);
  }

  private retire(server: HttpServer) {
    const retirement = server.close().catch((error: unknown) => {
      this.retirementFailures.push(error);
      this.onDiagnostic(`Workbench previous frontend listener failed to close: ${error instanceof Error ? error.message : String(error)}`);
    });
    this.retirements.add(retirement);
    void retirement.finally(() => {
      this.retirements.delete(retirement);
    });
  }
}
