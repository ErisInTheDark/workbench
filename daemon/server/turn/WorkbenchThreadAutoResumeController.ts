/*
 * Exports:
 * - AutoResumeThread: the saved facts one auto resume decision reads.
 * - countEndedAlike: how many of a thread's latest turns in a row ended this way.
 * - default WorkbenchThreadAutoResumeController: own when threads auto resume: attribute failed turns to usage limits by the provider's
 *   word or its account's cap, wait for quota, spread resumes out, re-gate a provider when one fails on the limit again, and apply the
 *   expired-cache setting. The thread's lifecycle is the durable arm, so this only holds timing, rebuilt each generation.
 */
import type { WorkbenchHarness } from "workbench-shared/types";
import type { WorkbenchThreadId, WorkbenchTurnId } from "workbench-shared/workbench/identity";
import { WorkbenchAccountLimits } from "workbench-shared/workbench/provider/provider-account";
import type { WorkbenchProviderObservation } from "workbench-shared/workbench/provider/provider-observation";
import type { ThreadAutoCompactAction, ThreadAutoCompactCause } from "workbench-shared/workbench/settings/thread-auto-compact";
import { ThreadAutoResumeRules, type ThreadAutoResumeSettings } from "workbench-shared/workbench/settings/thread-auto-resume";
import {
  getWorkbenchAutoResumeCause, getWorkbenchLifecycleTurnId, type WorkbenchThreadLifecycle,
} from "workbench-shared/workbench/thread/thread-state";

export interface AutoResumeThread {
  harness: WorkbenchHarness;
  threadId: WorkbenchThreadId;
  lifecycle: WorkbenchThreadLifecycle;
}

type Cause = "usageLimit" | "interrupted";

interface Tracked {
  harness: WorkbenchHarness;
  threadId: WorkbenchThreadId;
  dueAt: number;
}

/** Outlasts the split-second interrupted lifecycle inside a stop or refresh. */
const INTERRUPTED_GRACE_MS = 15_000;
/** Provider reset times are window boundaries; give them a moment to take effect. */
const RESET_GRACE_MS = 30_000;
const RESUME_SPACING_MS = 15_000;
const RETRY_BASE_MS = 300_000;
const RETRY_MAX_MS = 3_600_000;
/** Timers run late across OS sleep, so a wait never trusts one long timer. */
const MAX_TIMER_MS = 300_000;
/** How many latest turns in a row may end this way, the original turn included, before auto resume stops trying. */
const GIVE_UP_AFTER: Record<Cause, number> = { usageLimit: 7, interrupted: 4 };

export function countEndedAlike(statuses: readonly string[], status: "failed" | "interrupted") {
  const last = statuses.findLastIndex(candidate => candidate !== status);
  return statuses.length - 1 - last;
}

export default class WorkbenchThreadAutoResumeController {
  private readonly tracked = new Map<WorkbenchThreadId, Tracked>();
  /** No resume on this provider before this time: one failed on the limit, so its peers would too. */
  private readonly gates = new Map<WorkbenchHarness, number>();
  private readonly lastResumeAt = new Map<WorkbenchHarness, number>();
  private readonly schedule: (callback: () => void, delayMs: number) => unknown;
  private readonly cancel: (timer: unknown) => void;
  private timer: unknown | null = null;
  private passing = false;
  private passAgain = false;
  private retired = false;

  constructor(private readonly ports: {
    readSettings(): Promise<ThreadAutoResumeSettings>;
    listThreads(): Promise<AutoResumeThread[]>;
    readThread(threadId: WorkbenchThreadId): Promise<AutoResumeThread | null>;
    /** Null when the provider cannot say right now. */
    readLimits(harness: WorkbenchHarness): Promise<WorkbenchAccountLimits | null>;
    /** Every turn's status, oldest first. */
    readTurnStatuses(threadId: WorkbenchThreadId): Promise<readonly string[]>;
    /** Saves when this failed turn resumes, or null to leave it a plain thread error. */
    setResumeAt(thread: AutoResumeThread, turnId: WorkbenchTurnId, resumeAt: number | null): Promise<void>;
    /** Whether this thread's cache will have expired by then, going by its size and activity now. */
    cacheExpiredBy(threadId: WorkbenchThreadId, at: number): Promise<boolean>;
    /** Starts the resume; `onFailed` means it never ran, `onHeld` that a due compaction left it for the user. Throws only when not scheduled. */
    resume(thread: AutoResumeThread, turnId: WorkbenchTurnId, outcome: {
      whenCompactionDue: (cause: ThreadAutoCompactCause) => ThreadAutoCompactAction;
      onHeld(): Promise<void>;
      onFailed(): void;
    }): Promise<void>;
    schedule?(callback: () => void, delayMs: number): unknown;
    cancel?(timer: unknown): void;
    now(): number;
    warn(message: string): void;
  }) {
    this.schedule = ports.schedule ?? ((callback, delayMs) => {
      const timer = setTimeout(callback, delayMs);
      timer.unref?.();
      return timer;
    });
    this.cancel = ports.cancel ?? (timer => clearTimeout(timer as ReturnType<typeof setTimeout>));
  }

  /** Armed threads keep an unattended daemon awake, because nothing else would wake it to resume them. */
  hasPendingWork() { return this.tracked.size > 0; }

  /** Pick up threads armed before this generation, including overdue ones. */
  async start() {
    const now = this.ports.now();
    for (const thread of await this.ports.listThreads()) {
      if (this.retired) return;
      const cause = getWorkbenchAutoResumeCause(thread.lifecycle);
      if (!cause || this.tracked.has(thread.threadId)) continue;
      this.track(thread, cause === "interrupted" ? now + INTERRUPTED_GRACE_MS : (this.resumeAt(thread) ?? now) + RESET_GRACE_MS);
    }
    this.kick();
  }

  /** A provider's turn ended: arm the thread if it ended in a way auto resume continues. */
  observe(facts: WorkbenchProviderObservation) {
    const event = facts.lifecycle?.event;
    if (!facts.lifecycle || event?.kind !== "turnCompleted" || event.status === "completed" || this.retired) return;
    const { threadId } = facts.lifecycle;
    void this.arm(threadId, event.turnId, event.status, event.usageLimit).catch(error => this.warn(threadId, error));
  }

  /** A different account may have quota: whatever waits on this provider looks again now. */
  accountChanged(harness: WorkbenchHarness) {
    this.gates.delete(harness);
    const now = this.ports.now();
    for (const tracked of this.tracked.values()) if (tracked.harness === harness) tracked.dueAt = now;
    this.kick();
  }

  dispose() {
    this.retired = true;
    if (this.timer !== null) this.cancel(this.timer);
    this.timer = null;
    this.tracked.clear();
  }

  private resumeAt({ lifecycle }: AutoResumeThread) {
    return "resumeAt" in lifecycle ? lifecycle.resumeAt ?? null : null;
  }

  private track(thread: AutoResumeThread, dueAt: number) {
    this.tracked.set(thread.threadId, { harness: thread.harness, threadId: thread.threadId, dueAt });
  }

  private async arm(
    threadId: WorkbenchThreadId, turnId: WorkbenchTurnId, status: "failed" | "interrupted", signal: { resumeAt: number | null } | undefined,
  ) {
    const settings = await this.ports.readSettings();
    if (!settings.enabled) return;
    const thread = await this.ports.readThread(threadId);
    // A held question keeps its lifecycle through a turn's end, so that thread never reads as armed or failed here.
    if (!thread || getWorkbenchLifecycleTurnId(thread.lifecycle) !== turnId) return;
    if (status === "interrupted") {
      if (getWorkbenchAutoResumeCause(thread.lifecycle) !== "interrupted") return;
      this.track(thread, this.ports.now() + INTERRUPTED_GRACE_MS);
      this.kick();
      return;
    }
    if (thread.lifecycle.kind !== "needsAttention" || thread.lifecycle.reason !== "providerFailed") return;
    const attempts = await this.attempts(threadId, "failed");
    if (attempts >= GIVE_UP_AFTER.usageLimit) return;
    const limits = signal?.resumeAt ? null : await this.ports.readLimits(thread.harness);
    const cap = limits && WorkbenchAccountLimits.usageCap(limits);
    if (!signal && !cap) return;
    const now = this.ports.now();
    const resumeAt = signal?.resumeAt ?? cap?.resumeAt ?? now + Math.min(RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1), RETRY_MAX_MS);
    this.gate(thread.harness, resumeAt);
    // Waiting for its user after the reset, this thread must never promise a time it will not keep.
    if (settings.expiredCache === "wait" && await this.ports.cacheExpiredBy(threadId, resumeAt + RESET_GRACE_MS)) return;
    await this.ports.setResumeAt(thread, turnId, resumeAt);
    if (this.retired) return;
    this.track(thread, resumeAt + RESET_GRACE_MS);
    this.kick();
  }

  private async attempts(threadId: WorkbenchThreadId, status: "failed" | "interrupted") {
    return countEndedAlike(await this.ports.readTurnStatuses(threadId), status);
  }

  private gate(harness: WorkbenchHarness, resumeAt: number) {
    this.gates.set(harness, Math.max(this.gates.get(harness) ?? 0, resumeAt));
  }

  /** Run a pass now, or straight after the running one; one timer and one pass ever run. */
  private kick() {
    if (this.retired) return;
    if (this.passing) { this.passAgain = true; return; }
    if (this.timer !== null) this.cancel(this.timer);
    this.timer = null;
    this.passing = true;
    let failed = false;
    void this.pass().catch(error => {
      failed = true;
      this.ports.warn(`Auto resume pass failed: ${error instanceof Error ? error.message.slice(0, 300) : String(error)}`);
    }).finally(() => {
      this.passing = false;
      if (this.passAgain) { this.passAgain = false; this.kick(); } else this.scheduleNext(failed ? RESUME_SPACING_MS : 0);
    });
  }

  private earliest(tracked: Tracked) {
    return Math.max(tracked.dueAt, (this.gates.get(tracked.harness) ?? -Infinity) + RESET_GRACE_MS, (this.lastResumeAt.get(tracked.harness) ?? -Infinity) + RESUME_SPACING_MS);
  }

  private scheduleNext(minimumDelayMs: number) {
    if (this.retired || !this.tracked.size) return;
    const next = Math.min(...[...this.tracked.values()].map(tracked => this.earliest(tracked)));
    this.timer = this.schedule(() => { this.timer = null; this.kick(); }, Math.max(minimumDelayMs, Math.min(next - this.ports.now(), MAX_TIMER_MS)));
  }

  private async pass() {
    const settings = await this.ports.readSettings();
    for (const tracked of [...this.tracked.values()].sort((left, right) => left.dueAt - right.dueAt)) {
      if (this.retired) return;
      const thread = await this.ports.readThread(tracked.threadId);
      const cause = thread && getWorkbenchAutoResumeCause(thread.lifecycle);
      const turnId = thread && getWorkbenchLifecycleTurnId(thread.lifecycle);
      if (!thread || !cause || !turnId) { this.tracked.delete(tracked.threadId); continue; }
      // A peer failed on the limit after this was scheduled, so this thread's saved time was too early.
      const resumeAt = this.resumeAt(thread);
      const gate = this.gates.get(tracked.harness);
      if (cause === "usageLimit" && gate !== undefined && resumeAt !== null && resumeAt < gate) {
        await this.ports.setResumeAt(thread, turnId, gate);
      }
      if (!settings.enabled) {
        this.tracked.delete(tracked.threadId);
        if (cause === "usageLimit") await this.ports.setResumeAt(thread, turnId, null);
        continue;
      }
      if (this.earliest(tracked) > this.ports.now()) continue;
      if (cause === "interrupted" && await this.attempts(tracked.threadId, "interrupted") >= GIVE_UP_AFTER.interrupted) {
        this.tracked.delete(tracked.threadId);
        continue;
      }
      if (cause === "usageLimit" && await this.moveToLaterReset(thread, turnId, tracked)) continue;
      this.tracked.delete(tracked.threadId);
      this.lastResumeAt.set(tracked.harness, this.ports.now());
      await this.ports.resume(thread, turnId, {
        whenCompactionDue: dueCause => ThreadAutoResumeRules.whenCompactionDue(settings, dueCause),
        // Its promised time can no longer hold; an interrupted thread promised nothing and is asked again next generation.
        onHeld: async () => { if (cause === "usageLimit") await this.ports.setResumeAt(thread, turnId, null); },
        onFailed: () => {
          // A compaction or admission failure: the lifecycle still arms this thread, so only the timing moves.
          if (this.retired) return;
          this.track(thread, this.ports.now() + RETRY_BASE_MS);
          this.kick();
        },
      });
    }
  }

  /** Quota is the last word before spending a turn: still capped with a later reset means keep waiting. */
  private async moveToLaterReset(thread: AutoResumeThread, turnId: WorkbenchTurnId, tracked: Tracked) {
    const limits = await this.ports.readLimits(thread.harness);
    const reset = limits && WorkbenchAccountLimits.usageCap(limits)?.resumeAt;
    if (!reset || reset <= this.ports.now()) return false;
    await this.ports.setResumeAt(thread, turnId, reset);
    tracked.dueAt = reset + RESET_GRACE_MS;
    this.gate(thread.harness, reset);
    return true;
  }

  private warn(threadId: string, error: unknown) {
    this.ports.warn(`Auto resume failed for ${threadId.slice(0, 120)}: ${error instanceof Error ? error.message.slice(0, 300) : String(error)}`);
  }
}
