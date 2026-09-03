/*
 * Exports:
 * - default ThreadTranscriptProjection: render one canonical SQLite transcript projection through the established item UI. Keywords: transcript, SQLite, projection, canonical.
 */
"use client";

import { Fragment, useMemo, type RefObject } from "react";

import type {
  ThreadPayload,
  WorkbenchBrowseResultEntry,
  WorkbenchSkillSummary,
  WorkbenchSubagentSummary,
} from "workbench-shared/types";
import type { WorkbenchTranscriptProjection } from "workbench-shared/workbench/transcript/workbench-transcript-projection";
import type { WorkspaceFileLinkRoot } from "../../../workbench/markdown/markdown-links";
import type { InlineMentionHighlightSources } from "../../../workbench/thread/inline-mention-highlights";
import { useStableBrowseResultEntriesByTurn } from "./stable-browse-result-entries";
import type { ThreadReasoningStepReference } from "./thread-reasoning-display";
import { ThreadTranscriptItemsDetails } from "./thread-view-items";

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
        id: `${previous.id}:${segment.id}`,
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
  historySentinelRef,
  inlineMentionSources,
  knownSkills,
  projectFilePaths,
  projectId,
  projectRootPath,
  projection,
  relatedThreadsById,
  subagents,
  workspaceRoots,
}: {
  canLoadPreviousTurn: boolean;
  hiddenReasoningStep?: ThreadReasoningStepReference | null;
  historySentinelRef: RefObject<HTMLDivElement | null>;
  inlineMentionSources?: InlineMentionHighlightSources | null;
  knownSkills: WorkbenchSkillSummary[];
  projectFilePaths: readonly string[];
  projectId: string;
  projectRootPath: string;
  projection: WorkbenchTranscriptProjection;
  relatedThreadsById: Record<string, ThreadPayload | undefined>;
  subagents: readonly WorkbenchSubagentSummary[];
  workspaceRoots: readonly WorkspaceFileLinkRoot[];
}) {
  const turnsById = useMemo(
    () => new Map(projection.turns.map((turn) => [turn.id, turn])),
    [projection.turns],
  );
  const browseResultEntriesByTurnId = useStableBrowseResultEntriesByTurn(projection.browseResultEntries);
  const renderSegments = useMemo(
    () => mergeAdjacentTurnSegments(projection.display.segments),
    [projection.display.segments],
  );

  if (!renderSegments.length) {
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
      {renderSegments.map((segment) => {
        const turn = turnsById.get(segment.turnId);
        if (!turn) return null;
        const browseResultEntries = browseResultEntriesByTurnId.get(segment.turnId) ?? EMPTY_BROWSE_RESULT_ENTRIES;
        return (
          <Fragment key={segment.id}>
            {segment.isFirstForTurn ? (
              <div
                aria-hidden="true"
                className="h-0 w-full"
                data-thread-history-turn-id={segment.turnId}
              />
            ) : null}
            <section className={segment.isFirstForTurn
              ? "border-t border-[color-mix(in_srgb,var(--text)_10%,transparent)] py-3"
              : "pb-3"}
            >
              <ThreadTranscriptItemsDetails
                browseResultEntries={browseResultEntries}
                hiddenReasoningStep={hiddenReasoningStep}
                inlineMentionSources={inlineMentionSources}
                items={segment.items}
                itemTimeline={turn.itemTimeline}
                knownSkills={knownSkills}
                projectFilePaths={projectFilePaths}
                projectId={projectId}
                projectRootPath={projectRootPath}
                relatedThreadsById={relatedThreadsById}
                subagents={subagents}
                threadCwdPath={projection.thread.projectRoot}
                threadId={projection.thread.id}
                turnCompletedAt={turn.completedAt}
                turnStartedAt={turn.startedAt}
                turnStatus={turn.status}
                workspaceRoots={workspaceRoots}
              />
            </section>
          </Fragment>
        );
      })}
    </>
  );
}
