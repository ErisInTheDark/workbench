/*
 * Exports:
 * - WorkbenchThreadInstructionSelectionPorts: durable store, thread kind, skill catalog, activation recording and warning ports.
 * - defaultThreadInstructionSelection: the workflows a thread with no recorded selection runs, by thread kind.
 * - default WorkbenchThreadInstructionSelectionController: remember each thread's chosen instructions, supply them to messages that carry none, and activate the skills an admitted message names.
 */
import type { WorkbenchSkillSummary } from "workbench-shared/types";
import type { WorkbenchThreadId } from "workbench-shared/workbench/identity";
import {
  readWorkbenchInstructionSelection, type WorkbenchInstructionSelection, type WorkbenchMessageContext, type WorkbenchUserInput,
} from "workbench-shared/workbench/provider/provider-input";
import { collectActivatedSkillPaths } from "workbench-shared/workbench/thread/thread-skill-state";
import { readWorkbenchSkillMentionPaths } from "workbench-shared/workbench/thread/thread-skill-mentions";
import type { ThreadInstructionSelectionCommand } from "../database/thread-state/WorkbenchThreadInstructionSelectionStore";

export interface WorkbenchThreadInstructionSelectionPorts {
  store(command: ThreadInstructionSelectionCommand): Promise<WorkbenchInstructionSelection | null>;
  /** Whether the thread is a Workbench subagent; null when the thread is unknown. */
  readThreadKind(threadId: WorkbenchThreadId): Promise<"thread" | "subagent" | null>;
  /** Skills the thread can activate. */
  readSkills(threadId: WorkbenchThreadId): Promise<readonly WorkbenchSkillSummary[]>;
  recordSkillActivations(threadId: WorkbenchThreadId, paths: readonly string[]): Promise<void>;
  now(): number;
  warn(message: string): void;
}

export function defaultThreadInstructionSelection(kind: "thread" | "subagent" | null): WorkbenchInstructionSelection {
  return { workflowIds: [kind === "subagent" ? "subagent" : "default"] };
}

function failure(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}

export default class WorkbenchThreadInstructionSelectionController {
  constructor(private readonly ports: WorkbenchThreadInstructionSelectionPorts) {}

  /** The thread's recorded selection, or its kind's default. */
  async readSelection(threadId: WorkbenchThreadId): Promise<WorkbenchInstructionSelection> {
    return await this.ports.store({ kind: "read", threadId }) ?? defaultThreadInstructionSelection(await this.ports.readThreadKind(threadId));
  }

  /**
   * A context carrying a selection launches as sent; otherwise the thread's recorded selection, or its kind's default, applies.
   * A selection naming no workflows keeps the recorded ones: senders that do not choose a workflow must not reset it.
   * User input being admitted activates the skills it names, so merged messages need no stored activations.
   */
  async resolve(
    threadId: WorkbenchThreadId, context: WorkbenchMessageContext | undefined, input?: readonly WorkbenchUserInput[],
  ): Promise<WorkbenchMessageContext> {
    const selection = await this.withRecordedWorkflows(threadId, readWorkbenchInstructionSelection(context));
    const named = input
      ? readWorkbenchSkillMentionPaths(input.flatMap(part => part.type === "text" ? [part.text] : []), await this.ports.readSkills(threadId))
      : [];
    const activatedSkillPaths = collectActivatedSkillPaths(input ?? [], { activatedSkillPaths: [...context?.activatedSkillPaths ?? [], ...named] });
    return { ...selection, ...(activatedSkillPaths.length ? { activatedSkillPaths } : {}) };
  }

  private async withRecordedWorkflows(threadId: WorkbenchThreadId, sent: WorkbenchInstructionSelection | null) {
    if (sent?.workflowIds) return sent;
    const recorded = await this.readSelection(threadId);
    if (!sent) return recorded;
    const workflowIds = recorded.workflowIds
      ?? defaultThreadInstructionSelection(await this.ports.readThreadKind(threadId)).workflowIds;
    return { ...sent, workflowIds };
  }

  /** Record an accepted message's selection and activations; the message already landed, so failed writes only warn. */
  async record(threadId: WorkbenchThreadId, context: WorkbenchMessageContext | undefined, activatedSkillPaths: readonly string[] = []) {
    const sent = readWorkbenchInstructionSelection(context);
    if (sent) {
      try {
        const selection = await this.withRecordedWorkflows(threadId, sent);
        await this.ports.store({ kind: "record", threadId, selection, at: this.ports.now() });
      } catch (error) {
        this.ports.warn(`Instruction selection was not recorded for ${threadId}: ${failure(error)}`);
      }
    }
    if (!activatedSkillPaths.length) return;
    try {
      await this.ports.recordSkillActivations(threadId, activatedSkillPaths);
    } catch (error) {
      this.ports.warn(`Skill activations were not recorded for ${threadId}: ${failure(error)}`);
    }
  }
}
