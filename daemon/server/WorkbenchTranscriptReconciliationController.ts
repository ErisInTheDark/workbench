/*
 * Exports:
 * - WorkbenchTranscriptReconciliationOptions: canonical resolution, storage and native recovery ports.
 * - default WorkbenchTranscriptReconciliationController: own explicit demanded transcript recovery.
 */
import type { WorkbenchThreadReconcile, WorkbenchThreadReconcileResult } from "workbench-shared/workbench/thread/thread-actions";
import { ThreadReferenceSchema } from "workbench-shared/workbench/identity";
import type WorkbenchThreadIdentityController from "./WorkbenchThreadIdentityController";
import type WorkbenchTranscriptReader from "./WorkbenchTranscriptReader";

export interface WorkbenchTranscriptReconciliationOptions {
  identities: Pick<WorkbenchThreadIdentityController, "resolve">;
  transcripts: Pick<WorkbenchTranscriptReader, "catalog">;
  readGapIds(threadId: string): Promise<string[]>;
  recover(input: WorkbenchThreadReconcile & { harness: string; gapIds: string[] }, signal: AbortSignal): Promise<WorkbenchThreadReconcileResult>;
  warn(message: string): void;
}

type Target = WorkbenchThreadReconcile & { harness: string };
type Job = {
  target: Target;
  controller: AbortController;
  result: ReturnType<typeof Promise.withResolvers<WorkbenchThreadReconcileResult>>;
};

function sameWindow(left: Target, right: Target) {
  if (left.threadId !== right.threadId || left.harness !== right.harness || left.target.mode !== right.target.mode) return false;
  if (left.target.mode === "exact" && right.target.mode === "exact") return left.target.turnId === right.target.turnId;
  if (left.target.mode === "previous" && right.target.mode === "previous") return left.target.beforeTurnId === right.target.beforeTurnId;
  return true;
}

export default class WorkbenchTranscriptReconciliationController {
  private readonly controller = new AbortController();
  private readonly queue: Job[] = [];
  private active: Job | null = null;
  private draining: Promise<void> | null = null;

  constructor(private readonly options: WorkbenchTranscriptReconciliationOptions) {}

  async reconcile(input: WorkbenchThreadReconcile, signal?: AbortSignal): Promise<WorkbenchThreadReconcileResult> {
    this.controller.signal.throwIfAborted();
    signal?.throwIfAborted();
    const target = await this.resolveTarget(input);
    this.controller.signal.throwIfAborted();
    signal?.throwIfAborted();
    if (!target) return { turnIds: [], exhausted: true };
    const existing = this.queue.find(job => sameWindow(job.target, target))
      ?? (!input.refresh && this.active && sameWindow(this.active.target, target) ? this.active : null);
    if (existing) return this.wait(existing, signal);
    const job: Job = { target, controller: new AbortController(), result: Promise.withResolvers<WorkbenchThreadReconcileResult>() };
    this.queue.push(job);
    this.draining ??= Promise.resolve().then(() => this.drain());
    return this.wait(job, signal);
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

  private async drain() {
    try {
      while (this.queue.length) {
        const job = this.queue.shift()!;
        this.active = job;
        const signal = AbortSignal.any([this.controller.signal, job.controller.signal]);
        try {
          signal.throwIfAborted();
          const gapIds = await this.options.readGapIds(job.target.threadId);
          signal.throwIfAborted();
          const result = await this.options.recover({ ...job.target, gapIds }, signal);
          signal.throwIfAborted();
          job.result.resolve(result);
        } catch (error) {
          if (!signal.aborted) {
            const safe = (text: string) => text.replace(/[\u0000-\u001f\u007f-\u009f]/gu, "?").slice(0, 160);
            const message = (error instanceof Error ? error.message : String(error))
              .replace(/\b(Bearer\s+)[^\s,;]+/giu, "$1[redacted]")
              .replace(/\b(api[_-]?key|authorization|secret|token)(\s*[:=]\s*)[^\s,;]+/giu, "$1$2[redacted]")
              .replace(/[\u0000-\u001f\u007f-\u009f]/gu, "?").slice(0, 500);
            this.options.warn(`[transcript-reconciliation] ${safe(job.target.harness)} ${safe(job.target.threadId)} ${job.target.target.mode} failed: ${message}`);
          }
          job.result.reject(error);
        } finally {
          this.active = null;
        }
      }
    } finally {
      this.draining = null;
    }
  }

  async dispose() {
    this.controller.abort(new Error("Transcript reconciliation retired."));
    for (const job of this.queue.splice(0)) job.result.reject(this.controller.signal.reason);
    await this.draining;
  }
}
