/*
 * Exports:
 * - default ThreadRenderSurface: render standalone transcripts and live activity inside the shared scroll owner.
 */
"use client";

import { defaultProviderKey } from "workbench-shared/workbench/provider/provider-registrations";
import { useMemo, type CSSProperties } from "react";

import type { ThreadPayload, WorkbenchProjectRoot } from "workbench-shared/types";
import type { WorkbenchTranscriptProjection } from "workbench-shared/workbench/transcript/workbench-transcript-projection";
import { ThreadTurnDetails, ThreadTurnLoadingSkeleton } from "./thread-view-items";
import ThreadTranscriptProjection from "./ThreadTranscriptProjection";
import ThreadScrollViewport, { ThreadScrollViewportEnd } from "./ThreadScrollViewport";
import ThreadLiveActivity from "./ThreadLiveActivity";
import { getLiveThreadActivity, getThreadTerminalEntries } from "./thread-live-activity";
import projectThreadRenderTurns from "./thread-render-turns";
import type { ThreadRenderContext, ThreadRenderFlags } from "./thread-render-lab-options";
import type { ThreadTextPresentationSource } from "../../../workbench/thread/ThreadTextPresentationController";

function createThreadProjectRoots(thread: ThreadPayload | null | undefined): WorkbenchProjectRoot[] {
  if (!thread?.cwd) {
    return [];
  }

  return [{
    id: "thread-cwd",
    isPrimary: true,
    name: "Thread cwd",
    relativePath: "",
    rootPath: thread.cwd,
  }];
}

export default function ThreadRenderSurface({
  className = "",
  emptyMessage = "No thread activity was captured yet.",
  flattenCompletedWork = false,
  fontSizeRem = 1,
  thread,
  sql,
  context = {},
  flags = {},
  presentationSource: suppliedPresentationSource,
}: {
  className?: string;
  emptyMessage?: string;
  flattenCompletedWork?: boolean;
  fontSizeRem?: number;
  thread: ThreadPayload | null | undefined;
  context?: ThreadRenderContext;
  flags?: ThreadRenderFlags;
  presentationSource?: ThreadTextPresentationSource;
  sql?: {
    projection: WorkbenchTranscriptProjection | null;
    loading: boolean;
    canLoadPrevious: boolean;
    loadPrevious: () => void;
  };
}) {
  const projectRoots = createThreadProjectRoots(thread);
  const render = useMemo(() => thread ? projectThreadRenderTurns(thread) : null, [thread]);
  const projection = sql?.projection;
  const threadId = projection?.thread.id ?? thread?.id ?? "empty";
  const cwd = context.projectRootPath ?? projection?.thread.projectRoot ?? thread?.cwd ?? ".";
  const workspaceRoots = context.workspaceRoots ?? projectRoots;
  const knownSkills = context.knownSkills ?? [];
  const projectedTurn = projection?.turns.at(-1);
  const activityTurn = sql ? projectedTurn ? {
    ...projectedTurn,
    items: projectedTurn.items.filter((item): item is ThreadPayload["turns"][number]["items"][number] =>
      item.type !== "generic" && !("requestKey" in item)),
  } : null : render?.thread.turns.at(-1) ?? null;
  const terminalContext = useMemo(() => ({ cwd, knownSkills, workspaceRoots }), [cwd, knownSkills, workspaceRoots]);
  const terminalRetention = useMemo(() => ({
    itemTimeline: sql ? projectedTurn?.itemTimeline : render?.thread.turnHistory.find(entry => entry.turnId === activityTurn?.id)?.itemTimeline,
    turnStartedAt: activityTurn?.startedAt,
  }), [sql, projectedTurn, render, activityTurn]);
  const commands = getThreadTerminalEntries(
    activityTurn?.status === "inProgress" ? activityTurn.items.filter(item => "status" in item && item.status === "inProgress") : [],
    { ...terminalContext, includeOutput: false },
  );
  const activity = getLiveThreadActivity({ pendingUserInputRequest: null, turn: activityTurn, commands });
  const presentationSource = suppliedPresentationSource ?? (sql ? { kind: "sqlite" as const, sourceKey: `${thread?.harness ?? defaultProviderKey}:${threadId}` } : null);
  const turnsById = new Map(render?.thread.turns.map(turn => [turn.id, turn]));
  const style = {
    fontSize: `${fontSizeRem}rem`,
  } satisfies CSSProperties;

  return (
    <ThreadScrollViewport resetKey={threadId} className={`h-full ${className}`}>
    <div
      className="mx-auto w-full min-w-0 max-w-content px-5 py-4 text-text md:px-6"
      data-standalone-thread-render-surface="true"
      style={style}
    >
      {sql ? (
        <>
          {sql.canLoadPrevious ? (
            <button type="button" className="mb-3 rounded px-2 py-1 text-fg/muted hover:bg-[color-mix(in_srgb,var(--text)_7%,transparent)] hover:text-text" disabled={sql.loading} onClick={sql.loadPrevious}>
              {sql.loading ? "Loading..." : "Load older turns"}
            </button>
          ) : null}
          {sql.projection ? (
            <ThreadTranscriptProjection
              projection={sql.projection}
              canLoadPreviousTurn={false}
              historySentinelRef={null}
              knownSkills={knownSkills}
              projectFilePaths={context.projectFilePaths ?? []}
              projectId={context.projectId ?? sql.projection.thread.projectId}
              projectRootPath={cwd}
              presentationSource={presentationSource!}
              relatedThreadsById={context.relatedThreadsById ?? {}}
              subagents={context.subagents ?? []}
              workspaceRoots={workspaceRoots}
              inlineMentionSources={context.inlineMentionSources}
              hiddenReasoningStep={context.hiddenReasoningStep}
            />
          ) : <p className="text-fg/muted">{emptyMessage}</p>}
        </>
      ) : render?.thread.turnHistory.length ? render.thread.turnHistory.map(entry => {
        const turn = turnsById.get(entry.turnId);
        return turn ? <ThreadTurnDetails
          key={turn.id} {...context} {...flags}
          flattenCompletedWork={flags.flattenCompletedWork ?? flattenCompletedWork}
          browseResultEntries={render.browseResultEntries.filter(item => item.turnId === turn.id)}
          itemTimeline={entry.itemTimeline} threadCwdPath={thread?.cwd} threadId={threadId}
          projectRootPath={cwd} workspaceRoots={workspaceRoots} turn={turn}
          presentationSource={turn.status === "inProgress" ? presentationSource : null}
        /> : <ThreadTurnLoadingSkeleton key={entry.turnId} entry={entry} />;
      }) : <p className="text-fg/muted">{emptyMessage}</p>}
      {flags.showLiveActivity !== false && activityTurn?.status === "inProgress" ? <ThreadLiveActivity
        key={`${threadId}:${activityTurn.id}`} activity={activity} items={activityTurn.items}
        terminalContext={terminalContext} terminalRetention={terminalRetention}
        threadId={threadId} turnId={activityTurn.id} threadCwdPath={thread?.cwd ?? cwd}
        presentationSource={presentationSource} projectRootPath={cwd} projectId={context.projectId}
        inlineMentionSources={context.inlineMentionSources} projectFilePaths={context.projectFilePaths} workspaceRoots={workspaceRoots}
      /> : null}
    </div>
    <ThreadScrollViewportEnd />
    </ThreadScrollViewport>
  );
}
