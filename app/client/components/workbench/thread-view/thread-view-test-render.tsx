/*
 * Exports:
 * - default ThreadTestTurn: render one turn's items through the thread renderer, for owner tests that build turns by hand.
 * - ThreadTestOpenActivityRuns: render children with the named activity runs (keyed by first item id) already expanded.
 */
import type { ComponentProps, ReactNode } from "react";

import type { Turn } from "workbench-shared/workbench/thread/workbench-thread-turn";
import ThreadActivityRunController from "./ThreadActivityRunController";
import { ThreadScrollViewportContext, useThreadScrollViewportContext } from "./thread-scroll-viewport-context";
import { ThreadTranscriptItemsDetails } from "./thread-view-items";

type RendererProps = ComponentProps<typeof ThreadTranscriptItemsDetails>;

export function ThreadTestOpenActivityRuns({ children, runIds }: { children: ReactNode; runIds: readonly string[] }) {
  const context = useThreadScrollViewportContext();
  const activityRuns = new ThreadActivityRunController();
  for (const id of runIds) activityRuns.setOpen(id, true);
  return <ThreadScrollViewportContext.Provider value={{ ...context, activityRuns }}>{children}</ThreadScrollViewportContext.Provider>;
}

export default function ThreadTestTurn({ openActivityRunIds = [], turn, ...props }: Omit<RendererProps, "items" | "turnCompletedAt" | "turnId" | "turnStartedAt" | "turnStatus"> & {
  openActivityRunIds?: readonly string[];
  turn: Turn;
}) {
  return (
    <ThreadTestOpenActivityRuns runIds={openActivityRunIds}>
      <ThreadTranscriptItemsDetails
        initialUserItemId={turn.items.find(item => item.type === "userMessage")?.id ?? null}
        {...props}
        items={turn.items}
        turnCompletedAt={turn.completedAt}
        turnId={turn.id}
        turnStartedAt={turn.startedAt}
        turnStatus={turn.status}
      />
    </ThreadTestOpenActivityRuns>
  );
}
