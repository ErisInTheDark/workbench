/*
 * Exports:
 * - WorkbenchAgentCommandLogOutcome/WorkbenchAgentCommandLoggerOptions: define bounded command timing outcomes and injectable clock ports. Keywords: CLI, MCP, logging, timing, test.
 * - default WorkbenchAgentCommandLogger: own pending warnings and terminal timing logs for one CLI or MCP command lifecycle. Keywords: CLI, MCP, pending, completion, cancellation.
 */

const DEFAULT_PENDING_THRESHOLD_MS = 2_000;
const PENDING_WARNING_INTERVAL_MS = 2_000;
const ANSI_GREEN = "\u001b[32m";
const ANSI_RED = "\u001b[31m";
const ANSI_YELLOW = "\u001b[33m";
const ANSI_RESET = "\u001b[0m";

type Timer = ReturnType<typeof setTimeout>;

export type WorkbenchAgentCommandLogOutcome = "cancelled" | "error" | "ok";

export interface WorkbenchAgentCommandLoggerOptions {
  cancel?: (timer: Timer) => void;
  now?: () => number;
  pendingThresholdMs?: number;
  schedule?: (callback: () => void, delayMs: number) => Timer;
  writeLine?: (line: string) => void;
}

function formatDuration(value: number) {
  const duration = Math.max(0, value);
  return duration < 1_000 ? `${Math.round(duration)}ms` : `${(duration / 1_000).toFixed(1)}s`;
}

function completionToken(outcome: WorkbenchAgentCommandLogOutcome) {
  if (outcome === "ok") return `${ANSI_GREEN}ok${ANSI_RESET}`;
  if (outcome === "cancelled") return `${ANSI_YELLOW}cancelled${ANSI_RESET}`;
  return `${ANSI_RED}error${ANSI_RESET}`;
}

function pendingToken() {
  return `${ANSI_YELLOW}pending${ANSI_RESET}`;
}

export default class WorkbenchAgentCommandLogger {
  private readonly cancel: NonNullable<WorkbenchAgentCommandLoggerOptions["cancel"]>;
  private readonly now: NonNullable<WorkbenchAgentCommandLoggerOptions["now"]>;
  private readonly pendingThresholdMs: number;
  private readonly schedule: NonNullable<WorkbenchAgentCommandLoggerOptions["schedule"]>;
  private readonly writeLine: NonNullable<WorkbenchAgentCommandLoggerOptions["writeLine"]>;

  constructor({
    cancel = clearTimeout,
    now = Date.now,
    pendingThresholdMs = DEFAULT_PENDING_THRESHOLD_MS,
    schedule = setTimeout,
    writeLine = (line) => process.stdout.write(`${line}\n`),
  }: WorkbenchAgentCommandLoggerOptions = {}) {
    this.cancel = cancel;
    this.now = now;
    this.pendingThresholdMs = pendingThresholdMs;
    this.schedule = schedule;
    this.writeLine = writeLine;
  }

  async run<TValue>(
    label: string,
    signal: AbortSignal,
    operation: () => Promise<TValue>,
    succeeded: (value: TValue) => boolean = () => true,
  ) {
    const startedAt = this.now();
    let timer: Timer | null = null;
    const warn = () => {
      this.writeLine(` CLI ${label} ${pendingToken()} after ${formatDuration(this.now() - startedAt)}`);
      timer = this.schedule(warn, PENDING_WARNING_INTERVAL_MS);
    };
    timer = this.schedule(warn, this.pendingThresholdMs);
    let outcome: WorkbenchAgentCommandLogOutcome = "error";
    try {
      const value = await operation();
      outcome = signal.aborted ? "cancelled" : succeeded(value) ? "ok" : "error";
      return value;
    } catch (error) {
      outcome = signal.aborted ? "cancelled" : "error";
      throw error;
    } finally {
      if (timer) this.cancel(timer);
      this.writeLine(` CLI ${label} ${completionToken(outcome)} in ${formatDuration(this.now() - startedAt)}`);
    }
  }
}
