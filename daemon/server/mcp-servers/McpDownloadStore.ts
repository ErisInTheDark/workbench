/*
 * Exports:
 * - McpDownload: one saved download, with its file name, absolute path, content type and size.
 * - McpDownloadStoreOptions: cache directory, database, thread lifecycle and network ports.
 * - default McpDownloadStore: single owner of fetching links MCP servers sent and of those files' lifetime; refuses local
 *   and private addresses (re-checked on every redirect), caps size, and deletes a thread's downloads when it settles.
 */
import { randomUUID } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import { BlockList, isIP } from "node:net";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import {
  deleteRows, insertRow, selectRows,
  type WorkbenchDatabaseMutation, type WorkbenchDatabaseQuery, type WorkbenchDatabaseRow,
} from "workbench-shared/database/workbench-database-statements";
import { mcpDownloads } from "../lib/workbench/database/schema/mcp-server-schema";

export interface McpDownload {
  name: string;
  path: string;
  contentType: string;
  bytes: number;
}

export interface McpDownloadStoreOptions {
  directory: string;
  database: {
    executeTransaction(statements: readonly WorkbenchDatabaseMutation[]): Promise<{ changes: number }>;
    query<Row extends WorkbenchDatabaseRow>(statement: WorkbenchDatabaseQuery<Row>): Promise<Row[]>;
  };
  threads: {
    /** Calls back with a thread's id whenever its state is published as settled. */
    onSettled(listener: (threadId: string) => void): () => void;
    /** Whether the thread is settled; null when it is unknown. */
    settled(threadId: string): Promise<boolean | null>;
  };
  onError(error: unknown): void;
  maxBytes?: number;
  now?: () => number;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  /** Every address a host resolves to. */
  lookup?: (host: string) => Promise<string[]>;
}

const MAX_BYTES = 50 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const NAME_LIMIT = 120;

const EXTENSIONS: Record<string, string> = {
  "text/html": "html", "text/markdown": "md", "text/plain": "txt", "text/csv": "csv", "application/json": "json",
  "application/pdf": "pdf", "image/png": "png", "image/jpeg": "jpg", "application/zip": "zip",
};

const PRIVATE = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) PRIVATE.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]] as const) {
  PRIVATE.addSubnet(network, prefix, "ipv6");
}

function isPrivate(address: string) {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/iu.exec(address)?.[1];
  if (mapped) return PRIVATE.check(mapped, "ipv4");
  return PRIVATE.check(address, isIP(address) === 6 ? "ipv6" : "ipv4");
}

function sanitize(name: string) {
  const base = name.split(/[\\/]/u).pop() ?? "";
  return base.replace(/[<>:"|?*\u0000-\u001f]/gu, "").replace(/^\.+/u, "").trim().slice(0, NAME_LIMIT);
}

function dispositionName(header: string | null) {
  if (!header) return "";
  const encoded = /filename\*\s*=\s*[^']*'[^']*'([^;]+)/iu.exec(header)?.[1];
  if (encoded) {
    try { return decodeURIComponent(encoded.trim()); } catch { /* fall through to the plain form */ }
  }
  return /filename\s*=\s*"?([^";]+)"?/iu.exec(header)?.[1]?.trim() ?? "";
}

function urlName(url: URL) {
  try { return decodeURIComponent(path.posix.basename(url.pathname)); } catch { return path.posix.basename(url.pathname); }
}

export default class McpDownloadStore {
  /** Threads that own downloads; mirrors the table so settle events skip a query for the many threads without any. */
  readonly #owners = new Set<string>();
  #unsubscribe: (() => void) | null = null;
  readonly #releases = new Set<Promise<void>>();

  constructor(private readonly options: McpDownloadStoreOptions) {}

  /** Follows settlement, then drops downloads whose thread already settled or vanished and folders no row owns; failures go to `onError`. */
  start() {
    this.#track(this.#start());
  }

  /** Resolves once startup cleanup and any settle-triggered deletions have finished. */
  async idle() {
    await Promise.allSettled([...this.#releases]);
  }

  async #start() {
    const rows = await this.options.database.query(selectRows(mcpDownloads));
    for (const row of rows) this.#owners.add(row.thread_id);
    this.#unsubscribe = this.options.threads.onSettled(threadId => {
      if (this.#owners.has(threadId)) this.#track(this.#release(threadId));
    });
    for (const threadId of new Set(rows.map(row => row.thread_id))) {
      // An unknown thread may only be unloaded yet during startup; its files wait for a settle rather than risk a live thread's.
      if ((await this.options.threads.settled(threadId)) === true) await this.#release(threadId);
    }
    const owned = new Set(rows.map(row => path.basename(row.directory)));
    let entries: string[] = [];
    try {
      entries = await readdir(this.options.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await Promise.all(entries.filter(entry => !owned.has(entry))
      .map(entry => rm(path.join(this.options.directory, entry), { recursive: true, force: true })));
  }

  async dispose() {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    await this.idle();
  }

  /** `suggestedName` (e.g. a document title the server reported) wins over names derived from the response. */
  async download(threadId: string, link: string, suggestedName: string | undefined, signal: AbortSignal): Promise<McpDownload> {
    const { response, url } = await this.#fetch(new URL(link), signal);
    const maxBytes = this.options.maxBytes ?? MAX_BYTES;
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`The file is larger than ${maxBytes} bytes.`);
    const contentType = (response.headers.get("content-type") ?? "application/octet-stream").split(";")[0]!.trim().toLowerCase();
    const name = this.#name(suggestedName, response, url, contentType);
    const directory = path.join(this.options.directory, randomUUID());
    const file = path.join(directory, name);
    await mkdir(directory, { recursive: true });
    let bytes = 0;
    try {
      const counter = new Transform({
        transform(chunk: Buffer, _encoding, done) {
          bytes += chunk.length;
          done(bytes > maxBytes ? new Error(`The file is larger than ${maxBytes} bytes.`) : null, chunk);
        },
      });
      const body = response.body ? Readable.fromWeb(response.body as WebReadableStream) : Readable.from([]);
      await pipeline(body, counter, createWriteStream(file), { signal });
      await this.options.database.executeTransaction([insertRow(mcpDownloads, {
        id: path.basename(directory), thread_id: threadId, directory, created_at: (this.options.now ?? Date.now)(),
      })]);
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
    this.#owners.add(threadId);
    return { name, path: file, contentType, bytes };
  }

  async #release(threadId: string) {
    this.#owners.delete(threadId);
    const rows = await this.options.database.query(selectRows(mcpDownloads, { where: { thread_id: threadId } }));
    await Promise.all(rows.map(row => rm(row.directory, { recursive: true, force: true })));
    await this.options.database.executeTransaction([deleteRows(mcpDownloads, { thread_id: threadId })]);
  }

  #track(release: Promise<void>) {
    const tracked = release.catch(error => this.options.onError(error)).finally(() => this.#releases.delete(tracked));
    this.#releases.add(tracked);
  }

  /** Follows redirects itself so every hop's host is checked before it is contacted. */
  async #fetch(start: URL, signal: AbortSignal) {
    let url = start;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      if (url.protocol !== "https:") throw new Error("Only https links can be downloaded.");
      await this.#assertPublic(url.hostname);
      const response = await (this.options.fetch ?? fetch)(url.href, { redirect: "manual", signal });
      const location = response.headers.get("location");
      if (response.status >= 300 && response.status < 400 && location) {
        await response.body?.cancel();
        url = new URL(location, url);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`The download answered HTTP ${response.status}.`);
      }
      return { response, url };
    }
    throw new Error(`The download redirected more than ${MAX_REDIRECTS} times.`);
  }

  async #assertPublic(hostname: string) {
    const host = hostname.replace(/^\[|\]$/gu, "");
    const addresses = isIP(host) ? [host] : await (this.options.lookup ?? (async name => (await dnsLookup(name, { all: true })).map(entry => entry.address)))(host);
    if (!addresses.length || addresses.some(isPrivate)) throw new Error(`${hostname} resolves to a local or private address.`);
  }

  #name(suggested: string | undefined, response: Response, url: URL, contentType: string) {
    const name = sanitize(suggested ?? "") || sanitize(dispositionName(response.headers.get("content-disposition")))
      || sanitize(urlName(url)) || "download";
    const extension = EXTENSIONS[contentType];
    return extension && !path.extname(name) ? `${name}.${extension}` : name;
  }
}
