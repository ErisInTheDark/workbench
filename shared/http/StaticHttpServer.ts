/*
 * Exports:
 * - StaticHttpServerAddress/StaticHttpServerRequestContext/StaticHttpServerRequestHandler/StaticHttpServerOptions: compatibility contracts for the composed static server.
 * - default StaticHttpServer: compose the stable HTTP socket with reload-independent static request behavior. Keywords: HTTP, static, lifecycle.
 */
import HttpServer, { type HttpServerAddress } from "./HttpServer.ts";
import StaticHttpRequestController, {
  type StaticHttpRequestContext,
  type StaticHttpRequestHandler,
} from "./StaticHttpRequestController.ts";

export type StaticHttpServerAddress = HttpServerAddress;
export type StaticHttpServerRequestContext = StaticHttpRequestContext;
export type StaticHttpServerRequestHandler = StaticHttpRequestHandler;

export interface StaticHttpServerOptions {
  beforeStaticRequest?: StaticHttpRequestHandler;
  cacheSeconds?: number;
  displayHostname?: string;
  hostname?: string;
  onError?: (error: Error) => void;
  port?: number;
  rootDirectoryPath: string;
  spaFallbackPath?: string | null;
}

export default class StaticHttpServer {
  private readonly requests: StaticHttpRequestController;
  private readonly server: HttpServer;

  constructor(options: StaticHttpServerOptions) {
    this.requests = new StaticHttpRequestController(options);
    this.server = new HttpServer({
      displayHostname: options.displayHostname,
      handleRequest: async (request, response) => await this.requests.handleRequest(request, response),
      hostname: options.hostname,
      onError: options.onError,
      port: options.port,
    });
  }

  async start() {
    await this.requests.start();
    try {
      return await this.server.start();
    } catch (error) {
      this.requests.close();
      throw error;
    }
  }

  async close() {
    const failures: unknown[] = [];
    try {
      await this.server.close();
    } catch (error) {
      failures.push(error);
    }
    try {
      this.requests.close();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Static HTTP server shutdown failed.");
  }
}
