/*
 * Exports:
 * - WorkbenchAgentCommandLogOutcome: terminal command timing outcomes.
 * - WorkbenchAgentCommandLoggerOptions: injectable clock and logging ports.
 * - WorkbenchAgentCommandFailureReader: maps a command result to its failure reason, or null when it succeeded.
 * - default WorkbenchAgentCommandLogger: own pending warnings, terminal timing logs and failure reasons for CLI/MCP commands.
 */

import { green, red, yellow } from "workbench-shared/process/terminal-style";
import { isWorkbenchAgentMcpRuntimeReloadInterruption } from "../lib/workbench/commands/workbench-agent-command-definition";

const DEFAULT_PENDING_THRESHOLD_MS = 2_000;
const PENDING_WARNING_INTERVAL_MS = 2_000;
const LOG_OMISSION_LABELS = new Set(["wb shell", "wb rg", "wb request user input", "wb subagent queue"]);
// Commands that wait by design: a "pending" warning every 2s is noise, their completion still logs.
const PENDING_WARNING_OMISSION_LABELS = new Set(["wb git arc wait", "wb subagent wait", "wb message wait"]);

type Timer = ReturnType<typeof setTimeout>;

export type WorkbenchAgentCommandLogOutcome = "cancelled" | "error" | "ok";

export type WorkbenchAgentCommandFailureReader<TValue> = (value: TValue) => Promise<string | null> | string | null;

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

function describeError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function completionToken(outcome: WorkbenchAgentCommandLogOutcome) {
  if (outcome === "ok") return green("ok");
  if (outcome === "cancelled") return yellow("cancelled");
  return red("error");
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
    readFailure: WorkbenchAgentCommandFailureReader<TValue> = () => null,
  ) {
    const omitted = LOG_OMISSION_LABELS.has(label);
    const startedAt = this.now();
    let timer: Timer | null = null;
    const warn = () => {
      this.writeLine(` CLI ${label} ${yellow("pending")} after ${formatDuration(this.now() - startedAt)}`);
      timer = this.schedule(warn, PENDING_WARNING_INTERVAL_MS);
    };
    if (!omitted && !PENDING_WARNING_OMISSION_LABELS.has(label)) {
      timer = this.schedule(warn, this.pendingThresholdMs);
    }
    let outcome: WorkbenchAgentCommandLogOutcome = "error";
    let failure: string | null = null;
    try {
      const value = await operation();
      const reloadInterrupted = isWorkbenchAgentMcpRuntimeReloadInterruption(signal.reason);
      if (signal.aborted && !reloadInterrupted) {
        outcome = "cancelled";
      } else {
        // A reason that cannot be read must not replace the command's own result.
        failure = await Promise.resolve(value).then(readFailure).catch(describeError);
        outcome = failure === null ? "ok" : "error";
      }
      return value;
    } catch (error) {
      outcome = signal.aborted ? "cancelled" : "error";
      if (outcome === "error") failure = describeError(error);
      throw error;
    } finally {
      if (timer) this.cancel(timer);
      if (
        !omitted && (
          !isWorkbenchAgentMcpRuntimeReloadInterruption(signal.reason)
          || outcome === "ok"
        )
      ) {
        this.writeLine(` CLI ${label} ${completionToken(outcome)} in ${formatDuration(this.now() - startedAt)}`);
        const reason = failure?.trimEnd();
        if (reason) this.writeLine(` CLI ${label} ${red(reason)}`);
      }
    }
  }
}
