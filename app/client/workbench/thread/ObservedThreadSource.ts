/*
 * Exports:
 * - ObservedThreadSourcePorts: daemon channels, transports and app-owned context the observed feed needs.
 * - default createObservedThreadSource: feed one thread store from the family thread observation (entry + runtime) and the transcript subscription, with a store-local optimistic overlay and id-based actions.
 */
import type { WorkbenchHarness, WorkbenchPendingUserInputRequest, WorkbenchSubagentSummary } from "workbench-shared/types";
import type WorkbenchDaemonClient from "workbench-shared/workbench/daemon/WorkbenchDaemonClient";
import { createWorkbenchTextInput, type WorkbenchMessageContext, type WorkbenchUserInput as UserInput } from "workbench-shared/workbench/provider/provider-input";
import type { WorkbenchRateLimitSnapshot } from "workbench-shared/workbench/provider/provider-account";
import type { GitCheckpointProposal } from "workbench-shared/workbench/git/checkpoint-contracts";
import type { ThreadRuntime, WorkbenchThreadRouteTarget, WorkbenchThreadSidebarEntry } from "workbench-shared/workbench/thread/thread-state";
import type { Turn } from "workbench-shared/workbench/thread/workbench-thread-turn";
import { withWorkbenchTurnAdmission } from "workbench-shared/workbench/thread/thread-admission";
import { isWorkbenchMcpQuestionnaireRequestKey } from "workbench-shared/workbench/thread/thread-questionnaire-identity";
import {
  getWorkbenchApprovalSupplementalSteerText, hasWorkbenchApprovalDecisionSelection, isWorkbenchApprovalRequest,
} from "workbench-shared/workbench/thread/thread-user-input-requests";
import { ProjectIdSchema } from "workbench-shared/workbench/identity";
import type { TranscriptTextUpdate } from "workbench-shared/workbench/transcript/thread-transcript-stream";
import type ThreadObservationController from "./ThreadObservationController";
import { getThreadObservationKey } from "./ThreadObservationController";
import type ThreadTranscriptProjectionController from "../transcript/ThreadTranscriptProjectionController";
import type { ThreadTranscriptLocalThread, ThreadTranscriptProjectionState } from "../transcript/ThreadTranscriptProjectionController";
import { createOptimisticItem } from "./thread-optimistic-items";
import ThreadGitArcProposalObserver from "./ThreadGitArcProposalObserver";
import { ThreadMessageNotSentError } from "./thread-message-submission";
import { createThreadTurnsSlice, type ThreadHead, type ThreadStoreSource, type ThreadStoreState } from "./ThreadStore";

type ObservedTarget = Exclude<WorkbenchThreadRouteTarget, { kind: "new" | "draft" }>;
type ThreadEntry = Exclude<WorkbenchThreadSidebarEntry, { entryKind: "draft" }>;

export interface ObservedThreadSourcePorts {
  projectId: string;
  target: ObservedTarget;
  observations: ThreadObservationController;
  daemon: Pick<WorkbenchDaemonClient, "threads">;
  connect: () => Promise<void>;
  createTranscript: (
    onState: (state: ThreadTranscriptProjectionState) => void,
    onText: (update: TranscriptTextUpdate, canonicalText: string) => void,
  ) => { controller: ThreadTranscriptProjectionController; stopAvailability: () => void };
  presentText: (harness: WorkbenchHarness, update: TranscriptTextUpdate, canonicalText: string) => void;
  messageContext: (options: { workflowIds: readonly string[]; instructionInjections?: Record<string, string>; activatedSkillPaths?: readonly string[] }) => WorkbenchMessageContext;
  readRateLimits: (harness: WorkbenchHarness) => WorkbenchRateLimitSnapshot | null;
  /** Demand the provider's account limits while a view shows them (idempotent). */
  watchRateLimits: (harness: WorkbenchHarness) => void;
  subscribeRateLimits: (listener: () => void) => () => void;
  readGitArcProposal?: (input: { cwd: string; harness: WorkbenchHarness; proposalId: string; rootId?: string; threadId: string }) => Promise<GitCheckpointProposal>;
  subscribeGitArcProposalRefresh?: (listener: () => void) => () => void;
  updateThreadStateWithAcceptance: (request: {
    method: "workbench/thread-state/questionnaire/snooze"; projectId: ReturnType<typeof ProjectIdSchema.parse>;
    identity: ThreadEntry["identity"]; requestKey: string;
  }) => Promise<boolean>;
  reportError: (message: string) => void;
  /** Saved composer attachments are app URLs; the daemon needs the image itself. */
  resolveAttachmentUrl: (url: string) => Promise<string>;
}

/** The newest-turn window size; loading older turns raises it by the same step. */
const TURN_WINDOW_STEP = 4;

interface PendingInput {
  clientId: string;
  turn: Turn;
  /** Set once the provider started a turn for it; the overlay stays until the transcript delivers the input. */
  startedTurnId: string | null;
}

function statusOf(entry: ThreadEntry) {
  return entry.lifecycle.kind === "working" ? "active"
    : entry.lifecycle.kind === "needsAttention" && entry.lifecycle.reason === "pendingInput"
      && (entry.entryKind === "subagent" || !entry.metadata.snoozed) ? "active:waitingOnUserInput"
      : "idle";
}

function headOf(entry: ThreadEntry, runtime: ThreadRuntime | undefined, cwd: string): ThreadHead {
  const settings = entry.profile?.settings;
  return {
    id: entry.identity.threadId, harness: entry.identity.harness, isDraft: false, name: entry.title,
    agentNickname: entry.entryKind === "subagent" ? entry.name : null, agentRole: null,
    cwd: entry.entryKind === "subagent" ? entry.cwd : cwd, status: statusOf(entry),
    model: settings?.model ?? null, reasoningEffort: settings?.reasoningEffort ?? null,
    serviceTier: settings?.serviceTier ?? null, agentPath: settings?.agentPath ?? null,
    contextWindowTokens: settings?.contextWindowTokens ?? null,
    tokenUsage: runtime?.tokenUsage ?? null,
    ...(runtime?.willAutoCompact != null ? { willAutoCompact: runtime.willAutoCompact } : {}),
    goal: runtime?.goal ?? null,
    skills: runtime?.skills ?? [],
  };
}

/** The thread's open question: a durable questionnaire on the entry, else a live approval prompt from the runtime. */
function pendingOf(entry: ThreadEntry | null, runtime: ThreadRuntime | undefined): WorkbenchPendingUserInputRequest | null {
  if (!entry) return null;
  const pending = entry.pendingQuestionnaire ?? runtime?.pendingApproval ?? null;
  return pending ? {
    harness: entry.identity.harness, threadId: entry.identity.threadId,
    itemId: pending.itemId, request: pending.request, requestKey: pending.requestKey, turnId: pending.turnId,
  } : null;
}

/** Trims each input part and drops the empty ones; the daemon rejects blank parts. */
function normalizeInput(input: readonly UserInput[]): UserInput[] {
  return input.flatMap((entry): UserInput[] => {
    switch (entry.type) {
      case "text": {
        const text = entry.text.trim();
        return text ? [createWorkbenchTextInput(text)] : [];
      }
      case "image": {
        const url = entry.url.trim();
        return url ? [{ type: "image", url }] : [];
      }
      case "localImage": {
        const path = entry.path.trim();
        return path ? [{ type: "localImage", path }] : [];
      }
      case "skill":
      case "mention": {
        const name = entry.name.trim();
        const path = entry.path.trim();
        return name && path ? [{ type: entry.type, name, path }] : [];
      }
    }
    return [];
  });
}

function sanitize(message: string) {
  return message.replace(/[\u0000-\u001f\u007f-\u009f]/gu, "?").slice(0, 500);
}

export default function createObservedThreadSource(
  ports: ObservedThreadSourcePorts,
  publish: (next: Partial<ThreadStoreState>) => void,
): ThreadStoreSource {
  const threadId = ports.target.threadId;
  const observationKey = getThreadObservationKey(ports.projectId, ports.target);
  let disposed = false;
  let leases = 0;
  let views = 0;
  let observation: ReturnType<ThreadObservationController["acquire"]> | null = null;
  let stopRateLimits: (() => void) | null = null;
  let transcript: ReturnType<ObservedThreadSourcePorts["createTranscript"]> | null = null;
  /** The projection controller reports availability while it is constructed, before `transcript` is assigned. */
  let creatingTranscript = false;
  let transcriptState: ThreadTranscriptProjectionState = { status: "idle" };
  let turnLimit = TURN_WINDOW_STEP;
  let olderLoad: { previous: ReadonlySet<string>; resolve: (turnIds: readonly string[] | null) => void } | null = null;
  const pending = new Map<string, PendingInput>();
  const gitArc = new ThreadGitArcProposalObserver({
    ...(ports.readGitArcProposal ? { read: ports.readGitArcProposal } : {}),
    ...(ports.subscribeGitArcProposalRefresh ? { subscribeRefresh: ports.subscribeGitArcProposalRefresh } : {}),
    changed: () => sync(),
    isLive: () => !disposed && leases > 0,
  });

  const readEntry = () => {
    const state = ports.observations.getSnapshot(observationKey);
    const candidate = state.observation?.entries.find(entry => entry.entryKind !== "draft" && entry.identity.threadId === threadId);
    return { state, entry: candidate && candidate.entryKind !== "draft" ? candidate : null };
  };

  const projection = () => "projection" in transcriptState ? transcriptState.projection : null;

  const localThread = (entry: ThreadEntry): ThreadTranscriptLocalThread => ({
    id: entry.identity.threadId, harness: entry.identity.harness,
    turns: [...pending.values()].map(input => input.turn), turnHistory: [],
  });

  const select = (entry: ThreadEntry) => {
    transcript?.controller.select({ thread: localThread(entry), turnLimit });
  };

  /** Drops overlay inputs the transcript now carries; true when the overlay changed (and was re-selected). */
  const settleDelivered = (state: ThreadTranscriptProjectionState) => {
    const current = "projection" in state ? state.projection : null;
    if (!current || !pending.size) return false;
    const delivered = new Set(current.turns.flatMap(turn => turn.items.flatMap(item =>
      item.type === "userMessage" && item.clientId ? [item.clientId] : [])));
    let changed = false;
    for (const [clientId, entry] of pending) {
      const startedTurn = entry.startedTurnId ? current.turns.find(turn => turn.id === entry.startedTurnId) : null;
      if (delivered.has(clientId) || (startedTurn && startedTurn.status !== "inProgress")) {
        pending.delete(clientId);
        changed = true;
      }
    }
    return changed;
  };

  const acceptTranscript = (state: ThreadTranscriptProjectionState) => {
    transcriptState = state;
    const { entry } = readEntry();
    if (entry && settleDelivered(state)) {
      select(entry);
      return;
    }
    if (olderLoad && state.status === "ready") {
      const loaded = state.projection.turns.map(({ id }) => id).filter(id => !olderLoad!.previous.has(id));
      olderLoad.resolve(loaded.length ? loaded : null);
      olderLoad = null;
    }
    sync();
  };

  const presentText = (update: TranscriptTextUpdate, canonicalText: string) => {
    const { entry } = readEntry();
    if (entry) ports.presentText(entry.identity.harness, update, canonicalText);
  };

  function sync() {
    if (disposed || !leases) return;
    const { state, entry } = readEntry();
    const failure = state.status === "failed" || (!entry && (state.status === "absent" || state.status === "ready"))
      ? state.error || "This thread is no longer available." : null;
    if (entry && views) ports.watchRateLimits(entry.identity.harness);
    if (entry && views && !transcript && !creatingTranscript) {
      // Creation and selection publish synchronously (re-entering sync); everything below reads the result.
      creatingTranscript = true;
      try { transcript = ports.createTranscript(acceptTranscript, presentText); }
      finally { creatingTranscript = false; }
      select(entry);
    }
    const runtime = state.observation?.runtime ?? {};
    const current = projection();
    const head = entry ? headOf(entry, runtime[threadId], current?.thread.cwd ?? "") : null;
    gitArc.sync(entry, views && head?.cwd ? head.cwd : null);
    const subagents: WorkbenchSubagentSummary[] = ports.observations.getSubagents(observationKey);
    const relatedHeads = Object.fromEntries((state.observation?.entries ?? []).flatMap(candidate =>
      candidate.entryKind === "subagent" ? [[candidate.identity.threadId, headOf(candidate, runtime[candidate.identity.threadId], candidate.cwd)]] : []));
    const pendingQuestionnaire = pendingOf(entry, runtime[threadId]);
    publish({
      summary: {
        status: failure ? "failed" : entry ? "ready" : "loading", error: failure, head, entry,
        subagents, rateLimits: entry ? ports.readRateLimits(entry.identity.harness) : null,
        gitArcProposals: gitArc.proposals, relatedHeads, draftDocument: null,
      },
      turns: createThreadTurnsSlice(transcriptState, Boolean(current?.hasPreviousTurns), entry?.lifecycle.kind === "working"),
      questionnaire: { pending: pendingQuestionnaire },
      approvals: { entries: current?.approvalEntries ?? [] },
    });
  }

  const releaseTranscript = () => {
    transcript?.stopAvailability();
    void transcript?.controller.dispose();
    transcript = null;
    transcriptState = { status: "idle" };
    olderLoad?.resolve(null);
    olderLoad = null;
  };

  const requireEntry = () => {
    const { entry } = readEntry();
    if (!entry) throw new Error("This thread is not admitted yet.");
    return entry;
  };
  const readPending = () => {
    const { state, entry } = readEntry();
    return pendingOf(entry, state.observation?.runtime?.[threadId]);
  };

  return {
    feed: "observed",
    actions: {
      async send(input, options = {}) {
        const entry = requireEntry();
        const normalized = await Promise.all(normalizeInput(input).map(async part => part.type === "image"
          ? { ...part, url: await ports.resolveAttachmentUrl(part.url) } : part));
        if (!normalized.length) throw new Error("Message input cannot be empty.");
        await ports.connect();
        if (disposed) throw new ThreadMessageNotSentError();
        const clientId = crypto.randomUUID();
        const item = createOptimisticItem({ handle: clientId, clientUserMessageId: clientId, input: normalized, placement: "initial", status: "pending" });
        const turn = withWorkbenchTurnAdmission({
          id: `pending:${clientId}`, items: [item], status: "inProgress", error: null,
          startedAt: Math.floor(Date.now() / 1000), completedAt: null, durationMs: null, itemsView: "full",
        } satisfies Turn, "providerPending");
        pending.set(clientId, { clientId, turn, startedTurnId: null });
        select(entry);
        try {
          const result = await ports.daemon.threads.message({
            intent: options.startNewTurn ? "newTurn" : "continue",
            clientMessageId: clientId,
            input: normalized,
            threadId: entry.identity.threadId,
            context: ports.messageContext({
              workflowIds: options.workflowIds ?? [entry.entryKind === "subagent" ? "subagent" : "default"],
              ...(options.instructionInjections ? { instructionInjections: options.instructionInjections } : {}),
              ...(options.activatedSkillPaths ? { activatedSkillPaths: options.activatedSkillPaths } : {}),
            }),
            ...(options.skipAutoCompact ? { skipAutoCompact: true } : {}),
          });
          if (result.warning) ports.reportError(result.warning);
          const overlay = pending.get(clientId);
          if (result.kind === "started" && overlay) {
            overlay.startedTurnId = result.turn.id;
            options.onTurnAdmitted?.(result.turn.id);
          } else {
            // A steer reaches the transcript as held or delivered steer history.
            pending.delete(clientId);
            select(entry);
          }
        } catch (error) {
          pending.delete(clientId);
          if (!disposed) select(entry);
          throw error;
        }
      },
      // The thread's lifecycle, not a provider turn status, decides whether there is anything to stop.
      async stop() {
        const entry = requireEntry();
        const requestKey = readPending()?.requestKey ?? null;
        if (entry.lifecycle.kind !== "working" && !requestKey) return;
        await ports.daemon.threads.stop({
          threadId: entry.identity.threadId, intent: "stop", ...(requestKey ? { requestKey } : {}),
        });
      },
      async compact() { await ports.daemon.threads.compact({ threadId: requireEntry().identity.threadId }); },
      async resendSteer(itemId) { await ports.daemon.threads.steer.resend({ threadId, itemId }); },
      async dismissSteer(itemId) { await ports.daemon.threads.steer.dismiss({ threadId, itemId }); },
      async stopShell(itemId) {
        try { await ports.daemon.threads.shell.stop({ threadId, itemId }); }
        catch (error) { throw new Error(`The command could not be stopped: ${sanitize(error instanceof Error ? error.message : String(error)).slice(0, 300)}`); }
      },
      async submitQuestionnaire(response, options = {}) {
        const durable = readPending();
        if (!durable) throw new Error("There is no pending question for this thread.");
        if (isWorkbenchApprovalRequest(durable.request) && !hasWorkbenchApprovalDecisionSelection(durable.request, response)) {
          throw new Error("Choose one of the approval options before submitting.");
        }
        const steerText = getWorkbenchApprovalSupplementalSteerText(durable.request, response);
        const supplementalInput = [...(steerText ? [createWorkbenchTextInput(steerText)] : []), ...(options.supplementalInput ?? [])];
        const result = await ports.daemon.threads.questionnaire.respond({
          ...(options.activatedSkillPaths?.length ? { activatedSkillPaths: options.activatedSkillPaths } : {}),
          insertAfterItemId: options.insertAfterItemId ?? (isWorkbenchMcpQuestionnaireRequestKey(durable.requestKey) ? null : durable.itemId),
          insertAfterItemIndex: options.insertAfterItemIndex ?? null,
          projectId: ProjectIdSchema.parse(ports.projectId),
          requestKey: durable.requestKey,
          response,
          ...(supplementalInput.length ? { supplementalInput } : {}),
          threadId,
          turnId: options.turnId ?? durable.turnId,
        });
        if (result.warning) ports.reportError(result.warning);
      },
      async snoozeQuestionnaire(requestKey) {
        const entry = requireEntry();
        const accepted = await ports.updateThreadStateWithAcceptance({
          method: "workbench/thread-state/questionnaire/snooze", projectId: ProjectIdSchema.parse(ports.projectId),
          identity: entry.identity, requestKey,
        });
        if (!accepted) throw new Error("The questionnaire changed before it could be snoozed.");
      },
      // Settings are owned by the composer profile selection, which persists to the thread entry.
      changeAgent: () => {},
      changeModel: () => {},
      changeReasoningEffort: () => {},
      changeServiceTier: () => {},
      changeSettings: () => {},
      loadOlder() {
        const current = projection();
        const { entry } = readEntry();
        if (!transcript || !entry || !current?.hasPreviousTurns || olderLoad) return Promise.resolve(null);
        return new Promise(resolve => {
          olderLoad = { previous: new Set(current.turns.map(({ id }) => id)), resolve };
          turnLimit += TURN_WINDOW_STEP;
          select(entry);
        });
      },
      observeGitArcProposal(proposalId) {
        if (disposed) return () => {};
        const release = gitArc.demand(proposalId);
        sync();
        return release;
      },
      // The observation's runtime carries the resulting goal and skills.
      async setGoal(objective) { await ports.daemon.threads.goal.set({ threadId, objective }); },
      async clearGoal() { await ports.daemon.threads.goal.clear({ threadId }); },
      async deactivateSkill(path) { await ports.daemon.threads.skills.deactivate({ threadId, path }); },
    },
    acquire(interest) {
      if (disposed) throw new Error("The thread store is disposed.");
      if (!leases++) {
        observation = ports.observations.acquire(ports.projectId, ports.target, sync);
        stopRateLimits = ports.subscribeRateLimits(sync);
      }
      const view = interest !== "summary";
      if (view) views++;
      sync();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        if (view && !--views) {
          releaseTranscript();
          pending.clear();
          turnLimit = TURN_WINDOW_STEP;
        }
        if (!--leases) {
          gitArc.clear();
          stopRateLimits?.();
          stopRateLimits = null;
          observation?.release();
          observation = null;
          publish({ summary: { status: "loading", error: null, head: null, entry: null, subagents: [], rateLimits: null,
            gitArcProposals: {}, relatedHeads: {}, draftDocument: null } });
        } else sync();
      };
    },
    /** Resubscribes the transcript; the family observation is shared and reopens with its own owner. */
    async recover() {
      if (!views) return;
      releaseTranscript();
      sync();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      releaseTranscript();
      gitArc.dispose();
      stopRateLimits?.();
      observation?.release();
      observation = null;
      pending.clear();
    },
  };
}
