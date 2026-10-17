/*
 * Exports:
 * - WorkbenchThreadInstructionSelectionPorts: durable store, thread kind and warning ports.
 * - default WorkbenchThreadInstructionSelectionController: remember each thread's chosen instructions and supply them to messages that carry none.
 */
import type { WorkbenchThreadId } from "workbench-shared/workbench/identity";
import {
  readWorkbenchInstructionSelection, type WorkbenchInstructionSelection, type WorkbenchMessageContext,
} from "workbench-shared/workbench/provider/provider-input";
import type { ThreadInstructionSelectionCommand } from "./database/thread-state/WorkbenchThreadInstructionSelectionStore";

export interface WorkbenchThreadInstructionSelectionPorts {
  store(command: ThreadInstructionSelectionCommand): Promise<WorkbenchInstructionSelection | null>;
  /** Whether the thread is a Workbench subagent; null when the thread is unknown. */
  readThreadKind(threadId: WorkbenchThreadId): Promise<"thread" | "subagent" | null>;
  now(): number;
  warn(message: string): void;
}

export default class WorkbenchThreadInstructionSelectionController {
  constructor(private readonly ports: WorkbenchThreadInstructionSelectionPorts) {}

  /** A context carrying a selection launches as sent; otherwise the thread's recorded selection, or its kind's default, applies. */
  async resolve(threadId: WorkbenchThreadId, context: WorkbenchMessageContext | undefined): Promise<WorkbenchMessageContext> {
    if (context && readWorkbenchInstructionSelection(context)) return context;
    const selection = await this.ports.store({ kind: "read", threadId })
      ?? { workflowIds: [await this.ports.readThreadKind(threadId) === "subagent" ? "subagent" : "default"] };
    return { ...selection, ...(context?.activatedSkillPaths ? { activatedSkillPaths: context.activatedSkillPaths } : {}) };
  }

  /** Record an accepted message's selection; the message already landed, so a failed write only warns. */
  async record(threadId: WorkbenchThreadId, context: WorkbenchMessageContext | undefined) {
    const selection = readWorkbenchInstructionSelection(context);
    if (!selection) return;
    try {
      await this.ports.store({ kind: "record", threadId, selection, at: this.ports.now() });
    } catch (error) {
      this.ports.warn(`Instruction selection was not recorded for ${threadId}: ${(error instanceof Error ? error.message : String(error)).slice(0, 300)}`);
    }
  }
}
