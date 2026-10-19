/*
 * Exports:
 * - default ThreadTestTurn: render one turn's items through the thread renderer, for owner tests that build turns by hand.
 */
import type { ComponentProps } from "react";

import type { Turn } from "workbench-shared/workbench/thread/workbench-thread-turn";
import { ThreadTranscriptItemsDetails } from "./thread-view-items";

type RendererProps = ComponentProps<typeof ThreadTranscriptItemsDetails>;

export default function ThreadTestTurn({ turn, ...props }: Omit<RendererProps, "items" | "turnCompletedAt" | "turnId" | "turnStartedAt" | "turnStatus"> & { turn: Turn }) {
  return (
    <ThreadTranscriptItemsDetails
      initialUserItemId={turn.items.find(item => item.type === "userMessage")?.id ?? null}
      {...props}
      items={turn.items}
      turnCompletedAt={turn.completedAt}
      turnId={turn.id}
      turnStartedAt={turn.startedAt}
      turnStatus={turn.status}
    />
  );
}
