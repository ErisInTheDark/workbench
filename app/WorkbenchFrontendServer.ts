/*
 * Exports:
 * - WorkbenchFrontendRequestOwner: reload-host request port used by the stable socket. Keywords: app, HTTP, lease.
 * - WorkbenchFrontendServerOptions/default WorkbenchFrontendServer: own the stable app listener and random port only. Keywords: app, socket, lifecycle.
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

export default class WorkbenchFrontendServer {
  private readonly server: HttpServer;

  constructor(options: WorkbenchFrontendServerOptions) {
    this.server = new HttpServer({
      handleRequest: async (request, response) => await options.requests.handleRequest(request, response),
      hostname: options.hostname,
      onError: (error) => (options.onDiagnostic ?? console.error)(`Workbench frontend HTTP failure: ${error.message}`),
      port: options.port,
    });
  }

  async start(): Promise<HttpServerAddress> {
    return await this.server.start();
  }

  async close() {
    await this.server.close();
  }
}
