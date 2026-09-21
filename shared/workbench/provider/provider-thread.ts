/*
 * Exports:
 * - WORKBENCH_THREAD_HISTORY_PENDING/WorkbenchThreadHistoryPendingError: provider history is not materialised yet.
 * - WorkbenchProviderThreadCreate: resolved creation context supplied by the daemon.
 * - WorkbenchProviderThreadList: bounded provider discovery request.
 * - WorkbenchProviderThreads: WB-valued thread operations implemented at the provider edge.
 * - WorkbenchProviderTranscriptReconcile: demanded window and pre-fetch capture-gap identities.
 */
import type {
  ThreadPayload, WorkbenchComposerProfileTargetSelection,
} from "../../types.ts";
import type {
  WorkbenchThreadMessage, WorkbenchThreadMessageResult,
  WorkbenchThreadReconciliationTarget, WorkbenchThreadReconcileResult,
} from "../thread/thread-actions.ts";
import type { WorkbenchMessageContext } from "./provider-input.ts";
import type { Turn } from "../thread/workbench-thread-turn.ts";
import type { WorkbenchAgentMessage } from "../thread/thread-agent-message.ts";

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
export interface WorkbenchProviderTranscriptReconcile {
  threadId: string;
  target: WorkbenchThreadReconciliationTarget;
  gapIds: string[];
}
export interface WorkbenchProviderThreads {
  reconcile(input: WorkbenchProviderTranscriptReconcile, signal: AbortSignal): Promise<WorkbenchThreadReconcileResult>;
  history: {
    materialize(threadId: string, turnId: string | null, signal: AbortSignal): Promise<void>;
  };
  create(input: WorkbenchProviderThreadCreate): Promise<ThreadPayload>;
  list(input: WorkbenchProviderThreadList): Promise<{ data: ThreadPayload[]; nextCursor: string | null }>;
  read(threadId: string, options?: { background?: boolean }): Promise<ThreadPayload>;
  readLatest(threadId: string): Promise<ThreadPayload>;
  latestTurn(threadId: string): Promise<Turn | null>;
  admitTurn(threadId: string, turnReference: string): Promise<void>;
  submit(input: WorkbenchThreadMessage): Promise<WorkbenchThreadMessageResult>;
  messageAgent(input: { threadId: string; cwd: string; message: WorkbenchAgentMessage; context?: WorkbenchMessageContext }): Promise<void>;
  rename(threadId: string, title: string): Promise<void>;
  compact(threadId: string): Promise<void>;
  /** Delete the backing provider session, retaining WB identity, state and history. */
  delete?(threadId: string): Promise<void>;
  interrupt(threadId: string, turnId: string, options?: { preserveGoal?: boolean }): Promise<void>;
  materialize(threadId: string, turnIds: string[], signal?: AbortSignal): Promise<void>;
}
