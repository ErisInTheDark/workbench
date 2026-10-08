/*
 * Exports:
 * - WebSocketEventSubject: the threads one event is about, for subject-grouped lines.
 * - WorkbenchWebSocketEventLogOptions: clock, scheduler and log ports.
 * - default WorkbenchWebSocketEventLog: aggregate traffic logs per subject when events name one, else per event type, inner event detail and direction.
 */
import type { WorkbenchHarness } from "workbench-shared/types";
import { WORKBENCH_EVENT_STREAM_ACK_METHOD } from "workbench-shared/workbench/websocket-stream";
import { webSocketMethodLabel } from "./websocket-log-format";
import {
  formatWebSocketEventSummary, formatWebSocketSubjectSummary, webSocketSubjectKey, type WebSocketSubjectWindow,
} from "workbench-shared/process/websocket-traffic-format";

/** The threads an event is about; `kind` replaces the method label in the subject line (e.g. an observation kind). */
export interface WebSocketEventSubject {
  subjects: readonly string[];
  fields: readonly string[];
  kind?: string;
}

type Timer = ReturnType<typeof setTimeout>;
const DEFAULT_WINDOW_MS = 2_000;
const FREQUENT_OUTBOUND_WINDOW_MS = 10_000;
const FREQUENT_OUTBOUND_LABELS = new Set([
  "codex:item/started",
  "codex:item/completed",
  "codex:item/fileChange/patchUpdated",
  "codex:hook/started",
  "codex:hook/completed",
  "codex:item/reasoning/summaryPartAdded",
  "codex:item/reasoning/summaryTextDelta",
  "codex:thread/tokenUsage/updated",
  "codex:account/rateLimits/updated",
  "wb:thread-state/updated",
]);
const EXCLUDED_EVENTS = new Set([
  `in:${webSocketMethodLabel("workbench", WORKBENCH_EVENT_STREAM_ACK_METHOD)}`,
]);

interface EventWindow {
  bytes: number;
  count: number;
  deadline: number;
  direction: "in" | "out";
  label: string;
  windowMs: number;
}

export interface WorkbenchWebSocketEventLogOptions {
  clearTimeout?: (timer: Timer) => void;
  now?: () => number;
  setTimeout?: (callback: () => void, delayMs: number) => Timer;
  writeLine?: (line: string) => void;
}

export default class WorkbenchWebSocketEventLog {
  private readonly cancel: NonNullable<WorkbenchWebSocketEventLogOptions["clearTimeout"]>;
  private state: "active" | "suspended" | "disposed" = "active";
  private readonly now: NonNullable<WorkbenchWebSocketEventLogOptions["now"]>;
  private readonly schedule: NonNullable<WorkbenchWebSocketEventLogOptions["setTimeout"]>;
  private timer: Timer | null = null;
  private timerDeadline: number | null = null;
  private readonly windows = new Map<string, EventWindow>();
  private readonly subjectWindows = new Map<string, WebSocketSubjectWindow & { deadline: number }>();
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

  /**
   * `detail` names the event inside an envelope; each detail rolls up in its own window. Events naming `subject`
   * threads instead roll up per subject set, so everything one thread did in a window reads as one line.
   */
  record(
    direction: "in" | "out", harness: WorkbenchHarness | "unknown" | "workbench", method: string, bytes: number,
    detail: string | null = null, subject: WebSocketEventSubject | null = null,
  ) {
    if (this.state !== "active") return;
    const methodLabel = webSocketMethodLabel(harness, method);
    if (EXCLUDED_EVENTS.has(`${direction}:${methodLabel}`)) return;
    if (subject?.subjects.length) {
      this.recordSubject(direction, subject.kind ?? methodLabel, subject, bytes);
      return;
    }
    const label = detail ? `${methodLabel} ${detail}` : methodLabel;
    const key = `${direction}:${label}`;
    const now = this.now();
    const window = this.windows.get(key) ?? {
      bytes: 0,
      count: 0,
      deadline: now,
      direction,
      label,
      windowMs: direction === "out" && FREQUENT_OUTBOUND_LABELS.has(methodLabel)
        ? FREQUENT_OUTBOUND_WINDOW_MS
        : DEFAULT_WINDOW_MS,
    };
    window.bytes += bytes;
    window.count += 1;
    this.windows.set(key, window);
    if (window.deadline <= now) {
      this.flush(window);
      window.deadline = now + window.windowMs;
    }
    this.scheduleNext();
  }

  /** A subject window opens on its first event and logs once when its window ends. */
  private recordSubject(direction: "in" | "out", kind: string, subject: WebSocketEventSubject, bytes: number) {
    const key = webSocketSubjectKey(direction, subject.subjects);
    const window = this.subjectWindows.get(key) ?? {
      direction, subjects: subject.subjects, kinds: new Set<string>(), fields: new Set<string>(),
      connections: new Set<string>(), count: 0, bytes: 0, deadline: this.now() + DEFAULT_WINDOW_MS,
    };
    window.kinds.add(kind);
    for (const field of subject.fields) window.fields.add(field);
    window.count += 1;
    window.bytes += bytes;
    this.subjectWindows.set(key, window);
    this.scheduleNext();
  }

  dispose() {
    if (this.state === "disposed") return;
    this.state = "disposed";
    if (this.timer !== null) this.cancel(this.timer);
    this.timer = null;
    this.timerDeadline = null;
    for (const window of this.windows.values()) this.flush(window);
    this.windows.clear();
    for (const window of this.subjectWindows.values()) this.writeLine(formatWebSocketSubjectSummary(window));
    this.subjectWindows.clear();
  }

  suspend() {
    if (this.state === "disposed") throw new Error("WebSocket event log is disposed.");
    this.state = "suspended";
    if (this.timer !== null) this.cancel(this.timer);
    this.timer = null;
    this.timerDeadline = null;
  }

  resumeAfterFailedReload() {
    if (this.state === "disposed") throw new Error("WebSocket event log is disposed.");
    this.state = "active";
    this.scheduleNext();
  }

  private scheduleNext() {
    if ((!this.windows.size && !this.subjectWindows.size) || this.state !== "active") return;
    let deadline = Infinity;
    for (const window of this.windows.values()) deadline = Math.min(deadline, window.deadline);
    for (const window of this.subjectWindows.values()) deadline = Math.min(deadline, window.deadline);
    if (this.timer !== null) {
      if (this.timerDeadline !== null && this.timerDeadline <= deadline) return;
      this.cancel(this.timer);
      this.timer = null;
      this.timerDeadline = null;
    }
    const timer = this.schedule(() => {
      if (this.timer !== timer || this.state !== "active") return;
      this.timer = null;
      this.timerDeadline = null;
      const now = this.now();
      for (const [key, window] of this.windows) {
        if (window.deadline > now) continue;
        if (window.count === 0) {
          this.windows.delete(key);
        } else {
          this.flush(window);
          window.deadline = now + window.windowMs;
        }
      }
      for (const [key, window] of this.subjectWindows) {
        if (window.deadline > now) continue;
        this.subjectWindows.delete(key);
        this.writeLine(formatWebSocketSubjectSummary(window));
      }
      this.scheduleNext();
    }, Math.max(0, deadline - this.now()));
    this.timer = timer;
    this.timerDeadline = deadline;
  }

  private flush(window: EventWindow) {
    if (window.count === 0) return;
    this.writeLine(formatWebSocketEventSummary(window.direction, window.label, window.count, window.bytes));
    window.count = 0;
    window.bytes = 0;
  }
}
