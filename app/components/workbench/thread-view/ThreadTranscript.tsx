/*
 * Exports:
 * - default ThreadTranscript: render the normal settled thread history while preserving one external pagination lifecycle. Keywords: transcript, thread, history, pagination.
 */
"use client";

import { useMemo, type RefObject } from "react";

import type {
  ThreadPayload,
  WorkbenchBrowseResultEntry,
  WorkbenchSkillSummary,
  WorkbenchSubagentSummary,
  WorkbenchThreadTurnHistoryEntry,
} from "workbench-shared/types";
import type { WorkspaceFileLinkRoot } from "../../../workbench/markdown/markdown-links";
import type { InlineMentionHighlightSources } from "../../../workbench/thread/inline-mention-highlights";
import type { ThreadTextPresentationSource } from "../../../workbench/thread/ThreadTextPresentationController";
import type { ThreadReasoningStepReference } from "./thread-reasoning-display";
import { isWorkbenchQuestionnaireResponseInput } from "workbench-shared/workbench/thread/thread-recovery-message";
import type { PreviousTurnLoadStatus } from "./previous-turn-load-state";
import { useStableBrowseResultEntriesByTurn } from "./stable-browse-result-entries";
import {
  ThreadTurnDetails,
  ThreadTurnLoadFailure,
  ThreadTurnLoadingSkeleton,
} from "./thread-view-items";

const EMPTY_BROWSE_RESULT_ENTRIES: readonly WorkbenchBrowseResultEntry[] = [];
const EMPTY_HIDDEN_DYNAMIC_TOOL_CALL_ITEM_IDS: readonly string[] = [];
const EMPTY_HOISTED_GIT_ARC_PROPOSAL_IDS: ReadonlySet<string> = new Set();

export default function ThreadTranscript({
  browseResultEntries,
  canLoadPreviousTurn,
  currentTurnId,
  hiddenDynamicToolCallItemIds,
  hiddenReasoningStep,
  hiddenWebSearchItemIds,
  hideFinalAgentMessage,
  hideTerminalReasoning,
  hideWorkbenchControlAgentMessages,
  hideWorkbenchControlUserMessages,
  historySentinelRef,
  inlineMentionSources,
  knownSkills,
  onRetryPreviousTurn,
  previousTurnEntry,
  previousTurnLoadStatus,
  presentationSource,
  projectFilePaths,
  projectId,
  projectRootPath,
  relatedThreadsById,
  subagents,
  terminalGitArcProposalIds,
  thread,
  visibleHistoryEntries,
  workspaceRoots,
}: {
  browseResultEntries: readonly WorkbenchBrowseResultEntry[];
  canLoadPreviousTurn: boolean;
  currentTurnId: string | null;
  hiddenDynamicToolCallItemIds: readonly string[];
  hiddenReasoningStep: ThreadReasoningStepReference | null;
  hiddenWebSearchItemIds?: readonly string[];
  hideFinalAgentMessage: boolean;
  hideTerminalReasoning: boolean;
  hideWorkbenchControlAgentMessages: boolean;
  hideWorkbenchControlUserMessages: boolean;
  historySentinelRef: RefObject<HTMLDivElement | null>;
  inlineMentionSources?: InlineMentionHighlightSources | null;
  knownSkills: WorkbenchSkillSummary[];
  onRetryPreviousTurn: () => void;
  previousTurnEntry: WorkbenchThreadTurnHistoryEntry | null;
  previousTurnLoadStatus?: PreviousTurnLoadStatus;
  presentationSource: ThreadTextPresentationSource;
  projectFilePaths: readonly string[];
  projectId: string;
  projectRootPath: string;
  relatedThreadsById: Record<string, ThreadPayload | undefined>;
  subagents: readonly WorkbenchSubagentSummary[];
  terminalGitArcProposalIds: ReadonlySet<string>;
  thread: ThreadPayload;
  visibleHistoryEntries: readonly WorkbenchThreadTurnHistoryEntry[];
  workspaceRoots: readonly WorkspaceFileLinkRoot[];
}) {
  const loadedTurnsById = useMemo(
    () => new Map(thread.turns.map((turn) => [turn.id, turn])),
    [thread.turns],
  );
  const browseResultEntriesByTurnId = useStableBrowseResultEntriesByTurn(browseResultEntries);

  if (!visibleHistoryEntries.length) {
    return (
      <p className="m-0 border-t border-[color-mix(in_srgb,var(--text)_10%,transparent)] py-4 text-[0.92em] leading-[1.6] text-muted">
        No turns were returned for this thread yet.
      </p>
    );
  }

  return (
    <>
      {canLoadPreviousTurn ? (
        <div ref={historySentinelRef} className="h-px" aria-hidden="true" />
      ) : null}
      {visibleHistoryEntries.map((entry) => {
        const turn = loadedTurnsById.get(entry.turnId);
        const isCurrentTurn = turn?.id === currentTurnId;
        const isPreviousTurnBoundary = entry === previousTurnEntry;
        return [
          <div
            key={`${entry.turnId}:history-marker`}
            aria-hidden="true"
            className="h-0 w-full"
            data-thread-history-turn-id={entry.turnId}
          />,
          turn ? (
            <ThreadTurnDetails
              key={entry.turnId}
              browseResultEntries={browseResultEntriesByTurnId.get(entry.turnId) ?? EMPTY_BROWSE_RESULT_ENTRIES}
              hiddenDynamicToolCallItemIds={isCurrentTurn
                ? hiddenDynamicToolCallItemIds
                : EMPTY_HIDDEN_DYNAMIC_TOOL_CALL_ITEM_IDS}
              hideFinalAgentMessage={hideFinalAgentMessage}
              hideTerminalReasoning={isCurrentTurn && hideTerminalReasoning}
              hideTopBorder={turn.items.some((item) => (
                item.type === "userMessage" && isWorkbenchQuestionnaireResponseInput(item.content)
              ))}
              hideWorkbenchControlAgentMessages={hideWorkbenchControlAgentMessages}
              hideWorkbenchControlUserMessages={hideWorkbenchControlUserMessages}
              inlineMentionSources={inlineMentionSources}
              knownSkills={knownSkills}
              threadCwdPath={thread.cwd}
              threadId={thread.id}
              projectFilePaths={projectFilePaths}
              projectId={projectId}
              projectRootPath={projectRootPath}
              presentationSource={turn.status === "inProgress" ? presentationSource : null}
              relatedThreadsById={relatedThreadsById}
              subagents={subagents}
              turn={turn}
              workspaceRoots={workspaceRoots}
              hiddenReasoningStep={isCurrentTurn ? hiddenReasoningStep : null}
              hoistedGitArcProposalIds={isCurrentTurn
                ? terminalGitArcProposalIds
                : EMPTY_HOISTED_GIT_ARC_PROPOSAL_IDS}
              hiddenWebSearchItemIds={isCurrentTurn ? hiddenWebSearchItemIds : undefined}
              itemTimeline={entry.itemTimeline}
            />
          ) : isPreviousTurnBoundary && previousTurnLoadStatus === "loading" ? (
            <ThreadTurnLoadingSkeleton
              key={entry.turnId}
              entry={entry}
              isLoading
            />
          ) : isPreviousTurnBoundary && previousTurnLoadStatus === "failed" ? (
            <ThreadTurnLoadFailure
              key={entry.turnId}
              entry={entry}
              onRetry={onRetryPreviousTurn}
            />
          ) : null,
        ];
      })}
    </>
  );
}
