/*
 * Exports:
 * - WorkbenchThreadRuntimeFacts: one thread's stored runtime facts: goal, skills, todos, addressed feedback, usage and latest turn.
 * - default WorkbenchThreadRuntimeFactsReader: read many threads' runtime facts in one transaction through their owning stores.
 */
import type Database from "better-sqlite3";
import type { WorkbenchThreadGoal } from "workbench-shared/workbench/thread/thread-goal";
import type { WorkbenchThreadSkill } from "workbench-shared/workbench/thread/thread-skill-state";
import type { WorkbenchThreadTodo } from "workbench-shared/workbench/thread/thread-todo";
import type { WorkbenchThreadAddressedFeedback } from "workbench-shared/workbench/thread/thread-addressed-feedback";
import type { ThreadTokenUsage } from "workbench-shared/workbench/thread/thread-context-usage";
import type { Turn } from "workbench-shared/workbench/thread/workbench-thread-turn";
import { projectWorkbenchTranscriptTurnRow } from "workbench-shared/workbench/transcript/workbench-transcript-projection";
import WorkbenchThreadGoalStore from "../goals/WorkbenchThreadGoalStore.ts";
import WorkbenchThreadSkillStore from "../skills/WorkbenchThreadSkillStore.ts";
import WorkbenchThreadTodoStore from "../todos/WorkbenchThreadTodoStore.ts";
import WorkbenchThreadAddressedFeedbackStore from "../feedback/WorkbenchThreadAddressedFeedbackStore.ts";
import type WorkbenchTranscriptRepository from "../transcript/WorkbenchTranscriptRepository.ts";

export interface WorkbenchThreadRuntimeFacts {
  threadId: string;
  goal: WorkbenchThreadGoal | null;
  skills: WorkbenchThreadSkill[];
  todos: WorkbenchThreadTodo[];
  addressedFeedback: WorkbenchThreadAddressedFeedback[];
  tokenUsage: ThreadTokenUsage | null;
  latestTurn: Turn | null;
}

export default class WorkbenchThreadRuntimeFactsReader {
  constructor(
    private readonly database: Database.Database,
    private readonly transcript: Pick<WorkbenchTranscriptRepository, "readContextUsages" | "readLatestTurns">,
  ) {}

  /** Facts for every listed thread, in order; threads with no stored facts read as empty. */
  read(threadIds: readonly string[]): WorkbenchThreadRuntimeFacts[] {
    return this.database.transaction(() => {
      const ids = [...new Set(threadIds)];
      const goals = new WorkbenchThreadGoalStore(this.database).readMany(ids);
      const skills = new WorkbenchThreadSkillStore(this.database).readMany(ids);
      const todos = new WorkbenchThreadTodoStore(this.database).readMany(ids);
      const feedback = new WorkbenchThreadAddressedFeedbackStore(this.database).readMany(ids);
      const usage = this.transcript.readContextUsages(ids);
      const turns = this.transcript.readLatestTurns(ids);
      return threadIds.map(threadId => {
        const turn = turns.get(threadId);
        return {
          threadId,
          goal: goals.get(threadId) ?? null,
          skills: skills.get(threadId) ?? [],
          todos: todos.get(threadId) ?? [],
          addressedFeedback: feedback.get(threadId) ?? [],
          tokenUsage: usage.get(threadId)?.tokenUsage ?? null,
          latestTurn: turn ? projectWorkbenchTranscriptTurnRow(turn) : null,
        };
      });
    })();
  }
}
