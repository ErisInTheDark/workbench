/*
 * Exports:
 * - WorkbenchBrowserLogForwarderOptions/default WorkbenchBrowserLogForwarder: preserve and forward browser warnings, errors, and uncaught failures. Keywords: browser, logging, diagnostics.
 */
export interface WorkbenchBrowserLogForwarderOptions {
  console?: Pick<Console, "error" | "warn">;
  fetcher?: typeof fetch;
  schedule?: (callback: () => void) => void;
  target?: Pick<Window, "addEventListener" | "removeEventListener">;
}

interface ClientLogEntry {
  level: "error" | "warn";
  message: string;
}

const MAX_DEPTH = 4;
const MAX_MESSAGE_LENGTH = 8_000;
const MAX_QUEUE_LENGTH = 500;
const MAX_BATCH_LENGTH = 100;

function bounded(value: string) {
  return value.length <= MAX_MESSAGE_LENGTH ? value : `${value.slice(0, MAX_MESSAGE_LENGTH - 14)} [truncated]`;
}

function formatValue(value: unknown, seen: WeakSet<object>, depth = 0): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined || typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (typeof value === "symbol" || typeof value === "function") return String(value);
  if (value instanceof Error) return [value.name, value.message, value.stack].filter(Boolean).join(": ");
  if (typeof value !== "object" || value === null) return String(value);
  const objectValue = value;
  if (depth >= MAX_DEPTH) return "[depth limited]";
  if (seen.has(objectValue)) return "[circular]";
  seen.add(objectValue);
  try {
    if (Array.isArray(objectValue)) return `[${objectValue.map((item) => formatValue(item, seen, depth + 1)).join(", ")}]`;
    const name = objectValue.constructor?.name && objectValue.constructor.name !== "Object" ? `${objectValue.constructor.name} ` : "";
    const fields = Object.entries(objectValue).slice(0, 50).map(([key, item]) => (
      `${key}: ${formatValue(item, seen, depth + 1)}`
    ));
    return `${name}{${fields.join(", ")}}`;
  } catch {
    try { return String(value); } catch { return "[unprintable]"; }
  } finally {
    seen.delete(objectValue);
  }
}

function formatValues(values: readonly unknown[]) {
  return bounded(values.map((value) => formatValue(value, new WeakSet())).join(" "));
}

export default class WorkbenchBrowserLogForwarder {
  private readonly console: Pick<Console, "error" | "warn">;
  private disposed = false;
  private readonly fetcher: typeof fetch;
  private flushing = false;
  private installed = false;
  private readonly originalError: Console["error"];
  private readonly originalWarn: Console["warn"];
  private readonly queue: ClientLogEntry[] = [];
  private readonly schedule: (callback: () => void) => void;
  private scheduled = false;
  private readonly target: Pick<Window, "addEventListener" | "removeEventListener">;
  private readonly wrappedError: Console["error"];
  private readonly wrappedWarn: Console["warn"];

  constructor(options: WorkbenchBrowserLogForwarderOptions = {}) {
    this.console = options.console ?? console;
    this.fetcher = options.fetcher ?? globalThis.fetch;
    this.originalError = this.console.error;
    this.originalWarn = this.console.warn;
    this.schedule = options.schedule ?? queueMicrotask;
    this.target = options.target ?? window;
    this.wrappedError = (...values) => {
      this.originalError.apply(this.console, values);
      this.enqueue("error", values);
    };
    this.wrappedWarn = (...values) => {
      this.originalWarn.apply(this.console, values);
      this.enqueue("warn", values);
    };
  }

  install() {
    if (this.installed) return;
    this.installed = true;
    this.console.error = this.wrappedError;
    this.console.warn = this.wrappedWarn;
    this.target.addEventListener("error", this.onError);
    this.target.addEventListener("unhandledrejection", this.onUnhandledRejection);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.console.error === this.wrappedError) this.console.error = this.originalError;
    if (this.console.warn === this.wrappedWarn) this.console.warn = this.originalWarn;
    this.target.removeEventListener("error", this.onError);
    this.target.removeEventListener("unhandledrejection", this.onUnhandledRejection);
    this.queue.length = 0;
  }

  private readonly onError = (event: Event) => {
    const error = event as ErrorEvent;
    this.enqueue("error", [error.error ?? error.message, error.filename, error.lineno, error.colno]);
  };

  private readonly onUnhandledRejection = (event: Event) => {
    this.enqueue("error", ["Unhandled promise rejection:", (event as PromiseRejectionEvent).reason]);
  };

  private enqueue(level: ClientLogEntry["level"], values: readonly unknown[]) {
    if (this.disposed) return;
    if (this.queue.length >= MAX_QUEUE_LENGTH) {
      if (this.queue.at(-1)?.message !== "Client log queue overflowed; further entries were dropped.") {
        this.queue[MAX_QUEUE_LENGTH - 1] = {
          level: "error",
          message: "Client log queue overflowed; further entries were dropped.",
        };
      }
      return;
    }
    this.queue.push({ level, message: formatValues(values) || "<empty diagnostic>" });
    this.requestFlush();
  }

  private requestFlush() {
    if (this.scheduled || this.flushing || this.disposed) return;
    this.scheduled = true;
    this.schedule(() => {
      this.scheduled = false;
      void this.flush();
    });
  }

  private async flush() {
    if (this.flushing || this.disposed || !this.queue.length) return;
    this.flushing = true;
    const entries = this.queue.splice(0, MAX_BATCH_LENGTH);
    try {
      const response = await this.fetcher.call(globalThis, "/api/workbench-client-log", {
        body: JSON.stringify({ entries }),
        headers: { "Content-Type": "application/json" },
        keepalive: true,
        method: "POST",
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    } catch (error) {
      this.originalError.call(
        this.console,
        "Workbench could not forward browser diagnostics to the app server.",
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      this.flushing = false;
      this.requestFlush();
    }
  }
}
