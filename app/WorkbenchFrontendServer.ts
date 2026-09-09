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
  private readonly retirements = new Map<HttpServer, Promise<void>>();
  private closing: Promise<void> | null = null;
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
    if (this.closing) throw new Error("Workbench frontend server has closed.");
    if (this.server) throw new Error("Workbench frontend server has already started.");
    const server = this.createServer(this.options.port);
    this.server = server;
    const address = await server.start();
    if (this.closing) throw new Error("Workbench frontend server closed during startup.");
    this.address = address;
    return address;
  }

  async moveToPort(port: number, beforeActivate: () => Promise<void>): Promise<HttpServerAddress> {
    if (this.closing) throw new Error("Workbench frontend server is closing.");
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

  close() {
    if (this.closing) return this.closing;
    const servers = new Set([...this.retirements.keys(), ...(this.server ? [this.server] : [])]);
    // Request force-close from every listener before awaiting any one of them.
    const closures = [...servers].map(server => server.close({ force: true }));
    this.closing = Promise.allSettled(closures).then(results => {
      const failures = results.filter(result => result.status === "rejected").map(result => result.reason);
      throwFailures("Workbench frontend listener cleanup failed.", failures);
      this.server = null;
      this.address = null;
      this.retirements.clear();
    });
    return this.closing;
  }

  private retire(server: HttpServer) {
    const retirement = server.close();
    this.retirements.set(server, retirement);
    void retirement.then(
      () => { this.retirements.delete(server); },
      (error: unknown) => {
        this.onDiagnostic(`Workbench previous frontend listener failed to close: ${error instanceof Error ? error.message : String(error)}`);
      },
    );
  }
}
