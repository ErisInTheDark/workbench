/*
 * Exports:
 * - McpDownload: one saved download, with its file name, absolute path, content type and size.
 * - McpKeptResult: one kept tool result's name, JSON file path and size.
 * - McpDownloadStoreOptions: cache directory, database, thread lifecycle and network ports.
 * - default McpDownloadStore: single owner of a thread's tool files: downloads of links servers sent (refusing local and
 *   private addresses, re-checked on every redirect, size-capped), kept tool results (one per name) and spilled tool output,
 *   the last two capped per thread together; all are deleted when their thread settles.
 */
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import {
  deleteRows, insertRow, selectRows,
  type WorkbenchDatabaseMutation, type WorkbenchDatabaseQuery, type WorkbenchDatabaseRow,
} from "workbench-shared/database/workbench-database-statements";
import { mcpDownloads } from "../lib/workbench/database/schema/mcp-server-schema";
import { fetchPublicHttps, type PublicHttpsFetchPorts } from "../lib/public-https-fetch";

export interface McpDownload {
  name: string;
  path: string;
  contentType: string;
  bytes: number;
}

export interface McpKeptResult {
  name: string;
  path: string;
  bytes: number;
}

export interface McpDownloadStoreOptions extends PublicHttpsFetchPorts {
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
  maxKeptBytesPerThread?: number;
  now?: () => number;
}

const MAX_BYTES = 50 * 1024 * 1024;
const NAME_LIMIT = 120;
const KEPT_NAME = /^[A-Za-z0-9_-]{1,64}$/u;
const KEPT_PREFIX = "kept-";
/** `-` plus a UUID. */
const KEPT_SUFFIX_LENGTH = 37;
const SPILL_PREFIX = "spill-";
const SPILL_FILE = "output.txt";
const MAX_KEPT_BYTES = 4 * 1024 * 1024;
const MAX_KEPT_BYTES_PER_THREAD = 256 * 1024 * 1024;

const EXTENSIONS: Record<string, string> = {
  "text/html": "html", "text/markdown": "md", "text/plain": "txt", "text/csv": "csv", "application/json": "json",
  "application/pdf": "pdf", "image/png": "png", "image/jpeg": "jpg", "application/zip": "zip",
};

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
    const { response, url } = await fetchPublicHttps(link, signal, this.options);
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

  /**
   * Keep a tool result so agents can read slices of it with file tools and components can take it as a prop: text stays raw so its
   * lines survive, anything else is pretty-printed JSON. A name holds one result; keeping it again replaces the old file.
   */
  async keep(threadId: string, name: string, value: unknown): Promise<McpKeptResult> {
    if (!KEPT_NAME.test(name)) throw new Error("Kept result names use 1-64 letters, digits, - or _.");
    const text = typeof value === "string";
    const body = Buffer.from(text ? value : `${JSON.stringify(value, null, 2)}\n`, "utf8");
    if (body.byteLength > MAX_KEPT_BYTES) throw new Error(`The result is larger than ${MAX_KEPT_BYTES} bytes and cannot be kept.`);
    const id = `${KEPT_PREFIX}${name}-${randomUUID()}`;
    const file = await this.#write(threadId, id, `${name}.${text ? "txt" : "json"}`, body);
    const replaced = (await this.#saved(threadId)).filter(entry => entry.id !== id && entry.name === name);
    await this.#remove(replaced);
    await this.#enforceCap(threadId, id);
    return { name, path: file, bytes: body.byteLength };
  }

  /** Save the text of an oversized tool result; it shares kept results' cap and lifetime but has no name and is no `@result:` value. */
  async spill(threadId: string, text: string): Promise<{ path: string }> {
    const body = Buffer.from(text, "utf8");
    if (body.byteLength > MAX_KEPT_BYTES) throw new Error(`The output is larger than ${MAX_KEPT_BYTES} bytes.`);
    const id = `${SPILL_PREFIX}${randomUUID()}`;
    const file = await this.#write(threadId, id, SPILL_FILE, body);
    await this.#enforceCap(threadId, id);
    return { path: file };
  }

  /** The kept result's value, or null when the thread kept nothing under that name. */
  async readKept(threadId: string, name: string): Promise<unknown> {
    const entry = (await this.#saved(threadId)).findLast(candidate => candidate.name === name);
    if (!entry) return null;
    const body = await readFile(entry.file, "utf8");
    return entry.file.endsWith(".txt") ? body : JSON.parse(body) as unknown;
  }

  async #write(threadId: string, id: string, name: string, body: Buffer) {
    const directory = path.join(this.options.directory, id);
    const file = path.join(directory, name);
    await mkdir(directory, { recursive: true });
    try {
      await writeFile(file, body);
      await this.options.database.executeTransaction([insertRow(mcpDownloads, {
        id, thread_id: threadId, directory, created_at: (this.options.now ?? Date.now)(),
      })]);
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
    this.#owners.add(threadId);
    return file;
  }

  /** The oldest saved results go past the thread's cap, never the one just written. */
  async #enforceCap(threadId: string, newest: string) {
    const saved = await this.#saved(threadId);
    const evicted: typeof saved = [];
    let bytes = saved.reduce((sum, entry) => sum + entry.bytes, 0);
    for (const entry of saved) {
      if (bytes <= (this.options.maxKeptBytesPerThread ?? MAX_KEPT_BYTES_PER_THREAD) || entry.id === newest) break;
      evicted.push(entry);
      bytes -= entry.bytes;
    }
    await this.#remove(evicted);
  }

  /** A thread's kept results and spills, oldest first; spills have no name. */
  async #saved(threadId: string) {
    const rows = await this.options.database.query(selectRows(mcpDownloads, { where: { thread_id: threadId } }));
    const entries = await Promise.all(rows.filter(row => row.id.startsWith(KEPT_PREFIX) || row.id.startsWith(SPILL_PREFIX)).map(async row => {
      const kept = row.id.startsWith(KEPT_PREFIX);
      const name = kept ? row.id.slice(KEPT_PREFIX.length, -KEPT_SUFFIX_LENGTH) : null;
      const candidates = (kept ? [`${name}.txt`, `${name}.json`] : [SPILL_FILE]).map(file => path.join(row.directory, file));
      const sizes = await Promise.all(candidates.map(async file => await stat(file).then(info => info.size, () => null)));
      const found = Math.max(0, sizes.findIndex(size => size !== null));
      return { id: row.id, name, file: candidates[found]!, directory: row.directory, bytes: sizes[found] ?? 0, createdAt: row.created_at };
    }));
    return entries.sort((left, right) => left.createdAt - right.createdAt);
  }

  async #remove(entries: readonly { id: string; directory: string }[]) {
    if (!entries.length) return;
    await Promise.all(entries.map(entry => rm(entry.directory, { recursive: true, force: true })));
    await this.options.database.executeTransaction(entries.map(entry => deleteRows(mcpDownloads, { id: entry.id })));
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

  #name(suggested: string | undefined, response: Response, url: URL, contentType: string) {
    const name = sanitize(suggested ?? "") || sanitize(dispositionName(response.headers.get("content-disposition")))
      || sanitize(urlName(url)) || "download";
    const extension = EXTENSIONS[contentType];
    return extension && !path.extname(name) ? `${name}.${extension}` : name;
  }
}
