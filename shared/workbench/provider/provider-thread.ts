/*
 * Exports:
 * - WORKBENCH_THREAD_HISTORY_PENDING/WorkbenchThreadHistoryPendingError: provider history is not materialised yet.
 * - WorkbenchProviderThreadCreate: resolved creation context supplied by the daemon.
 * - WorkbenchProviderThreadList: bounded provider discovery request.
 * - WorkbenchProviderThreads: WB-valued thread operations implemented at the provider edge.
 */
import type {
  ThreadPayload, WorkbenchComposerProfileTargetSelection, WorkbenchQuestionnaireHistoryEntry,
  WorkbenchSteerHistoryEntry, WorkbenchBrowseResultEntry,
} from "../../types.ts";
import type {
  WorkbenchThreadMessage, WorkbenchThreadMessageResult, WorkbenchThreadPage, WorkbenchThreadPageResult,
} from "../thread/thread-actions.ts";
import type { WorkbenchMessageContext } from "./provider-input.ts";
import type { Turn } from "../thread/workbench-thread-turn.ts";

export const WORKBENCH_THREAD_HISTORY_PENDING = -32010;
export class WorkbenchThreadHistoryPendingError extends Error {}

export interface WorkbenchProviderThreadCreate {
  cwd: string;
  profile: WorkbenchComposerProfileTargetSelection;
  context?: WorkbenchMessageContext;
  projectRoots?: string[];
  additionalWritableRoots?: string[];
}
export interface WorkbenchProviderThreadList {
  cwd: string;
  cursor?: string | null;
  limit?: number;
  archived?: boolean;
  background?: boolean;
}
export interface WorkbenchProviderThreads {
  history: {
    questionnaires(threadId: string): Promise<WorkbenchQuestionnaireHistoryEntry[]>;
    steers(threadId: string): Promise<WorkbenchSteerHistoryEntry[]>;
    browse(threadId: string): Promise<WorkbenchBrowseResultEntry[]>;
  };
  create(input: WorkbenchProviderThreadCreate): Promise<ThreadPayload>;
  list(input: WorkbenchProviderThreadList): Promise<{ data: ThreadPayload[]; nextCursor: string | null }>;
  read(threadId: string, options?: { background?: boolean }): Promise<ThreadPayload>;
  latestTurn(threadId: string): Promise<Turn | null>;
  admitTurn(threadId: string, turnReference: string): Promise<void>;
  page(input: WorkbenchThreadPage): Promise<WorkbenchThreadPageResult>;
  submit(input: WorkbenchThreadMessage): Promise<WorkbenchThreadMessageResult>;
  rename(threadId: string, title: string): Promise<void>;
  compact(threadId: string): Promise<void>;
  interrupt(threadId: string, turnId: string): Promise<void>;
  materialize(threadId: string, turnIds: string[], signal?: AbortSignal): Promise<void>;
}
