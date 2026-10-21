/*
 * Exports:
 * - WorkbenchAccountLimitsFact: one provider's observed limits and read freshness.
 * - default WorkbenchAccountLimitsController: own one shared, demand-driven limits read per provider: on first demand, at most
 *   every 15s while that provider is active, and every 5 minutes otherwise.
 */
import type { WorkbenchHarness } from "workbench-shared/types";
import type { WorkbenchAccountLimits } from "workbench-shared/workbench/provider/provider-account";
import { areDeeplyEqual } from "workbench-shared/workbench/deep-equality";

/** Limits move only when tokens are spent; activity rereads are spaced so a busy provider costs one read per window. */
const ACTIVE_READ_INTERVAL_MS = 15_000;
/** Usage elsewhere (another device, the provider's own app) still shows up while Workbench is idle. */
const IDLE_READ_INTERVAL_MS = 300_000;

export interface WorkbenchAccountLimitsFact {
  phase: "pending" | "current" | "stale" | "failed" | "unavailable";
  failure: string | null;
  limits: WorkbenchAccountLimits | null;
}

interface ProviderState {
  listeners: Set<() => void>;
  fact: WorkbenchAccountLimitsFact;
  lastReadAt: number | null;
  reading: boolean;
  /** Activity arrived during a read: the next read is due one active interval after this one. */
  activeSinceRead: boolean;
  timer: { cancel(): void; dueAt: number } | null;
}

interface Options {
  /** Null when the provider does not report limits. */
  read(harness: WorkbenchHarness): Promise<WorkbenchAccountLimits> | null;
  record(harness: WorkbenchHarness, limits: WorkbenchAccountLimits): void;
  warn(message: string): void;
  now?(): number;
  schedule?(run: () => void, delayMs: number): () => void;
}

function defaultSchedule(run: () => void, delayMs: number) {
  const timer = setTimeout(run, delayMs);
  timer.unref?.();
  return () => clearTimeout(timer);
}

export default class WorkbenchAccountLimitsController {
  private readonly providers = new Map<WorkbenchHarness, ProviderState>();
  private disposed = false;

  constructor(private readonly options: Options) {}

  observe(harness: WorkbenchHarness, listener: () => void) {
    if (this.disposed) throw new Error("Account limits are reloading.");
    const state = this.state(harness);
    state.listeners.add(listener);
    const stale = state.lastReadAt === null || this.now() - state.lastReadAt >= ACTIVE_READ_INTERVAL_MS;
    // A read in flight answers this observer too.
    if (!state.reading) {
      if (stale) this.read(harness, state);
      else if (!state.timer) this.schedule(harness, state, state.lastReadAt! + IDLE_READ_INTERVAL_MS);
    }
    let released = false;
    return {
      read: () => state.fact,
      release: () => {
        if (released) return;
        released = true;
        state.listeners.delete(listener);
        if (state.listeners.size) return;
        state.timer?.cancel();
        state.timer = null;
      },
    };
  }

  /** A provider event: its turns may be spending tokens, so its limits are due within one active interval. */
  noteActivity(harness: WorkbenchHarness) {
    const state = this.providers.get(harness);
    if (this.disposed || !state?.listeners.size) return;
    if (state.reading) { state.activeSinceRead = true; return; }
    const dueAt = (state.lastReadAt ?? 0) + ACTIVE_READ_INTERVAL_MS;
    if (dueAt <= this.now()) this.read(harness, state);
    else if (!state.timer || state.timer.dueAt > dueAt) this.schedule(harness, state, dueAt);
  }

  dispose() {
    this.disposed = true;
    for (const state of this.providers.values()) {
      state.timer?.cancel();
      state.timer = null;
      state.listeners.clear();
    }
    this.providers.clear();
  }

  private state(harness: WorkbenchHarness) {
    let state = this.providers.get(harness);
    if (!state) {
      state = {
        listeners: new Set(), fact: { phase: "pending", failure: null, limits: null },
        lastReadAt: null, reading: false, activeSinceRead: false, timer: null,
      };
      this.providers.set(harness, state);
    }
    return state;
  }

  private now() { return (this.options.now ?? Date.now)(); }

  private schedule(harness: WorkbenchHarness, state: ProviderState, dueAt: number) {
    state.timer?.cancel();
    const cancel = (this.options.schedule ?? defaultSchedule)(() => {
      if (state.timer?.cancel !== cancel) return;
      state.timer = null;
      if (!this.disposed && state.listeners.size) this.read(harness, state);
    }, Math.max(0, dueAt - this.now()));
    state.timer = { cancel, dueAt };
  }

  private read(harness: WorkbenchHarness, state: ProviderState) {
    state.timer?.cancel();
    state.timer = null;
    const pending = this.options.read(harness);
    if (!pending) {
      this.publish(state, { phase: "unavailable", failure: "This provider does not report account limits.", limits: null });
      return;
    }
    state.reading = true;
    state.activeSinceRead = false;
    void pending.then(limits => {
      if (this.disposed) return;
      this.options.record(harness, limits);
      this.publish(state, { phase: "current", failure: null, limits });
    }, (error: unknown) => {
      if (this.disposed) return;
      const failure = (error instanceof Error ? error.message : "Account limits read failed.")
        .replace(/[\u0000-\u001f\u007f-\u009f]/gu, "").slice(0, 500);
      this.options.warn(`Account limits read failed for ${harness}: ${failure}`);
      this.publish(state, { phase: state.fact.limits ? "stale" : "failed", failure, limits: state.fact.limits });
    }).finally(() => {
      if (this.disposed) return;
      state.reading = false;
      state.lastReadAt = this.now();
      if (!state.listeners.size) return;
      this.schedule(harness, state, state.lastReadAt
        + (state.activeSinceRead ? ACTIVE_READ_INTERVAL_MS : IDLE_READ_INTERVAL_MS));
    });
  }

  private publish(state: ProviderState, fact: WorkbenchAccountLimitsFact) {
    if (areDeeplyEqual(state.fact, fact)) return;
    state.fact = fact;
    for (const listener of [...state.listeners]) listener();
  }
}
