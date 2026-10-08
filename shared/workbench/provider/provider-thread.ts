/*
 * Exports:
 * - WORKBENCH_THREAD_HISTORY_PENDING/WorkbenchThreadHistoryPendingError: provider history is not materialised yet.
 * - WorkbenchProviderThreadCreate: resolved creation context supplied by the daemon.
 * - WorkbenchProviderCompactionScope: canonical item and turn owned by one compaction execution.
 * - WorkbenchProviderThreadList: bounded provider discovery request.
 * - WorkbenchProviderThreads: WB-valued thread operations implemented at the provider edge.
 * - WorkbenchProviderThreadContextRollover: optional fresh-native-context operations.
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
import type { ProjectId, WorkbenchItemId, WorkbenchTurnId } from "../identity.ts";

export interface WorkbenchProviderThreadContextRollover {
  requestDirective(input: { instruction: string; key: string; threadId: string; turnId: string }): Promise<void>;
  /** Resolve only after the replacement summary turn has natively started. */
  replace(input: { summary: string; threadId: string; turnId: string }): Promise<void>;
}

export interface WorkbenchProviderCompactionScope {
  itemId: WorkbenchItemId;
  turnId: WorkbenchTurnId;
}

export const WORKBENCH_THREAD_HISTORY_PENDING = -32010;
export class WorkbenchThreadHistoryPendingError extends Error {}

export interface WorkbenchProviderThreadCreate {
  cwd: string;
  projectLocation?: { id: ProjectId; rootPath: string; launchId?: string };
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
  readonly contextRollover?: WorkbenchProviderThreadContextRollover;
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
  /** Deliver an attributed agent message; report whether its Workbench turn started or was steered. */
  messageAgent(input: { threadId: string; cwd: string; message: WorkbenchAgentMessage; context?: WorkbenchMessageContext }): Promise<{ kind: "started" | "steered"; turnId: string }>;
  rename(threadId: string, title: string): Promise<void>;
  compact(threadId: string, options: { scope: WorkbenchProviderCompactionScope; signal?: AbortSignal }): Promise<void>;
  /** Delete the backing provider session, retaining WB identity, state and history. */
  delete?(threadId: string): Promise<void>;
  /** Interrupt the thread's current execution without requiring a caller-selected turn. */
  interrupt(threadId: string): Promise<void>;
  /** Runtime truth only: whether this provider still runs the turn. Workbench settles turns nobody runs. */
  isTurnLive(threadId: string, turnId: string): Promise<boolean>;
  materialize(threadId: string, turnIds: string[], signal?: AbortSignal): Promise<void>;
}
