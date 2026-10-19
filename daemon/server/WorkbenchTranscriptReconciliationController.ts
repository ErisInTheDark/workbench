/*
 * Exports:
 * - WorkbenchTranscriptReconciliationOptions: canonical resolution, storage, reload-lease and native recovery ports.
 * - default WorkbenchTranscriptReconciliationController: own serial demanded recovery entered under each waiter's reload lease, coalesced
 *   observed-thread restoration, change reporting, and capture-gap healing.
 */
import type { WorkbenchThreadReconcile, WorkbenchThreadReconcileResult } from "workbench-shared/workbench/thread/thread-actions";
import { ThreadReferenceSchema } from "workbench-shared/workbench/identity";
import type WorkbenchThreadIdentityController from "./WorkbenchThreadIdentityController";
import type WorkbenchTranscriptReader from "./WorkbenchTranscriptReader";

export interface WorkbenchTranscriptReconciliationOptions {
  identities: Pick<WorkbenchThreadIdentityController, "resolve">;
  transcripts: Pick<WorkbenchTranscriptReader, "catalog">;
  isThreadObserved(threadId: string): boolean;
  readPreviousCursor(threadId: string, turnId: string): Promise<string | null | undefined>;
  readMaterializedTurnIds(threadId: string, turnIds: readonly string[]): Promise<string[]>;
  /** Open capture gaps of a canonical thread, with the anchor turns no window has re-read yet. */
  readRecoveryGaps(threadId: string): Promise<ReadonlyArray<{ id: string; turnIds: readonly string[] }>>;
  /** Threads each transcript commit changed; lets a window report whether it changed anything. */
  subscribeSettled?(listener: (threadIds: readonly string[]) => void): () => void;
  /** Run work under a reload lease on the harness's provider, entered from the calling async context. */
  lease(harness: string, work: () => Promise<void>): Promise<void>;
  recover(input: WorkbenchThreadReconcile & { harness: string; gapIds: string[] }, signal: AbortSignal): Promise<WorkbenchThreadReconcileResult>;
  warn(message: string): void;
}

type Target = WorkbenchThreadReconcile & { harness: string };
type Job = {
  target: Target;
  onlyWhileObserved: boolean;
  controller: AbortController;
  result: ReturnType<typeof Promise.withResolvers<WorkbenchThreadReconcileResult>>;
  /** queued: no lease entered yet; entered: one waiter's lease runs it; settled: its result is final. */
  state: "queued" | "entered" | "settled";
  /** A commit for this thread landed while the window ran. */
  changed?: boolean;
};

/** One redacted, single-line, bounded failure message. */
function boundedMessage(error: unknown) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\b(Bearer\s+)[^\s,;]+/giu, "$1[redacted]")
    .replace(/\b(api[_-]?key|authorization|secret|token)(\s*[:=]\s*)[^\s,;]+/giu, "$1$2[redacted]")
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, "?").slice(0, 500);
}

function sameWindow(left: Target, right: Target) {
  if (left.threadId !== right.threadId || left.harness !== right.harness || left.target.mode !== right.target.mode
    || left.explicit !== right.explicit) return false;
  if (left.target.mode === "exact" && right.target.mode === "exact") return left.target.turnId === right.target.turnId;
  if (left.target.mode === "previous" && right.target.mode === "previous") return left.target.beforeTurnId === right.target.beforeTurnId;
  return true;
}

export default class WorkbenchTranscriptReconciliationController {
  private readonly controller = new AbortController();
  /** Jobs not running yet, in demand order; later demands coalesce onto them. */
  private readonly queue: Job[] = [];
  private active: Job | null = null;
  /** Settles once the last entered job has left the one-at-a-time lane. */
  private lane: Promise<void> = Promise.resolve();
  /** Lease attempts not settled yet, including ones still waiting at a reload gate. */
  private readonly entries = new Set<Promise<void>>();
  private readonly stopSettled: () => void;
  /** `${gapId}:${turnId}` anchors already queued for healing; an unrecoverable turn warns once, not on every visit. */
  private readonly healedAnchors = new Set<string>();
  private readonly observedRecoveries = new Map<string, Promise<void>>();

  constructor(private readonly options: WorkbenchTranscriptReconciliationOptions) {
    this.stopSettled = options.subscribeSettled?.(threadIds => {
      if (this.active && threadIds.includes(this.active.target.threadId)) this.active.changed = true;
    }) ?? (() => undefined);
  }

  async reconcile(input: WorkbenchThreadReconcile, signal?: AbortSignal): Promise<WorkbenchThreadReconcileResult> {
    this.controller.signal.throwIfAborted();
    signal?.throwIfAborted();
    const target = await this.resolveTarget(input);
    this.controller.signal.throwIfAborted();
    signal?.throwIfAborted();
    if (!target) return { turnIds: [], exhausted: true };
    return this.enqueue(target, signal);
  }

  async recoverObservedThread(threadId: string) {
    try {
      this.controller.signal.throwIfAborted();
      const identity = await this.options.identities.resolve({ threadId: ThreadReferenceSchema.parse(threadId) });
      this.controller.signal.throwIfAborted();
      if (!identity || !this.options.isThreadObserved(identity.threadId)) return;
      const existing = this.observedRecoveries.get(identity.threadId);
      if (existing) return await existing;
      const task = this.recoverObservedHistory(identity.threadId)
        .finally(() => { this.observedRecoveries.delete(identity.threadId); });
      this.observedRecoveries.set(identity.threadId, task);
      await task;
    } catch (error) {
      if (!this.controller.signal.aborted) this.options.warn(`[transcript-reconciliation] observed recovery failed: ${boundedMessage(error)}`);
    }
  }

  private async recoverObservedHistory(threadId: string) {
    const catalog = await this.options.transcripts.catalog(threadId);
    const expired = new Set(catalog?.expiredTurnPayloads?.map(payload => payload.turnId));
    for (const turn of (catalog?.turns ?? []).toReversed()) {
      this.controller.signal.throwIfAborted();
      if (!this.options.isThreadObserved(threadId)) return;
      if (!expired.has(turn.id)) continue;
      if (!turn.native_turn_id) {
        this.options.warn(`[transcript-reconciliation] expired turn has no provider recovery identity: ${boundedMessage(turn.id)}`);
        continue;
      }
      const result = await this.enqueue({
        threadId, harness: turn.harness_id, target: { mode: "exact", turnId: turn.id }, refresh: false, explicit: true,
      }, undefined, true).catch(() => null); // The queue reports failures; one unavailable turn must not strand the rest.
      if (!this.options.isThreadObserved(threadId)) return;
      if (result && !result.turnIds.includes(turn.id)) {
        this.options.warn(`[transcript-reconciliation] provider did not recover expired turn: ${boundedMessage(turn.id)}`);
      }
    }
    await this.recoverMissingHistory(threadId);
  }

  private async recoverMissingHistory(threadId: string) {
    let catalog = await this.options.transcripts.catalog(threadId);
    while (this.options.isThreadObserved(threadId)) {
      this.controller.signal.throwIfAborted();
      const before = catalog?.turns[0];
      const materialized = new Set(await this.options.readMaterializedTurnIds(threadId, catalog?.turns.map(turn => turn.id) ?? []));
      const missing = catalog?.turns.findLast(turn => !materialized.has(turn.id));
      let target: Target | null;
      if (missing) {
        if (!missing.native_turn_id) {
          this.options.warn(`[transcript-reconciliation] missing turn has no provider recovery identity: ${boundedMessage(missing.id)}`);
          return;
        }
        target = {
          threadId, harness: missing.harness_id, target: { mode: "exact", turnId: missing.id },
          refresh: false, explicit: true,
        };
      } else if (before) {
        if (!before.native_turn_id || typeof await this.options.readPreviousCursor(threadId, before.id) !== "string") return;
        target = {
          threadId, harness: before.harness_id, target: { mode: "previous", beforeTurnId: before.id },
          refresh: false, explicit: true,
        };
      } else {
        target = await this.resolveTarget({ threadId, target: { mode: "latest" }, refresh: false, explicit: true });
      }
      if (!target) return;
      const result = await this.enqueue(target, undefined, true).catch(() => null);
      if (!result || !this.options.isThreadObserved(threadId)) return;
      catalog = await this.options.transcripts.catalog(threadId);
      if (missing) {
        if ((await this.options.readMaterializedTurnIds(threadId, [missing.id])).includes(missing.id)) continue;
        this.options.warn(`[transcript-reconciliation] provider did not materialise requested turn: ${boundedMessage(missing.id)}`);
        return;
      }
      const oldest = catalog?.turns[0];
      if (!oldest || oldest.id === before?.id) {
        if (!result.exhausted || result.turnIds.length) {
          this.options.warn(`[transcript-reconciliation] provider made no stored history progress: ${boundedMessage(threadId)}`);
        }
        return;
      }
      if (result.exhausted) return;
    }
  }

  /**
   * Queue one exact re-read for each open-gap anchor of the thread not healed yet. Never rejects: queued windows warn
   * through the drain, and every earlier failure warns here.
   */
  async healCaptureGaps(threadId: string) {
    try {
      this.controller.signal.throwIfAborted();
      const identity = await this.options.identities.resolve({ threadId: ThreadReferenceSchema.parse(threadId) });
      if (!identity) return;
      const turnIds = new Set<string>();
      for (const gap of await this.options.readRecoveryGaps(identity.threadId)) {
        for (const turnId of gap.turnIds) {
          const key = `${gap.id}:${turnId}`;
          if (this.healedAnchors.has(key)) continue;
          this.healedAnchors.add(key);
          turnIds.add(turnId);
        }
      }
      for (const turnId of turnIds) {
        this.controller.signal.throwIfAborted();
        const target = await this.resolveTarget({ threadId: identity.threadId, target: { mode: "exact", turnId }, refresh: false });
        if (target) void this.enqueue(target).catch(() => undefined);
      }
    } catch (error) {
      if (!this.controller.signal.aborted) this.options.warn(`[transcript-reconciliation] capture-gap healing failed: ${boundedMessage(error)}`);
    }
  }

  private enqueue(target: Target, signal?: AbortSignal, onlyWhileObserved = false) {
    this.controller.signal.throwIfAborted();
    const existing = this.queue.find(job => sameWindow(job.target, target))
      ?? (!target.refresh && this.active && sameWindow(this.active.target, target) ? this.active : null);
    if (existing) existing.onlyWhileObserved &&= onlyWhileObserved;
    const job: Job = existing ?? {
      target, onlyWhileObserved, controller: new AbortController(),
      result: Promise.withResolvers<WorkbenchThreadReconcileResult>(), state: "queued",
    };
    if (!existing) this.queue.push(job);
    const result = this.wait(job, signal);
    this.enter(job);
    return result;
  }

  /**
   * Runs in the waiter's async context, so an admitted waiter's reload lease also admits the work it waits on. Every
   * waiter tries; the first lease to enter runs the job, so an attempt held at a reload gate never strands a later one.
   */
  private enter(job: Job) {
    if (job.state !== "queued") return;
    const entry: Promise<void> = this.options.lease(job.target.harness, () => this.run(job))
      .catch((error: unknown) => {
        if (job.state !== "queued") return;
        this.queue.splice(this.queue.indexOf(job), 1);
        job.state = "settled";
        this.warnFailure(job.target, error);
        job.result.reject(error);
      })
      .finally(() => { this.entries.delete(entry); });
    this.entries.add(entry);
  }

  /** Lanes are taken only after entering a lease, so nothing waiting at a reload gate can hold the lane. */
  private async run(job: Job) {
    if (job.state !== "queued") return;
    job.state = "entered";
    const previous = this.lane;
    const done = Promise.withResolvers<void>();
    this.lane = done.promise;
    try {
      await previous;
      await this.execute(job);
    } finally {
      done.resolve();
    }
  }

  private async resolveTarget(input: WorkbenchThreadReconcile): Promise<Target | null> {
    const identity = await this.options.identities.resolve({ threadId: ThreadReferenceSchema.parse(input.threadId) });
    if (!identity) throw new Error("Transcript recovery has no admitted thread identity.");
    const target = input.target;
    if (target.mode === "latest") {
      const harness = identity.bindings[0]?.harness;
      return harness ? { ...input, threadId: identity.threadId, harness } : null;
    }
    const catalog = await this.options.transcripts.catalog(identity.threadId);
    const id = target.mode === "exact" ? target.turnId : target.beforeTurnId;
    const boundary = catalog?.turns.find(turn => turn.id === id);
    if (!boundary) throw new Error("Transcript recovery boundary does not belong to this thread.");
    if (target.mode === "previous") {
      const previous = catalog!.turns.findLast(turn => turn.turn_index < boundary.turn_index);
      if (previous && (!boundary.native_turn_id || previous.harness_id !== boundary.harness_id
        || previous.native_thread_id !== boundary.native_thread_id || previous.native_location !== boundary.native_location)) {
        return previous.native_turn_id ? {
          ...input, threadId: identity.threadId, harness: previous.harness_id,
          target: { mode: "exact", turnId: previous.id },
        } : null;
      }
    }
    return boundary.native_turn_id
      ? { ...input, threadId: identity.threadId, harness: boundary.harness_id } : null;
  }

  private wait(job: Job, signal?: AbortSignal) {
    if (signal) {
      const abort = () => {
        job.controller.abort(signal.reason);
        const index = this.queue.indexOf(job);
        if (index >= 0) {
          this.queue.splice(index, 1);
          job.state = "settled";
          job.result.reject(signal.reason);
        }
      };
      signal.addEventListener("abort", abort, { once: true });
      const cleanup = () => signal.removeEventListener("abort", abort);
      void job.result.promise.then(cleanup, cleanup);
      if (signal.aborted) abort();
    }
    return job.result.promise;
  }

  private async execute(job: Job) {
    if (job.state === "settled") return;
    this.queue.splice(this.queue.indexOf(job), 1);
    this.active = job;
    const signal = AbortSignal.any([this.controller.signal, job.controller.signal]);
    try {
      signal.throwIfAborted();
      const gapIds = (await this.options.readRecoveryGaps(job.target.threadId)).map(gap => gap.id);
      signal.throwIfAborted();
      if (job.onlyWhileObserved && !this.options.isThreadObserved(job.target.threadId)) {
        job.result.resolve({ turnIds: [], exhausted: false, changed: false });
        return;
      }
      job.changed = false;
      const result = await this.options.recover({ ...job.target, gapIds }, signal);
      signal.throwIfAborted();
      // Without commit observation the outcome is unknown, so callers keep rereading.
      job.result.resolve(this.options.subscribeSettled ? { ...result, changed: job.changed } : result);
    } catch (error) {
      if (!signal.aborted) this.warnFailure(job.target, error);
      job.result.reject(error);
    } finally {
      this.active = null;
      job.state = "settled";
    }
  }

  private warnFailure(target: Target, error: unknown) {
    if (this.controller.signal.aborted) return;
    const safe = (text: string) => text.replace(/[\u0000-\u001f\u007f-\u009f]/gu, "?").slice(0, 160);
    this.options.warn(`[transcript-reconciliation] ${safe(target.harness)} ${safe(target.threadId)} ${target.target.mode} failed: ${boundedMessage(error)}`);
  }

  async dispose() {
    this.stopSettled();
    this.controller.abort(new Error("Transcript reconciliation retired."));
    for (const job of this.queue.splice(0)) {
      job.state = "settled";
      job.result.reject(this.controller.signal.reason);
    }
    await this.lane;
    await Promise.allSettled([...this.entries, ...this.observedRecoveries.values()]);
  }

  hasPendingWork() {
    return this.active !== null || this.queue.length > 0 || this.entries.size > 0 || this.observedRecoveries.size > 0;
  }
}
