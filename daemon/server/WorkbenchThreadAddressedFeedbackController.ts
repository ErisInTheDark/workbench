/*
 * Exports:
 * - default WorkbenchThreadAddressedFeedbackController: own the feedback each thread was launched to address, until the user clears it.
 */
import type { WorkbenchThreadId } from "workbench-shared/workbench/identity";
import type { WorkbenchThreadAddressedFeedback } from "workbench-shared/workbench/thread/thread-addressed-feedback";
import type { ThreadAddressedFeedbackCommand } from "./database/feedback/WorkbenchThreadAddressedFeedbackStore";

export default class WorkbenchThreadAddressedFeedbackController {
  constructor(private readonly options: {
    store(command: ThreadAddressedFeedbackCommand): Promise<WorkbenchThreadAddressedFeedback[]>;
    resolve(threadId: string): Promise<WorkbenchThreadId | null>;
    changed(threadId: WorkbenchThreadId, feedback: WorkbenchThreadAddressedFeedback[]): void;
  }) {}

  async read(threadId: string) {
    const resolved = await this.options.resolve(threadId);
    return resolved ? await this.options.store({ kind: "read", threadId: resolved }) : [];
  }

  async record(threadId: string, feedback: readonly WorkbenchThreadAddressedFeedback[]) {
    if (!feedback.length) return;
    await this.#change(threadId, resolved => ({ kind: "record", threadId: resolved, feedback }));
  }

  async clear(threadId: string) {
    await this.#change(threadId, resolved => ({ kind: "clear", threadId: resolved }));
  }

  async #change(threadId: string, command: (resolved: WorkbenchThreadId) => ThreadAddressedFeedbackCommand) {
    const resolved = await this.options.resolve(threadId);
    if (!resolved) throw new Error("This thread is unknown to Workbench.");
    this.options.changed(resolved, await this.options.store(command(resolved)));
  }
}
