/*
 * Exports:
 * - CodexThreadContextReadResponse: legacy native metadata envelope retained for internal provider callers.
 * - CodexThreadPageResponse: native page metadata before WB projection.
 */
import type { Thread } from "./generated/app-server/v2/Thread.ts";
import type { Turn } from "../workbench/thread/workbench-thread-turn.ts";
import type { ThreadTokenUsage } from "../workbench/thread/thread-context-usage.ts";
import type {
  WorkbenchBrowseResultEntry, WorkbenchThreadContextEntryScope,
  WorkbenchQuestionnaireHistoryEntry, WorkbenchSteerHistoryEntry,
} from "../types.ts";

export interface CodexThreadContextReadResponse {
  browseResultEntries: WorkbenchBrowseResultEntry[];
  entryScope?: WorkbenchThreadContextEntryScope;
  questionnaireEntries: WorkbenchQuestionnaireHistoryEntry[];
  steerEntries: WorkbenchSteerHistoryEntry[];
  thread: Omit<Thread, "turns"> & { turns: Turn[] };
}

export interface CodexThreadPageResponse<Id extends string = string> extends Omit<CodexThreadContextReadResponse, "thread"> {
  tokenUsage?: ThreadTokenUsage | null;
  model?: string | null;
  nextCursor: string | null;
  reasoningEffort?: string | null;
  serviceTier?: string | null;
  thread: Omit<Thread, "id" | "turns"> & { id: Id; turns: Turn[] };
}
