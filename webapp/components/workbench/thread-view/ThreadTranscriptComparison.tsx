/*
 * Exports:
 * - default ThreadTranscriptComparison: render one item-aligned desktop comparison of JSON and SQLite transcript projections. Keywords: transcript, parity, comparison, desktop.
 */
"use client";

import { Fragment, useMemo } from "react";

import type {
  ThreadPayload,
  WorkbenchBrowseResultEntry,
  WorkbenchSkillSummary,
  WorkbenchSubagentSummary,
} from "../../../lib/types";
import type { WorkspaceFileLinkRoot } from "../../../lib/workbench/markdown/markdown-links";
import type { InlineMentionHighlightSources } from "../../../lib/workbench/thread/inline-mention-highlights";
import {
  planWorkbenchTranscriptItemComparison,
  type WorkbenchTranscriptComparisonItem,
} from "../../../lib/workbench/transcript/thread-transcript-parity";
import type { WorkbenchTranscriptProjection } from "../../../lib/workbench/transcript/workbench-transcript-projection";
import { getThreadVisibleHistoryEntries } from "./thread-visible-history";
import { ThreadTranscriptItemDetails } from "./thread-view-items";

const EMPTY_BROWSE_RESULT_ENTRIES: readonly WorkbenchBrowseResultEntry[] = [];

function groupBrowseEntriesByTurn(entries: readonly WorkbenchBrowseResultEntry[]) {
  const entriesByTurnId = new Map<string, WorkbenchBrowseResultEntry[]>();
  for (const entry of entries) {
    const turnEntries = entriesByTurnId.get(entry.turnId) ?? [];
    turnEntries.push(entry);
    entriesByTurnId.set(entry.turnId, turnEntries);
  }
  return entriesByTurnId;
}

function TranscriptComparisonCell({
  browseResultEntries,
  entry,
  inlineMentionSources,
  knownSkills,
  missingIdentity,
  projectFilePaths,
  projectId,
  projectRootPath,
  relatedThreadsById,
  subagents,
  threadCwdPath,
  threadId,
  turn,
  workspaceRoots,
}: {
  browseResultEntries: readonly WorkbenchBrowseResultEntry[];
  entry: WorkbenchTranscriptComparisonItem | null;
  inlineMentionSources?: InlineMentionHighlightSources | null;
  knownSkills: WorkbenchSkillSummary[];
  missingIdentity: string;
  projectFilePaths: readonly string[];
  projectId: string;
  projectRootPath: string;
  relatedThreadsById: Record<string, ThreadPayload | undefined>;
  subagents: readonly WorkbenchSubagentSummary[];
  threadCwdPath: string;
  threadId: string;
  turn: ThreadPayload["turns"][number] | WorkbenchTranscriptProjection["turns"][number] | null;
  workspaceRoots: readonly WorkspaceFileLinkRoot[];
}) {
  if (!entry) {
    return (
      <div className="flex min-h-16 min-w-0 items-center justify-center px-4 py-6 text-center text-[0.78em] text-muted">
        Missing {missingIdentity}
      </div>
    );
  }

  if (!turn) return null;

  return (
    <div className="min-w-0">
      <ThreadTranscriptItemDetails
        browseResultEntries={browseResultEntries}
        inlineMentionSources={inlineMentionSources}
        item={entry.item}
        itemTimeline={"itemTimeline" in turn ? turn.itemTimeline : undefined}
        knownSkills={knownSkills}
        projectFilePaths={projectFilePaths}
        projectId={projectId}
        projectRootPath={projectRootPath}
        relatedThreadsById={relatedThreadsById}
        subagents={subagents}
        threadCwdPath={threadCwdPath}
        threadId={threadId}
        turnCompletedAt={turn.completedAt}
        turnStartedAt={turn.startedAt}
        turnStatus={turn.status}
        workspaceRoots={workspaceRoots}
      />
    </div>
  );
}

export default function ThreadTranscriptComparison({
  inlineMentionSources,
  jsonBrowseResultEntries,
  jsonThread,
  knownSkills,
  projectFilePaths,
  projectId,
  projectRootPath,
  relatedThreadsById,
  sqliteProjection,
  subagents,
  visibleTurnIds,
  workspaceRoots,
}: {
  inlineMentionSources?: InlineMentionHighlightSources | null;
  jsonBrowseResultEntries: readonly WorkbenchBrowseResultEntry[];
  jsonThread: ThreadPayload;
  knownSkills: WorkbenchSkillSummary[];
  projectFilePaths: readonly string[];
  projectId: string;
  projectRootPath: string;
  relatedThreadsById: Record<string, ThreadPayload | undefined>;
  sqliteProjection: WorkbenchTranscriptProjection;
  subagents: readonly WorkbenchSubagentSummary[];
  visibleTurnIds: ReadonlySet<string>;
  workspaceRoots: readonly WorkspaceFileLinkRoot[];
}) {
  const comparisonTurnIds = useMemo(() => new Set([
    ...visibleTurnIds,
    ...getThreadVisibleHistoryEntries(sqliteProjection)
      .filter((entry) => entry.loadState === "loaded")
      .map((entry) => entry.turnId),
  ]), [sqliteProjection, visibleTurnIds]);
  const rows = useMemo(() => planWorkbenchTranscriptItemComparison({
    jsonThread,
    sqliteProjection,
    visibleTurnIds: comparisonTurnIds,
  }), [comparisonTurnIds, jsonThread, sqliteProjection]);
  const jsonTurnsById = useMemo(
    () => new Map(jsonThread.turns.map((turn) => [turn.id, turn])),
    [jsonThread.turns],
  );
  const sqliteTurnsById = useMemo(
    () => new Map(sqliteProjection.turns.map((turn) => [turn.id, turn])),
    [sqliteProjection.turns],
  );
  const jsonBrowseEntriesByTurnId = useMemo(
    () => groupBrowseEntriesByTurn(jsonBrowseResultEntries),
    [jsonBrowseResultEntries],
  );
  const sqliteBrowseEntriesByTurnId = useMemo(
    () => groupBrowseEntriesByTurn(sqliteProjection.browseResultEntries),
    [sqliteProjection.browseResultEntries],
  );

  if (!rows.length) {
    return (
      <p className="m-0 py-4 text-[0.92em] leading-[1.6] text-muted">
        No settled transcript items are available to compare yet.
      </p>
    );
  }

  const markedTurnIds = new Set<string>();

  return (
    <div
      aria-label="JSON and SQLite transcript comparison"
      className="relative left-1/2 w-[calc(100vw-24rem)] max-w-[112rem] -translate-x-1/2 space-y-2 py-2"
    >
      <div className="grid grid-cols-2 gap-3 px-4 text-[0.72em] font-semibold tracking-[0.12em] text-muted uppercase">
        <span>JSON transcript</span>
        <span>SQLite transcript</span>
      </div>
      {rows.map((row, index) => {
        const identity = row.json?.identity ?? row.sqlite?.identity ?? String(index);
        const markerTurnIds = [row.json?.turnId, row.sqlite?.turnId]
          .filter((turnId): turnId is string => Boolean(turnId))
          .filter((turnId) => {
            if (markedTurnIds.has(turnId)) return false;
            markedTurnIds.add(turnId);
            return true;
          });
        return (
          <Fragment key={`${identity}:${row.json?.sourceItemId ?? "missing"}:${row.sqlite?.sourceItemId ?? "missing"}:${index}`}>
            {markerTurnIds.map((turnId) => (
              <div
                key={`${turnId}:history-marker`}
                aria-hidden="true"
                className="h-0 w-full"
                data-thread-history-turn-id={turnId}
              />
            ))}
            <div className="grid grid-cols-2 items-stretch gap-3">
              <TranscriptComparisonCell
                browseResultEntries={row.json
                  ? jsonBrowseEntriesByTurnId.get(row.json.turnId) ?? EMPTY_BROWSE_RESULT_ENTRIES
                  : EMPTY_BROWSE_RESULT_ENTRIES}
                entry={row.json}
                inlineMentionSources={inlineMentionSources}
                knownSkills={knownSkills}
                missingIdentity={identity}
                projectFilePaths={projectFilePaths}
                projectId={projectId}
                projectRootPath={projectRootPath}
                relatedThreadsById={relatedThreadsById}
                subagents={subagents}
                threadCwdPath={jsonThread.cwd}
                threadId={jsonThread.id}
                turn={row.json ? jsonTurnsById.get(row.json.turnId) ?? null : null}
                workspaceRoots={workspaceRoots}
              />
              <TranscriptComparisonCell
                browseResultEntries={row.sqlite
                  ? sqliteBrowseEntriesByTurnId.get(row.sqlite.turnId) ?? EMPTY_BROWSE_RESULT_ENTRIES
                  : EMPTY_BROWSE_RESULT_ENTRIES}
                entry={row.sqlite}
                inlineMentionSources={inlineMentionSources}
                knownSkills={knownSkills}
                missingIdentity={identity}
                projectFilePaths={projectFilePaths}
                projectId={projectId}
                projectRootPath={projectRootPath}
                relatedThreadsById={relatedThreadsById}
                subagents={subagents}
                threadCwdPath={sqliteProjection.thread.projectRoot}
                threadId={sqliteProjection.thread.id}
                turn={row.sqlite ? sqliteTurnsById.get(row.sqlite.turnId) ?? null : null}
                workspaceRoots={workspaceRoots}
              />
            </div>
          </Fragment>
        );
      })}
    </div>
  );
}
