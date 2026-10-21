/*
 * Exports:
 * - WorkbenchDatabaseReader: the worker surface the pool drives; a node Worker in production.
 * - WORKBENCH_DATABASE_READER_COUNT: reader workers (and read connections) beside the writer.
 * - default WorkbenchDatabaseReadPool: reader workers shared by priority, spawned at construction so they boot beside the
 *   writer. Each runs one read at a time, the most urgent queued read goes next, background reads never take the last
 *   free reader, queued reads can be abandoned, and closing abandons background reads rather than waiting on them.
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
  /** The read the reader is running; null while idle. */
  running: Queued | null;
}

interface Queued {
  request: WorkbenchDatabaseRequest;
  rank: number;
  readClass: WorkbenchDatabaseReadClass;
  abandon(reason: unknown): void;
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
  /** Set from `open` until close or termination; spawned readers are only booting before then. */
  #opened = false;
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
    this.#slots = this.#spawnAll();
  }

  /** False until every reader is initialized, and again from the start of closing; callers then read through the writer. */
  get ready() { return this.#ready && !this.#closing; }

  /** Initializes the booted readers, or fresh ones after a close or termination. */
  async open(initialize: (reader: WorkbenchDatabaseReader) => Promise<void>) {
    if (this.#opened) return;
    this.#opened = true;
    if (!this.#slots.length) this.#slots = this.#spawnAll();
    const slots = this.#slots;
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
    const entry: Queued = { abandon, request, readClass, rank: WORKBENCH_DATABASE_READ_CLASSES.indexOf(readClass), detach: () => {} };
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

  /**
   * Lets queued and running interactive reads finish, then closes every reader. Background reads are abandoned instead:
   * SQLite cannot interrupt a running scan, so its reader is terminated rather than waited on.
   */
  async close(closeReader: (reader: WorkbenchDatabaseReader) => Promise<void>) {
    if (!this.#opened) {
      await this.terminate();
      return;
    }
    this.#closing = true;
    const reason = new Error("Database background read was abandoned because the database is closing.");
    for (const entry of this.#queue.filter(({ readClass }) => isBackgroundDatabaseReadClass(readClass))) {
      this.#queue.splice(this.#queue.indexOf(entry), 1);
      entry.detach();
      entry.abandon(reason);
    }
    const abandoned = this.#slots.filter(({ running }) => running && isBackgroundDatabaseReadClass(running.readClass));
    this.#slots = this.#slots.filter(slot => !abandoned.includes(slot));
    for (const { running } of abandoned) running!.abandon(reason);
    const terminated = Promise.all(abandoned.map(({ reader }) => reader.terminate()));
    await new Promise<void>((resolve) => {
      this.#drainWaiters.push(resolve);
      this.#notifyDrained();
    });
    const slots = this.#slots;
    this.#slots = [];
    this.#opened = false;
    this.#ready = false;
    this.#closing = false;
    await Promise.all([terminated, ...slots.map(async ({ reader }) => {
      try { await closeReader(reader); }
      finally { await reader.terminate(); }
    })]);
  }

  /** Drops every reader and queued read at once; the controller rejects their callers. */
  async terminate() {
    const slots = this.#slots;
    this.#slots = [];
    this.#opened = false;
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

  #spawnAll() {
    return Array.from({ length: this.#options.size ?? WORKBENCH_DATABASE_READER_COUNT }, () => this.#spawn());
  }

  #spawn(): Slot {
    const slot: Slot = { reader: this.#options.create(), running: null };
    slot.reader.on("message", (response) => {
      this.#options.settle(response);
      if (slot.running?.request.id !== response.id) return;
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
      free[0]!.running = entry!;
      free[0]!.reader.postMessage(entry!.request);
    }
  }

  #notifyDrained() {
    if (this.#queue.length || this.#slots.some(({ running }) => running !== null)) return;
    for (const resolve of this.#drainWaiters.splice(0)) resolve();
  }
}
