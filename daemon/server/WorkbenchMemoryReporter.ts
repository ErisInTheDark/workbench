/*
 * Exports:
 * - WorkbenchMemoryReporterOptions: memory reads, scheduling, event-loop watching and logging ports.
 * - WorkbenchEventLoopWatch: running event-loop watch that reports its interval's longest delay.
 * - default WorkbenchMemoryReporter: once started, log one periodic daemon memory breakdown, including database worker
 *   heaps, machine free memory and the interval's longest event-loop delay, and warn whenever one block passes 1s.
 */

import os from "node:os";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { dim, yellow } from "workbench-shared/process/terminal-style";
import { WORKBENCH_DATABASE_READ_LANES, type WorkbenchDatabaseReadLane } from "./database/workbench-database-protocol";

type WorkerHeap = { used: number; total: number } | null;

export interface WorkbenchMemoryReporterOptions {
  readProcess?: () => Pick<NodeJS.MemoryUsage, "rss" | "heapUsed" | "heapTotal" | "external" | "arrayBuffers">;
  readWorkerHeaps(): Promise<{ writer: WorkerHeap } & Record<WorkbenchDatabaseReadLane, WorkerHeap>>;
  /** Machine memory, so an incident shows whether RAM ran out rather than leaving it to inference from rss. */
  readSystem?: () => { free: number; total: number };
  log(message: string): void;
  warn(message: string): void;
  intervalMs?: number;
  schedule?: (tick: () => void, intervalMs: number) => { stop(): void };
  /** Starts watching the event loop; `onBlocked` receives each block's length once the loop runs again. */
  watchEventLoop?: (onBlocked: (blockedMs: number) => void) => WorkbenchEventLoopWatch;
}

export interface WorkbenchEventLoopWatch {
  /** Longest event-loop delay since the previous call, in milliseconds. */
  takeMaxDelayMs(): number;
  stop(): void;
}

const DEFAULT_INTERVAL_MS = 60_000;
/** A single block this long is worth a log line: it is far past any healthy turn and well before the host's silence kill. */
const BLOCK_WARNING_MS = 1_000;
const BLOCK_PROBE_MS = 500;

/** A histogram for the interval maximum plus a probe timer whose lateness measures each individual block. */
function defaultWatchEventLoop(onBlocked: (blockedMs: number) => void): WorkbenchEventLoopWatch {
  const histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  let expected = performance.now() + BLOCK_PROBE_MS;
  const probe = setInterval(() => {
    const now = performance.now();
    const late = now - expected;
    expected = now + BLOCK_PROBE_MS;
    if (late >= BLOCK_WARNING_MS) onBlocked(late);
  }, BLOCK_PROBE_MS);
  probe.unref();
  return {
    takeMaxDelayMs: () => {
      const max = histogram.max / 1_000_000;
      histogram.reset();
      return max;
    },
    stop: () => {
      clearInterval(probe);
      histogram.disable();
    },
  };
}

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
  private loop: WorkbenchEventLoopWatch | null = null;
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
    this.loop = (this.options.watchEventLoop ?? defaultWatchEventLoop)((blockedMs) => {
      if (!this.disposed) this.options.warn(` LOOP ${yellow(`blocked ${(blockedMs / 1_000).toFixed(1)}s`)} ${dim("(synchronous work held the daemon event loop)")}`);
    });
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
      const loopMax = this.loop ? `, loop max ${Math.round(this.loop.takeMaxDelayMs())}ms` : "";
      this.options.log(
        ` MEM heap ${Math.round(memory.heapUsed / 1_048_576)}/${megabytes(memory.heapTotal)}, rss ${megabytes(memory.rss)}, `
        + `system free ${gigabytes(system.free)}/${Math.round(system.total / 1_073_741_824)}GB `
        + dim(`(external ${megabytes(memory.external)}, array buffers ${megabytes(memory.arrayBuffers)}, `
          + `db workers: writer ${heap(workers.writer)}, ${WORKBENCH_DATABASE_READ_LANES.map(lane => `${lane} ${heap(workers[lane])}`).join(", ")}${loopMax})`),
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
    this.loop?.stop();
    this.loop = null;
  }
}
