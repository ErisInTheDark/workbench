/*
 * Exports:
 * - HttpReverseProxyOptions: endpoint admission and bounded failure reporting.
 * - default HttpReverseProxy: forward HTTP and upgrades once, owning cancellation and disposal.
 */
import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

export interface HttpReverseProxyOptions {
  activityChanged?(): void;
  target(signal: AbortSignal): Promise<string>;
  warn(message: string): void;
}

export default class HttpReverseProxy {
  private readonly requests = new Set<AbortController>();
  private readonly sockets = new Set<Duplex>();
  private closed = false;

  constructor(private readonly options: HttpReverseProxyOptions) {}

  hasPendingWork() { return this.requests.size > 0 || this.sockets.size > 0; }

  async handle(request: IncomingMessage, response: ServerResponse) {
    const abort = this.admit();
    const cancel = () => abort.abort(new Error("Proxy caller disconnected."));
    response.once("close", cancel);
    try {
      const target = this.destination(await this.options.target(abort.signal), request.url);
      abort.signal.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        const upstream = httpRequest(target, {
          method: request.method,
          headers: this.headers(request, target, false),
          signal: abort.signal,
        }, incoming => {
          response.writeHead(incoming.statusCode ?? 502, incoming.headers);
          incoming.once("error", reject);
          incoming.once("end", resolve);
          incoming.pipe(response);
        });
        upstream.once("error", reject);
        request.once("error", cancel);
        upstream.once("close", () => request.off("error", cancel));
        request.pipe(upstream);
      });
    } catch (error) {
      if (abort.signal.aborted) response.destroy();
      else {
        this.report(error);
        if (!response.headersSent) response.writeHead(502, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
        if (!response.writableEnded) response.end("Daemon unavailable.");
      }
    } finally {
      response.off("close", cancel);
      this.requests.delete(abort);
      this.options.activityChanged?.();
    }
  }

  async upgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
    const abort = this.admit();
    const cancel = () => abort.abort(new Error("Proxy upgrade caller disconnected."));
    socket.once("close", cancel);
    this.track(socket);
    try {
      const target = this.destination(await this.options.target(abort.signal), request.url);
      abort.signal.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        const upstream = httpRequest(target, {
          method: request.method,
          headers: this.headers(request, target, true),
          signal: abort.signal,
        });
        upstream.once("error", reject);
        upstream.once("response", incoming => {
          incoming.resume();
          socket.end(`HTTP/1.1 ${incoming.statusCode ?? 502} Upgrade rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
          resolve();
        });
        upstream.once("upgrade", (incoming, peer, remainder) => {
          this.track(peer);
          const headers = incoming.rawHeaders;
          let handshake = `HTTP/1.1 ${incoming.statusCode ?? 101} ${incoming.statusMessage ?? "Switching Protocols"}\r\n`;
          for (let index = 0; index < headers.length; index += 2) handshake += `${headers[index]}: ${headers[index + 1]}\r\n`;
          socket.write(`${handshake}\r\n`);
          if (remainder.length) socket.write(remainder);
          if (head.length) peer.write(head);
          const finish = () => { socket.destroy(); peer.destroy(); resolve(); };
          socket.once("close", finish);
          peer.once("close", finish);
          socket.once("error", error => { this.report(error); finish(); });
          peer.once("error", error => { this.report(error); finish(); });
          socket.pipe(peer).pipe(socket);
          // The upgrade admission is complete; this owner retains the sockets for disposal.
          resolve();
        });
        upstream.end();
      });
    } catch (error) {
      if (!abort.signal.aborted) this.report(error);
      socket.destroy();
    } finally {
      socket.off("close", cancel);
      this.requests.delete(abort);
      this.options.activityChanged?.();
    }
  }

  close() {
    this.closed = true;
    for (const request of this.requests) request.abort(new Error("Proxy disposed."));
    for (const socket of this.sockets) socket.destroy();
  }

  private admit() {
    if (this.closed) throw new Error("Proxy is closed.");
    const abort = new AbortController();
    this.requests.add(abort);
    this.options.activityChanged?.();
    return abort;
  }

  private destination(origin: string, pathname = "/") {
    const target = new URL(origin);
    if (target.protocol !== "http:" || !["127.0.0.1", "[::1]", "localhost"].includes(target.hostname)) {
      throw new Error("Proxy target must be a verified loopback HTTP endpoint.");
    }
    // Never let an absolute request URL replace the admitted destination.
    const source = new URL(pathname, "http://request.invalid");
    target.pathname = source.pathname;
    target.search = source.search;
    return target;
  }

  private headers(request: IncomingMessage, target: URL, upgrade: boolean) {
    const headers: IncomingMessage["headers"] = { ...request.headers, host: target.host };
    delete headers["proxy-authorization"];
    delete headers["proxy-connection"];
    if (!upgrade) {
      const connection = String(headers.connection ?? "").split(",").map(value => value.trim().toLowerCase());
      for (const name of connection) delete headers[name];
      delete headers.connection;
      delete headers.upgrade;
      delete headers["keep-alive"];
    }
    return headers;
  }

  private track(socket: Duplex) {
    this.sockets.add(socket);
    this.options.activityChanged?.();
    socket.once("close", () => {
      this.sockets.delete(socket);
      this.options.activityChanged?.();
    });
  }

  private report(error: unknown) {
    this.options.warn(`Daemon forwarding failed: ${error instanceof Error ? error.message.replace(/[\r\n]/gu, " ").slice(0, 512) : "unknown failure"}`);
  }
}
