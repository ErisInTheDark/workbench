/*
 * Exports:
 * - WorkbenchDatabaseReader: the worker surface the pool drives; a node Worker in production.
 * - WORKBENCH_DATABASE_READER_COUNT: reader workers (and read connections) beside the writer.
 * - default WorkbenchDatabaseReadPool: reader workers shared by priority. Each runs one read at a time, the most
 *   urgent queued read goes next, background reads never take the last free reader, and queued reads can be abandoned.
 */
import {
  isBackgroundDatabaseReadClass,
  WORKBENCH_DATABASE_READ_CLASSES,
  type WorkbenchDatabaseReadClass,
  type WorkbenchDatabaseRequest,
  type WorkbenchDatabaseResponse,
} from "./workbench-database-protocol";

export interface WorkbenchDatabaseReader {
  postMessage(message: WorkbenchDatabaseRequest): void;
  on(event: "message", listener: (response: WorkbenchDatabaseResponse) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "exit", listener: (code: number) => void): unknown;
  terminate(): Promise<number>;
  getHeapStatistics(): Promise<{ used_heap_size: number; total_heap_size: number }>;
}

/** The same worker and connection count the fixed per-class readers used, so memory stays flat. */
export const WORKBENCH_DATABASE_READER_COUNT = 4;

interface Slot {
  reader: WorkbenchDatabaseReader;
  /** Request id the reader is running; null while idle. */
  running: number | null;
}

interface Queued {
  request: WorkbenchDatabaseRequest;
  rank: number;
  readClass: WorkbenchDatabaseReadClass;
  /** Detaches the abort listener once the read leaves the queue. */
  detach(): void;
}

interface ReadPoolOptions {
  create(): WorkbenchDatabaseReader;
  /** Every reader response, in arrival order; the controller owns request correlation. */
  settle(response: WorkbenchDatabaseResponse): void;
  fail(error: unknown): void;
  size?: number;
}

export default class WorkbenchDatabaseReadPool {
  readonly #options: ReadPoolOptions;
  #slots: Slot[] = [];
  #ready = false;
  /** Set while closing: queued reads still drain, but new reads go to the writer so the drain can end. */
  #closing = false;
  /** Most urgent class first, arrival order within a class. */
  readonly #queue: Queued[] = [];
  #drainWaiters: Array<() => void> = [];

  constructor(options: ReadPoolOptions) {
    // Background reads must leave one reader free, so a single reader would never run them.
    if ((options.size ?? WORKBENCH_DATABASE_READER_COUNT) < 2) throw new Error("The database read pool needs at least two readers.");
    this.#options = options;
  }

  /** False until every reader is initialized, and again from the start of closing; callers then read through the writer. */
  get ready() { return this.#ready && !this.#closing; }

  async open(initialize: (reader: WorkbenchDatabaseReader) => Promise<void>) {
    if (this.#slots.length) return;
    const slots = Array.from({ length: this.#options.size ?? WORKBENCH_DATABASE_READER_COUNT }, () => this.#spawn());
    this.#slots = slots;
    await Promise.all(slots.map(({ reader }) => initialize(reader)));
    if (this.#slots !== slots) return;
    this.#ready = true;
    this.#pump();
  }

  /**
   * Queues one read. `abandon` receives the abort reason when `signal` fires before a reader takes the read;
   * a read that has started always finishes, because the reader cannot interrupt SQLite.
   */
  run(request: WorkbenchDatabaseRequest, readClass: WorkbenchDatabaseReadClass, options: { signal?: AbortSignal; abandon(reason: unknown): void }) {
    const { signal, abandon } = options;
    if (signal?.aborted) {
      abandon(signal.reason);
      return;
    }
    const entry: Queued = { request, readClass, rank: WORKBENCH_DATABASE_READ_CLASSES.indexOf(readClass), detach: () => {} };
    if (signal) {
      const onAbort = () => {
        const index = this.#queue.indexOf(entry);
        if (index < 0) return;
        this.#queue.splice(index, 1);
        abandon(signal.reason);
        this.#notifyDrained();
      };
      signal.addEventListener("abort", onAbort, { once: true });
      entry.detach = () => signal.removeEventListener("abort", onAbort);
    }
    const after = this.#queue.findIndex((queued) => queued.rank > entry.rank);
    this.#queue.splice(after < 0 ? this.#queue.length : after, 0, entry);
    this.#pump();
  }

  /** Lets queued and running reads finish, then closes every reader. */
  async close(closeReader: (reader: WorkbenchDatabaseReader) => Promise<void>) {
    if (!this.#slots.length) return;
    this.#closing = true;
    await new Promise<void>((resolve) => {
      this.#drainWaiters.push(resolve);
      this.#notifyDrained();
    });
    const slots = this.#slots;
    this.#slots = [];
    this.#ready = false;
    this.#closing = false;
    await Promise.all(slots.map(async ({ reader }) => {
      try { await closeReader(reader); }
      finally { await reader.terminate(); }
    }));
  }

  /** Drops every reader and queued read at once; the controller rejects their callers. */
  async terminate() {
    const slots = this.#slots;
    this.#slots = [];
    this.#ready = false;
    this.#closing = false;
    for (const entry of this.#queue.splice(0)) entry.detach();
    for (const resolve of this.#drainWaiters.splice(0)) resolve();
    await Promise.all(slots.map(({ reader }) => reader.terminate()));
  }

  /** Each reader's own V8 heap, in pool order. */
  async heaps() {
    return await Promise.all(this.#slots.map(async ({ reader }) => {
      const { used_heap_size: used, total_heap_size: total } = await reader.getHeapStatistics();
      return { used, total };
    }));
  }

  #spawn(): Slot {
    const slot: Slot = { reader: this.#options.create(), running: null };
    slot.reader.on("message", (response) => {
      this.#options.settle(response);
      if (slot.running !== response.id) return;
      slot.running = null;
      this.#pump();
      this.#notifyDrained();
    });
    slot.reader.on("error", (error) => this.#options.fail(error));
    slot.reader.on("exit", (code) => {
      if (this.#slots.includes(slot)) this.#options.fail(new Error(`Workbench database reader exited unexpectedly with code ${code}`));
    });
    return slot;
  }

  #pump() {
    if (!this.#ready) return;
    for (;;) {
      const free = this.#slots.filter(({ running }) => running === null);
      if (!free.length) return;
      // Interactive reads may take the last free reader; background reads leave it for them.
      const index = this.#queue.findIndex(({ readClass }) => !isBackgroundDatabaseReadClass(readClass) || free.length > 1);
      if (index < 0) return;
      const [entry] = this.#queue.splice(index, 1);
      entry!.detach();
      free[0]!.running = entry!.request.id;
      free[0]!.reader.postMessage(entry!.request);
    }
  }

  #notifyDrained() {
    if (this.#queue.length || this.#slots.some(({ running }) => running !== null)) return;
    for (const resolve of this.#drainWaiters.splice(0)) resolve();
  }
}
