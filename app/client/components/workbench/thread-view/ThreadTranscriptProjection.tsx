/*
 * Exports:
 * - default ThreadTranscriptProjection: render canonical SQLite transcript items through the established UI.
 */
"use client";

import { Fragment, useMemo, useState, type Ref } from "react";

import type {
  ThreadPayload,
  WorkbenchBrowseResultEntry,
  WorkbenchSkillSummary,
  WorkbenchSubagentSummary,
} from "workbench-shared/types";
import type { WorkbenchTranscriptProjection } from "workbench-shared/workbench/transcript/workbench-transcript-projection";
import type { WorkspaceFileLinkRoot } from "../../../workbench/markdown/markdown-links";
import type { InlineMentionHighlightSources } from "../../../workbench/thread/inline-mention-highlights";
import type { ThreadTextPresentationSource } from "../../../workbench/thread/ThreadTextPresentationController";
import { isWorkbenchQuestionnaireResponseInput } from "workbench-shared/workbench/thread/thread-recovery-message";
import { useStableBrowseResultEntriesByTurn } from "./stable-browse-result-entries";
import type { ThreadReasoningStepReference } from "./thread-reasoning-display";
import ThreadMeasuredContent from "./ThreadMeasuredContent";
import { ThreadTranscriptItemsDetails } from "./thread-view-items";

const EMPTY_BROWSE_RESULT_ENTRIES: readonly WorkbenchBrowseResultEntry[] = [];
const EMPTY_HOISTED_GIT_ARC_PROPOSAL_IDS: ReadonlySet<string> = new Set();

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
      result.push({
        id: segment.id,
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
  hoistedGitArcProposalIds = EMPTY_HOISTED_GIT_ARC_PROPOSAL_IDS,
  historySentinelRef,
  inlineMentionSources,
  knownSkills,
  projectFilePaths,
  projectId,
  projectRootPath,
  presentationSource,
  projection,
  relatedThreadsById,
  subagents,
  workspaceRoots,
}: {
  canLoadPreviousTurn: boolean;
  hiddenReasoningStep?: ThreadReasoningStepReference | null;
  hoistedGitArcProposalIds?: ReadonlySet<string>;
  historySentinelRef: Ref<HTMLDivElement>;
  inlineMentionSources?: InlineMentionHighlightSources | null;
  knownSkills: WorkbenchSkillSummary[];
  projectFilePaths: readonly string[];
  projectId: string;
  projectRootPath: string;
  presentationSource: ThreadTextPresentationSource;
  projection: WorkbenchTranscriptProjection;
  relatedThreadsById: Record<string, ThreadPayload | undefined>;
  subagents: readonly WorkbenchSubagentSummary[];
  workspaceRoots: readonly WorkspaceFileLinkRoot[];
}) {
  const [initialInactive, setInitialInactive] = useState(() => ({
    threadId: projection.thread.id,
    itemIds: new Set(projection.turns.filter(turn => turn.status !== "inProgress").flatMap(turn => turn.items.map(item => item.id))),
  }));
  if (initialInactive.threadId !== projection.thread.id) {
    setInitialInactive({
      threadId: projection.thread.id,
      itemIds: new Set(projection.turns.filter(turn => turn.status !== "inProgress").flatMap(turn => turn.items.map(item => item.id))),
    });
  }
  const turnsById = useMemo(
    () => new Map(projection.turns.map((turn) => [turn.id, turn])),
    [projection.turns],
  );
  const browseResultEntriesByTurnId = useStableBrowseResultEntriesByTurn(projection.browseResultEntries);
  const renderSegments = useMemo(
    () => mergeAdjacentTurnSegments(projection.display.segments),
    [projection.display.segments],
  );

  return (
    <>
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
                <ThreadTranscriptItemsDetails
                  initialInactiveItemIds={initialInactive.threadId === projection.thread.id ? initialInactive.itemIds : new Set<string>()}
                  initialUserItemId={turn.items.find((item) => item.type === "userMessage")?.id ?? null}
                  browseResultEntries={browseResultEntries}
                  hiddenReasoningStep={hiddenReasoningStep}
                  hoistedGitArcProposalIds={hoistedGitArcProposalIds}
                  inlineMentionSources={inlineMentionSources}
                  items={segment.items}
                  itemTimeline={turn.itemTimeline}
                  knownSkills={knownSkills}
                  projectFilePaths={projectFilePaths}
                  projectId={projectId}
                  projectRootPath={projectRootPath}
                  presentationSource={turn.status === "inProgress" ? presentationSource : null}
                  relatedThreadsById={relatedThreadsById}
                  subagents={subagents}
                  threadCwdPath={projection.thread.projectRoot}
                  threadId={projection.thread.id}
                  turnCompletedAt={turn.completedAt}
                  turnId={turn.id}
                  turnStartedAt={turn.startedAt}
                  turnStatus={turn.status}
                  workspaceRoots={workspaceRoots}
                />
              </section>
            </ThreadMeasuredContent>
          </Fragment>
        );
      })}
    </>
  );
}
