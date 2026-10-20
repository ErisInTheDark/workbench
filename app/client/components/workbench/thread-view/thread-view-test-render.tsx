/*
 * Exports:
 * - default ThreadTestTurn: render one turn's items through the transcript's turn renderer inside a test transcript scope and
 *   contextual project, for owner tests that build turns by hand.
 * - ThreadTestOpenActivityRuns: render children with the named activity runs (keyed by first item id) already expanded.
 */
import type { ComponentProps, ReactNode } from "react";

import type { WorkbenchSkillSummary } from "workbench-shared/types";
import type { Turn } from "workbench-shared/workbench/thread/workbench-thread-turn";
import type { WorkspaceFileLinkRoot } from "../../../workbench/markdown/markdown-links";
import type { InlineMentionHighlightSources } from "../../../workbench/thread/inline-mention-highlights";
import ContextualProjectProvider from "../ContextualProjectProvider";
import { TranscriptScopeContext, type TranscriptScope } from "../use-transcript";
import ThreadActivityRunController from "./ThreadActivityRunController";
import { ThreadScrollViewportContext, useThreadScrollViewportContext } from "./thread-scroll-viewport-context";
import ThreadTurnItems from "./transcript/ThreadTurnItems";

type TurnItemsProps = ComponentProps<typeof ThreadTurnItems>;

export function ThreadTestOpenActivityRuns({ children, runIds }: { children: ReactNode; runIds: readonly string[] }) {
  const context = useThreadScrollViewportContext();
  const activityRuns = new ThreadActivityRunController();
  for (const id of runIds) activityRuns.setOpen(id, true);
  return <ThreadScrollViewportContext.Provider value={{ ...context, activityRuns }}>{children}</ThreadScrollViewportContext.Provider>;
}

export default function ThreadTestTurn({
  browseResultEntries, hiddenReasoningStep, initialUserItemId, itemTimeline, items, presentationSource,
  inlineMentionSources, knownSkills, openActivityRunIds = [], projectFilePaths, projectId = null, projectRootPath,
  relatedThreadsById = {}, subagents = [], threadCwdPath, threadId, turn, workspaceRoots,
}: Partial<TranscriptScope> & Pick<TranscriptScope, "threadId">
  & Pick<TurnItemsProps, "browseResultEntries" | "hiddenReasoningStep" | "initialUserItemId" | "itemTimeline" | "presentationSource"> & {
    inlineMentionSources?: InlineMentionHighlightSources | null;
    /** Items to render instead of the turn's own, such as projected interaction items. */
    items?: TurnItemsProps["items"];
    knownSkills?: WorkbenchSkillSummary[];
    openActivityRunIds?: readonly string[];
    projectFilePaths?: readonly string[];
    projectId?: string | null;
    projectRootPath?: string;
    threadCwdPath?: string;
    turn: Turn;
    workspaceRoots?: readonly WorkspaceFileLinkRoot[];
  }) {
  return (
    <ContextualProjectProvider
      cwd={threadCwdPath}
      filePaths={projectFilePaths}
      id={projectId}
      mentions={inlineMentionSources}
      rootPath={projectRootPath}
      skills={knownSkills}
      workspaceRoots={workspaceRoots}
    >
      <TranscriptScopeContext.Provider value={{ relatedThreadsById, subagents, threadId }}>
        <ThreadTestOpenActivityRuns runIds={openActivityRunIds}>
          <ThreadTurnItems
            browseResultEntries={browseResultEntries}
            hiddenReasoningStep={hiddenReasoningStep}
            initialUserItemId={initialUserItemId === undefined ? turn.items.find(item => item.type === "userMessage")?.id ?? null : initialUserItemId}
            items={items ?? turn.items}
            itemTimeline={itemTimeline}
            presentationSource={presentationSource}
            turnCompletedAt={turn.completedAt}
            turnId={turn.id}
            turnStartedAt={turn.startedAt}
            turnStatus={turn.status}
          />
        </ThreadTestOpenActivityRuns>
      </TranscriptScopeContext.Provider>
    </ContextualProjectProvider>
  );
}
