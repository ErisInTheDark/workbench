/*
 * Exports:
 * - default WorkbenchWorkspaceAssetRoutes: stream recognised daemon assets through the authenticated app origin.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { pipeline } from "node:stream/promises";
import { DaemonIdSchema } from "workbench-shared/workbench/identity";
import type WorkbenchDaemonSources from "./WorkbenchDaemonSources";

export default class WorkbenchWorkspaceAssetRoutes {
  private readonly active = new Set<AbortController>();
  private closed = false;

  constructor(private readonly options: {
    sources: WorkbenchDaemonSources;
    warn(message: string): void;
    fetcher?: typeof fetch;
  }) {}

  async handle(request: IncomingMessage, response: ServerResponse, url: URL) {
    if (!url.pathname.startsWith("/api/workspace/assets/")) return false;
    const match = /^\/api\/workspace\/assets\/([^/]+)(\/daemon\/(?:project-icons\/[^/]+|transcript-assets\/(?:[^/]+\/){1,2}[a-f0-9]{64}\.(?:png|jpg|jpeg|webp|gif)))$/u.exec(url.pathname);
    const id = DaemonIdSchema.safeParse(match?.[1]);
    if (!match || !id.success || request.method !== "GET") {
      response.writeHead(400).end();
      return true;
    }
    const source = this.options.sources.get(id.data);
    const origin = source?.httpOrigin;
    if (this.closed || !source || !origin) {
      response.writeHead(503, { "Cache-Control": "no-store" }).end();
      return true;
    }
    const cancellation = new AbortController();
    this.active.add(cancellation);
    const release = source.retain();
    const disconnected = () => { if (!response.writableFinished) cancellation.abort(); };
    response.once("close", disconnected);
    const stop = source.subscribe(() => {
      if (!source.available || source.httpOrigin !== origin) cancellation.abort();
    });
    try {
      const headers = new Headers();
      for (const name of ["if-none-match", "if-modified-since", "range"]) {
        const value = request.headers[name];
        if (typeof value === "string") headers.set(name, value);
      }
      const destination = new URL(`${match[2]}${url.search}`, origin);
      destination.searchParams.set("wb-daemon", source.id);
      const upstream = await (this.options.fetcher ?? fetch)(destination, {
        headers, redirect: "manual", signal: cancellation.signal,
      });
      if (upstream.status >= 300 && upstream.status < 400 && upstream.status !== 304) throw new Error("Daemon asset returned an unexpected redirect.");
      response.statusCode = upstream.status;
      for (const name of ["content-type", "content-length", "cache-control", "etag", "last-modified", "content-range", "accept-ranges"]) {
        const value = upstream.headers.get(name);
        if (value !== null) response.setHeader(name, value);
      }
      response.setHeader("X-Content-Type-Options", "nosniff");
      if (!upstream.body) response.end();
      // DOM and Node declarations describe the same WHATWG stream with incompatible BYOB generics.
      else await pipeline(Readable.fromWeb(upstream.body as unknown as NodeReadableStream<Uint8Array>),
        response, { signal: cancellation.signal });
    } catch (error) {
      if (!cancellation.signal.aborted) this.options.warn(`Workspace asset failed: ${error instanceof Error ? error.message.slice(0, 512) : "Unexpected failure."}`);
      if (!response.destroyed && !response.writableEnded) {
        if (response.headersSent) response.destroy();
        else response.writeHead(502, { "Cache-Control": "no-store" }).end();
      }
    } finally {
      stop();
      release();
      response.off("close", disconnected);
      this.active.delete(cancellation);
    }
    return true;
  }

  dispose() {
    this.closed = true;
    for (const cancellation of this.active) cancellation.abort();
    this.active.clear();
  }
}
