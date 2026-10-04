/*
 * Exports:
 * - WorkbenchCommandCapacityOptions: slot count, machine memory, scheduling and log ports.
 * - expensiveCommandSlots: hardware-derived concurrent expensive-command limit.
 * - default WorkbenchCommandCapacity: machine-wide FIFO admission for expensive agent commands, gated on memory pressure.
 */
import { dim } from "workbench-shared/process/terminal-style";

export interface WorkbenchCommandCapacityOptions {
  slots: number;
  readMemory(): { free: number; total: number };
  log(message: string): void;
  /** Below this free-memory share, no additional expensive command starts while another runs. */
  minimumFreeShare?: number;
  schedule?: (recheck: () => void, delayMs: number) => () => void;
}

interface Waiter {
  command: string;
  queuedAt: number;
  reportedPressure: boolean;
  admit(): void;
}

const DEFAULT_MINIMUM_FREE_SHARE = 0.15;
const PRESSURE_RECHECK_MS = 5_000;
const GIGABYTE = 1_073_741_824;
const label = (command: string) => command.replace(/\s+/gu, " ").trim().slice(0, 80);

/** A release build happily uses ~4 cores and several GB, so slots scale with whichever runs out first; never below 1. */
export function expensiveCommandSlots(hardware: { cores: number; totalMemory: number }) {
  return Math.max(1, Math.min(Math.floor(hardware.cores / 4), Math.floor(hardware.totalMemory / (8 * GIGABYTE))));
}

function defaultSchedule(recheck: () => void, delayMs: number) {
  const timer = setTimeout(recheck, delayMs);
  timer.unref();
  return () => clearTimeout(timer);
}

/**
 * Builds and test suites from many agents at once starve the machine (and the daemon with it). Expensive commands
 * take one of a few shared slots and start in arrival order; while another runs, a free slot also waits for memory
 * to recover. One expensive command can always run, so pressure never blocks expensive work entirely. Waiting
 * happens before the command starts, so its own timeout only measures running time.
 */
export default class WorkbenchCommandCapacity {
  private running = 0;
  private readonly waiting: Waiter[] = [];
  private cancelRecheck: (() => void) | null = null;
  private disposed = false;

  constructor(private readonly options: WorkbenchCommandCapacityOptions) {
    if (!Number.isSafeInteger(options.slots) || options.slots < 1) throw new Error("Expensive command slots must be a positive integer.");
  }

  async run<Result>(command: string, signal: AbortSignal, task: () => Promise<Result>): Promise<Result> {
    signal.throwIfAborted();
    if (this.disposed) throw new Error("The expensive command queue was retired.");
    if (!this.waiting.length && this.canStart()) this.running += 1;
    else await this.wait(command, signal);
    try { return await task(); }
    finally {
      this.running -= 1;
      this.pump();
    }
  }

  /** Stops rechecking; commands already admitted finish normally. */
  dispose() {
    this.disposed = true;
    this.stopRecheck();
  }

  private canStart() {
    if (this.running === 0) return true;
    return this.running < this.options.slots && !this.pressure();
  }

  private pressure() {
    const memory = this.options.readMemory();
    return memory.free < memory.total * (this.options.minimumFreeShare ?? DEFAULT_MINIMUM_FREE_SHARE) ? memory : null;
  }

  private wait(command: string, signal: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        command, queuedAt: Date.now(), reportedPressure: false,
        admit: () => { signal.removeEventListener("abort", abort); resolve(); },
      };
      const abort = () => {
        const index = this.waiting.indexOf(waiter);
        if (index >= 0) this.waiting.splice(index, 1);
        this.pump();
        reject(signal.reason);
      };
      signal.addEventListener("abort", abort, { once: true });
      this.options.log(` CMD expensive command queued ${dim(`(${this.waiting.length} ahead, ${this.running} running: ${label(command)})`)}`);
      this.waiting.push(waiter);
      this.pump();
    });
  }

  /** Starts waiters in order while they may start; a free slot held back by memory pressure rechecks on a timer. */
  private pump() {
    this.stopRecheck();
    while (this.waiting.length && this.canStart()) {
      const next = this.waiting.shift()!;
      this.running += 1;
      this.options.log(` CMD expensive command started after ${Math.round((Date.now() - next.queuedAt) / 1_000)}s in queue ${dim(`(${label(next.command)})`)}`);
      next.admit();
    }
    const head = this.waiting[0];
    if (!head || this.running >= this.options.slots || this.disposed) return;
    const memory = this.pressure();
    if (!memory) return;
    if (!head.reportedPressure) {
      head.reportedPressure = true;
      this.options.log(` CMD expensive command waiting for memory ${dim(`(${(memory.free / GIGABYTE).toFixed(1)}/${Math.round(memory.total / GIGABYTE)}GB free: ${label(head.command)})`)}`);
    }
    this.cancelRecheck = (this.options.schedule ?? defaultSchedule)(() => {
      this.cancelRecheck = null;
      this.pump();
    }, PRESSURE_RECHECK_MS);
  }

  private stopRecheck() {
    this.cancelRecheck?.();
    this.cancelRecheck = null;
  }
}
