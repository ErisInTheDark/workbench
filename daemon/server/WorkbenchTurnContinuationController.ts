/*
 * Exports:
 * - WorkbenchTurnContinuationTarget: one thread turn a hidden continuation follows.
 * - WorkbenchTurnContinuationOptions: lifecycle reads, interruption, hidden-turn admission and failure ports.
 * - default WorkbenchTurnContinuationController: start hidden Workbench turns for every provider, waking agents whose turn ended unfinished and refreshing live turns on request; a stop cancels them.
 */
import type { WorkbenchHarness } from "workbench-shared/types";
import type { ProjectId, WorkbenchThreadId, WorkbenchTurnId } from "workbench-shared/workbench/identity";
import type { WorkbenchProviderObservation } from "workbench-shared/workbench/provider/provider-observation";
import type { WorkbenchProviderThreads } from "workbench-shared/workbench/provider/provider-thread";
import {
  createWorkbenchThreadRecoveryId, createWorkbenchThreadRecoveryInput, createWorkbenchUnfinishedTurnInput,
} from "workbench-shared/workbench/thread/thread-recovery-message";
import type { WorkbenchThreadLifecycle } from "workbench-shared/workbench/thread/thread-state";
import type WorkbenchTurnRecoveryController from "./WorkbenchTurnRecoveryController";
import type { WorkbenchProviderHiddenTurn } from "./WorkbenchProviderHandle";

export interface WorkbenchTurnContinuationTarget {
  threadId: WorkbenchThreadId;
  turnId: WorkbenchTurnId;
}

export interface WorkbenchTurnContinuationOptions {
  coordinator: Pick<WorkbenchTurnRecoveryController, "schedule" | "shouldContinue">;
  /** Canonical lifecycle and owning project; null when the thread is unknown. */
  readLifecycle(harness: WorkbenchHarness, threadId: WorkbenchThreadId): Promise<{
    projectId: ProjectId; lifecycle: WorkbenchThreadLifecycle;
  } | null>;
  /** Canonical identity of a provider-reported turn. */
  canonicalTurnId(reference: string): WorkbenchTurnId;
  interrupt(harness: WorkbenchHarness, threadId: WorkbenchThreadId): Promise<void>;
  admitHiddenTurn(harness: WorkbenchHarness, turn: WorkbenchProviderHiddenTurn): Promise<"started" | "superseded">;
  reportFailed(projectId: ProjectId, harness: WorkbenchHarness, threadId: WorkbenchThreadId): Promise<unknown>;
  log(message: string): void;
}

type ProviderTurnFacts = Pick<WorkbenchProviderThreads, "latestTurn" | "isTurnLive">;

function message(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}

interface HiddenTurnTask {
  abort(): void;
  /** Set once the in-lane check passed and the provider is admitting the turn; settles with the task. */
  admitting: Promise<void> | null;
}

export default class WorkbenchTurnContinuationController {
  private readonly generation = new AbortController();
  private readonly tasks = new Map<WorkbenchThreadId, Set<HiddenTurnTask>>();

  constructor(private readonly options: WorkbenchTurnContinuationOptions) {}

  /**
   * A stop wins against hidden turns: pending ones never pass their in-lane check, and one the provider is
   * already admitting is awaited so the caller's interruption reaches the turn it starts.
   */
  async cancel(threadId: WorkbenchThreadId) {
    const admitting: Promise<void>[] = [];
    for (const task of this.tasks.get(threadId) ?? []) {
      task.abort();
      if (task.admitting) admitting.push(task.admitting);
    }
    await Promise.allSettled(admitting);
  }

  /** React to a settled lifecycle observation; continuation itself runs later on the recovery coordinator. */
  observe(harness: WorkbenchHarness, facts: WorkbenchProviderObservation, lifecycle: WorkbenchThreadLifecycle | null) {
    const event = facts.lifecycle?.event;
    if (!facts.lifecycle || event?.kind !== "turnCompleted" || event.status !== "completed") return;
    if (this.generation.signal.aborted || !this.options.coordinator.shouldContinue(lifecycle)) return;
    const target = { threadId: facts.lifecycle.threadId, turnId: event.turnId };
    try {
      this.schedule("unfinished-turn continuation", harness, target, async (signal, threads) => {
        const current = await this.options.readLifecycle(harness, target.threadId);
        // A newer user message, stop or completion moved the thread on while this waited.
        if (signal.aborted || !current || !this.options.coordinator.shouldContinue(current.lifecycle)) return false;
        // Runtime liveness can lag the completion that scheduled this; the stored turn reopening or a newer turn cannot.
        const latest = await threads.latestTurn(target.threadId);
        return latest?.status === "completed" && this.options.canonicalTurnId(latest.id) === target.turnId;
      }, { id: `unfinished:${target.turnId}`, input: createWorkbenchUnfinishedTurnInput() });
    } catch (error) {
      // Draining for reload: the thread stays in needs attention, where manual recovery remains available.
      this.options.log(`Unfinished-turn continuation was not scheduled for ${harness}:${target.threadId}: ${message(error)}`);
    }
  }

  /** Interrupt the live turn, then resume it in a fresh turn carrying current instructions and tools. Throws only when not scheduled. */
  refresh(harness: WorkbenchHarness, target: WorkbenchTurnContinuationTarget) {
    this.schedule("thread refresh", harness, target, async (signal, threads) => {
      const current = await this.options.readLifecycle(harness, target.threadId);
      if (signal.aborted || !current || current.lifecycle.kind === "stopped") return false;
      const latest = await threads.latestTurn(target.threadId);
      // A message admitted after the interruption already resumed the agent.
      if (!latest || this.options.canonicalTurnId(latest.id) !== target.turnId) return false;
      if (await threads.isTurnLive(target.threadId, target.turnId)) throw new Error(`Interrupted turn ${target.turnId} did not stop.`);
      return true;
    }, { id: `refresh:${target.turnId}`, input: createWorkbenchThreadRecoveryInput() }, true);
  }

  dispose() {
    this.generation.abort(new Error("Turn continuation generation was retired."));
  }

  private schedule(
    label: string,
    harness: WorkbenchHarness,
    target: WorkbenchTurnContinuationTarget,
    isCurrent: (signal: AbortSignal, threads: ProviderTurnFacts) => Promise<boolean>,
    turn: { id: string; input: WorkbenchProviderHiddenTurn["input"] },
    interruptFirst = false,
  ) {
    const abort = new AbortController();
    const signal = AbortSignal.any([this.generation.signal, abort.signal]);
    const settled = Promise.withResolvers<void>();
    const task: HiddenTurnTask = { abort: () => abort.abort(), admitting: null };
    const tasks = this.tasks.get(target.threadId) ?? new Set();
    tasks.add(task);
    this.tasks.set(target.threadId, tasks);
    const release = () => {
      tasks.delete(task);
      if (!tasks.size && this.tasks.get(target.threadId) === tasks) this.tasks.delete(target.threadId);
      settled.resolve();
    };
    // A task aborted before admitting may never run, so nothing else would release it.
    signal.addEventListener("abort", () => { if (!task.admitting) release(); }, { once: true });
    try {
      this.options.coordinator.schedule(`${label} ${harness}:${target.threadId}`, signal, task.abort, async () => {
        try {
          if (interruptFirst) await this.options.interrupt(harness, target.threadId);
          if (signal.aborted) return;
          await this.options.admitHiddenTurn(harness, {
            threadId: target.threadId, clientMessageId: createWorkbenchThreadRecoveryId(turn.id), input: turn.input,
            isCurrent: async threads => {
              const current = !signal.aborted && await isCurrent(signal, threads) && !signal.aborted;
              if (current) task.admitting = settled.promise;
              return current;
            },
          });
        } catch (error) {
          if (signal.aborted) return;
          this.options.log(`${label} failed for ${harness}:${target.threadId}: ${message(error)}`);
          const current = await this.options.readLifecycle(harness, target.threadId);
          if (current) await this.options.reportFailed(current.projectId, harness, target.threadId);
        } finally {
          release();
        }
      });
    } catch (error) {
      release();
      throw error;
    }
  }
}
