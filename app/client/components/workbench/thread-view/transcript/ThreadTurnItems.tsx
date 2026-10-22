/*
 * Exports:
 * - default ThreadTurnItems: the one transcript renderer for a turn's items: provides the turn scope, folds items into
 *   blocks and activity runs, and windows them with stable content keys so history landing above never remounts rows;
 *   a running turn's typewriter caret waits below its last item for the next one; a retried arc start slides up into its
 *   failed attempts as they merge.
 */
"use client";

import { memo, useContext, useEffect, useMemo, useRef, useState } from "react";

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
import ThreadAnimationStyleContext from "../ThreadAnimationStyleContext";
import { ThreadEntryAnimation, ThreadStreamCaretSlot } from "../ThreadRevealText";
import ThreadStableChunkIdentities, { ThreadStableKeys } from "../ThreadStableChunkIdentities";
import { useThreadCodeDetails } from "../WorkbenchThreadDisplaySettingsContext";
import type { ThreadReasoningStepReference } from "../thread-reasoning-display";
import { getGitArcFoldAnchor, isGitArcCardBlock } from "../thread-git-arc-retries";
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
  const caret = useContext(ThreadAnimationStyleContext).caret;
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
    () => buildTranscriptEntries(items, { browseResultEntries, codeDetails, hiddenReasoningStep, project, turnLive: turnStatus === "inProgress" }),
    [browseResultEntries, codeDetails, hiddenReasoningStep, items, project, turnStatus],
  );
  const stableBlocks = useStableRenderableBlocks(entries.flatMap(entry => entry.kind === "block" ? [entry.block] : []), "identity");
  let stableBlockIndex = 0;
  const stableEntries: TranscriptEntry[] = entries.map(entry => entry.kind === "block"
    ? { ...entry, block: stableBlocks[stableBlockIndex++]! } : entry);
  // Content keys, never positions or first items: a block keeps its key as older items join it above and live items
  // below, so the block under the reader's anchor never remounts as history lands.
  const entryKeysRef = useRef<ThreadStableKeys | null>(null);
  entryKeysRef.current ??= new ThreadStableKeys();
  const entryKeys = entryKeysRef.current.resolve(stableEntries.map(entry => entry.kind === "generic"
    ? [`generic:${entry.item.id}`]
    : getRenderableBlockItems(entry.block).map(item => item.id)));
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
    // An arc card may later fold or stitch into a bigger card, which then slides up from where that card sat.
    const trackAs = animateEntries && entry.kind === "block" && firstItem && isGitArcCardBlock(entry.block) ? identity : null;
    const absorbed = entry.kind === "block" ? getGitArcFoldAnchor(entry.block) : null;
    const slideFrom = absorbed ? getThreadEntryMotionIdentity(absorbed) : null;
    return (
      <ThreadEntryMotion
        enabled={animateEntries && !(entry.kind === "block" && entry.block.kind === "fileChangeSequence")}
        identity={identity}
        key={entryKeys[index]}
      >
        {(animate) => (
          <ThreadEntryAnimation play={animate} slideFrom={slideFrom} trackAs={trackAs}>
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
  // Messages and reasoning carry their own caret while they stream; after anything else, it waits where the next item lands.
  const lastItemType = items.at(-1)?.type;
  const nextItemSlot = caret && turnStatus === "inProgress" && Boolean(presentationSource)
    && lastItemType !== "agentMessage" && lastItemType !== "reasoning";
  const groupIdentity = chunkIdentities.groups([entryKeys])[0]!;
  const progressiveChunks: ThreadProgressiveWindowChunk[] = chunkIdentities
    .chunks(groupIdentity, entryKeys, THREAD_WINDOW_CHUNK_SIZE)
    .map((chunk) => {
      const key = `window:${chunk.identity}`;
      return {
        key,
        content: (
          <ThreadMeasuredContent key={key} visibilityRange="approaching" windowed>
            {/* Flex stops entry margins collapsing, so gaps inside a chunk match gaps across its flow-root border. */}
            <div className="flex flex-col">
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
        {nextItemSlot ? <div className="py-2"><ThreadStreamCaretSlot /></div> : null}
      </SubagentActivitySlot.Provider>
    </TranscriptTurnContext.Provider>
  );
});
