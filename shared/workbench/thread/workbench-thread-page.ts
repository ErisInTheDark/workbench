/*
 * Exports:
 * - WORKBENCH_THREAD_PAGE_READ_METHOD: harness-neutral browser thread-page request identity.
 * - WorkbenchThreadPageReadParamsSchema/WorkbenchThreadPageReadParams: first-page and continuation request contract.
 * - WorkbenchThreadPageResponse: harness response preserving source identity.
 * - readWorkbenchThreadPageNextCursor: derive the next continuation boundary from one returned page.
 */
import { z } from "zod";
import type { Thread } from "../../codex/generated/app-server/v2/Thread.ts";
import type { Turn } from "./workbench-thread-turn.ts";
import type { ThreadTokenUsage } from "./thread-context-usage.ts";
import type {
  WorkbenchBrowseResultEntry,
  WorkbenchQuestionnaireHistoryEntry,
  WorkbenchSteerHistoryEntry,
  WorkbenchThreadContextEntryScope,
  WorkbenchThreadTurnHistoryEntry,
} from "../../types.ts";

export const WORKBENCH_THREAD_PAGE_READ_METHOD = "workbench/thread/page/read";

export const WorkbenchThreadPageReadParamsSchema = z.object({
  cursor: z.string().trim().min(1).nullable(),
  cwd: z.string().trim().min(1).optional(),
  readScope: z.literal("subagentBackground").optional(),
  threadId: z.string().trim().min(1),
}).strict();

export type WorkbenchThreadPageReadParams = z.infer<typeof WorkbenchThreadPageReadParamsSchema>;

export interface WorkbenchThreadPageResponse<Id extends string = string> {
  tokenUsage?: ThreadTokenUsage | null;
  browseResultEntries: WorkbenchBrowseResultEntry[];
  entryScope?: WorkbenchThreadContextEntryScope;
  model?: string | null;
  nextCursor: string | null;
  questionnaireEntries: WorkbenchQuestionnaireHistoryEntry[];
  reasoningEffort?: string | null;
  serviceTier?: string | null;
  steerEntries: WorkbenchSteerHistoryEntry[];
  thread: Omit<Thread, "id" | "turns"> & { id: Id; turns: Turn[] };
}

type ThreadWithHistory = { turns: readonly { id: string }[] } & {
  workbenchTurnHistory?: WorkbenchThreadTurnHistoryEntry[];
};

export function readWorkbenchThreadPageNextCursor(thread: { turns: readonly { id: string }[] }) {
  const history = (thread as ThreadWithHistory).workbenchTurnHistory;
  if (!history?.length || !thread.turns.length) return null;
  const historyIndexByTurnId = new Map(history.map((entry, index) => [entry.turnId, index]));
  const loadedIndexes = thread.turns
    .map((turn) => historyIndexByTurnId.get(turn.id))
    .filter((index): index is number => index !== undefined);
  if (!loadedIndexes.length) return null;
  const earliestLoadedIndex = Math.min(...loadedIndexes);
  return earliestLoadedIndex > 0 ? history[earliestLoadedIndex]!.turnId : null;
}
