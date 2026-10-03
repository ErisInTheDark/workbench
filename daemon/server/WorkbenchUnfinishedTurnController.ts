/*
 * Exports:
 * - WorkbenchUnfinishedTurnOptions: lifecycle reads, provider continuation and failure ports.
 * - default WorkbenchUnfinishedTurnController: wake agents whose completed turn left their thread unfinished, for every provider.
 */
import type { WorkbenchHarness } from "workbench-shared/types";
import type { ProjectId, WorkbenchThreadId } from "workbench-shared/workbench/identity";
import type { WorkbenchProviderObservation } from "workbench-shared/workbench/provider/provider-observation";
import type { WorkbenchUnfinishedTurnTarget } from "workbench-shared/workbench/provider/provider-recovery";
import type { WorkbenchThreadLifecycle } from "workbench-shared/workbench/thread/thread-state";
import type WorkbenchTurnRecoveryController from "./WorkbenchTurnRecoveryController";

export interface WorkbenchUnfinishedTurnOptions {
  coordinator: Pick<WorkbenchTurnRecoveryController, "schedule" | "shouldContinue">;
  /** Canonical lifecycle and owning project; null when the thread is unknown. */
  readLifecycle(harness: WorkbenchHarness, threadId: WorkbenchThreadId): Promise<{
    projectId: ProjectId; lifecycle: WorkbenchThreadLifecycle;
  } | null>;
  continueUnfinished(harness: WorkbenchHarness, target: WorkbenchUnfinishedTurnTarget): Promise<"handled" | "unsupported">;
  reportFailed(projectId: ProjectId, harness: WorkbenchHarness, threadId: WorkbenchThreadId): Promise<unknown>;
  log(message: string): void;
}

function message(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}

export default class WorkbenchUnfinishedTurnController {
  private readonly generation = new AbortController();

  constructor(private readonly options: WorkbenchUnfinishedTurnOptions) {}

  /** React to a settled lifecycle observation; continuation itself runs later on the recovery coordinator. */
  observe(harness: WorkbenchHarness, facts: WorkbenchProviderObservation, lifecycle: WorkbenchThreadLifecycle | null) {
    const event = facts.lifecycle?.event;
    if (!facts.lifecycle || event?.kind !== "turnCompleted" || event.status !== "completed") return;
    if (this.generation.signal.aborted || !this.options.coordinator.shouldContinue(lifecycle, false)) return;
    const target = { threadId: facts.lifecycle.threadId, turnId: event.turnId };
    const label = `unfinished-turn continuation ${harness}:${target.threadId}`;
    const task = new AbortController();
    const signal = AbortSignal.any([this.generation.signal, task.signal]);
    try {
      this.options.coordinator.schedule(label, signal, () => task.abort(), () => this.continue(harness, target, signal));
    } catch (error) {
      // Draining for reload: the thread stays in needs attention, where manual recovery remains available.
      this.options.log(`Unfinished-turn continuation was not scheduled for ${harness}:${target.threadId}: ${message(error)}`);
    }
  }

  dispose() {
    this.generation.abort(new Error("Unfinished-turn continuation generation was retired."));
  }

  private async continue(harness: WorkbenchHarness, target: WorkbenchUnfinishedTurnTarget, signal: AbortSignal) {
    const current = await this.options.readLifecycle(harness, target.threadId);
    // A newer user message, stop or completion moved the thread on while this waited.
    if (!current || signal.aborted || !this.options.coordinator.shouldContinue(current.lifecycle, false)) return;
    try {
      await this.options.continueUnfinished(harness, target);
    } catch (error) {
      if (signal.aborted) return;
      this.options.log(`Unfinished-turn continuation failed for ${harness}:${target.threadId}: ${message(error)}`);
      await this.options.reportFailed(current.projectId, harness, target.threadId);
    }
  }
}
