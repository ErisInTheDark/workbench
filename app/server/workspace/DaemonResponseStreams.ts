/*
 * Exports:
 * - default DaemonResponseStreams: stream one daemon HTTP response to a browser request, retaining the daemon while it
 *   flows and aborting it when the browser leaves, the daemon goes away, or the owner disposes.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { pipeline } from "node:stream/promises";
import type WorkbenchDaemonSource from "./WorkbenchDaemonSource";

const REQUEST_HEADERS = ["if-none-match", "if-modified-since", "range"] as const;
const RESPONSE_HEADERS = [
  "content-type", "content-length", "cache-control", "etag", "last-modified", "content-range", "accept-ranges",
  "content-security-policy",
] as const;

export default class DaemonResponseStreams {
  readonly #active = new Set<AbortController>();
  #closed = false;

  constructor(private readonly options: { warn(message: string): void; fetcher?: typeof fetch }) {}

  /** `daemonPath` includes any query; the daemon is told which daemon the app meant, so a stale origin cannot answer for another. */
  async stream(source: WorkbenchDaemonSource | null, daemonPath: string, request: IncomingMessage, response: ServerResponse, label: string) {
    const origin = source?.httpOrigin;
    if (this.#closed || !source || !origin) {
      response.writeHead(503, { "Cache-Control": "no-store" }).end();
      return;
    }
    const cancellation = new AbortController();
    this.#active.add(cancellation);
    const release = source.retain();
    const disconnected = () => { if (!response.writableFinished) cancellation.abort(); };
    response.once("close", disconnected);
    const stop = source.subscribe(() => {
      if (!source.available || source.httpOrigin !== origin) cancellation.abort();
    });
    try {
      const headers = new Headers();
      for (const name of REQUEST_HEADERS) {
        const value = request.headers[name];
        if (typeof value === "string") headers.set(name, value);
      }
      const destination = new URL(daemonPath, origin);
      destination.searchParams.set("wb-daemon", source.id);
      const upstream = await (this.options.fetcher ?? fetch)(destination, {
        method: request.method === "HEAD" ? "HEAD" : "GET", headers, redirect: "manual", signal: cancellation.signal,
      });
      if (upstream.status >= 300 && upstream.status < 400 && upstream.status !== 304) throw new Error(`${label} returned an unexpected redirect.`);
      response.statusCode = upstream.status;
      for (const name of RESPONSE_HEADERS) {
        const value = upstream.headers.get(name);
        if (value !== null) response.setHeader(name, value);
      }
      response.setHeader("X-Content-Type-Options", "nosniff");
      if (!upstream.body) response.end();
      // DOM and Node declarations describe the same WHATWG stream with incompatible BYOB generics.
      else await pipeline(Readable.fromWeb(upstream.body as unknown as NodeReadableStream<Uint8Array>),
        response, { signal: cancellation.signal });
    } catch (error) {
      if (!cancellation.signal.aborted) this.options.warn(`${label} failed: ${error instanceof Error ? error.message.slice(0, 512) : "Unexpected failure."}`);
      if (!response.destroyed && !response.writableEnded) {
        if (response.headersSent) response.destroy();
        else response.writeHead(502, { "Cache-Control": "no-store" }).end();
      }
    } finally {
      stop();
      release();
      response.off("close", disconnected);
      this.#active.delete(cancellation);
    }
  }

  dispose() {
    this.#closed = true;
    for (const cancellation of this.#active) cancellation.abort();
    this.#active.clear();
  }
}
