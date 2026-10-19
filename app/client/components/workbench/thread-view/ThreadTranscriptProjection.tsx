/*
 * Exports:
 * - default ThreadTranscriptProjection: render canonical SQLite transcript turns through the one turn renderer, providing the transcript scope its items read.
 */
"use client";

import { Fragment, useMemo, type Ref } from "react";

import type {
  ThreadPayload,
  WorkbenchBrowseResultEntry,
  WorkbenchSkillSummary,
  WorkbenchSubagentSummary,
} from "workbench-shared/types";
import type { WorkbenchTranscriptProjection } from "workbench-shared/workbench/transcript/workbench-transcript-projection";
import type { WorkspaceFileLinkRoot } from "../../../workbench/markdown/markdown-links";
import type { RelatedThread } from "../../../workbench/thread/ThreadStore";
import type { InlineMentionHighlightSources } from "../../../workbench/thread/inline-mention-highlights";
import type { ThreadTextPresentationSource } from "../../../workbench/thread/ThreadTextPresentationController";
import { isWorkbenchQuestionnaireResponseInput } from "workbench-shared/workbench/thread/thread-recovery-message";
import { TranscriptScopeContext, type TranscriptScope } from "../use-transcript";
import { useStableBrowseResultEntriesByTurn } from "./stable-browse-result-entries";
import type { ThreadReasoningStepReference } from "./thread-reasoning-display";
import ThreadMeasuredContent from "./ThreadMeasuredContent";
import ThreadTurnItems from "./transcript/ThreadTurnItems";

const EMPTY_BROWSE_RESULT_ENTRIES: readonly WorkbenchBrowseResultEntry[] = [];

function mergeAdjacentTurnSegments(
  segments: WorkbenchTranscriptProjection["display"]["segments"],
) {
  return segments.reduce<Array<{
    id: string;
    isFirstForTurn: boolean;
    items: WorkbenchTranscriptProjection["display"]["segments"][number]["items"];
    turnId: string;
  }>>((result, segment) => {
    const previous = result.at(-1);
    if (previous?.turnId === segment.turnId) {
      result[result.length - 1] = {
        ...previous,
        items: [...previous.items, ...segment.items],
      };
    } else {
      // Keyed by turn, not by its first segment: history landing inside a turn must not remount the whole turn.
      const repeats = result.filter(entry => entry.turnId === segment.turnId).length;
      result.push({
        id: repeats ? `${segment.turnId}#${repeats + 1}` : segment.turnId,
        isFirstForTurn: segment.isFirstForTurn,
        items: segment.items,
        turnId: segment.turnId,
      });
    }
    return result;
  }, []);
}

export default function ThreadTranscriptProjection({
  canLoadPreviousTurn,
  hiddenReasoningStep,
  historySentinelRef,
  inlineMentionSources,
  knownSkills,
  projectFilePaths,
  projectId,
  projectRootPath,
  presentationSource,
  projection,
  liveTurnId,
  relatedThreadsById,
  subagents,
  workspaceRoots,
}: {
  canLoadPreviousTurn: boolean;
  hiddenReasoningStep?: ThreadReasoningStepReference | null;
  historySentinelRef: Ref<HTMLDivElement>;
  inlineMentionSources?: InlineMentionHighlightSources | null;
  knownSkills: WorkbenchSkillSummary[];
  projectFilePaths: readonly string[];
  projectId: string;
  projectRootPath: string;
  presentationSource: ThreadTextPresentationSource;
  projection: WorkbenchTranscriptProjection;
  /** The turn the thread is working on, or null; providers' own turn statuses never mark a turn live. */
  liveTurnId: string | null;
  relatedThreadsById: Record<string, RelatedThread | undefined>;
  subagents: readonly WorkbenchSubagentSummary[];
  workspaceRoots: readonly WorkspaceFileLinkRoot[];
}) {
  // A turn renders live only while the thread works on it; an orphaned provider status renders settled.
  const displayStatus = (turn: WorkbenchTranscriptProjection["turns"][number]) => turn.id === liveTurnId ? "inProgress" as const
    : turn.status === "inProgress" ? "completed" as const : turn.status;
  const turnsById = useMemo(
    () => new Map(projection.turns.map((turn) => [turn.id, turn])),
    [projection.turns],
  );
  const browseResultEntriesByTurnId = useStableBrowseResultEntriesByTurn(projection.browseResultEntries);
  const renderSegments = useMemo(
    () => mergeAdjacentTurnSegments(projection.display.segments),
    [projection.display.segments],
  );
  const threadId = projection.thread.id;
  const threadCwdPath = projection.thread.projectRoot;
  const scope = useMemo<TranscriptScope>(() => ({
    inlineMentionSources: inlineMentionSources ?? null,
    knownSkills,
    projectFilePaths,
    projectId,
    projectRootPath,
    relatedThreadsById,
    subagents,
    threadCwdPath,
    threadId,
    workspaceRoots,
  }), [
    inlineMentionSources, knownSkills, projectFilePaths, projectId, projectRootPath, relatedThreadsById, subagents,
    threadCwdPath, threadId, workspaceRoots,
  ]);

  return (
    <TranscriptScopeContext.Provider value={scope}>
      {canLoadPreviousTurn ? (
        <div ref={historySentinelRef} className="h-px" aria-hidden="true" />
      ) : null}
      {!renderSegments.length ? (
        <p className="m-0 border-t border-[color-mix(in_srgb,var(--text)_10%,transparent)] py-4 text-[0.92em] leading-[1.6] text-fg/muted">
          No turns were returned for this thread yet.
        </p>
      ) : null}
      {renderSegments.map((segment) => {
        const turn = turnsById.get(segment.turnId);
        if (!turn) return null;
        const browseResultEntries = browseResultEntriesByTurnId.get(segment.turnId) ?? EMPTY_BROWSE_RESULT_ENTRIES;
        const hideTopBorder = segment.isFirstForTurn && segment.items.some((item) => (
          item.type === "userMessage" && isWorkbenchQuestionnaireResponseInput(item.content)
        ));
        return (
          <Fragment key={segment.id}>
            {segment.isFirstForTurn ? (
              <div
                aria-hidden="true"
                className="h-0 w-full"
                data-thread-history-turn-id={segment.turnId}
              />
            ) : null}
            <ThreadMeasuredContent visibilityRange="nearby">
              <section className={segment.isFirstForTurn
                ? `${hideTopBorder ? "" : "border-t border-[color-mix(in_srgb,var(--text)_10%,transparent)]"} py-3`
                : "pb-3"}
              >
                <ThreadTurnItems
                  browseResultEntries={browseResultEntries}
                  hiddenReasoningStep={hiddenReasoningStep}
                  initialUserItemId={turn.items.find((item) => item.type === "userMessage")?.id ?? null}
                  items={segment.items}
                  itemTimeline={turn.itemTimeline}
                  presentationSource={turn.id === liveTurnId ? presentationSource : null}
                  turnCompletedAt={turn.completedAt}
                  turnId={turn.id}
                  turnStartedAt={turn.startedAt}
                  turnStatus={displayStatus(turn)}
                />
              </section>
            </ThreadMeasuredContent>
          </Fragment>
        );
      })}
    </TranscriptScopeContext.Provider>
  );
}
