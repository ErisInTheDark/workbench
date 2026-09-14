/*
 * Exports:
 * - default ThreadRenderSurface: render standalone SQL transcripts or existing provider/render-lab payloads.
 */
"use client";

import type { CSSProperties } from "react";

import type { ThreadPayload, WorkbenchProjectRoot } from "workbench-shared/types";
import type { WorkbenchTranscriptProjection } from "workbench-shared/workbench/transcript/workbench-transcript-projection";
import { ThreadThreadContent } from "./thread-view-items";
import ThreadTranscriptProjection from "./ThreadTranscriptProjection";

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
}: {
  className?: string;
  emptyMessage?: string;
  flattenCompletedWork?: boolean;
  fontSizeRem?: number;
  thread: ThreadPayload | null | undefined;
  sql?: {
    projection: WorkbenchTranscriptProjection | null;
    loading: boolean;
    canLoadPrevious: boolean;
    loadPrevious: () => void;
  };
}) {
  const projectRoots = createThreadProjectRoots(thread);
  const style = {
    fontSize: `${fontSizeRem}rem`,
  } satisfies CSSProperties;

  return (
    <div
      className={`mx-auto w-full min-w-0 max-w-content overflow-x-hidden px-5 py-8 text-text md:px-6 ${className}`}
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
              knownSkills={[]}
              projectFilePaths={[]}
              projectId={sql.projection.thread.projectId}
              projectRootPath={sql.projection.thread.projectRoot}
              presentationSource={{ kind: "sqlite", sourceKey: `codex:${sql.projection.thread.id}` }}
              relatedThreadsById={{}}
              subagents={[]}
              workspaceRoots={[]}
            />
          ) : <p className="text-fg/muted">{emptyMessage}</p>}
        </>
      ) : <ThreadThreadContent
        browseResultEntries={thread?.browseResultEntries ?? []}
        defaultOpenCompletedWork
        emptyMessage={emptyMessage}
        flattenCompletedWork={flattenCompletedWork}
        hideWorkbenchControlAgentMessages
        hideWorkbenchControlUserMessages
        knownSkills={[]}
        projectRootPath={thread?.cwd}
        projectRoots={projectRoots}
        thread={thread}
        threadCwdPath={thread?.cwd}
      />}
    </div>
  );
}
