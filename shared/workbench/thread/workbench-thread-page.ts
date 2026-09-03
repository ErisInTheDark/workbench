/*
 * Exports:
 * - WORKBENCH_THREAD_PAGE_READ_METHOD: harness-neutral browser thread-page request identity. Keywords: thread, page, WebSocket, harness.
 * - WorkbenchThreadPageReadParamsSchema/WorkbenchThreadPageReadParams: strict first-page and continuation request contract. Keywords: cursor, pagination, validation.
 * - WorkbenchThreadPageResponse: normalized harness response consumed by the browser thread owner. Keywords: thread, overlays, model, cursor.
 * - readWorkbenchThreadPageNextCursor: derive the next stable Workbench continuation boundary from one returned page. Keywords: turn, history, cursor.
 */
import { z } from "zod";
import type { Thread } from "../../codex/generated/app-server/v2/Thread.ts";
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

export interface WorkbenchThreadPageResponse {
  browseResultEntries: WorkbenchBrowseResultEntry[];
  entryScope?: WorkbenchThreadContextEntryScope;
  model?: string | null;
  nextCursor: string | null;
  questionnaireEntries: WorkbenchQuestionnaireHistoryEntry[];
  reasoningEffort?: string | null;
  serviceTier?: string | null;
  steerEntries: WorkbenchSteerHistoryEntry[];
  thread: Thread;
}

type ThreadWithHistory = Thread & {
  workbenchTurnHistory?: WorkbenchThreadTurnHistoryEntry[];
};

export function readWorkbenchThreadPageNextCursor(thread: Thread) {
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
