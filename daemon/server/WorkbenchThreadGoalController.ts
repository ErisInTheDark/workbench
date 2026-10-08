/*
 * Exports:
 * - WorkbenchThreadGoalsOptions: persistence, agent-context delivery and runtime publication ports.
 * - default WorkbenchThreadGoalController: own the user-set thread goal, its silent change notices and its re-send after compaction.
 */
import type { WorkbenchThreadId } from "workbench-shared/workbench/identity";
import type { WorkbenchContextAdmission } from "workbench-shared/workbench/provider/provider-context";
import {
  createWorkbenchGoalClearedText,
  createWorkbenchGoalReminderText,
  createWorkbenchGoalSetText,
  WorkbenchThreadGoalObjectiveSchema,
  type WorkbenchThreadGoal,
} from "workbench-shared/workbench/thread/thread-goal";
import type {
  WorkbenchAgentContextContribution,
  WorkbenchAgentContextSource,
  WorkbenchAgentContextTarget,
} from "./WorkbenchAgentContextController";
import type { ThreadGoalCommand, ThreadGoalState } from "./database/goals/WorkbenchThreadGoalStore";

export interface WorkbenchThreadGoalsOptions {
  store(command: ThreadGoalCommand): Promise<ThreadGoalState>;
  /** The thread's delivery provider; null when the thread has no installed provider. */
  target(threadId: string): Promise<WorkbenchAgentContextTarget | null>;
  publish(target: WorkbenchAgentContextTarget, text: string): Promise<WorkbenchContextAdmission | "failed">;
  /** The thread's goal changed; observers show the new value. */
  changed(threadId: WorkbenchThreadId, goal: WorkbenchThreadGoal | null): void;
  warn(message: string): void;
  now?(): number;
}

export default class WorkbenchThreadGoalController {
  /** Serialises immediate delivery per thread so one pending notice is never published twice. */
  readonly #flushes = new Map<WorkbenchThreadId, Promise<void>>();

  /** An undelivered notice joins the agent's next input when immediate delivery was unsupported. */
  readonly contextSource: WorkbenchAgentContextSource = {
    id: "thread-goal",
    collect: async target => this.#contributions(target),
  };

  constructor(private readonly options: WorkbenchThreadGoalsOptions) {}

  async read(threadId: string) {
    const target = await this.options.target(threadId);
    return target ? (await this.options.store({ kind: "read", threadId: target.threadId })).goal : null;
  }

  async set(threadId: string, objective: string) {
    const target = await this.#requireTarget(threadId);
    const state = await this.options.store({
      kind: "set", threadId: target.threadId, objective: WorkbenchThreadGoalObjectiveSchema.parse(objective),
      at: this.options.now?.() ?? Date.now(),
    });
    this.options.changed(target.threadId, state.goal);
    await this.#flush(target);
    return state.goal;
  }

  async clear(threadId: string) {
    const target = await this.#requireTarget(threadId);
    const state = await this.options.store({ kind: "clear", threadId: target.threadId, at: this.options.now?.() ?? Date.now() });
    this.options.changed(target.threadId, state.goal);
    await this.#flush(target);
  }

  async observeCompaction(threadId: string) {
    const target = await this.options.target(threadId);
    if (!target) return;
    const state = await this.options.store({ kind: "markCompacted", threadId: target.threadId });
    if (state.pending) await this.#flush(target);
  }

  async #requireTarget(threadId: string) {
    const target = await this.options.target(threadId);
    if (!target) throw new Error("This thread has no installed provider for goals.");
    return target;
  }

  /** The recorded transition already succeeded; a delivery failure only leaves its notice pending. */
  #flush(target: WorkbenchAgentContextTarget) {
    const previous = this.#flushes.get(target.threadId) ?? Promise.resolve();
    const flushed: Promise<void> = previous.then(async () => {
      for (const contribution of await this.#contributions(target)) {
        if (await this.options.publish(target, contribution.text) === "admitted") await contribution.admitted?.();
      }
    }).catch((error: unknown) => {
      this.options.warn(`Goal notice delivery failed; it stays pending: ${
        error instanceof Error ? error.message.slice(0, 300) : "unknown failure"}`);
    }).finally(() => {
      if (this.#flushes.get(target.threadId) === flushed) this.#flushes.delete(target.threadId);
    });
    this.#flushes.set(target.threadId, flushed);
    return flushed;
  }

  async #contributions(target: WorkbenchAgentContextTarget): Promise<WorkbenchAgentContextContribution[]> {
    const { pending } = await this.options.store({ kind: "read", threadId: target.threadId });
    if (!pending) return [];
    const text = pending.notice === "cleared" || pending.objective === null ? createWorkbenchGoalClearedText()
      : pending.notice === "updated" ? createWorkbenchGoalSetText(pending.objective)
        : createWorkbenchGoalReminderText(pending.objective);
    return [{
      text,
      admitted: async () => {
        await this.options.store({ kind: "acknowledge", threadId: target.threadId, notice: pending.notice, updatedAt: pending.updatedAt });
      },
    }];
  }
}
