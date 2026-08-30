/*
 * Exports:
 * - HttpServerAddress: bound listener identity returned after startup. Keywords: HTTP, port, URL.
 * - HttpServerOptions/default HttpServer: own one dependency-free HTTP socket and delegate every request. Keywords: HTTP, listener, lifecycle.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export interface HttpServerAddress {
  hostname: string;
  port: number;
  url: string;
}

export interface HttpServerOptions {
  displayHostname?: string;
  handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> | void;
  hostname?: string;
  onError?: (error: Error) => void;
  port?: number;
}

function boundedPort(value: number | undefined) {
  const port = value ?? 0;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new Error("HTTP port must be an integer from 0 through 65535.");
  }
  return port;
}

function displayHost(hostname: string) {
  if (hostname === "0.0.0.0") return "127.0.0.1";
  if (hostname === "::") return "::1";
  return hostname;
}

function formatHost(hostname: string) {
  return hostname.includes(":") && !hostname.startsWith("[") ? `[${hostname}]` : hostname;
}

export default class HttpServer {
  private readonly displayHostname?: string;
  private readonly handle: HttpServerOptions["handleRequest"];
  private readonly hostname: string;
  private readonly onError: (error: Error) => void;
  private readonly port: number;
  private server: Server | null = null;

  constructor(options: HttpServerOptions) {
    this.displayHostname = options.displayHostname?.trim() || undefined;
    this.handle = options.handleRequest;
    this.hostname = options.hostname?.trim() || "0.0.0.0";
    this.onError = options.onError ?? ((error) => console.error(`HTTP server failed: ${error.message}`));
    this.port = boundedPort(options.port);
  }

  async start(): Promise<HttpServerAddress> {
    if (this.server) throw new Error("HTTP server is already running.");
    const server = createServer((request, response) => {
      void Promise.resolve(this.handle(request, response)).catch((error: unknown) => {
        const normalized = error instanceof Error ? error : new Error(String(error));
        this.onError(normalized);
        if (!response.headersSent) {
          response.writeHead(500, { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" });
          response.end("Internal server error.");
        } else if (!response.writableEnded) {
          response.destroy(normalized);
        }
      });
    });
    this.server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(this.port, this.hostname);
      });
    } catch (error) {
      this.server = null;
      throw error;
    }
    const address = server.address();
    if (!address || typeof address === "string") {
      await this.close();
      throw new Error("HTTP server did not expose a TCP address.");
    }
    const hostname = this.displayHostname ?? displayHost(this.hostname);
    return { hostname, port: address.port, url: `http://${formatHost(hostname)}:${address.port}` };
  }

  async close() {
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeIdleConnections();
    });
  }
}
