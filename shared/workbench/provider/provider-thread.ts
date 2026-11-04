/*
 * Exports:
 * - WORKBENCH_THREAD_HISTORY_PENDING/WorkbenchThreadHistoryPendingError: provider history is not materialised yet.
 * - WorkbenchThreadCreationNotDispatchedError: creation definitely failed before any creation request reached the provider.
 * - WorkbenchProviderThreadCreate: resolved creation context supplied by the daemon.
 * - WorkbenchProviderCompactionScope: canonical item and turn owned by one compaction execution.
 * - WorkbenchProviderThreadList: bounded provider discovery request.
 * - WorkbenchAgentMessageAdmission: whether an agent message started a turn or steered the live one.
 * - WorkbenchAgentMessageResult: an agent message's admission, or its hold for the user's next turn.
 * - WorkbenchAgentMessageInput: one attributed agent message and its hold-for-user admission policy.
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
export class WorkbenchThreadCreationNotDispatchedError extends Error {}

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
  /** Record the window as an explicit recovery, which may recreate retention-expired turns. */
  explicit?: true;
}
/** How a provider admitted an agent message: as a new turn, or steered into the live one. */
export interface WorkbenchAgentMessageAdmission {
  kind: "started" | "steered";
  turnId: string;
}
/** An agent message's outcome: admitted, or held for its user's next turn because compaction was due or a questionnaire awaits its answer. */
export type WorkbenchAgentMessageResult = WorkbenchAgentMessageAdmission | { kind: "held" };
export interface WorkbenchAgentMessageInput {
  threadId: string;
  cwd: string;
  message: WorkbenchAgentMessage;
  context?: WorkbenchMessageContext;
  /** Workbench admission policy, never seen by providers: a due compaction or a questionnaire awaiting its answer holds the message instead of running. */
  holdForUser?: boolean;
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
  messageAgent(input: WorkbenchAgentMessageInput): Promise<WorkbenchAgentMessageResult>;
  rename(threadId: string, title: string): Promise<void>;
  compact(threadId: string, options: { scope: WorkbenchProviderCompactionScope; signal?: AbortSignal }): Promise<void>;
  /**
   * Move the backing native session so later turns run in `location`; idempotent. Workbench identity and history stay.
   * Resolves to the location as the provider now spells it, which its later reports repeat.
   */
  relocate(threadId: string, location: string): Promise<string>;
  /** Delete the backing provider session, retaining WB identity, state and history. */
  delete?(threadId: string): Promise<void>;
  /** Interrupt the thread's current execution without requiring a caller-selected turn. */
  interrupt(threadId: string): Promise<void>;
  /** Runtime truth only: whether this provider still runs the turn. Workbench settles turns nobody runs. */
  isTurnLive(threadId: string, turnId: string): Promise<boolean>;
  materialize(threadId: string, turnIds: string[], signal?: AbortSignal): Promise<void>;
}
