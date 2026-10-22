/*
 * Exports:
 * - TranscriptEntry: one rendered turn entry: a renderable block, or a generic item that renders alone.
 * - buildTranscriptEntries: the one pipeline from turn items to entries: an ended turn's running calls ended, renderable
 *   blocks folded into activity runs, then retried Git arc starts folded into their success.
 * - withInteractionTimeline: a turn's item timeline with relational questionnaire and approval resolution times.
 * - useStableRenderableBlocks: keep unchanged blocks' identities across renders so memoised block views skip them.
 * - getMostRecentDeliveredIndex: the newest entry actually in the turn, skipping trailing undelivered steers and held messages.
 * - getActiveItemStartedAtMs: when a running item started, from its timeline entry.
 */
import { useEffect, useMemo, useRef } from "react";

import type { WorkbenchBrowseResultEntry } from "workbench-shared/types";
import type { ThreadItem } from "workbench-shared/workbench/thread/workbench-thread-items";
import {
  findWorkbenchThreadItemTimelineEntry, upsertWorkbenchThreadItemTimelineEntry, type WorkbenchThreadItemTimelineEntry,
} from "workbench-shared/workbench/thread/thread-item-timeline";
import { WORKBENCH_QUESTIONNAIRE_TOOL_NAME } from "workbench-shared/workbench/thread/thread-questionnaire-history";
import { endTurnItem } from "workbench-shared/workbench/thread/thread-turn-settlement";
import type {
  WorkbenchProjectedGenericItem,
  WorkbenchProjectedInteractionItem,
  WorkbenchProjectedTranscriptItem,
} from "workbench-shared/workbench/transcript/workbench-transcript-projection";
import { getThreadItemsRenderChunkSignature } from "../../../../workbench/thread/thread-item-signature";
import type ContextualProject from "../../../../workbench/project/ContextualProject";
import { buildActivityRuns } from "../thread-activity-runs";
import { getBrowseScreenshotUrls } from "../thread-browse-steps";
import { foldGitArcBlocks } from "../thread-git-arc-retries";
import type { ThreadReasoningStepReference } from "../thread-reasoning-display";
import {
  buildRenderableBlocks, getRenderableBlockItems, getRenderableBlockKey, getUserMessageDeliveryState, reuseRenderableBlocks,
  type ThreadRenderableBlock,
} from "../thread-render-blocks";

export type TranscriptEntry =
  | { block: ThreadRenderableBlock; kind: "block" }
  | { item: WorkbenchProjectedGenericItem; kind: "generic" };

function isProjectedInteractionItem(item: WorkbenchProjectedTranscriptItem): item is WorkbenchProjectedInteractionItem {
  return item.type === "questionnaire" || item.type === "approval";
}

/** Relational questionnaires and approvals render through the questionnaire tool's history row. */
function adaptProjectedInteractionItem(item: WorkbenchProjectedInteractionItem): Extract<ThreadItem, { type: "dynamicToolCall" }> {
  return {
    arguments: item.request as unknown as Extract<ThreadItem, { type: "dynamicToolCall" }>["arguments"],
    contentItems: [{ text: JSON.stringify(item.response, null, 2), type: "inputText" }],
    durationMs: null,
    id: item.id,
    namespace: null,
    status: item.state === "answered" ? "completed" : "failed",
    success: item.state === "answered",
    tool: WORKBENCH_QUESTIONNAIRE_TOOL_NAME,
    type: "dynamicToolCall",
  };
}

/** Interaction items have no item timing of their own; their resolution time stands in as completion. */
export function withInteractionTimeline(
  items: readonly WorkbenchProjectedTranscriptItem[],
  itemTimeline: readonly WorkbenchThreadItemTimelineEntry[] | undefined,
) {
  return items.filter(isProjectedInteractionItem).reduce<readonly WorkbenchThreadItemTimelineEntry[]>((timeline, item) => (
    upsertWorkbenchThreadItemTimelineEntry(timeline, {
      completedAt: item.resolvedAt, firstSeenAt: null, itemId: item.id, lastSeenAt: null, startedAt: null,
    })
  ), itemTimeline ?? []);
}

export function buildTranscriptEntries(items: readonly WorkbenchProjectedTranscriptItem[], {
  browseResultEntries, codeDetails, hiddenReasoningStep, project, turnLive,
}: {
  browseResultEntries: readonly WorkbenchBrowseResultEntry[];
  codeDetails: boolean;
  hiddenReasoningStep: ThreadReasoningStepReference | null;
  project: ContextualProject | null;
  /** An ended turn runs nothing: a call whose finish never arrived still shows as over. */
  turnLive: boolean;
}): TranscriptEntry[] {
  const matchers = project?.matcherContext;
  const browseScreenshotUrls = getBrowseScreenshotUrls(items.flatMap(item => item.type === "commandExecution" ? [item] : []), browseResultEntries);
  const entries: TranscriptEntry[] = [];
  let pending: ThreadItem[] = [];
  const flush = () => {
    if (!pending.length) return;
    entries.push(...foldGitArcBlocks(buildActivityRuns(
      buildRenderableBlocks(pending, { reasoningStep: hiddenReasoningStep }, project?.cwd),
      { browseScreenshotUrls, codeDetails, knownSkills: matchers?.knownSkills, projectRootPath: matchers?.projectRootPath, workspaceRoots: matchers?.workspaceRoots },
    )).map(block => ({ block, kind: "block" as const })));
    pending = [];
  };
  for (const item of items) {
    if (item.type === "generic") {
      flush();
      entries.push({ item, kind: "generic" });
    } else {
      const threadItem = isProjectedInteractionItem(item) ? adaptProjectedInteractionItem(item) : item;
      pending.push(turnLive ? threadItem : endTurnItem(threadItem));
    }
  }
  flush();
  return entries;
}

interface StableRenderableBlockEntry {
  block: ThreadRenderableBlock;
  blockKey: string;
  signature: string;
}

function getRenderableBlockSignature(block: ThreadRenderableBlock) {
  return [block.kind, getThreadItemsRenderChunkSignature(getRenderableBlockItems(block))].join("\n");
}

/** `identity` reuses blocks whose items are the same objects; `signature` reuses blocks whose rendered content matches. */
export function useStableRenderableBlocks(blocks: ThreadRenderableBlock[], mode: "signature" | "identity" = "signature") {
  const previousEntriesRef = useRef<StableRenderableBlockEntry[]>([]);
  const stableEntries = useMemo(() => {
    if (mode === "identity") {
      return reuseRenderableBlocks(previousEntriesRef.current.map(entry => entry.block), blocks)
        .map(block => ({ block, blockKey: getRenderableBlockKey(block), signature: "" }));
    }
    const previousEntriesByBlockKey = new Map(previousEntriesRef.current.map(entry => [entry.blockKey, entry]));
    return blocks.map((block): StableRenderableBlockEntry => {
      const blockKey = getRenderableBlockKey(block);
      const signature = getRenderableBlockSignature(block);
      const previousEntry = previousEntriesByBlockKey.get(blockKey);
      return { blockKey, block: previousEntry?.signature === signature ? previousEntry.block : block, signature };
    });
  }, [blocks, mode]);

  useEffect(() => {
    previousEntriesRef.current = stableEntries;
  }, [stableEntries]);

  return useMemo(() => stableEntries.map(entry => entry.block), [stableEntries]);
}

/** Undelivered steers and held messages are not in the turn yet, so the newest delivered entry stays the most recent. */
export function getMostRecentDeliveredIndex(entries: readonly TranscriptEntry[]) {
  return entries.findLastIndex(entry => entry.kind === "generic"
    || !getRenderableBlockItems(entry.block).every(item => item.type === "userMessage" && getUserMessageDeliveryState(item)));
}

export function getActiveItemStartedAtMs(
  item: { id: string; status?: string },
  itemTimeline: readonly WorkbenchThreadItemTimelineEntry[] | null | undefined,
) {
  if (item.status !== "inProgress") return null;
  const timeline = findWorkbenchThreadItemTimelineEntry(item.id, itemTimeline);
  return timeline?.startedAt ?? timeline?.firstSeenAt ?? null;
}
