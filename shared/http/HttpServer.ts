/*
 * Exports:
 * - HttpServerAddress: bound listener identity returned after startup.
 * - HttpServerOptions: request, upgrade and failure boundaries for one listener.
 * - default HttpServer: own an HTTP listener and its upgraded connections.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

export interface HttpServerAddress {
  hostname: string;
  port: number;
  url: string;
}

export interface HttpServerOptions {
  displayHostname?: string;
  handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> | void;
  handleUpgrade?(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> | void;
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
  private readonly listenController = new AbortController();
  private closing: Promise<void> | null = null;
  private readonly upgrades = new Set<Duplex>();

  constructor(private readonly options: HttpServerOptions) {
    this.displayHostname = options.displayHostname?.trim() || undefined;
    this.handle = options.handleRequest;
    this.hostname = options.hostname?.trim() || "0.0.0.0";
    this.onError = options.onError ?? ((error) => console.error(`HTTP server failed: ${error.message}`));
    this.port = boundedPort(options.port);
  }

  async start(): Promise<HttpServerAddress> {
    if (this.closing) throw new Error("HTTP server has closed.");
    if (this.server) throw new Error("HTTP server is already running.");
    const server = createServer((request, response) => {
      void Promise.resolve().then(() => this.handle(request, response)).catch((error: unknown) => {
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
    server.on("upgrade", (request, socket, head) => {
      if (!this.options.handleUpgrade || this.closing) {
        socket.destroy();
        return;
      }
      this.upgrades.add(socket);
      socket.once("close", () => this.upgrades.delete(socket));
      void Promise.resolve().then(() => this.options.handleUpgrade!(request, socket, head)).catch((error: unknown) => {
        const normalized = error instanceof Error ? error : new Error(String(error));
        this.onError(normalized);
        socket.destroy();
      });
    });
    this.server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          server.off("listening", onListening);
          server.off("close", onClose);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          server.off("close", onClose);
          resolve();
        };
        const onClose = () => onError(new Error("HTTP server closed before listening."));
        server.once("error", onError);
        server.once("listening", onListening);
        server.once("close", onClose);
        server.listen({ port: this.port, host: this.hostname, signal: this.listenController.signal });
      });
    } catch (error) {
      this.server = null;
      throw error;
    }
    const address = server.address();
    server.on("error", this.onError);
    if (!address || typeof address === "string") {
      await this.close();
      throw new Error("HTTP server did not expose a TCP address.");
    }
    const hostname = this.displayHostname ?? displayHost(this.hostname);
    return { hostname, port: address.port, url: `http://${formatHost(hostname)}:${address.port}` };
  }

  close(options: { force?: boolean } = {}) {
    const server = this.server;
    if (!server) return this.closing ?? Promise.resolve();
    if (!this.closing) {
      this.closing = new Promise<void>(resolve => {
        server.once("close", () => {
          if (this.server === server) this.server = null;
          resolve();
        });
      });
      // The same native cancellation covers an in-progress bind and a live listener.
      this.listenController.abort();
      server.closeIdleConnections();
      for (const socket of this.upgrades) socket.destroy();
    }
    if (options.force) server.closeAllConnections();
    return this.closing;
  }
}
