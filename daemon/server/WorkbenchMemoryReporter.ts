/*
 * Exports:
 * - WorkbenchMemoryReporterOptions: memory reads, scheduling and logging ports.
 * - default WorkbenchMemoryReporter: log one periodic daemon memory breakdown, including database worker heaps.
 */

import { dim, yellow } from "workbench-shared/process/terminal-style";

type WorkerHeap = { used: number; total: number } | null;

export interface WorkbenchMemoryReporterOptions {
  readProcess?: () => Pick<NodeJS.MemoryUsage, "rss" | "heapUsed" | "heapTotal" | "external" | "arrayBuffers">;
  readWorkerHeaps(): Promise<{ writer: WorkerHeap; core: WorkerHeap; transcript: WorkerHeap }>;
  log(message: string): void;
  warn(message: string): void;
  intervalMs?: number;
  schedule?: (tick: () => void, intervalMs: number) => { stop(): void };
}

const DEFAULT_INTERVAL_MS = 60_000;

function megabytes(bytes: number) {
  return `${Math.round(bytes / 1_048_576)}MB`;
}

function heap(value: WorkerHeap) {
  return value ? `${Math.round(value.used / 1_048_576)}/${megabytes(value.total)}` : "off";
}

function defaultSchedule(tick: () => void, intervalMs: number) {
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}

export default class WorkbenchMemoryReporter {
  private readonly timer: { stop(): void };
  private pendingSince: number | null = null;
  private disposed = false;
  private readonly intervalMs: number;

  constructor(private readonly options: WorkbenchMemoryReporterOptions) {
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.timer = (options.schedule ?? defaultSchedule)(() => { void this.tick(); }, this.intervalMs);
  }

  async tick() {
    if (this.disposed) return;
    // A sample that outlives its interval means the event loop or the workers stalled.
    if (this.pendingSince !== null) {
      this.options.log(` MEM sample ${yellow("still pending")} after ${Math.round(this.intervalMs / 1_000)}s`);
      return;
    }
    this.pendingSince = Date.now();
    try {
      const memory = (this.options.readProcess ?? process.memoryUsage)();
      const workers = await this.options.readWorkerHeaps();
      if (this.disposed) return;
      this.options.log(
        ` MEM heap ${Math.round(memory.heapUsed / 1_048_576)}/${megabytes(memory.heapTotal)}, rss ${megabytes(memory.rss)} `
        + dim(`(external ${megabytes(memory.external)}, array buffers ${megabytes(memory.arrayBuffers)}, `
          + `db workers: writer ${heap(workers.writer)}, core ${heap(workers.core)}, transcript ${heap(workers.transcript)})`),
      );
    } catch (error) {
      if (!this.disposed) this.options.warn(` MEM sample failed ${dim(`(${(error instanceof Error ? error.message : String(error)).slice(0, 300)})`)}`);
    } finally {
      this.pendingSince = null;
    }
  }

  dispose() {
    this.disposed = true;
    this.timer.stop();
  }
}
