/*
 * Exports:
 * - CodexThreadContextReadResponse: legacy native metadata envelope retained for internal provider callers.
 */
import type { Thread } from "./generated/app-server/v2/Thread.ts";
import type { Turn } from "../workbench/thread/workbench-thread-turn.ts";
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
