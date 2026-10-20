/*
 * Exports:
 * - default ThreadTurnItems: the one transcript renderer for a turn's items: provides the turn scope, folds items into
 *   blocks and activity runs, and windows them with stable content keys so history landing above never remounts rows.
 */
"use client";

import { memo, useEffect, useMemo, useRef, useState } from "react";

import type { WorkbenchBrowseResultEntry } from "workbench-shared/types";
import { findWorkbenchThreadItemTimelineEntry, type WorkbenchThreadItemTimelineEntry } from "workbench-shared/workbench/thread/thread-item-timeline";
import type { Turn } from "workbench-shared/workbench/thread/workbench-thread-turn";
import type { WorkbenchProjectedTranscriptItem } from "workbench-shared/workbench/transcript/workbench-transcript-projection";
import type { ThreadTextPresentationSource } from "../../../../workbench/thread/ThreadTextPresentationController";
import { useProject } from "../../use-projects";
import { TranscriptTurnContext, useTranscript, type TranscriptTurnScope } from "../../use-transcript";
import { getThreadEntryMotionIdentity } from "../ThreadEntryMotionController";
import ThreadGenericItem from "../ThreadGenericItem";
import ThreadMeasuredContent from "../ThreadMeasuredContent";
import ThreadProgressiveWindow, { type ThreadProgressiveWindowChunk } from "../ThreadProgressiveWindow";
import { ThreadEntryAnimation } from "../ThreadRevealText";
import ThreadStableChunkIdentities from "../ThreadStableChunkIdentities";
import { useThreadCodeDetails } from "../WorkbenchThreadDisplaySettingsContext";
import type { ThreadReasoningStepReference } from "../thread-reasoning-display";
import { getRenderableBlockItems } from "../thread-render-blocks";
import { THREAD_WINDOW_CHUNK_SIZE } from "../thread-progressive-window-policy";
import { ThreadEntryMotion } from "../thread-scroll-viewport-context";
import ThreadRenderableBlockView from "./ThreadRenderableBlockView";
import ThreadSubagentActivityWindow from "./ThreadSubagentActivityWindow";
import { SubagentActivitySlot } from "./subagent-activity-slot";
import {
  buildTranscriptEntries, getMostRecentDeliveredIndex, useStableRenderableBlocks, withInteractionTimeline, type TranscriptEntry,
} from "./transcript-blocks";

const NO_BROWSE_RESULTS: readonly WorkbenchBrowseResultEntry[] = [];

function useEntryMotionAfterMount(enabled: boolean) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return enabled && mounted;
}

export default memo(function ThreadTurnItems({
  browseResultEntries = NO_BROWSE_RESULTS,
  hiddenReasoningStep = null,
  initialUserItemId = null,
  items,
  itemTimeline,
  presentationSource = null,
  turnCompletedAt,
  turnId,
  turnStartedAt,
  turnStatus,
}: {
  browseResultEntries?: readonly WorkbenchBrowseResultEntry[];
  hiddenReasoningStep?: ThreadReasoningStepReference | null;
  /** The turn's opening message, which falls back to the turn's start time; later segments of the turn never borrow it. */
  initialUserItemId?: string | null;
  items: readonly WorkbenchProjectedTranscriptItem[];
  itemTimeline?: readonly WorkbenchThreadItemTimelineEntry[];
  presentationSource?: ThreadTextPresentationSource | null;
  turnCompletedAt: number | null;
  turnId: string;
  turnStartedAt: number | null;
  turnStatus: Turn["status"];
}) {
  const transcript = useTranscript();
  const presentationKind = presentationSource?.kind;
  const presentationKey = presentationSource?.sourceKey;
  const turn = useMemo<TranscriptTurnScope>(() => ({
    browseResultEntries,
    completedAt: turnCompletedAt,
    id: turnId,
    presentationSource: presentationKind && presentationKey !== undefined ? { kind: presentationKind, sourceKey: presentationKey } : null,
    startedAt: turnStartedAt,
    status: turnStatus,
  }), [browseResultEntries, presentationKey, presentationKind, turnCompletedAt, turnId, turnStartedAt, turnStatus]);
  const animateEntries = useEntryMotionAfterMount(turnStatus === "inProgress");
  const renderItemTimeline = useMemo(() => withInteractionTimeline(items, itemTimeline), [items, itemTimeline]);
  const codeDetails = useThreadCodeDetails();
  const project = useProject.contextual();
  const entries = useMemo(
    () => buildTranscriptEntries(items, { browseResultEntries, codeDetails, hiddenReasoningStep, project }),
    [browseResultEntries, codeDetails, hiddenReasoningStep, items, project],
  );
  const stableBlocks = useStableRenderableBlocks(entries.flatMap(entry => entry.kind === "block" ? [entry.block] : []), "identity");
  let stableBlockIndex = 0;
  const stableEntries: TranscriptEntry[] = entries.map(entry => entry.kind === "block"
    ? { ...entry, block: stableBlocks[stableBlockIndex++]! } : entry);
  // Content keys, never positions: history landing above must not re-key the rows already on screen,
  // and a block keeps its key as it grows, so a live activity run never remounts.
  const keyOccurrences = new Map<string, number>();
  const entryKeys = stableEntries.map(entry => {
    const base = entry.kind === "generic"
      ? `generic:${entry.item.id}`
      : `${entry.block.kind}:${getRenderableBlockItems(entry.block)[0]?.id}`;
    const occurrence = (keyOccurrences.get(base) ?? 0) + 1;
    keyOccurrences.set(base, occurrence);
    return occurrence > 1 ? `${base}#${occurrence}` : base;
  });
  const chunkIdentitiesRef = useRef<ThreadStableChunkIdentities | null>(null);
  chunkIdentitiesRef.current ??= new ThreadStableChunkIdentities();
  const chunkIdentities = chunkIdentitiesRef.current;

  const primaryUserBlock = stableEntries.flatMap((entry) => (
    entry.kind === "block" && entry.block.kind === "item" && entry.block.item.id === initialUserItemId ? [entry.block] : []
  )).at(0) ?? null;
  const finalAgentMessageId = items.findLast((item) => item.type === "agentMessage" && item.phase === "final_answer")?.id ?? null;
  const mostRecentIndex = getMostRecentDeliveredIndex(stableEntries);
  const renderEntry = (entry: TranscriptEntry, index: number) => {
    const firstItem = entry.kind === "block" ? getRenderableBlockItems(entry.block)[0] : null;
    const identity = entry.kind === "generic"
      ? `item:${entry.item.id}`
      : firstItem ? getThreadEntryMotionIdentity(firstItem) : `empty:${turnId}:${index}`;
    return (
      <ThreadEntryMotion
        enabled={animateEntries && !(entry.kind === "block" && entry.block.kind === "fileChangeSequence")}
        identity={identity}
        key={entryKeys[index]}
      >
        {(animate) => (
          <ThreadEntryAnimation play={animate}>
            {entry.kind === "generic" ? (
              <ThreadGenericItem
                item={entry.item}
                threadId={transcript.threadId}
                timeline={findWorkbenchThreadItemTimelineEntry(entry.item.id, renderItemTimeline)}
                turnStatus={turnStatus}
              />
            ) : (
              <ThreadRenderableBlockView
                animateEntries={animateEntries}
                block={entry.block}
                finalAgentMessageId={finalAgentMessageId}
                isMostRecentBlock={index === mostRecentIndex}
                itemTimeline={renderItemTimeline}
                primaryUserBlock={primaryUserBlock}
              />
            )}
          </ThreadEntryAnimation>
        )}
      </ThreadEntryMotion>
    );
  };
  const groupIdentity = chunkIdentities.groups([entryKeys])[0]!;
  const progressiveChunks: ThreadProgressiveWindowChunk[] = chunkIdentities
    .chunks(groupIdentity, entryKeys, THREAD_WINDOW_CHUNK_SIZE)
    .map((chunk) => {
      const key = `window:${chunk.identity}`;
      return {
        key,
        content: (
          <ThreadMeasuredContent key={key} visibilityRange="approaching" windowed>
            <div className="space-y-2">
              {stableEntries.slice(chunk.start, chunk.end).map((entry, index) => renderEntry(entry, chunk.start + index))}
            </div>
          </ThreadMeasuredContent>
        ),
      };
    });
  return (
    <TranscriptTurnContext.Provider value={turn}>
      <SubagentActivitySlot.Provider value={ThreadSubagentActivityWindow}>
        <ThreadProgressiveWindow
          chunks={progressiveChunks}
          identity={`${turnId}:${groupIdentity}`}
          key={`progressive:${turnId}:${groupIdentity}`}
        />
      </SubagentActivitySlot.Provider>
    </TranscriptTurnContext.Provider>
  );
});
