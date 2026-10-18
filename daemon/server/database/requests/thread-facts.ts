/*
 * Exports:
 * - threadFactRequests: database requests for thread-owned facts: skills, instruction selection, goals, vis, todos, addressed feedback,
 *   summary fact seeds and batched runtime facts.
 */
import type { ThreadSummaryFacts } from "workbench-shared/workbench/thread/thread-summary";
import WorkbenchThreadAddressedFeedbackStore, { type ThreadAddressedFeedbackCommand } from "../feedback/WorkbenchThreadAddressedFeedbackStore.ts";
import WorkbenchThreadGoalStore, { type ThreadGoalCommand } from "../goals/WorkbenchThreadGoalStore.ts";
import WorkbenchThreadSkillStore, { type ThreadSkillCommand } from "../skills/WorkbenchThreadSkillStore.ts";
import WorkbenchThreadInstructionSelectionStore, { type ThreadInstructionSelectionCommand } from "../thread-state/WorkbenchThreadInstructionSelectionStore.ts";
import WorkbenchThreadRuntimeFactsReader from "../thread-runtime/WorkbenchThreadRuntimeFactsReader.ts";
import WorkbenchThreadTodoStore, { type ThreadTodoCommand } from "../todos/WorkbenchThreadTodoStore.ts";
import WorkbenchThreadVisStore, { type ThreadVisCommand } from "../vis/WorkbenchThreadVisStore.ts";
import { defineDatabaseRequest } from "./define-database-request.ts";

export const threadFactRequests = {
  executeThreadSkills: defineDatabaseRequest({
    run: ({ database }, command: ThreadSkillCommand) => new WorkbenchThreadSkillStore(database).execute(command),
  }),
  executeThreadInstructionSelection: defineDatabaseRequest({
    run: ({ database }, command: ThreadInstructionSelectionCommand) => new WorkbenchThreadInstructionSelectionStore(database).execute(command),
  }),
  executeThreadGoals: defineDatabaseRequest({
    run: ({ database }, command: ThreadGoalCommand) => new WorkbenchThreadGoalStore(database).execute(command),
  }),
  executeThreadVis: defineDatabaseRequest({
    run: ({ database }, command: ThreadVisCommand) => new WorkbenchThreadVisStore(database).execute(command),
  }),
  executeThreadTodos: defineDatabaseRequest({
    run: ({ database }, command: ThreadTodoCommand) => new WorkbenchThreadTodoStore(database).execute(command),
  }),
  executeThreadAddressedFeedback: defineDatabaseRequest({
    run: ({ database }, command: ThreadAddressedFeedbackCommand) => new WorkbenchThreadAddressedFeedbackStore(database).execute(command),
  }),
  /** Every thread's stored summary facts (required todo and addressed feedback counts) in one read. */
  readThreadSummaryFactSeeds: defineDatabaseRequest({
    read: "core",
    run: ({ database }) => {
      const facts = new Map<string, ThreadSummaryFacts>();
      const seed = (counts: Record<string, number>, key: "addressedFeedbackCount" | "requiredTodoCount") => {
        for (const [threadId, count] of Object.entries(counts)) facts.set(threadId, { ...facts.get(threadId), [key]: count });
      };
      seed(new WorkbenchThreadTodoStore(database).requiredCounts(), "requiredTodoCount");
      seed(new WorkbenchThreadAddressedFeedbackStore(database).counts(), "addressedFeedbackCount");
      return facts as ReadonlyMap<string, ThreadSummaryFacts>;
    },
  }),
  /** Many threads' stored runtime facts in one reader round trip. */
  readThreadRuntimeFacts: defineDatabaseRequest({
    read: "core",
    run: ({ database, transcripts }, threadIds: readonly string[]) => new WorkbenchThreadRuntimeFactsReader(database, transcripts).read(threadIds),
  }),
};
