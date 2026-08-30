/*
 * Exports:
 * - StaticHttpRequestContext/StaticHttpRequestHandler: narrow first-party request seam before static resolution. Keywords: HTTP, request, route.
 * - StaticHttpRequestControllerOptions/default StaticHttpRequestController: own safe static resolution, SPA fallback, MIME, and cache behavior. Keywords: HTTP, static, controller.
 */
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";

export interface StaticHttpRequestContext {
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
}

export type StaticHttpRequestHandler = (
  context: StaticHttpRequestContext,
) => boolean | Promise<boolean>;

export interface StaticHttpRequestControllerOptions {
  beforeStaticRequest?: StaticHttpRequestHandler;
  cacheSeconds?: number;
  rootDirectoryPath: string;
  spaFallbackPath?: string | null;
}

const MIME_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".txt", "text/plain; charset=utf-8"],
  [".webmanifest", "application/manifest+json; charset=utf-8"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`Expected an integer from ${minimum} through ${maximum}.`);
  }
  return value;
}

function errorCode(error: unknown) {
  return error && typeof error === "object" && "code" in error
    ? String(error.code)
    : null;
}

function isMissingFileError(error: unknown) {
  const code = errorCode(error);
  return code === "ENOENT" || code === "ENOTDIR";
}

function acceptsHtml(request: IncomingMessage) {
  const accept = request.headers.accept;
  return accept === undefined || accept.includes("*/*") || accept.includes("text/html");
}

function cacheControlFor(filePath: string, cacheSeconds: number) {
  return path.extname(filePath).toLowerCase() === ".html"
    ? "no-cache"
    : `public, max-age=${cacheSeconds}`;
}

function sendText(response: ServerResponse, statusCode: number, message: string, extraHeaders: Record<string, string> = {}) {
  response.writeHead(statusCode, {
    "Cache-Control": "no-store",
    "Content-Type": "text/plain; charset=utf-8",
    ...extraHeaders,
  });
  response.end(message);
}

export default class StaticHttpRequestController {
  private readonly beforeStaticRequest?: StaticHttpRequestHandler;
  private readonly cacheSeconds: number;
  private readonly rootDirectoryPath: string;
  private readonly spaFallbackPath: string | null;
  private realRootDirectoryPath: string | null = null;

  constructor(options: StaticHttpRequestControllerOptions) {
    this.beforeStaticRequest = options.beforeStaticRequest;
    this.cacheSeconds = boundedInteger(options.cacheSeconds, 300, 0, 86_400);
    this.rootDirectoryPath = path.resolve(options.rootDirectoryPath);
    this.spaFallbackPath = options.spaFallbackPath === undefined
      ? null
      : options.spaFallbackPath;
  }

  async start() {
    if (this.realRootDirectoryPath) throw new Error("Static HTTP request controller is already running.");
    const rootStat = await stat(this.rootDirectoryPath);
    if (!rootStat.isDirectory()) throw new Error("Static HTTP root must be a directory.");
    this.realRootDirectoryPath = await realpath(this.rootDirectoryPath);
  }

  close() {
    this.realRootDirectoryPath = null;
  }

  async handleRequest(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url ?? "/", "http://workbench.local");
    if (this.beforeStaticRequest && await this.beforeStaticRequest({ request, response, url })) return;

    if (request.method !== "GET" && request.method !== "HEAD") {
      sendText(response, 405, "Method not allowed.", { Allow: "GET, HEAD" });
      return;
    }

    const resolution = this.resolveRequestPath(request.url ?? "/");
    if (resolution.kind === "invalid") {
      sendText(response, resolution.statusCode, resolution.message);
      return;
    }

    let filePath = resolution.filePath;
    const requestedPath = filePath;
    let file = await this.readPath(filePath);
    if (file.kind === "escaped") {
      sendText(response, 403, "Path escapes the static root.");
      return;
    }
    if (file.kind === "found" && file.stat.isDirectory()) {
      filePath = path.join(file.filePath, "index.html");
      file = await this.readPath(filePath);
    }

    if (file.kind === "escaped") {
      sendText(response, 403, "Path escapes the static root.");
      return;
    }
    if (file.kind !== "found" && this.shouldUseSpaFallback(request, requestedPath)) {
      const fallback = this.resolveConfiguredPath(this.spaFallbackPath ?? "");
      if (fallback) {
        filePath = fallback;
        file = await this.readPath(filePath);
      }
    }

    if (file.kind === "escaped") {
      sendText(response, 403, "Path escapes the static root.");
      return;
    }
    if (file.kind !== "found" || !file.stat.isFile()) {
      sendText(response, 404, "Not found.");
      return;
    }
    filePath = file.filePath;

    response.writeHead(200, {
      "Cache-Control": cacheControlFor(filePath, this.cacheSeconds),
      "Content-Length": String(file.stat.size),
      "Content-Type": MIME_TYPES.get(path.extname(filePath).toLowerCase()) ?? "application/octet-stream",
    });
    if (request.method === "HEAD") {
      response.end();
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const stream = createReadStream(filePath);
      stream.once("error", reject);
      response.once("close", () => {
        stream.destroy();
        resolve();
      });
      response.once("finish", resolve);
      stream.pipe(response);
    });
  }

  private resolveRequestPath(requestUrl: string):
    | { filePath: string; kind: "file" }
    | { kind: "invalid"; message: string; statusCode: number } {
    const rawPath = requestUrl.split(/[?#]/u, 1)[0] || "/";
    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(rawPath);
    } catch {
      return { kind: "invalid", message: "Malformed URL path.", statusCode: 400 };
    }

    if (decodedPath.includes("\0")) {
      return { kind: "invalid", message: "Invalid URL path.", statusCode: 400 };
    }

    const normalizedPath = decodedPath.replaceAll("\\", "/");
    if (normalizedPath.split("/").some((segment) => segment === "..")) {
      return { kind: "invalid", message: "Path escapes the static root.", statusCode: 403 };
    }

    const filePath = this.resolveConfiguredPath(normalizedPath.replace(/^\/+/u, ""));
    if (!filePath) {
      return { kind: "invalid", message: "Path escapes the static root.", statusCode: 403 };
    }
    return { filePath, kind: "file" };
  }

  private resolveConfiguredPath(relativePath: string) {
    const candidate = path.resolve(this.rootDirectoryPath, relativePath);
    const relative = path.relative(this.rootDirectoryPath, candidate);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
      ? candidate
      : null;
  }

  private shouldUseSpaFallback(request: IncomingMessage, requestedPath: string) {
    return this.spaFallbackPath !== null
      && path.extname(requestedPath) === ""
      && acceptsHtml(request);
  }

  private async readPath(filePath: string): Promise<
    | { kind: "escaped" }
    | { kind: "found"; filePath: string; stat: Awaited<ReturnType<typeof stat>> }
    | { kind: "missing" }
  > {
    try {
      const canonicalPath = await realpath(filePath);
      const realRootDirectoryPath = this.realRootDirectoryPath;
      if (!realRootDirectoryPath) throw new Error("Static HTTP server is not running.");
      const relative = path.relative(realRootDirectoryPath, canonicalPath);
      if (relative.startsWith("..") || path.isAbsolute(relative)) return { kind: "escaped" };
      return {
        filePath: canonicalPath,
        kind: "found",
        stat: await stat(canonicalPath),
      };
    } catch (error) {
      if (isMissingFileError(error)) return { kind: "missing" };
      throw error;
    }
  }
}
