/*
 * Exports:
 * - ThreadHead: the metadata every thread consumer reads (identity, settings, usage, status), without turn content.
 * - RelatedThread: a child or linked thread for renderers: head plus turns when loaded.
 * - ThreadSummarySlice/ThreadTurnsSlice/ThreadQuestionnaireSlice/ThreadApprovalsSlice: one thread's independently subscribed slices.
 * - createThreadTurnsSlice: build a turns slice whose provider-item turns are derived once per projection.
 * - ThreadStoreState/ThreadSliceName: all slices and their keys.
 * - ThreadStoreActions: id-based thread actions.
 * - ThreadStoreSource: one feed that publishes slices and owns actions (legacy document owner or observed daemon channels).
 * - ThreadInterest: how much of a thread one consumer needs.
 * - ThreadFeed: which feed backs a store (observed daemon channels, or a local draft document).
 * - default ThreadStore: per-thread slice cache with per-slice listeners and consumer leases over one source.
 */
import type {
  ThreadPayload, WorkbenchControls, WorkbenchHarness, WorkbenchPendingUserInputRequest, WorkbenchSendThreadMessageOptions,
  WorkbenchSubagentSummary, WorkbenchSubmitUserInputRequestOptions, WorkbenchUserInputResponse,
} from "workbench-shared/types";
import type { WorkbenchUserInput as UserInput } from "workbench-shared/workbench/provider/provider-input";
import type { WorkbenchRateLimitSnapshot } from "workbench-shared/workbench/provider/provider-account";
import type { WorkbenchApprovalOutcomeEntry } from "workbench-shared/workbench/provider/provider-approval";
import type { ThreadTokenUsage } from "workbench-shared/workbench/thread/thread-context-usage";
import type { WorkbenchThreadGoal } from "workbench-shared/workbench/thread/thread-goal";
import type { WorkbenchThreadSkill } from "workbench-shared/workbench/thread/thread-skill-state";
import type { WorkbenchThreadTodo } from "workbench-shared/workbench/thread/thread-todo";
import type { WorkbenchThreadAddressedFeedback } from "workbench-shared/workbench/thread/thread-addressed-feedback";
import type { WorkbenchThreadSidebarEntry, WorkbenchThreadRouteTarget } from "workbench-shared/workbench/thread/thread-state";
import { areDeeplyEqual } from "workbench-shared/workbench/deep-equality";
import type { DraftId, WorkbenchThreadId } from "workbench-shared/workbench/identity";
import type { ThreadItem } from "workbench-shared/workbench/thread/workbench-thread-items";
import type { Turn } from "workbench-shared/workbench/thread/workbench-thread-turn";
import type { WorkbenchTranscriptProjection } from "workbench-shared/workbench/transcript/workbench-transcript-projection";
import type { ThreadTranscriptProjectionState } from "../transcript/ThreadTranscriptProjectionController";
import type { ThreadGitArcProposalObservation } from "./ThreadGitArcProposalObserver";

export type ThreadHead = ThreadHeadFields & ({ id: DraftId; isDraft: true } | { id: WorkbenchThreadId; isDraft: false });

interface ThreadHeadFields {
  harness: WorkbenchHarness;
  name: string | null;
  agentNickname: string | null;
  agentRole: string | null;
  cwd: string;
  /** Provider-style status: `active`, `active:waitingOnUserInput`, `idle` or `notLoaded`. */
  status: string;
  model: string | null;
  reasoningEffort: string | null;
  serviceTier: string | null;
  agentPath: string | null;
  tokenUsage: ThreadTokenUsage | null;
  contextWindowTokens?: number | null;
  willAutoCompact?: boolean;
  /** The user-set Workbench goal; drafts have none. */
  goal?: WorkbenchThreadGoal | null;
  skills?: readonly WorkbenchThreadSkill[];
  /** Follow-up todos; drafts have none. */
  todos?: readonly WorkbenchThreadTodo[];
  /** Feedback the thread was launched to address, until the user deletes or clears it. */
  addressedFeedback?: readonly WorkbenchThreadAddressedFeedback[];
}

/** A child or linked thread as renderers see it: its head, plus turns when they are loaded. */
export type RelatedThread = ThreadHead & { turns?: readonly Turn[] };

type ThreadEntry = Exclude<WorkbenchThreadSidebarEntry, { entryKind: "draft" }>;

export interface ThreadSummarySlice {
  status: "loading" | "ready" | "failed";
  error: string | null;
  head: ThreadHead | null;
  entry: ThreadEntry | null;
  subagents: WorkbenchSubagentSummary[];
  rateLimits: WorkbenchRateLimitSnapshot | null;
  gitArcProposals: Record<string, ThreadGitArcProposalObservation>;
  /** Child heads by thread id, for subagent tab labels and linked items. */
  relatedHeads: Record<string, ThreadHead>;
  /** Drafts only: the local draft document the app launches a thread from on first send. */
  draftDocument: ThreadPayload | null;
}

export interface ThreadTurnsSlice {
  transcript: ThreadTranscriptProjectionState;
  /** The loaded turns with provider thread items only; generic and questionnaire items render from the projection. */
  turns: readonly Turn[];
  canLoadOlder: boolean;
  /** The newest turn while the thread itself is working, else null. A turn's own status is a provider detail, never activity. */
  liveTurnId: string | null;
}

const NO_TURNS: readonly Turn[] = [];
const threadTurnsByProjection = new WeakMap<WorkbenchTranscriptProjection, readonly Turn[]>();

/** One turns slice per transcript state; the provider-item turns are derived once per projection. */
export function createThreadTurnsSlice(transcript: ThreadTranscriptProjectionState, canLoadOlder: boolean, working: boolean): ThreadTurnsSlice {
  const projection = "projection" in transcript ? transcript.projection : null;
  let turns = projection ? threadTurnsByProjection.get(projection) : NO_TURNS;
  if (!turns && projection) {
    turns = projection.turns.map(turn => ({
      ...turn,
      items: turn.items.filter((item): item is ThreadItem => item.type !== "generic" && !("requestKey" in item)),
    }));
    threadTurnsByProjection.set(projection, turns);
  }
  return { transcript, turns: turns ?? NO_TURNS, canLoadOlder, liveTurnId: working ? projection?.turns.at(-1)?.id ?? null : null };
}

export interface ThreadQuestionnaireSlice {
  pending: WorkbenchPendingUserInputRequest | null;
}

export interface ThreadApprovalsSlice {
  entries: readonly WorkbenchApprovalOutcomeEntry[];
}

export interface ThreadStoreState {
  summary: ThreadSummarySlice;
  turns: ThreadTurnsSlice;
  questionnaire: ThreadQuestionnaireSlice;
  approvals: ThreadApprovalsSlice;
}
export type ThreadSliceName = keyof ThreadStoreState;

export interface ThreadStoreActions {
  send(input: UserInput[], options?: WorkbenchSendThreadMessageOptions): Promise<void>;
  stop(): Promise<void>;
  compact(): Promise<void>;
  resendSteer(itemId: string): Promise<void>;
  dismissSteer(itemId: string): Promise<void>;
  stopShell(itemId: string): Promise<void>;
  submitQuestionnaire(response: WorkbenchUserInputResponse, options?: WorkbenchSubmitUserInputRequestOptions): Promise<void>;
  snoozeQuestionnaire(requestKey: string): Promise<void>;
  changeAgent(value: string | null): void;
  changeModel(value: string): void;
  changeReasoningEffort(value: string | null): void;
  changeServiceTier(value: string | null): void;
  changeSettings(value: Parameters<WorkbenchControls["setCurrentThreadComposerSettings"]>[1]): void;
  /** Loads one older turn window; resolves with the newly loaded turn ids, or null when nothing loaded. */
  loadOlder(): Promise<readonly string[] | null>;
  /** Demands one Git arc proposal card until released. */
  observeGitArcProposal(proposalId: string): () => void;
  setGoal(objective: string): Promise<void>;
  clearGoal(): Promise<void>;
  deactivateSkill(path: string): Promise<void>;
  addTodo(text: string, required: boolean): Promise<void>;
  removeTodo(id: number): Promise<void>;
  setTodoRequired(id: number, required: boolean): Promise<void>;
  setTodoText(id: number, text: string): Promise<void>;
  clearAddressedFeedback(): Promise<void>;
}

export type ThreadFeed = "draft" | "observed";
export type ThreadInterest = "summary" | "view" | "route";

export interface ThreadStoreSource {
  readonly feed: ThreadFeed;
  readonly actions: ThreadStoreActions;
  /** `view` consumers need turn content; `summary` consumers only the summary slice; `route` is the route's own view. */
  acquire(interest: ThreadInterest): () => void;
  /** Retries a failed open. */
  recover(): Promise<void>;
  dispose(): void;
}

export const EMPTY_THREAD_STORE_STATE: ThreadStoreState = {
  summary: {
    status: "loading", error: null, head: null, entry: null, subagents: [], rateLimits: null,
    gitArcProposals: {}, relatedHeads: {}, draftDocument: null,
  },
  turns: { transcript: { status: "idle" }, turns: NO_TURNS, canLoadOlder: false, liveTurnId: null },
  questionnaire: { pending: null },
  approvals: { entries: [] },
};

function sameSlice(name: ThreadSliceName, left: object, right: object) {
  if (name === "summary" || name === "questionnaire") return areDeeplyEqual(left, right);
  // Turn content is large and streamed; sources keep references stable until something changes.
  const leftValues = left as Record<string, unknown>;
  const rightValues = right as Record<string, unknown>;
  const keys = new Set([...Object.keys(leftValues), ...Object.keys(rightValues)]);
  return [...keys].every(key => Object.is(leftValues[key], rightValues[key]));
}

export default class ThreadStore {
  #state: ThreadStoreState = EMPTY_THREAD_STORE_STATE;
  readonly #listeners = new Map<ThreadSliceName, Set<() => void>>();
  readonly #source: ThreadStoreSource;
  #consumers = 0;
  #disposed = false;

  constructor(
    readonly projectId: string,
    readonly target: Exclude<WorkbenchThreadRouteTarget, { kind: "new" }>,
    createSource: (publish: (next: Partial<ThreadStoreState>) => void) => ThreadStoreSource,
  ) {
    this.#source = createSource(next => this.#publish(next));
  }

  get threadId() { return this.target.kind === "draft" ? this.target.draftId : this.target.threadId; }
  get feed() { return this.#source.feed; }
  get actions() { return this.#source.actions; }
  get hasConsumers() { return this.#consumers > 0; }

  getSlice<Name extends ThreadSliceName>(name: Name): ThreadStoreState[Name] {
    return this.#state[name];
  }

  subscribe(name: ThreadSliceName, listener: () => void) {
    let listeners = this.#listeners.get(name);
    if (!listeners) this.#listeners.set(name, listeners = new Set());
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }

  acquire(interest: ThreadInterest) {
    if (this.#disposed) throw new Error("The thread store is disposed.");
    this.#consumers++;
    const release = this.#source.acquire(interest);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#consumers--;
      release();
    };
  }

  recover() { return this.#source.recover(); }

  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#source.dispose();
    this.#listeners.clear();
  }

  #publish(next: Partial<ThreadStoreState>) {
    if (this.#disposed) return;
    const changed: ThreadSliceName[] = [];
    let state = this.#state;
    for (const name of Object.keys(next) as ThreadSliceName[]) {
      const value = next[name];
      if (!value || sameSlice(name, state[name], value)) continue;
      state = { ...state, [name]: value };
      changed.push(name);
    }
    if (!changed.length) return;
    this.#state = state;
    for (const name of changed) for (const listener of this.#listeners.get(name) ?? []) listener();
  }
}
