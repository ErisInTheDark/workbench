/*
 * Keywords: websocket, event, logging, throttle, independent windows.
 * Exports:
 * - WorkbenchWebSocketEventLogOptions: clock, scheduler and log ports.
 * - default WorkbenchWebSocketEventLog: aggregate traffic logs independently per event type and direction.
 */
import type { WorkbenchHarness } from "workbench-shared/types";
import { WORKBENCH_EVENT_STREAM_ACK_METHOD } from "workbench-shared/workbench/websocket-stream";
import { formatWebSocketEventSummary, webSocketMethodLabel } from "./websocket-log-format";

type Timer = ReturnType<typeof setTimeout>;
const WINDOW_MS = 2_000;
const EXCLUDED_EVENTS = new Set([
  `in:${webSocketMethodLabel("workbench", WORKBENCH_EVENT_STREAM_ACK_METHOD)}`,
]);

interface EventWindow {
  bytes: number;
  count: number;
  deadline: number;
  direction: "in" | "out";
  label: string;
}

export interface WorkbenchWebSocketEventLogOptions {
  clearTimeout?: (timer: Timer) => void;
  now?: () => number;
  setTimeout?: (callback: () => void, delayMs: number) => Timer;
  writeLine?: (line: string) => void;
}

export default class WorkbenchWebSocketEventLog {
  private readonly cancel: NonNullable<WorkbenchWebSocketEventLogOptions["clearTimeout"]>;
  private disposed = false;
  private readonly now: NonNullable<WorkbenchWebSocketEventLogOptions["now"]>;
  private readonly schedule: NonNullable<WorkbenchWebSocketEventLogOptions["setTimeout"]>;
  private timer: Timer | null = null;
  private readonly windows = new Map<string, EventWindow>();
  private readonly writeLine: NonNullable<WorkbenchWebSocketEventLogOptions["writeLine"]>;

  constructor({
    clearTimeout: cancel = clearTimeout,
    now = Date.now,
    setTimeout: schedule = setTimeout,
    writeLine = (line) => process.stdout.write(`${line}\n`),
  }: WorkbenchWebSocketEventLogOptions = {}) {
    this.cancel = cancel;
    this.now = now;
    this.schedule = schedule;
    this.writeLine = writeLine;
  }

  record(direction: "in" | "out", harness: WorkbenchHarness | "unknown" | "workbench", method: string, bytes: number) {
    if (this.disposed) return;
    const label = webSocketMethodLabel(harness, method);
    const key = `${direction}:${label}`;
    if (EXCLUDED_EVENTS.has(key)) return;
    const window = this.windows.get(key) ?? {
      bytes: 0, count: 0, deadline: this.now() + WINDOW_MS, direction, label,
    };
    window.bytes += bytes;
    window.count += 1;
    this.windows.set(key, window);
    this.scheduleNext();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer !== null) this.cancel(this.timer);
    this.timer = null;
    for (const window of this.windows.values()) this.flush(window);
    this.windows.clear();
  }

  private scheduleNext() {
    if (this.timer !== null || !this.windows.size || this.disposed) return;
    let deadline = Infinity;
    for (const window of this.windows.values()) deadline = Math.min(deadline, window.deadline);
    this.timer = this.schedule(() => {
      this.timer = null;
      const now = this.now();
      for (const [key, window] of this.windows) {
        if (window.deadline > now) continue;
        this.windows.delete(key);
        this.flush(window);
      }
      this.scheduleNext();
    }, Math.max(0, deadline - this.now()));
  }

  private flush(window: EventWindow) {
    this.writeLine(formatWebSocketEventSummary(window.direction, window.label, window.count, window.bytes));
  }
}
