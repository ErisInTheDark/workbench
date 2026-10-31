/*
 * Exports:
 * - default WorkbenchVisHttpController: serve vis pages: a session's document with its bridge, and any file under the
 *   session's build root, under a policy that allows the page's own origin and nothing else.
 */
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import type http from "node:http";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { mimeTypeFor } from "workbench-shared/http/mime-types";
import { frameVisDocument, VIS_SERVED_CONTENT_POLICY } from "workbench-shared/workbench/vis/vis-frame";
import { parseDaemonVisPath, readVisFrameQuery, type VisVariant } from "workbench-shared/workbench/vis/vis-url";
import { isPathInside } from "../lib/comparable-path";
import type { VisServed } from "./WorkbenchVisController";

function notFound(response: http.ServerResponse) {
  response.writeHead(404, { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" }).end("Not found.");
}

export default class WorkbenchVisHttpController {
  constructor(private readonly options: { serve(sessionId: string, variant: VisVariant): Promise<VisServed | null> }) {}

  async handleHttpRequest(request: http.IncomingMessage, response: http.ServerResponse) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { Allow: "GET, HEAD" }).end();
      return;
    }
    const url = new URL(request.url ?? "/", "http://localhost");
    const target = parseDaemonVisPath(url.pathname);
    const served = target && await this.options.serve(target.sessionId, target.variant);
    if (!target || !served) return notFound(response);
    response.setHeader("Content-Security-Policy", VIS_SERVED_CONTENT_POLICY);
    response.setHeader("X-Content-Type-Options", "nosniff");
    if (!target.file) {
      const body = frameVisDocument(served.document, served.controls, { served: true, ...readVisFrameQuery(url.searchParams) });
      response.writeHead(200, {
        "Cache-Control": "no-store", "Content-Type": "text/html; charset=utf-8", "Content-Length": Buffer.byteLength(body),
      });
      response.end(request.method === "HEAD" ? undefined : body);
      return;
    }
    const file = await this.#resolve(served.rootPath, target.file);
    if (!file) return notFound(response);
    response.writeHead(200, { "Cache-Control": "no-cache", "Content-Type": mimeTypeFor(file.path), "Content-Length": file.size });
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    await pipeline(createReadStream(file.path), response);
  }

  /** Symlinks resolve before the containment check, so none can point a request outside the build root. */
  async #resolve(rootPath: string, relative: string) {
    try {
      const root = await realpath(rootPath);
      const resolved = await realpath(path.resolve(root, relative));
      if (!isPathInside(resolved, root)) return null;
      const info = await stat(resolved);
      return info.isFile() ? { path: resolved, size: info.size } : null;
    } catch {
      return null;
    }
  }
}
