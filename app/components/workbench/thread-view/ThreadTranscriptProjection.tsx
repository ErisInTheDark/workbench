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
import { ThreadTranscriptItemDetails } from "./thread-view-items";

const EMPTY_BROWSE_RESULT_ENTRIES: readonly WorkbenchBrowseResultEntry[] = [];

export default function ThreadTranscriptProjection({
  canLoadPreviousTurn,
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

  if (!projection.display.segments.length) {
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
      {projection.display.segments.map((segment) => {
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
              <div className="space-y-2">
                {segment.items.map((item) => (
                  <ThreadTranscriptItemDetails
                    key={item.id}
                    browseResultEntries={browseResultEntries}
                    inlineMentionSources={inlineMentionSources}
                    item={item}
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
                ))}
              </div>
            </section>
          </Fragment>
        );
      })}
    </>
  );
}
