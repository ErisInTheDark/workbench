/*
 * Exports:
 * - StaticHttpRequestContext/StaticHttpRequestHandler: narrow first-party request seam before static resolution.
 * - StaticHttpRequestControllerOptions/default StaticHttpRequestController: own safe static resolution, SPA fallback, MIME, revalidation, compression, and cache behavior.
 */
import { createReadStream } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { brotliCompress, constants as zlibConstants, gzip } from "node:zlib";

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

const COMPRESSIBLE_EXTENSIONS = new Set([".css", ".html", ".js", ".json", ".map", ".svg", ".txt", ".webmanifest"]);
const MIN_COMPRESSIBLE_BYTES = 1024;
// Encoded bodies are kept per file version; the bound only needs to cover the live frontend assets.
const ENCODED_CACHE_LIMIT = 32;
const brotliCompressAsync = promisify(brotliCompress);
const gzipAsync = promisify(gzip);

type ContentEncoding = "br" | "gzip";
type FileStat = Awaited<ReturnType<typeof stat>>;

function cacheControlFor(filePath: string, cacheSeconds: number) {
  // Zero means always revalidate: clients keep the bytes and receive 304 until the file changes.
  if (cacheSeconds === 0) return "no-cache";
  return path.extname(filePath).toLowerCase() === ".html"
    ? "no-cache"
    : `public, max-age=${cacheSeconds}`;
}

function preferredEncoding(header: string | string[] | undefined): ContentEncoding | null {
  const accepted = new Map<string, number>();
  for (const part of (Array.isArray(header) ? header.join(",") : header ?? "").split(",")) {
    const [rawName, ...parameters] = part.trim().toLowerCase().split(";");
    if (!rawName) continue;
    const quality = parameters.map(value => value.trim()).find(value => value.startsWith("q="));
    accepted.set(rawName, quality ? Number(quality.slice(2)) || 0 : 1);
  }
  const allows = (name: ContentEncoding) => (accepted.get(name) ?? accepted.get("*") ?? 0) > 0;
  if (allows("br")) return "br";
  if (allows("gzip")) return "gzip";
  return null;
}

function entityTagFor(file: FileStat, encoding: ContentEncoding | null) {
  const version = `${Number(file.size).toString(36)}-${Math.trunc(Number(file.mtimeMs)).toString(36)}`;
  return `W/"${encoding ? `${version}-${encoding}` : version}"`;
}

function matchesEntityTag(request: IncomingMessage, entityTag: string) {
  const header = request.headers["if-none-match"];
  if (!header) return false;
  const weak = (value: string) => value.trim().replace(/^W\//u, "");
  return header.split(",").some(candidate => candidate.trim() === "*" || weak(candidate) === weak(entityTag));
}

function encode(contents: Buffer, encoding: ContentEncoding) {
  return encoding === "br"
    ? brotliCompressAsync(contents, {
      params: {
        // Fast enough to run on first request after a rebuild while still beating gzip.
        [zlibConstants.BROTLI_PARAM_QUALITY]: 5,
        [zlibConstants.BROTLI_PARAM_SIZE_HINT]: contents.length,
      },
    })
    : gzipAsync(contents, { level: 6 });
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
  private readonly encodedBodies = new Map<string, Promise<Buffer>>();
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
    this.encodedBodies.clear();
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
    const fileStat = file.stat;
    const compressible = COMPRESSIBLE_EXTENSIONS.has(path.extname(filePath).toLowerCase())
      && Number(fileStat.size) >= MIN_COMPRESSIBLE_BYTES;
    const encoding = compressible ? preferredEncoding(request.headers["accept-encoding"]) : null;
    const entityTag = entityTagFor(fileStat, encoding);
    const headers: Record<string, string> = {
      "Cache-Control": cacheControlFor(filePath, this.cacheSeconds),
      "Content-Type": MIME_TYPES.get(path.extname(filePath).toLowerCase()) ?? "application/octet-stream",
      ETag: entityTag,
      ...(compressible ? { Vary: "Accept-Encoding" } : {}),
    };
    if (matchesEntityTag(request, entityTag)) {
      response.writeHead(304, headers);
      response.end();
      return;
    }

    if (encoding) {
      const body = await this.encodedBody(filePath, fileStat, encoding);
      response.writeHead(200, { ...headers, "Content-Encoding": encoding, "Content-Length": String(body.length) });
      response.end(request.method === "HEAD" ? undefined : body);
      return;
    }

    response.writeHead(200, { ...headers, "Content-Length": String(fileStat.size) });
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

  /** One encode per file version and encoding; concurrent requests share it and failures are not cached. */
  private encodedBody(filePath: string, file: FileStat, encoding: ContentEncoding) {
    const key = `${filePath}\0${entityTagFor(file, encoding)}`;
    const cached = this.encodedBodies.get(key);
    if (cached) return cached;
    const body = readFile(filePath).then(contents => encode(contents, encoding));
    this.encodedBodies.set(key, body);
    body.catch(() => {
      if (this.encodedBodies.get(key) === body) this.encodedBodies.delete(key);
    });
    while (this.encodedBodies.size > ENCODED_CACHE_LIMIT) {
      const oldest = this.encodedBodies.keys().next().value;
      if (oldest === undefined) break;
      this.encodedBodies.delete(oldest);
    }
    return body;
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
