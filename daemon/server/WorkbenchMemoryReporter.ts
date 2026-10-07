/*
 * Exports:
 * - WorkbenchMemoryReporterOptions: memory reads, scheduling and logging ports.
 * - default WorkbenchMemoryReporter: once started, log one periodic daemon memory breakdown, including database worker heaps and machine free memory.
 */

import os from "node:os";
import { dim, yellow } from "workbench-shared/process/terminal-style";

type WorkerHeap = { used: number; total: number } | null;

export interface WorkbenchMemoryReporterOptions {
  readProcess?: () => Pick<NodeJS.MemoryUsage, "rss" | "heapUsed" | "heapTotal" | "external" | "arrayBuffers">;
  readWorkerHeaps(): Promise<{ writer: WorkerHeap; core: WorkerHeap; transcript: WorkerHeap; query: WorkerHeap }>;
  /** Machine memory, so an incident shows whether RAM ran out rather than leaving it to inference from rss. */
  readSystem?: () => { free: number; total: number };
  log(message: string): void;
  warn(message: string): void;
  intervalMs?: number;
  schedule?: (tick: () => void, intervalMs: number) => { stop(): void };
}

const DEFAULT_INTERVAL_MS = 60_000;

function megabytes(bytes: number) {
  return `${Math.round(bytes / 1_048_576)}MB`;
}

function gigabytes(bytes: number) {
  return (bytes / 1_073_741_824).toFixed(1);
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
  private timer: { stop(): void } | null = null;
  private pendingSince: number | null = null;
  private disposed = false;
  private readonly intervalMs: number;

  constructor(private readonly options: WorkbenchMemoryReporterOptions) {
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  }

  /**
   * Begin periodic samples. Owners start this once their runtime is committed: the host's silence watchdog reads any
   * output as liveness, so samples during a stalled startup would keep it from ever recovering the process.
   */
  start() {
    if (this.disposed || this.timer) return;
    this.timer = (this.options.schedule ?? defaultSchedule)(() => { void this.tick(); }, this.intervalMs);
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
      const system = (this.options.readSystem ?? (() => ({ free: os.freemem(), total: os.totalmem() })))();
      this.options.log(
        ` MEM heap ${Math.round(memory.heapUsed / 1_048_576)}/${megabytes(memory.heapTotal)}, rss ${megabytes(memory.rss)}, `
        + `system free ${gigabytes(system.free)}/${Math.round(system.total / 1_073_741_824)}GB `
        + dim(`(external ${megabytes(memory.external)}, array buffers ${megabytes(memory.arrayBuffers)}, `
          + `db workers: writer ${heap(workers.writer)}, core ${heap(workers.core)}, transcript ${heap(workers.transcript)}, query ${heap(workers.query)})`),
      );
    } catch (error) {
      if (!this.disposed) this.options.warn(` MEM sample failed ${dim(`(${(error instanceof Error ? error.message : String(error)).slice(0, 300)})`)}`);
    } finally {
      this.pendingSince = null;
    }
  }

  dispose() {
    this.disposed = true;
    this.timer?.stop();
    this.timer = null;
  }
}
