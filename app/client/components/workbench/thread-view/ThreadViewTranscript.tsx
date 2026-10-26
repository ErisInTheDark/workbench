/*
 * Exports:
 * - readActiveTranscript: the transcript source and projection that belong to the shown thread, or null for another thread's.
 * - default ThreadViewTranscript: the shown thread's transcript (older-turn paging, source states, item contexts) or the subagent message board.
 */
"use client";

import { useMemo, type RefObject } from "react";

import type { WorkbenchSubagentSummary } from "workbench-shared/types";
import type { WorkbenchThreadRouteTarget } from "workbench-shared/workbench/thread/thread-state";
import type { Turn } from "workbench-shared/workbench/thread/workbench-thread-turn";
import type { ThreadTranscriptProjectionState } from "../../../workbench/transcript/ThreadTranscriptProjectionController";
import type { RelatedThread } from "../../../workbench/thread/ThreadStore";
import { deriveThreadItemApprovals, ThreadItemApprovalsContext } from "../../../workbench/thread/thread-item-approvals";
import {
  deriveThreadItemShellQueue, deriveThreadYieldedShells, ThreadItemShellQueueContext, ThreadShellOutputStoreContext,
  ThreadYieldedShellsContext,
} from "../../../workbench/thread/thread-item-shell-queue";
import { WorkbenchFeedbackAddressingContext, type WorkbenchFeedbackAddressing } from "../address-feedback-context";
import { useThread } from "../use-thread";
import { TranscriptBodiesContext, useTranscript } from "../use-transcript";
import WorkbenchLoadingSpinner from "../WorkbenchLoadingSpinner";
import ThreadItemActionsContext, { type ThreadItemActions } from "./ThreadItemActionsContext";
import ThreadMessageBoard from "./ThreadMessageBoard";
import { ThreadTodoControlsContext, type ThreadTodoControls } from "./thread-todo-controls";
import { useThreadScrollViewportContext } from "./thread-scroll-viewport-context";
import ThreadTranscriptProjection from "./ThreadTranscriptProjection";
import { ThreadTurnLoadFailure, ThreadTurnLoadingSkeleton } from "./transcript/ThreadTurnLoadStates";
import useThreadHistoryPaging from "./use-thread-history-paging";

const EMPTY_TURNS: readonly Turn[] = [];

/** A thread view's turns slice can still hold the previous thread's transcript while the shown one loads. */
export function readActiveTranscript (thread: { id: string } | null, transcript: ThreadTranscriptProjectionState) {
  const source = thread && "threadId" in transcript && transcript.threadId === thread.id ? transcript : null;
  return { source, projection: source && "projection" in source ? source.projection : null };
}

export default function ThreadViewTranscript ({
  feedbackAddressing,
  isMessageBoardOpen,
  projectId,
  relatedThreadsById,
  scrollViewportRef,
  subagents,
  target,
  todoControls,
  viewInstanceKey,
}: {
  feedbackAddressing: WorkbenchFeedbackAddressing;
  isMessageBoardOpen: boolean;
  projectId: string;
  relatedThreadsById: Readonly<Record<string, RelatedThread | undefined>>;
  scrollViewportRef: RefObject<HTMLDivElement | null>;
  subagents: readonly WorkbenchSubagentSummary[];
  /** The shown thread: the root, or the selected subagent. */
  target: WorkbenchThreadRouteTarget;
  /** Null where todos are read-only (drafts, unlisted threads). */
  todoControls: ThreadTodoControls | null;
  viewInstanceKey: string;
}) {
  const active = useThread(projectId, target, "view");
  const activeThread = active.head;
  const turns = useTranscript.turns(active.store);
  const { pending: pendingUserInputRequest } = useThread.questionnaire(active.store);
  const { entries: approvalEntries } = useTranscript.approvals(active.store);
  const threadScrollViewport = useThreadScrollViewportContext();
  const usesSqlTranscript = Boolean(activeThread && !activeThread.isDraft);
  const { source: transcriptSource, projection } = readActiveTranscript(activeThread, turns.transcript);
  const isLaunchingDraft = Boolean(activeThread?.isDraft) && turns.turns.length > 0;
  const loadedTurns = activeThread?.isDraft || projection ? turns.turns : EMPTY_TURNS;
  const renderedHistoryTurnIds = useMemo(() => loadedTurns.map(({ id }) => id), [loadedTurns]);
  // The turn just before the loaded window, when the catalog lists one, anchors the older-turn skeleton.
  const firstLoadedHistoryIndex = projection?.turnHistory.findIndex(entry => entry.turnId === loadedTurns[0]?.id) ?? -1;
  const previousTurnEntry = firstLoadedHistoryIndex > 0 ? projection?.turnHistory[firstLoadedHistoryIndex - 1] ?? null : null;
  const itemApprovals = useMemo(
    () => deriveThreadItemApprovals(activeThread ? approvalEntries : [], pendingUserInputRequest),
    [approvalEntries, pendingUserInputRequest, activeThread],
  );
  const shellQueue = activeThread?.shellQueue;
  const itemShellQueue = useMemo(() => deriveThreadItemShellQueue(shellQueue), [shellQueue]);
  const yieldedShellReferences = activeThread?.yieldedShells;
  const yieldedShells = useMemo(() => deriveThreadYieldedShells(yieldedShellReferences), [yieldedShellReferences]);
  const itemActions = useMemo<ThreadItemActions>(() => ({
    resendSteer: itemId => active.actions.resendSteer(itemId),
    dismissSteer: itemId => active.actions.dismissSteer(itemId),
    stopShell: itemId => active.actions.stopShell(itemId),
    startShellNow: itemId => active.actions.startShellNow(itemId),
  }), [active.actions]);

  // Reconciles after every commit, including SQL's later prepend and skeleton removal.
  const historyPaging = useThreadHistoryPaging({
    thread: activeThread ? { id: activeThread.id, harness: activeThread.harness } : null,
    viewKey: `${projectId}\0${viewInstanceKey}`,
    canLoadOlder: turns.canLoadOlder,
    renderedTurnIds: renderedHistoryTurnIds,
    sourceReady: !usesSqlTranscript || transcriptSource?.status === "ready",
    loadOlder: active.actions.loadOlder,
    scrollViewportRef,
    reconcileLayout: threadScrollViewport.reconcileLayout,
  });

  if (isMessageBoardOpen) return <ThreadMessageBoard projectId={projectId} subagents={subagents} />;
  const sourceMessage = transcriptSource?.status === "failed"
    ? transcriptSource.message
    : transcriptSource?.status === "absent"
      ? "No SQLite transcript exists for this window."
      : transcriptSource?.status === "unavailable"
        ? "The SQLite transcript source is unavailable."
        : null;
  return <>
    {activeThread && usesSqlTranscript && previousTurnEntry ? (
      historyPaging.status === "loading" ? (
        <ThreadTurnLoadingSkeleton entry={previousTurnEntry} isLoading />
      ) : historyPaging.status === "failed" ? (
        <ThreadTurnLoadFailure
          entry={previousTurnEntry}
          onRetry={() => void historyPaging.load({ retry: true })}
        />
      ) : null
    ) : null}
    {activeThread ? (
      usesSqlTranscript || isLaunchingDraft ? (
        projection ? (
          <>
            {transcriptSource?.status === "failed" ? (
              <div role="alert" className="mx-auto max-w-content px-5 py-3 text-sm text-danger md:px-6">
                {transcriptSource.message}
              </div>
            ) : null}
            <TranscriptBodiesContext.Provider value={active.store?.transcriptBodies ?? null}>
            <ThreadItemApprovalsContext.Provider value={itemApprovals}>
            <ThreadItemShellQueueContext.Provider value={itemShellQueue}>
            <ThreadYieldedShellsContext.Provider value={yieldedShells}>
            <ThreadShellOutputStoreContext.Provider value={active.store}>
            <ThreadItemActionsContext.Provider value={itemActions}>
            <ThreadTodoControlsContext.Provider value={todoControls}>
            <WorkbenchFeedbackAddressingContext.Provider value={feedbackAddressing}>
            <ThreadTranscriptProjection
              canLoadPreviousTurn={turns.canLoadOlder}
              hiddenReasoningStep={null}
              historySentinelRef={historyPaging.setSentinel}
              presentationSource={{
                kind: "sqlite",
                sourceKey: `${activeThread.harness}:${projection.thread.id}`,
              }}
              projection={projection}
              liveTurnId={turns.liveTurnId}
              relatedThreadsById={relatedThreadsById}
              subagents={subagents}
            />
            </WorkbenchFeedbackAddressingContext.Provider>
            </ThreadTodoControlsContext.Provider>
            </ThreadItemActionsContext.Provider>
            </ThreadShellOutputStoreContext.Provider>
            </ThreadYieldedShellsContext.Provider>
            </ThreadItemShellQueueContext.Provider>
            </ThreadItemApprovalsContext.Provider>
            </TranscriptBodiesContext.Provider>
          </>
        ) : sourceMessage ? (
          <div className="flex min-h-48 items-center justify-center px-4 text-center text-sm text-fg/muted">
            {sourceMessage}
          </div>
        ) : (
          <WorkbenchLoadingSpinner label="Loading thread" />
        )
      ) : null
    ) : (
      <div className="border-t border-[color-mix(in srgb, var(--text) 10%, transparent)] py-4">
        <p className="m-0 text-[0.92em] leading-[1.6] text-fg/muted">Loading subagent thread...</p>
      </div>
    )}
  </>;
}
