/*
 * Exports:
 * - default ThreadTestTurn: render one turn's items through the transcript's turn renderer inside a test transcript scope, for owner tests that build turns by hand.
 * - ThreadTestOpenActivityRuns: render children with the named activity runs (keyed by first item id) already expanded.
 */
import type { ComponentProps, ReactNode } from "react";

import type { Turn } from "workbench-shared/workbench/thread/workbench-thread-turn";
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
  initialUserItemId,
  items,
  openActivityRunIds = [],
  turn,
  browseResultEntries, hiddenReasoningStep, itemTimeline, presentationSource,
  ...scope
}: Partial<Omit<TranscriptScope, "threadId">> & Pick<TranscriptScope, "threadId">
  & Pick<TurnItemsProps, "browseResultEntries" | "hiddenReasoningStep" | "initialUserItemId" | "itemTimeline" | "presentationSource"> & {
    /** Items to render instead of the turn's own, such as projected interaction items. */
    items?: TurnItemsProps["items"];
    openActivityRunIds?: readonly string[];
    turn: Turn;
  }) {
  const value: TranscriptScope = {
    inlineMentionSources: null, knownSkills: [], projectId: null, relatedThreadsById: {}, subagents: [], ...scope,
  };
  return (
    <TranscriptScopeContext.Provider value={value}>
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
  );
}
