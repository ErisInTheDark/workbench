/*
 * Exports:
 * - ThreadTurnDetails: render one thread turn with grouped commands and typed item sections. Keywords: workbench, thread, turn.
 * - ThreadThreadContent: render all turns for one thread payload without composer chrome. Keywords: workbench, thread, subagent, preview.
 * - ThreadTurnLoadingSkeleton: render a lightweight placeholder for unloaded lazy-history turns. Keywords: workbench, thread, lazy history, skeleton.
 * - useStableBrowseScreenshotEntriesByTurn: preserve turn-owned screenshot chunk arrays across thread-level sidecar refreshes. Keywords: browse, screenshot, render, chunk.
 * - Local helpers: summarize inputs, group command, reasoning, file, and web-search sequences, and render the supported thread item variants. Keywords: thread items, command sequence, reasoning, rendering.
 */
"use client";

import { memo, useEffect, useMemo, useRef, type ReactNode } from "react";

import type { ThreadItem } from "../../../lib/codex/generated/app-server/v2/ThreadItem";
import type { Turn } from "../../../lib/codex/generated/app-server/v2/Turn";
import type { UserInput } from "../../../lib/codex/generated/app-server/v2/UserInput";
import { getCurrentTurn } from "../../../lib/codex/thread-state";
import type { ThreadPayload, WorkbenchBrowseScreenshotEntry, WorkbenchSkillSummary, WorkbenchThreadTurnHistoryEntry } from "../../../lib/types";
import type { WorkbenchThreadItemTimelineEntry } from "../../../lib/workbench/thread/thread-item-timeline";
import { getThreadItemsRenderChunkSignature } from "../../../lib/workbench/thread/thread-item-signature";
import type { WorkspaceFileLinkRoot } from "../../../lib/workbench/markdown/markdown-links";
import type { InlineMentionHighlightSources } from "../../../lib/workbench/thread/inline-mention-highlights";
import {
  getPrimaryCollabAgentThreadId,
  type CollabAgentToolCallItem,
} from "../../../lib/workbench/thread/thread-collab-agents";
import { isSyntheticQuestionnaireHistoryItem } from "../../../lib/workbench/thread/thread-questionnaire-history";
import {
  getAgentScreenshotSteerImages,
  isAgentScreenshotSteerUserMessage,
} from "../../../lib/workbench/thread/thread-steer-markers";
import {
  getThreadCommandBlockDisplay,
  getThreadCommandDisplay,
  isBrowseWebRequestMatcherClaim,
  isGitCheckpointDiffMatcherClaim,
  parseBrowseSequenceCommandOutput,
  parseGitCheckpointDiffArtifactId,
  parseGitCheckpointDiffOutput,
  type ThreadCommandDetailRow,
  type ThreadCommandDetailTarget,
} from "../../../lib/workbench/thread/thread-command-matchers";
import {
  formatThreadDuration,
  formatThreadTimestamp,
  humanizeThreadLabel,
  ThreadCommandSummary,
  truncateThreadText,
} from "./thread-view-primitives";
import ThreadAgentName from "./ThreadAgentName";
import ThreadCheckpointDiffItem from "./ThreadCheckpointDiffItem";
import ThreadCodeDisplay, { ThreadCommandHeader } from "./ThreadCodeDisplay";
import ThreadContextCompactionItem from "./ThreadContextCompactionItem";
import ThreadDisclosure, { ThreadDisclosureStaticRow } from "./ThreadDisclosure";
import ThreadDurationText from "./ThreadDurationText";
import ThreadDynamicToolCallItem from "./ThreadDynamicToolCallItem";
import ThreadFileChangeItem from "./ThreadFileChangeItem";
import ThreadMarkdown from "./ThreadMarkdown";
import ThreadMcpToolCallItem from "./ThreadMcpToolCallItem";
import ThreadPreviewFrame from "./ThreadPreviewFrame";
import ThreadReasoningItem from "./ThreadReasoningItem";
import ThreadSummaryText from "./ThreadSummaryText";
import ThreadUserImage from "./ThreadUserImage";
import ThreadWebSearchItem, {
  isThreadWebSearchPlaceholder,
  ThreadWebSearchSequence,
} from "./ThreadWebSearchItem";
import { createThreadTurnCompactionRenderPlan } from "./thread-turn-compaction-sections";
import { CheckIcon, ClockIcon, PlayIcon, WarningIcon } from "../workbench-icons";

const THREAD_DETAIL_INLINE_CODE_CLASS = "rounded-[0.35rem] bg-[color-mix(in_srgb,var(--text)_7%,transparent)] px-[0.34em] py-[0.08em] font-mono text-[0.88em] leading-[1.6] text-text";
const LIVE_RENDER_BLOCK_TAIL_ITEM_COUNT = 8;
const EMPTY_BROWSE_SCREENSHOT_ENTRIES: readonly WorkbenchBrowseScreenshotEntry[] = [];

type CommandItem = Extract<ThreadItem, { type: "commandExecution" }>;
type FileChangeItem = Extract<ThreadItem, { type: "fileChange" }>;
type ReasoningItem = Extract<ThreadItem, { type: "reasoning" }>;
type WebSearchItem = Extract<ThreadItem, { type: "webSearch" }>;
type NonGroupedItem = Exclude<ThreadItem, { type: "commandExecution" } | { type: "fileChange" } | { type: "reasoning" }>;

type ThreadRenderableBlock =
  | { kind: "commandSequence"; items: CommandItem[] }
  | { kind: "fileChangeSequence"; items: FileChangeItem[] }
  | { kind: "reasoningSequence"; items: ReasoningItem[] }
  | { kind: "webSearchSequence"; items: WebSearchItem[] }
  | { kind: "item"; item: NonGroupedItem };

type RelatedThreadsById = Record<string, ThreadPayload | undefined>;

interface HiddenThreadItemIds {
  collabAgentToolCallIds?: ReadonlySet<string> | null;
  controlAgentMessages?: boolean;
  controlUserMessages?: boolean;
  dynamicToolCallIds?: ReadonlySet<string> | null;
  reasoningItemId?: string | null;
  webSearchItemIds?: ReadonlySet<string> | null;
}

function isOpenCodeQuestionToolCall(item: ThreadItem) {
  return item.type === "dynamicToolCall"
    && item.namespace === "opencode"
    && item.tool === "question";
}

function ThreadContentLoadingSkeleton () {
  return (
    <div aria-label="Loading subagent thread" aria-live="polite" role="status" className="space-y-3 py-1">
      <div className="h-3.5 w-44 max-w-full rounded-full workbench-skeleton" aria-hidden="true" />
      <div className="space-y-2">
        <div className="h-3 w-[92%] rounded-full workbench-skeleton" aria-hidden="true" />
        <div className="h-3 w-[76%] rounded-full workbench-skeleton" aria-hidden="true" />
        <div className="h-3 w-[84%] rounded-full workbench-skeleton" aria-hidden="true" />
      </div>
    </div>
  );
}

export function ThreadTurnLoadingSkeleton ({
  entry,
  isLoading = false,
}: {
  entry: WorkbenchThreadTurnHistoryEntry;
  isLoading?: boolean;
}) {
  return (
    <section className="border-t border-[color-mix(in_srgb,var(--text)_10%,transparent)] py-3" data-thread-turn-load-state={entry.loadState}>
      <div className="space-y-2" aria-busy={isLoading ? "true" : undefined}>
        <div className="h-3 w-28 animate-pulse rounded bg-[color-mix(in_srgb,var(--text)_10%,transparent)]" />
        <div className="space-y-1.5">
          <div className="h-3 w-[82%] animate-pulse rounded bg-[color-mix(in_srgb,var(--text)_8%,transparent)]" />
          <div className="h-3 w-[64%] animate-pulse rounded bg-[color-mix(in_srgb,var(--text)_7%,transparent)]" />
        </div>
      </div>
    </section>
  );
}

function getFinalAgentMessageId (turn: Turn) {
  for (let index = turn.items.length - 1; index >= 0; index -= 1) {
    const item = turn.items[index];
    if (item.type !== "agentMessage" || !item.text.trim()) {
      continue;
    }

    if (item.phase === "final_answer") {
      return item.id;
    }
  }

  return null;
}

function isUserMessageBlock (block: ThreadRenderableBlock) {
  return block.kind === "item" && block.item.type === "userMessage";
}

function isWorkbenchControlUserMessage(item: Extract<ThreadItem, { type: "userMessage" }>) {
  return item.content.some((content) => content.type === "text" && content.text.includes("<!-- workbench-collaboration-control -->"));
}

function getSteerUserMessageState(item: Extract<ThreadItem, { type: "userMessage" }>) {
  if (
    item.id.startsWith("optimistic-user-message:steer:pending:")
    || item.id.startsWith("workbench:steer-history:pending:")
  ) {
    return "pending";
  }

  if (
    item.id.startsWith("optimistic-user-message:steer:interrupted:")
    || item.id.startsWith("optimistic-user-message:steer:failed:")
    || item.id.startsWith("workbench:steer-history:interrupted:")
    || item.id.startsWith("workbench:steer-history:failed:")
  ) {
    return "unsent";
  }

  return null;
}

function isFinalAgentMessageBlock (block: ThreadRenderableBlock, finalAgentMessageId: string | null) {
  return block.kind === "item"
    && block.item.type === "agentMessage"
    && block.item.id === finalAgentMessageId;
}

function isGenericSnapshotItemId(itemId: string) {
  return /^item-\d+$/u.test(itemId);
}

function getNarrativeTextForSnapshotDedupe(item: ThreadItem) {
  switch (item.type) {
    case "agentMessage":
    case "plan":
      return item.text;
    case "reasoning":
      return [...item.summary, ...item.content].join("\n");
    default:
      return null;
  }
}

function normalizeNarrativeTextForSnapshotDedupe(value: string) {
  return value
    .replace(/\s+/gu, " ")
    .replace(/[^\p{L}\p{N}\s#`./:-]+/gu, "")
    .trim()
    .toLowerCase();
}

function getNarrativeSnapshotDedupeKey(item: ThreadItem) {
  const text = getNarrativeTextForSnapshotDedupe(item);
  if (!text) {
    return null;
  }

  const normalizedText = normalizeNarrativeTextForSnapshotDedupe(text);
  return normalizedText.length >= 40 ? normalizedText.slice(0, 120) : null;
}

function isGenericSnapshotNarrativeArtifact(item: ThreadItem) {
  return isGenericSnapshotItemId(item.id)
    && (item.type === "agentMessage" || item.type === "plan" || item.type === "reasoning");
}

function getWorkedSummaryForDuration(durationMs: number | null) {
  return durationMs === null
    ? "Worked"
    : (
      <span>
        Worked for <ThreadDurationText durationMs={durationMs} />
      </span>
    );
}

function getWorkedSummary (turn: Turn) {
  return getWorkedSummaryForDuration(turn.durationMs);
}

function buildRenderableBlocks (items: ThreadItem[], hiddenItemIds: HiddenThreadItemIds = {}): ThreadRenderableBlock[] {
  const blocks: ThreadRenderableBlock[] = [];
  let pendingCommands: CommandItem[] = [];
  let pendingFileChanges: FileChangeItem[] = [];
  let pendingReasoning: ReasoningItem[] = [];
  let pendingWebSearches: WebSearchItem[] = [];
  const hasSyntheticQuestionnaireHistory = items.some(isSyntheticQuestionnaireHistoryItem);
  const narrativeSnapshotDedupeKeys = new Set<string>();
  let hasSeenContextCompaction = false;

  const flushPendingCommands = () => {
    if (!pendingCommands.length) {
      return;
    }

    blocks.push({
      kind: "commandSequence",
      items: pendingCommands,
    });
    pendingCommands = [];
  };

  const flushPendingReasoning = () => {
    if (!pendingReasoning.length) {
      return;
    }

    blocks.push({
      kind: "reasoningSequence",
      items: pendingReasoning,
    });
    pendingReasoning = [];
  };

  const flushPendingFileChanges = () => {
    if (!pendingFileChanges.length) {
      return;
    }

    blocks.push({
      kind: "fileChangeSequence",
      items: pendingFileChanges,
    });
    pendingFileChanges = [];
  };

  const flushPendingWebSearches = () => {
    if (!pendingWebSearches.length) {
      return;
    }

    blocks.push({
      kind: "webSearchSequence",
      items: pendingWebSearches,
    });
    pendingWebSearches = [];
  };

  for (const item of items) {
    const narrativeSnapshotDedupeKey = getNarrativeSnapshotDedupeKey(item);
    if (
      hasSeenContextCompaction
      && narrativeSnapshotDedupeKey
      && isGenericSnapshotNarrativeArtifact(item)
      && narrativeSnapshotDedupeKeys.has(narrativeSnapshotDedupeKey)
    ) {
      continue;
    }
    if (narrativeSnapshotDedupeKey) {
      narrativeSnapshotDedupeKeys.add(narrativeSnapshotDedupeKey);
    }
    if (item.type === "contextCompaction") {
      hasSeenContextCompaction = true;
    }

    if (item.type === "agentMessage" && !item.text.trim()) {
      continue;
    }

    if (item.type === "agentMessage" && hiddenItemIds.controlAgentMessages) {
      continue;
    }

    if (item.type === "userMessage" && hiddenItemIds.controlUserMessages && isWorkbenchControlUserMessage(item)) {
      continue;
    }

    if (item.type === "commandExecution" && isHiddenCommandExecution(item.command)) {
      continue;
    }

    if (item.type === "commandExecution") {
      flushPendingReasoning();
      flushPendingFileChanges();
      flushPendingWebSearches();
      pendingCommands.push(item);
      continue;
    }

    if (item.type === "reasoning") {
      if (item.id === hiddenItemIds.reasoningItemId || !hasReasoningSteps(item)) {
        continue;
      }

      flushPendingCommands();
      flushPendingFileChanges();
      flushPendingWebSearches();
      pendingReasoning.push(item);
      continue;
    }

    if (item.type === "fileChange") {
      flushPendingCommands();
      flushPendingReasoning();
      flushPendingWebSearches();
      pendingFileChanges.push(item);
      continue;
    }

    if (item.type === "webSearch") {
      flushPendingCommands();
      flushPendingReasoning();
      flushPendingFileChanges();
      if (hiddenItemIds.webSearchItemIds?.has(item.id) || isThreadWebSearchPlaceholder(item)) {
        continue;
      }
      pendingWebSearches.push(item);
      continue;
    }

    if (item.type === "collabAgentToolCall" && hiddenItemIds.collabAgentToolCallIds?.has(item.id)) {
      flushPendingCommands();
      flushPendingReasoning();
      flushPendingFileChanges();
      flushPendingWebSearches();
      continue;
    }

    if (
      item.type === "dynamicToolCall"
      && (
        hiddenItemIds.dynamicToolCallIds?.has(item.id)
        || (hasSyntheticQuestionnaireHistory && isOpenCodeQuestionToolCall(item))
      )
    ) {
      flushPendingCommands();
      flushPendingReasoning();
      flushPendingFileChanges();
      flushPendingWebSearches();
      continue;
    }

    flushPendingCommands();
    flushPendingReasoning();
    flushPendingFileChanges();
    flushPendingWebSearches();
    blocks.push({
      kind: "item",
      item,
    });
  }

  flushPendingCommands();
  flushPendingReasoning();
  flushPendingFileChanges();
  flushPendingWebSearches();
  return blocks;
}

interface StableRenderableBlockEntry {
  block: ThreadRenderableBlock;
  blockKey: string;
  signature: string;
}

interface StableBrowseScreenshotEntriesByTurnResult {
  cacheEntriesByTurnId: Map<string, StableBrowseScreenshotEntriesByTurnEntry>;
  entriesByTurnId: Map<string, readonly WorkbenchBrowseScreenshotEntry[]>;
}

interface StableBrowseScreenshotEntriesByTurnEntry {
  entries: readonly WorkbenchBrowseScreenshotEntry[];
  signature: string;
}

function getRenderableBlockItems(block: ThreadRenderableBlock): readonly ThreadItem[] {
  switch (block.kind) {
    case "commandSequence":
    case "fileChangeSequence":
    case "reasoningSequence":
    case "webSearchSequence":
      return block.items;
    case "item":
      return [block.item];
  }
}

function getRenderableBlockItemCount(block: ThreadRenderableBlock) {
  return getRenderableBlockItems(block).length;
}

function getRenderableBlockKey(block: ThreadRenderableBlock) {
  return [
    block.kind,
    ...getRenderableBlockItems(block).map((item) => item.id),
  ].join(":");
}

function getRenderableBlockSignature(block: ThreadRenderableBlock) {
  return [
    block.kind,
    getThreadItemsRenderChunkSignature(getRenderableBlockItems(block)),
  ].join("\n");
}

function getStabilizableRenderableBlockFlags(blocks: readonly ThreadRenderableBlock[]) {
  const flags = blocks.map(() => true);
  let liveTailItemCount = 0;
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    if (liveTailItemCount >= LIVE_RENDER_BLOCK_TAIL_ITEM_COUNT) {
      break;
    }

    flags[index] = false;
    liveTailItemCount += getRenderableBlockItemCount(blocks[index]);
  }
  return flags;
}

function useStableRenderableBlocks(blocks: ThreadRenderableBlock[]) {
  const previousEntriesRef = useRef<StableRenderableBlockEntry[]>([]);
  const stableEntries = useMemo(() => {
    const previousEntriesByBlockKey = new Map(previousEntriesRef.current.map((entry) => [entry.blockKey, entry]));
    const stabilizableFlags = getStabilizableRenderableBlockFlags(blocks);
    return blocks.map((block, index): StableRenderableBlockEntry => {
      const blockKey = getRenderableBlockKey(block);
      const signature = getRenderableBlockSignature(block);
      const matchingPreviousEntry = previousEntriesByBlockKey.get(blockKey) ?? null;
      const previousEntry = stabilizableFlags[index] && matchingPreviousEntry?.signature === signature
        ? matchingPreviousEntry
        : null;
      return {
        blockKey,
        block: previousEntry?.block ?? block,
        signature,
      };
    });
  }, [blocks]);

  useEffect(() => {
    previousEntriesRef.current = stableEntries;
  }, [stableEntries]);

  return useMemo(() => stableEntries.map((entry) => entry.block), [stableEntries]);
}

function getBrowseScreenshotEntryChunkSignature(entry: WorkbenchBrowseScreenshotEntry) {
  return [
    entry.entryKey,
    entry.turnId,
    entry.commandItemId ?? "",
    entry.recordedAt,
    entry.assetUrl,
    entry.action,
    entry.actionIndex,
  ].join("\n");
}

function getBrowseScreenshotEntriesChunkSignature(entries: readonly WorkbenchBrowseScreenshotEntry[]) {
  return entries.map(getBrowseScreenshotEntryChunkSignature).join("\n---\n");
}

export function useStableBrowseScreenshotEntriesByTurn(
  entries: readonly WorkbenchBrowseScreenshotEntry[] = EMPTY_BROWSE_SCREENSHOT_ENTRIES,
) {
  const previousEntriesRef = useRef<Map<string, StableBrowseScreenshotEntriesByTurnEntry>>(new Map());
  const stableResult = useMemo((): StableBrowseScreenshotEntriesByTurnResult => {
    const groupedEntriesByTurnId = new Map<string, WorkbenchBrowseScreenshotEntry[]>();
    for (const entry of entries) {
      const turnEntries = groupedEntriesByTurnId.get(entry.turnId) ?? [];
      turnEntries.push(entry);
      groupedEntriesByTurnId.set(entry.turnId, turnEntries);
    }

    const cacheEntriesByTurnId = new Map<string, StableBrowseScreenshotEntriesByTurnEntry>();
    const entriesByTurnId = new Map<string, readonly WorkbenchBrowseScreenshotEntry[]>();
    for (const [turnId, turnEntries] of groupedEntriesByTurnId) {
      const signature = getBrowseScreenshotEntriesChunkSignature(turnEntries);
      const previousEntry = previousEntriesRef.current.get(turnId);
      const stableEntries = previousEntry?.signature === signature ? previousEntry.entries : turnEntries;
      const cacheEntry = {
        entries: stableEntries,
        signature,
      };
      cacheEntriesByTurnId.set(turnId, cacheEntry);
      entriesByTurnId.set(turnId, stableEntries);
    }

    return {
      cacheEntriesByTurnId,
      entriesByTurnId,
    };
  }, [entries]);

  useEffect(() => {
    previousEntriesRef.current = stableResult.cacheEntriesByTurnId;
  }, [stableResult]);

  return stableResult.entriesByTurnId;
}

function isHiddenCommandExecution (command: string) {
  if (/^report_intent(?:\s|$)/i.test(command.trim())) {
    return true;
  }

  return getThreadCommandDisplay({
    command,
    commandActions: [],
    cwd: "",
  }).omitFromDisplay;
}

function hasReasoningSteps (item: ReasoningItem) {
  return item.summary.some((section) => section.trim())
    || item.content.some((section) => section.trim());
}

function formatReasoningStepTitle (value: string) {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)
    ?.replace(/^#{1,6}\s+/, "")
    .replace(/^\*\*(.+)\*\*$/, "$1")
    .replace(/^\[(.+)\]$/, "$1")
    .replace(/:$/, "")
    .trim() || null;
}

function getReasoningStepTitle (item: ReasoningItem) {
  const visibleSections = item.summary.length ? item.summary : item.content;
  for (const section of visibleSections) {
    const title = formatReasoningStepTitle(section);
    if (title) {
      return title;
    }
  }

  return "Step";
}

function ThreadUserInputLine ({
  inlineMentionSources,
  input,
  threadCwdPath,
  projectFilePaths,
  projectId,
  projectRootPath,
  workspaceRoots,
}: {
  inlineMentionSources?: InlineMentionHighlightSources | null;
  input: UserInput;
  threadCwdPath?: string;
  projectFilePaths?: readonly string[];
  projectId?: string | null;
  projectRootPath?: string;
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
}) {
  switch (input.type) {
    case "text": {
      const text = input.text.trim();
      return (
        <ThreadMarkdown
          inlineMentionSources={inlineMentionSources}
          markdown={text || "No text captured."}
          threadCwdPath={threadCwdPath}
          projectFilePaths={projectFilePaths}
          projectId={projectId}
          projectRootPath={projectRootPath}
          workspaceRoots={workspaceRoots}
        />
      );
    }
    case "image":
      return (
        <ThreadUserImage
          alt="User-provided image"
          className="max-w-[22rem]"
          src={input.url}
        />
      );
    case "localImage":
      return (
        <p className="m-0 break-all font-mono text-[0.78em] leading-[1.6] text-muted">
          Local image: {input.path}
        </p>
      );
    case "skill":
      return (
        <p className="m-0 text-[0.92em] leading-[1.6] text-muted">
          Skill: <span className="text-text">{input.name}</span>{" "}
          <span className="break-all font-mono text-[0.78em]">({input.path})</span>
        </p>
      );
    case "mention":
      return (
        <p className="m-0 text-[0.92em] leading-[1.6] text-muted">
          Mention: <span className="text-text">{input.name}</span>{" "}
          <span className="break-all font-mono text-[0.78em]">({input.path})</span>
        </p>
      );
    default:
      return null;
  }
}

function ThreadMessageTimestamp ({
  align = "left",
  className = "",
  timestampSeconds,
}: {
  align?: "left" | "right";
  className?: string;
  timestampSeconds: number | null;
}) {
  if (timestampSeconds === null) {
    return null;
  }

  return (
    <p className={`m-0 text-[0.67em] leading-[1.5] text-muted${align === "right" ? " text-right" : ""}${className ? ` ${className}` : ""}`}>
      {formatThreadTimestamp(timestampSeconds)}
    </p>
  );
}

function ThreadUserMessageItem ({
  inlineMentionSources,
  item,
  threadCwdPath,
  projectFilePaths,
  projectId,
  projectRootPath,
  showStartedAt,
  startedAt,
  workspaceRoots,
}: {
  inlineMentionSources?: InlineMentionHighlightSources | null;
  item: Extract<ThreadItem, { type: "userMessage" }>;
  threadCwdPath?: string;
  projectFilePaths?: readonly string[];
  projectId?: string | null;
  projectRootPath?: string;
  showStartedAt: boolean;
  startedAt: number | null;
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
}) {
  if (isAgentScreenshotSteerUserMessage(item)) {
    return (
      <ThreadAgentScreenshotSteerItem
        item={item}
        showStartedAt={showStartedAt}
        startedAt={startedAt}
      />
    );
  }

  const steerState = getSteerUserMessageState(item);
  const isDecoratedSteer = steerState !== null;
  const steerMessageClass = steerState ? ` thread-${steerState}-steer-message px-0.5 py-0.5` : "";
  return (
    <section className="flex flex-col items-end py-2" data-thread-user-message-state={steerState ? `${steerState}-steer` : undefined}>
      <div className={`w-full max-w-[42rem]${isDecoratedSteer ? steerMessageClass : " rounded-[1.15rem] bg-[color-mix(in_srgb,var(--text)_6%,transparent)] px-4 py-3"}`}>
        <div className={`space-y-2 text-left${isDecoratedSteer ? " rounded-[1.15rem] bg-[color-mix(in_srgb,var(--text)_6%,transparent)] px-4 py-3" : ""}`}>
          {item.content.length ? item.content.map((content, index) => (
            <ThreadUserInputLine
              key={`${item.id}:content:${index}:${content.type}`}
              input={content}
              inlineMentionSources={inlineMentionSources}
              threadCwdPath={threadCwdPath}
              projectFilePaths={projectFilePaths}
              projectId={projectId}
              projectRootPath={projectRootPath}
              workspaceRoots={workspaceRoots}
            />
          )) : (
            <p className="m-0 text-[0.92em] leading-[1.6] text-muted">No user content captured.</p>
          )}
        </div>
      </div>
      {showStartedAt ? <ThreadMessageTimestamp align="right" className="mt-1" timestampSeconds={startedAt} /> : null}
    </section>
  );
}

function ThreadAgentScreenshotSteerItem ({
  item,
  showStartedAt,
  startedAt,
}: {
  item: Extract<ThreadItem, { type: "userMessage" }>;
  showStartedAt: boolean;
  startedAt: number | null;
}) {
  const images = getAgentScreenshotSteerImages(item);
  if (!images.length) {
    return null;
  }

  return (
    <section className="flex flex-col items-start py-2" data-thread-user-message-state="agent-screenshot-steer">
      <div className="w-full max-w-[42rem] space-y-2">
        {images.map((image, index) => (
          <ThreadUserImage
            key={`${item.id}:agent-screenshot:${index}`}
            alt="Agent-captured screenshot"
            className="max-w-[28rem]"
            src={image.url}
          />
        ))}
      </div>
      {showStartedAt ? <ThreadMessageTimestamp className="mt-1" timestampSeconds={startedAt} /> : null}
    </section>
  );
}

function ThreadAgentMessageItem ({
  completedAt,
  inlineMentionSources,
  isFinal,
  item,
  threadCwdPath,
  projectFilePaths,
  projectId,
  projectRootPath,
  workspaceRoots,
}: {
  completedAt: number | null;
  inlineMentionSources?: InlineMentionHighlightSources | null;
  isFinal: boolean;
  item: Extract<ThreadItem, { type: "agentMessage" }>;
  threadCwdPath?: string;
  projectFilePaths?: readonly string[];
  projectId?: string | null;
  projectRootPath?: string;
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
}) {
  return (
    <section className="py-2">
      <ThreadMarkdown
        inlineMentionSources={inlineMentionSources}
        markdown={item.text || "No assistant text captured."}
        threadCwdPath={threadCwdPath}
        projectFilePaths={projectFilePaths}
        projectId={projectId}
        projectRootPath={projectRootPath}
        workspaceRoots={workspaceRoots}
      />
      {isFinal ? <ThreadMessageTimestamp className="mt-1" timestampSeconds={completedAt} /> : null}
    </section>
  );
}

function ThreadPlanItem ({
  inlineMentionSources,
  item,
  threadCwdPath,
  projectFilePaths,
  projectId,
  projectRootPath,
  workspaceRoots,
}: {
  inlineMentionSources?: InlineMentionHighlightSources | null;
  item: Extract<ThreadItem, { type: "plan" }>;
  threadCwdPath?: string;
  projectFilePaths?: readonly string[];
  projectId?: string | null;
  projectRootPath?: string;
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
}) {
  return (
    <ThreadDisclosure
      className="py-2"
      contentClassName="mt-2 pl-6"
      summary={<ThreadSummaryText text="Plan" />}
      summaryClassName="text-[0.92em] leading-[1.6] text-muted"
    >
      <ThreadMarkdown
        inlineMentionSources={inlineMentionSources}
        markdown={item.text || "No plan text captured."}
        threadCwdPath={threadCwdPath}
        projectFilePaths={projectFilePaths}
        projectId={projectId}
        projectRootPath={projectRootPath}
        workspaceRoots={workspaceRoots}
      />
    </ThreadDisclosure>
  );
}

function ThreadAgentBubble ({
  inlineMentionSources,
  label,
  markdown,
  threadCwdPath,
  projectFilePaths,
  projectId,
  projectRootPath,
  workspaceRoots,
}: {
  inlineMentionSources?: InlineMentionHighlightSources | null;
  label: ReactNode;
  markdown: string;
  threadCwdPath?: string;
  projectFilePaths?: readonly string[];
  projectId?: string | null;
  projectRootPath?: string;
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
}) {
  return (
    <section className="py-2">
      <div className="w-full max-w-[42rem] rounded-[1.15rem] bg-[color-mix(in_srgb,var(--text)_4%,transparent)] px-4 py-3">
        <div className="m-0 pb-2 text-[0.74em] font-medium leading-[1.4] text-muted">
          {label}
        </div>
        <ThreadMarkdown
          inlineMentionSources={inlineMentionSources}
          markdown={markdown || "No message captured."}
          threadCwdPath={threadCwdPath}
          projectFilePaths={projectFilePaths}
          projectId={projectId}
          projectRootPath={projectRootPath}
          workspaceRoots={workspaceRoots}
        />
      </div>
    </section>
  );
}

function getCollabAgentStateMessage (item: CollabAgentToolCallItem, receiverThreadId: string) {
  const preferredMessage = item.agentsStates[receiverThreadId]?.message?.trim();
  if (preferredMessage) {
    return preferredMessage;
  }

  for (const threadId of item.receiverThreadIds) {
    const message = item.agentsStates[threadId]?.message?.trim();
    if (message) {
      return message;
    }
  }

  return null;
}

function ThreadCurrentSubagentItemPreview ({
  inlineMentionSources,
  knownSkills,
  threadCwdPath,
  projectFilePaths,
  projectId,
  projectRootPath,
  relatedThreadsById,
  thread,
  workspaceRoots,
}: {
  inlineMentionSources?: InlineMentionHighlightSources | null;
  knownSkills?: WorkbenchSkillSummary[];
  threadCwdPath?: string;
  projectFilePaths?: readonly string[];
  projectId?: string | null;
  projectRootPath?: string;
  relatedThreadsById: RelatedThreadsById;
  thread: ThreadPayload | undefined;
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
}) {
  const currentTurn = getCurrentTurn(thread);
  if (!currentTurn) {
    return (
      <p className="m-0 text-[0.92em] leading-[1.6] text-muted">
        No subagent activity was captured yet.
      </p>
    );
  }

  const blocks = buildRenderableBlocks(currentTurn.items);
  const block = blocks.at(-1) ?? null;
  if (!block) {
    return (
      <p className="m-0 text-[0.92em] leading-[1.6] text-muted">
        No subagent activity was captured yet.
      </p>
    );
  }

  return (
    <ThreadPreviewFrame height="22rem" scale={0.9}>
      <ThreadRenderableBlockView
        block={block}
        finalAgentMessageId={getFinalAgentMessageId(currentTurn)}
        isMostRecentBlock={true}
        inlineMentionSources={inlineMentionSources}
        knownSkills={knownSkills}
        primaryUserBlock={null}
        threadCwdPath={threadCwdPath ?? thread?.cwd}
        threadId={thread.id}
        projectFilePaths={projectFilePaths}
        projectId={projectId}
        projectRootPath={projectRootPath}
        relatedThreadsById={relatedThreadsById}
        turnCompletedAt={currentTurn.completedAt}
        turnStartedAt={currentTurn.startedAt}
        turnStatus={currentTurn.status}
        workspaceRoots={workspaceRoots}
      />
    </ThreadPreviewFrame>
  );
}

function ThreadCollabAgentToolCallItem ({
  inlineMentionSources,
  isMostRecent,
  item,
  knownSkills,
  threadCwdPath,
  projectFilePaths,
  projectId,
  projectRootPath,
  relatedThreadsById,
  workspaceRoots,
}: {
  inlineMentionSources?: InlineMentionHighlightSources | null;
  isMostRecent: boolean;
  item: CollabAgentToolCallItem;
  knownSkills?: WorkbenchSkillSummary[];
  threadCwdPath?: string;
  projectFilePaths?: readonly string[];
  projectId?: string | null;
  projectRootPath?: string;
  relatedThreadsById: RelatedThreadsById;
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
}) {
  const receiverThreadId = getPrimaryCollabAgentThreadId(item);
  const receiverThread = relatedThreadsById[receiverThreadId];
  const prompt = item.prompt?.trim() ?? "";
  const responseMessage = getCollabAgentStateMessage(item, receiverThreadId);
  const isActiveWait = item.status === "inProgress" && isMostRecent;
  const agentName = (
    <ThreadAgentName
      fallbackKey={receiverThreadId}
      thread={receiverThread}
    />
  );

  if (item.tool === "spawnAgent") {
    return (
      <ThreadDisclosure
        className="py-2"
        contentClassName="mt-2 pl-6"
        summary={<><span>Spawned </span>{agentName}</>}
        summaryClassName="text-[0.92em] leading-[1.6] text-muted"
      >
        <ThreadAgentBubble
          label="Main agent"
          inlineMentionSources={inlineMentionSources}
          markdown={prompt}
          threadCwdPath={threadCwdPath}
          projectFilePaths={projectFilePaths}
          projectId={projectId}
          projectRootPath={projectRootPath}
          workspaceRoots={workspaceRoots}
        />
      </ThreadDisclosure>
    );
  }

  if (item.tool === "wait") {
    return (
      <ThreadDisclosure
        className="py-2"
        contentClassName="mt-2 pl-6"
        defaultOpen={isActiveWait}
        summary={<><span>{isActiveWait ? "Waiting for " : "Waited for "}</span>{agentName}</>}
        summaryClassName="text-[0.92em] leading-[1.6] text-muted"
      >
        {isActiveWait ? (
          <ThreadCurrentSubagentItemPreview
            inlineMentionSources={inlineMentionSources}
            knownSkills={knownSkills}
            threadCwdPath={receiverThread?.cwd ?? threadCwdPath}
            projectFilePaths={projectFilePaths}
            projectId={projectId}
            projectRootPath={projectRootPath}
            relatedThreadsById={relatedThreadsById}
            thread={receiverThread}
            workspaceRoots={workspaceRoots}
          />
        ) : null}
      </ThreadDisclosure>
    );
  }

  if ((item.tool === "sendInput" || item.tool === "resumeAgent") && prompt) {
    return (
      <ThreadDisclosure
        className="py-2"
        contentClassName="mt-2 pl-6"
        summary={<><span>Messaged </span>{agentName}</>}
        summaryClassName="text-[0.92em] leading-[1.6] text-muted"
      >
        <ThreadAgentBubble
          label="Main agent"
          inlineMentionSources={inlineMentionSources}
          markdown={prompt}
          threadCwdPath={threadCwdPath}
          projectFilePaths={projectFilePaths}
          projectId={projectId}
          projectRootPath={projectRootPath}
          workspaceRoots={workspaceRoots}
        />
      </ThreadDisclosure>
    );
  }

  if (responseMessage) {
    return (
      <ThreadDisclosure
        className="py-2"
        contentClassName="mt-2 pl-6"
        summary={<><span>Received response from </span>{agentName}</>}
        summaryClassName="text-[0.92em] leading-[1.6] text-muted"
      >
        <ThreadAgentBubble
          label={agentName}
          inlineMentionSources={inlineMentionSources}
          markdown={responseMessage}
          threadCwdPath={receiverThread?.cwd ?? threadCwdPath}
          projectFilePaths={projectFilePaths}
          projectId={projectId}
          projectRootPath={projectRootPath}
          workspaceRoots={workspaceRoots}
        />
      </ThreadDisclosure>
    );
  }

  if (item.tool === "closeAgent") {
    return (
      <ThreadDisclosure
        className="py-2"
        contentClassName="mt-2 pl-6"
        summary={<><span>Closed </span>{agentName}</>}
        summaryClassName="text-[0.92em] leading-[1.6] text-muted"
      >
        <></>
      </ThreadDisclosure>
    );
  }

  return (
    <ThreadDisclosure
      className="py-2"
      contentClassName="mt-2 pl-6"
      summary={`Collaboration: ${humanizeThreadLabel(item.tool)}`}
      summaryClassName="text-[0.92em] leading-[1.6] text-muted"
    >
      <pre className="m-0 max-w-full overflow-x-auto whitespace-pre rounded-[0.9rem] bg-[color-mix(in_srgb,var(--text)_4%,transparent)] px-4 py-3 font-mono text-[0.78em] leading-[1.6] text-text">
        {JSON.stringify(item, null, 2)}
      </pre>
    </ThreadDisclosure>
  );
}

function ThreadReasoningSequence ({
  block,
  inlineMentionSources,
  isMostRecent,
  threadCwdPath,
  projectFilePaths,
  projectId,
  projectRootPath,
  workspaceRoots,
}: {
  block: Extract<ThreadRenderableBlock, { kind: "reasoningSequence" }>;
  inlineMentionSources?: InlineMentionHighlightSources | null;
  isMostRecent: boolean;
  threadCwdPath?: string;
  projectFilePaths?: readonly string[];
  projectId?: string | null;
  projectRootPath?: string;
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
}) {
  const visibleItems = block.items.filter(hasReasoningSteps);
  const totalItems = visibleItems.reduce((sum, item) => (
    sum + (item.summary.filter((section) => section.trim()).length || item.content.filter((section) => section.trim()).length)
  ), 0);
  if (!totalItems) {
    return null;
  }

  const content = (
    <div className="space-y-4">
      {visibleItems.map((item, index) => (
        <ThreadReasoningItem
          key={item.id}
          className={index ? "border-t border-[color-mix(in_srgb,var(--text)_10%,transparent)] pt-4" : undefined}
          item={item}
          inlineMentionSources={inlineMentionSources}
          threadCwdPath={threadCwdPath}
          projectFilePaths={projectFilePaths}
          projectId={projectId}
          projectRootPath={projectRootPath}
          workspaceRoots={workspaceRoots}
        />
      ))}
    </div>
  );

  return (
    <ThreadDisclosure
      className="py-2"
      contentClassName="mt-2 space-y-4 pl-6"
      defaultOpen={isMostRecent}
      summary={totalItems === 1 ? (<>
        <span>Reasoned: </span>
        <span className="thread-item-disclosure-prominent-text-portion font-medium text-text">{getReasoningStepTitle(visibleItems[0])}</span>
      </>) : (<>
        <span>Reasoned over </span>
        <span className="thread-item-disclosure-prominent-text-portion text-text">{totalItems}</span>
        <span> steps</span>
      </>)}
      summaryClassName="text-[0.92em] leading-[1.6] text-muted"
    >
      {content}
    </ThreadDisclosure>
  );
}

function formatThreadDetailUrlLabel(url: string) {
  try {
    const parsedUrl = new URL(url);
    const path = `${parsedUrl.pathname}${parsedUrl.search}`.replace(/\/$/, "");
    return truncateThreadText(`${parsedUrl.host}${path || ""}`, 96);
  } catch {
    return truncateThreadText(url, 96);
  }
}

function ThreadCommandDetailTargetView({ target }: { target: ThreadCommandDetailTarget }) {
  if (target.kind === "url") {
    return (
      <a
        className="min-w-0 break-all text-accent underline-offset-3 hover:underline focus-visible:underline focus-visible:outline-none"
        href={target.text}
        rel="noreferrer"
        target="_blank"
        title={target.text}
      >
        {formatThreadDetailUrlLabel(target.text)}
      </a>
    );
  }

  if (target.kind === "code") {
    return (
      <code className={`${THREAD_DETAIL_INLINE_CODE_CLASS} inline-block max-w-full overflow-hidden text-ellipsis whitespace-nowrap align-bottom`} title={target.text}>
        {target.text}
      </code>
    );
  }

  return <span className="min-w-0 break-words font-medium text-text">{target.text}</span>;
}

function ThreadCommandDetailMeta({ row }: { row: ThreadCommandDetailRow }) {
  const hasDuration = typeof row.durationMs === "number";
  const hasDetailText = Boolean(row.detailText?.trim());
  if (!hasDuration && !hasDetailText) {
    return null;
  }

  return (
    <span className="inline-flex min-w-0 max-w-full items-baseline gap-x-1.5 text-[0.78em] text-muted">
      {hasDuration ? <ThreadDurationText durationMs={row.durationMs ?? null} /> : null}
      {hasDuration && hasDetailText ? <span aria-hidden="true">·</span> : null}
      {hasDetailText ? (
        <span className="inline-flex min-w-0 max-w-full items-baseline gap-x-1">
          {row.detailLabel ? <span>{row.detailLabel}:</span> : null}
          <span
            className={`min-w-0 max-w-[36rem] truncate ${row.detailKind === "error" ? "text-danger" : "text-muted"}`}
            title={row.detailText ?? undefined}
          >
            {row.detailText}
          </span>
        </span>
      ) : null}
    </span>
  );
}

function ThreadStructuredCommandDetailRow({
  hideSharedContext,
  projectFilePaths,
  projectId,
  row,
}: {
  hideSharedContext: boolean;
  projectFilePaths?: readonly string[];
  projectId?: string | null;
  row: ThreadCommandDetailRow;
}) {
  if (!row.label && !row.target) {
    return (
      <ThreadCommandSummary
        display={{
          claimedBy: "command-detail-row",
          omitFromDisplay: false,
          shell: null,
          showShell: false,
          summaryKind: "matched",
          summaryParts: row.summaryParts,
          summaryStats: {
            deletedPaths: 0,
            gitCheckpointCreates: 0,
            gitCheckpointDiffs: 0,
            gitCheckpointRestores: 0,
            gitDiffChecks: 0,
            gitStatusChecks: 0,
            listedFiles: 0,
            otherCommands: 0,
            pathChecks: 0,
            readFiles: 0,
            searchedFiles: 0,
            skillLoads: 0,
            typescriptBuilds: 0,
            typescriptValidations: 0,
            webRequests: 0,
          },
          summaryText: "",
        }}
        projectFilePaths={projectFilePaths}
        projectId={projectId}
      />
    );
  }

  return (
    <span className="inline-flex min-w-0 max-w-full flex-wrap items-baseline gap-x-2 gap-y-1 align-bottom">
      {row.label ? <span className="shrink-0 text-muted">{row.label}</span> : null}
      {row.target ? <ThreadCommandDetailTargetView target={row.target} /> : null}
      {row.contextText && !hideSharedContext ? (
        <span className="min-w-0 text-muted">
          in <span className="font-medium text-text">{row.contextText}</span>
        </span>
      ) : null}
      <ThreadCommandDetailMeta row={row} />
    </span>
  );
}

function ThreadCommandDetailResultBlock({
  row,
}: {
  row: ThreadCommandDetailRow;
}) {
  if (!shouldRenderFramedDetailTarget(row)) {
    return null;
  }

  const output = row.detailKind === "result" && row.detailText?.trim()
    ? row.detailText
    : undefined;

  return (
    <div className="max-w-[46rem] pl-6 pt-1">
      <ThreadCodeDisplay
        header={<ThreadCommandHeader command={row.target.text} surface="framed" />}
        output={output}
        preview
        previewHeight="10rem"
        variant="plain"
      />
    </div>
  );
}

function shouldRenderFramedDetailTarget(row: ThreadCommandDetailRow) {
  return row.label === "Evaluate" && row.target?.kind === "code";
}

function hasCommandDetailResultBlock(row: ThreadCommandDetailRow) {
  return shouldRenderFramedDetailTarget(row);
}

function ThreadCommandDetailImageBlock({
  row,
}: {
  row: ThreadCommandDetailRow;
}) {
  const imageUrls = [
    ...(row.imageUrl ? [row.imageUrl] : []),
    ...(row.imageUrls ?? []),
  ].filter((imageUrl, index, values) => imageUrl && values.indexOf(imageUrl) === index);
  if (!imageUrls.length) {
    return null;
  }

  return (
    <div className="max-w-[28rem] space-y-2 pl-6 pt-1">
      {imageUrls.map((imageUrl, index) => (
        <ThreadUserImage
          alt={`${row.label ?? "Browse"} screenshot`}
          className="max-w-[28rem]"
          key={`${row.id}:image:${index}:${imageUrl}`}
          src={imageUrl}
        />
      ))}
    </div>
  );
}

function hasCommandDetailImageBlock(row: ThreadCommandDetailRow) {
  return Boolean(row.imageUrl || row.imageUrls?.length);
}

function getDetailRowSummary(row: ThreadCommandDetailRow): ThreadCommandDetailRow {
  const shouldHideCompletedWaitTarget = row.label === "Wait" && row.durationMs !== null;
  const shouldHideFramedTarget = shouldRenderFramedDetailTarget(row);
  if (!shouldHideCompletedWaitTarget && !shouldHideFramedTarget) {
    return row;
  }

  return {
    ...row,
    detailKind: shouldHideFramedTarget && row.detailKind === "result" ? undefined : row.detailKind,
    detailLabel: shouldHideFramedTarget && row.detailKind === "result" ? null : row.detailLabel,
    detailText: shouldHideFramedTarget && row.detailKind === "result" ? null : row.detailText,
    target: shouldHideCompletedWaitTarget || shouldHideFramedTarget ? null : row.target,
  };
}

function ThreadCommandDetailRows ({
  rows,
  projectFilePaths,
  projectId,
}: {
  rows: ThreadCommandDetailRow[];
  projectFilePaths?: readonly string[];
  projectId?: string | null;
}) {
  if (!rows.length) {
    return null;
  }
  const contexts = Array.from(new Set(rows.map((row) => row.contextText?.trim()).filter(Boolean)));
  const hideSharedContext = contexts.length === 1 && rows.length > 1;
  const expandableRowIndexes = rows
    .map((row, index) => hasCommandDetailResultBlock(row) || hasCommandDetailImageBlock(row) ? index : -1)
    .filter((index) => index >= 0);
  const defaultOpenRowIndex = expandableRowIndexes.find((index) => rows[index]?.state === "inProgress")
    ?? expandableRowIndexes.at(-1)
    ?? -1;

  return (
    <div className="space-y-0.5">
      {rows.map((row, index) => {
        const summary = <ThreadStructuredCommandDetailRow hideSharedContext={hideSharedContext} projectFilePaths={projectFilePaths} projectId={projectId} row={getDetailRowSummary(row)} />;
        const hasExpandableContent = hasCommandDetailResultBlock(row) || hasCommandDetailImageBlock(row);
        return (
          <div className="space-y-1" key={row.id}>
            {hasExpandableContent ? (
              <ThreadDisclosure
                className="py-1"
                contentClassName="space-y-1"
                defaultOpen={index === defaultOpenRowIndex}
                leading={renderCommandDetailStateIcon(row)}
                leadingClassName={getCommandDetailStateMarkerClassName(row)}
                leadingLabel={getCommandDetailStateLabel(row)}
                summary={summary}
                summaryClassName="text-[0.9em] leading-[1.55]"
              >
                <>
                  <ThreadCommandDetailResultBlock row={row} />
                  <ThreadCommandDetailImageBlock row={row} />
                </>
              </ThreadDisclosure>
            ) : (
          <ThreadDisclosureStaticRow
            className="py-1"
            summary={summary}
            summaryClassName="text-[0.9em] leading-[1.55]"
          />
            )}
          </div>
        );
      })}
    </div>
  );
}

function renderCommandDetailStateIcon(row: ThreadCommandDetailRow) {
  switch (row.state) {
    case "queued":
      return <ClockIcon className="size-[0.9rem]" />;
    case "inProgress":
      return <PlayIcon className="size-[0.85rem]" />;
    case "completed":
      return <CheckIcon className="size-[0.95rem]" />;
    case "failed":
      return <WarningIcon className="size-[0.95rem]" />;
    default:
      return null;
  }
}

function getCommandDetailStateMarkerClassName(row: ThreadCommandDetailRow) {
  switch (row.state) {
    case "queued":
      return "text-muted opacity-60";
    case "inProgress":
      return "text-accent";
    case "completed":
      return "text-muted";
    case "failed":
      return "text-danger";
    default:
      return undefined;
  }
}

function getCommandDetailStateLabel(row: ThreadCommandDetailRow) {
  switch (row.state) {
    case "queued":
      return "Queued";
    case "inProgress":
      return "In progress";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    default:
      return undefined;
  }
}

function getDefaultBrowseDetailRowState(
  rows: readonly ThreadCommandDetailRow[],
  outputRows: readonly Partial<ThreadCommandDetailRow>[],
  commandStatus: CommandItem["status"],
  index: number,
) {
  const explicitState = outputRows[index]?.state;
  if (explicitState) {
    return explicitState;
  }

  if (commandStatus === "completed") {
    return "completed";
  }

  if (commandStatus === "failed") {
    return index === rows.length - 1 ? "failed" : "completed";
  }

  if (commandStatus === "inProgress") {
    const activeIndex = outputRows.findIndex((row) => row.state === "inProgress");
    if (activeIndex >= 0) {
      return index < activeIndex ? "completed" : index === activeIndex ? "inProgress" : "queued";
    }

    const completedCount = outputRows.filter((row) => row.state === "completed" || row.state === "failed").length;
    return index < completedCount ? "completed" : index === completedCount ? "inProgress" : "queued";
  }

  return rows[index]?.state ?? null;
}

function mergeCommandDetailRowsWithBrowseOutput(
  rows: ThreadCommandDetailRow[] | undefined,
  output: string | null,
  browseScreenshotEntries: readonly WorkbenchBrowseScreenshotEntry[] = [],
  commandStatus: CommandItem["status"] = "completed",
) {
  if (!rows?.length) {
    return [];
  }

  const outputRows = parseBrowseSequenceCommandOutput(output);

  return rows.map((row, index) => {
    const durationMs = row.durationMs ?? outputRows[index]?.durationMs ?? null;
    const shouldSuppressDuplicateWaitDuration = row.label === "Wait"
      && row.target?.kind === "text"
      && durationMs !== null
      && formatThreadDuration(durationMs) === row.target.text;

    return {
      ...row,
      detailKind: row.detailKind ?? outputRows[index]?.detailKind,
      detailLabel: row.detailLabel ?? outputRows[index]?.detailLabel ?? null,
      detailText: row.detailText ?? outputRows[index]?.detailText ?? null,
      durationMs: shouldSuppressDuplicateWaitDuration ? null : durationMs,
      imageUrl: row.imageUrl ?? browseScreenshotEntries.find((entry) => entry.actionIndex === index)?.assetUrl ?? null,
      state: row.state ?? getDefaultBrowseDetailRowState(rows, outputRows, commandStatus, index),
    };
  });
}

function isBrowseWebRequestCommandItem({
  item,
  knownSkills,
  projectRootPath,
  workspaceRoots,
}: {
  item: CommandItem;
  knownSkills?: WorkbenchSkillSummary[];
  projectRootPath?: string;
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
}) {
  const display = getThreadCommandDisplay({
    command: item.command,
    commandActions: item.commandActions,
    cwd: item.cwd,
    knownSkills,
    projectRootPath,
    workspaceRoots,
  });
  return isBrowseWebRequestMatcherClaim(display.claimedBy);
}

function ThreadCommandExecutionDetails ({
  browseScreenshotEntries = EMPTY_BROWSE_SCREENSHOT_ENTRIES,
  isMostRecent = false,
  item,
  knownSkills,
  projectFilePaths,
  projectId,
  projectRootPath,
  threadId,
  workspaceRoots,
}: {
  browseScreenshotEntries?: readonly WorkbenchBrowseScreenshotEntry[];
  isMostRecent?: boolean;
  item: CommandItem;
  knownSkills?: WorkbenchSkillSummary[];
  projectFilePaths?: readonly string[];
  projectId?: string | null;
  projectRootPath?: string;
  threadId: string;
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
}) {
  const commandDisplay = useMemo(() => getThreadCommandDisplay({
    command: item.command,
    commandActions: item.commandActions,
    cwd: item.cwd,
    knownSkills,
    projectRootPath,
    workspaceRoots,
  }), [item.command, item.commandActions, item.cwd, knownSkills, projectRootPath, workspaceRoots]);
  const checkpointDiffChanges = isGitCheckpointDiffMatcherClaim(commandDisplay.claimedBy)
    ? parseGitCheckpointDiffOutput(item.aggregatedOutput ?? "")
    : null;
  const checkpointDiffArtifactId = isGitCheckpointDiffMatcherClaim(commandDisplay.claimedBy)
    ? parseGitCheckpointDiffArtifactId(item.aggregatedOutput ?? "")
    : null;
  const shouldRenderCheckpointDiff = checkpointDiffChanges !== null
    && (!item.aggregatedOutput?.trim() || Boolean(checkpointDiffArtifactId) || checkpointDiffChanges.length > 0);
  const commandDetailRows = useMemo(() => (
    isBrowseWebRequestMatcherClaim(commandDisplay.claimedBy)
      ? mergeCommandDetailRowsWithBrowseOutput(
        commandDisplay.detailRows,
        item.aggregatedOutput,
        browseScreenshotEntries.filter((entry) => entry.commandItemId === item.id),
        item.status,
      )
      : commandDisplay.detailRows ?? []
  ), [browseScreenshotEntries, commandDisplay.claimedBy, commandDisplay.detailRows, item.aggregatedOutput, item.id, item.status]);
  const metaParts = [];

  if (item.status !== "completed") {
    metaParts.push(
      <ThreadSummaryText
        key={`${item.id}:status`}
        text={humanizeThreadLabel(item.status)}
      />,
    );
  }

  if (item.exitCode !== null && item.exitCode !== 0) {
    metaParts.push(
      <ThreadSummaryText
        key={`${item.id}:exit`}
        text={`exit ${item.exitCode}`}
      />,
    );
  }

  if (item.durationMs !== null) {
    metaParts.push(
      <ThreadDurationText
        key={`${item.id}:duration`}
        durationMs={item.durationMs}
      />,
    );
  }

  return (
    <ThreadDisclosure
      className="py-2"
      contentClassName="mt-2 space-y-2 pl-6"
      defaultOpen={isMostRecent}
      summary={(
        <>
          <ThreadCommandSummary display={commandDisplay} projectFilePaths={projectFilePaths} projectId={projectId} />
          {metaParts.length ? (
            <span className="ml-2 text-[0.78em] text-muted">
              {metaParts.map((part, index) => (
                <span key={`${item.id}:meta:${index}`}>
                  {index ? <span className="text-muted"> | </span> : null}
                  {part}
                </span>
              ))}
            </span>
          ) : null}
        </>
      )}
      summaryClassName="text-[0.92em] leading-[1.6] text-muted"
    >
      <>
        {/*commandDisplay.showShell && commandDisplay.shell ? (
          <p className="m-0 text-[0.78em] leading-[1.6] text-muted">
            Shell: <span className="font-mono text-text">{commandDisplay.shell}</span>
          </p>
        ) : null*/}
        {commandDisplay.cwdDisplay && !commandDisplay.hideCommandCwd ? (
          <p className="m-0 text-[0.78em] leading-[1.6] text-muted">
            Working dir: <span className="break-all font-mono text-text">{commandDisplay.cwdDisplay}</span>
          </p>
        ) : null}
        {commandDetailRows.length ? (
          <ThreadCommandDetailRows
            rows={commandDetailRows}
            projectFilePaths={projectFilePaths}
            projectId={projectId}
          />
        ) : null}
        {commandDisplay.hideCommandOutput ? null : shouldRenderCheckpointDiff ? (
          <ThreadCheckpointDiffItem
            cwd={item.cwd}
            output={item.aggregatedOutput ?? ""}
            projectFilePaths={projectFilePaths}
            projectId={projectId}
            projectRootPath={projectRootPath}
            sourceItemId={item.id}
            threadId={threadId}
            workspaceRoots={workspaceRoots}
          />
        ) : item.aggregatedOutput?.trim() ? (
          <ThreadCodeDisplay
            header={<ThreadCommandHeader command={item.command} surface="framed" />}
            output={item.aggregatedOutput.trim()}
            preview
            variant="plain"
          />
        ) : (
          <ThreadCodeDisplay
            header={<ThreadCommandHeader command={item.command} surface="framed" />}
            preview
            variant="plain"
          />
        )}
      </>
    </ThreadDisclosure>
  );
}

function ThreadCommandSequence ({
  browseScreenshotEntries = EMPTY_BROWSE_SCREENSHOT_ENTRIES,
  isMostRecent,
  items,
  knownSkills,
  projectFilePaths,
  projectId,
  projectRootPath,
  threadId,
  workspaceRoots,
}: {
  browseScreenshotEntries?: readonly WorkbenchBrowseScreenshotEntry[];
  isMostRecent: boolean;
  items: CommandItem[];
  knownSkills?: WorkbenchSkillSummary[];
  projectFilePaths?: readonly string[];
  projectId?: string | null;
  projectRootPath?: string;
  threadId: string;
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
}) {
  const allBrowseRequests = useMemo(() => {
    if (items.length <= 1) {
      return false;
    }

    return items.every((item) => isBrowseWebRequestCommandItem({
      item,
      knownSkills,
      projectRootPath,
      workspaceRoots,
    }));
  }, [items, knownSkills, projectRootPath, workspaceRoots]);
  const commandBlockItems = useMemo(() => items.map((item) => ({
    command: item.command,
    commandActions: item.commandActions,
    cwd: item.cwd,
  })), [items]);
  const commandBlockDisplay = useMemo(() => {
    if (items.length <= 1 || allBrowseRequests) {
      return null;
    }

    return getThreadCommandBlockDisplay({
      items: commandBlockItems,
      knownSkills,
      projectRootPath,
      workspaceRoots,
    });
  }, [allBrowseRequests, commandBlockItems, items.length, knownSkills, projectRootPath, workspaceRoots]);

  if (items.length === 1) {
    return <ThreadCommandExecutionDetails browseScreenshotEntries={browseScreenshotEntries} isMostRecent={isMostRecent} item={items[0]} knownSkills={knownSkills} projectFilePaths={projectFilePaths} projectId={projectId} projectRootPath={projectRootPath} threadId={threadId} workspaceRoots={workspaceRoots} />;
  }

  if (allBrowseRequests) {
    return (
      <div className="space-y-1">
        {items.map((item, index) => (
          <ThreadCommandExecutionDetails
            browseScreenshotEntries={browseScreenshotEntries}
            isMostRecent={isMostRecent && index === items.length - 1}
            item={item}
            key={item.id}
            knownSkills={knownSkills}
            projectFilePaths={projectFilePaths}
            projectId={projectId}
            projectRootPath={projectRootPath}
            threadId={threadId}
            workspaceRoots={workspaceRoots}
          />
        ))}
      </div>
    );
  }

  if (!commandBlockDisplay) {
    return null;
  }

  return (
    <ThreadDisclosure
      className="py-2"
      contentClassName="mt-2 space-y-1 pl-6"
      defaultOpen={isMostRecent}
      summary={<ThreadCommandSummary display={commandBlockDisplay} projectFilePaths={projectFilePaths} projectId={projectId} />}
      summaryClassName="text-[0.92em] leading-[1.6] text-muted"
    >
      <>
        {items.map((item, index) => (
          <ThreadCommandExecutionDetails
            browseScreenshotEntries={browseScreenshotEntries}
            isMostRecent={isMostRecent && index === items.length - 1}
            item={item}
            key={item.id}
            knownSkills={knownSkills}
            projectFilePaths={projectFilePaths}
            projectId={projectId}
            projectRootPath={projectRootPath}
            threadId={threadId}
            workspaceRoots={workspaceRoots}
          />
        ))}
      </>
    </ThreadDisclosure>
  );
}

function ThreadFallbackItem ({ item }: { item: NonGroupedItem }) {
  return (
    <ThreadDisclosure
      className="py-2"
      contentClassName="mt-2 pl-6"
      summary={<ThreadSummaryText text={item.type} />}
      summaryClassName="text-[0.92em] leading-[1.6] text-muted"
    >
      <pre className="m-0 max-w-full overflow-x-auto whitespace-pre rounded-[0.9rem] bg-[color-mix(in_srgb,var(--text)_4%,transparent)] px-4 py-3 font-mono text-[0.78em] leading-[1.6] text-text">
        {JSON.stringify(item, null, 2)}
      </pre>
    </ThreadDisclosure>
  );
}

function ThreadRenderableBlockViewComponent ({
  block,
  browseScreenshotEntries,
  finalAgentMessageId,
  inlineMentionSources,
  isMostRecentBlock,
  knownSkills,
  primaryUserBlock,
  threadCwdPath,
  threadId,
  projectFilePaths,
  projectId,
  projectRootPath,
  relatedThreadsById,
  turnCompletedAt,
  turnStartedAt,
  turnStatus,
  workspaceRoots,
}: {
  block: ThreadRenderableBlock;
  browseScreenshotEntries?: readonly WorkbenchBrowseScreenshotEntry[];
  finalAgentMessageId: string | null;
  inlineMentionSources?: InlineMentionHighlightSources | null;
  isMostRecentBlock: boolean;
  knownSkills?: WorkbenchSkillSummary[];
  primaryUserBlock: ThreadRenderableBlock | null;
  threadCwdPath?: string;
  threadId: string;
  projectFilePaths?: readonly string[];
  projectId?: string | null;
  projectRootPath?: string;
  relatedThreadsById: RelatedThreadsById;
  turnCompletedAt: number | null;
  turnStartedAt: number | null;
  turnStatus: Turn["status"];
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
}) {
  if (block.kind === "commandSequence") {
    return <ThreadCommandSequence browseScreenshotEntries={browseScreenshotEntries} isMostRecent={isMostRecentBlock} items={block.items} knownSkills={knownSkills} projectFilePaths={projectFilePaths} projectId={projectId} projectRootPath={projectRootPath} threadId={threadId} workspaceRoots={workspaceRoots} />;
  }

  if (block.kind === "fileChangeSequence") {
    return <ThreadFileChangeItem items={block.items} projectFilePaths={projectFilePaths} projectId={projectId} projectRootPath={projectRootPath} workspaceRoots={workspaceRoots} />;
  }

  if (block.kind === "reasoningSequence") {
    return (
      <ThreadReasoningSequence
        block={block}
        inlineMentionSources={inlineMentionSources}
        isMostRecent={isMostRecentBlock}
        projectFilePaths={projectFilePaths}
        projectId={projectId}
        threadCwdPath={threadCwdPath}
        projectRootPath={projectRootPath}
        workspaceRoots={workspaceRoots}
      />
    );
  }

  if (block.kind === "webSearchSequence") {
    return <ThreadWebSearchSequence items={block.items} />;
  }

  switch (block.item.type) {
    case "userMessage":
      return (
        <ThreadUserMessageItem
          item={block.item}
          inlineMentionSources={inlineMentionSources}
          projectFilePaths={projectFilePaths}
          projectId={projectId}
          threadCwdPath={threadCwdPath}
          projectRootPath={projectRootPath}
          workspaceRoots={workspaceRoots}
          showStartedAt={block === primaryUserBlock}
          startedAt={turnStartedAt}
        />
      );
    case "agentMessage":
      return (
        <ThreadAgentMessageItem
          completedAt={turnCompletedAt}
          isFinal={block.item.id === finalAgentMessageId}
          item={block.item}
          inlineMentionSources={inlineMentionSources}
          projectFilePaths={projectFilePaths}
          projectId={projectId}
          threadCwdPath={threadCwdPath}
          projectRootPath={projectRootPath}
          workspaceRoots={workspaceRoots}
        />
      );
    case "plan":
      return (
        <ThreadPlanItem
          inlineMentionSources={inlineMentionSources}
          item={block.item}
          threadCwdPath={threadCwdPath}
          projectFilePaths={projectFilePaths}
          projectId={projectId}
          projectRootPath={projectRootPath}
          workspaceRoots={workspaceRoots}
        />
      );
    case "contextCompaction":
      return <ThreadContextCompactionItem isActive={turnStatus === "inProgress"} item={block.item} />;
    case "mcpToolCall":
      return <ThreadMcpToolCallItem item={block.item} />;
    case "dynamicToolCall":
      return <ThreadDynamicToolCallItem inlineMentionSources={inlineMentionSources} item={block.item} threadCwdPath={threadCwdPath} projectFilePaths={projectFilePaths} projectId={projectId} projectRootPath={projectRootPath} workspaceRoots={workspaceRoots} />;
    case "webSearch":
      return <ThreadWebSearchItem item={block.item} />;
    case "collabAgentToolCall":
      return (
        <ThreadCollabAgentToolCallItem
          isMostRecent={isMostRecentBlock}
          inlineMentionSources={inlineMentionSources}
          item={block.item}
          knownSkills={knownSkills}
          threadCwdPath={threadCwdPath}
          projectFilePaths={projectFilePaths}
          projectId={projectId}
          projectRootPath={projectRootPath}
          relatedThreadsById={relatedThreadsById}
          workspaceRoots={workspaceRoots}
        />
      );
    default:
      return <ThreadFallbackItem item={block.item} />;
  }
}

const ThreadRenderableBlockView = memo(ThreadRenderableBlockViewComponent, (left, right) => (
  left.block === right.block
  && left.browseScreenshotEntries === right.browseScreenshotEntries
  && left.finalAgentMessageId === right.finalAgentMessageId
  && (left.inlineMentionSources?.cacheKey ?? "") === (right.inlineMentionSources?.cacheKey ?? "")
  && left.isMostRecentBlock === right.isMostRecentBlock
  && left.knownSkills === right.knownSkills
  && left.primaryUserBlock === right.primaryUserBlock
  && left.threadCwdPath === right.threadCwdPath
  && left.threadId === right.threadId
  && left.projectFilePaths === right.projectFilePaths
  && left.projectId === right.projectId
  && left.projectRootPath === right.projectRootPath
  && left.relatedThreadsById === right.relatedThreadsById
  && left.turnCompletedAt === right.turnCompletedAt
  && left.turnStartedAt === right.turnStartedAt
  && left.turnStatus === right.turnStatus
  && left.workspaceRoots === right.workspaceRoots
));

function ThreadTurnDetailsComponent ({
  browseScreenshotEntries = EMPTY_BROWSE_SCREENSHOT_ENTRIES,
  flattenCompletedWork = false,
  hiddenCollabAgentToolCallItemIds = [],
  hiddenDynamicToolCallItemIds = [],
  hideFinalAgentMessage = false,
  hideTopBorder = false,
  hideWorkbenchControlAgentMessages = false,
  hideWorkbenchControlUserMessages = false,
  hiddenReasoningItemId = null,
  hiddenWebSearchItemIds = [],
  inlineMentionSources = null,
  itemTimeline = [],
  knownSkills = [],
  threadCwdPath,
  threadId,
  projectFilePaths,
  projectId,
  projectRootPath,
  relatedThreadsById = {},
  turn,
  workspaceRoots,
}: {
  browseScreenshotEntries?: readonly WorkbenchBrowseScreenshotEntry[];
  flattenCompletedWork?: boolean;
  hiddenCollabAgentToolCallItemIds?: readonly string[];
  hiddenDynamicToolCallItemIds?: readonly string[];
  hideFinalAgentMessage?: boolean;
  hideTopBorder?: boolean;
  hideWorkbenchControlAgentMessages?: boolean;
  hideWorkbenchControlUserMessages?: boolean;
  hiddenReasoningItemId?: string | null;
  hiddenWebSearchItemIds?: readonly string[];
  inlineMentionSources?: InlineMentionHighlightSources | null;
  itemTimeline?: readonly WorkbenchThreadItemTimelineEntry[];
  knownSkills?: WorkbenchSkillSummary[];
  threadCwdPath?: string;
  threadId: string;
  projectFilePaths?: readonly string[];
  projectId?: string | null;
  projectRootPath?: string;
  relatedThreadsById?: RelatedThreadsById;
  turn: Turn;
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
}) {
  const hiddenCollabAgentToolCallIds = useMemo(() => (
    hiddenCollabAgentToolCallItemIds.length
      ? new Set(hiddenCollabAgentToolCallItemIds)
      : null
  ), [hiddenCollabAgentToolCallItemIds]);
  const hiddenDynamicToolCallIds = useMemo(() => (
    hiddenDynamicToolCallItemIds.length
      ? new Set(hiddenDynamicToolCallItemIds)
      : null
  ), [hiddenDynamicToolCallItemIds]);
  const hiddenWebSearchIds = useMemo(() => (
    hiddenWebSearchItemIds.length
      ? new Set(hiddenWebSearchItemIds)
      : null
  ), [hiddenWebSearchItemIds]);
  const isWorkbenchControlTurn = useMemo(() => (
    turn.items.some((item) => item.type === "userMessage" && isWorkbenchControlUserMessage(item))
  ), [turn.items]);
  const hiddenItemIds = useMemo(() => ({
    collabAgentToolCallIds: hiddenCollabAgentToolCallIds,
    controlAgentMessages: hideWorkbenchControlAgentMessages && isWorkbenchControlTurn,
    controlUserMessages: hideWorkbenchControlUserMessages,
    dynamicToolCallIds: hiddenDynamicToolCallIds,
    reasoningItemId: hiddenReasoningItemId,
    webSearchItemIds: hiddenWebSearchIds,
  } satisfies HiddenThreadItemIds), [
    hiddenCollabAgentToolCallIds,
    hiddenDynamicToolCallIds,
    hiddenReasoningItemId,
    hiddenWebSearchIds,
    hideWorkbenchControlAgentMessages,
    hideWorkbenchControlUserMessages,
    isWorkbenchControlTurn,
  ]);
  const finalAgentMessageId = useMemo(() => getFinalAgentMessageId(turn), [turn.items]);
  const isCompleted = turn.status === "completed";
  const primaryUserItem = useMemo(() => (
    turn.items.find((item) => item.type === "userMessage") ?? null
  ), [turn.items]);
  const finalAgentItem = useMemo(() => (
    finalAgentMessageId
      ? turn.items.find((item) => item.id === finalAgentMessageId) ?? null
      : null
  ), [finalAgentMessageId, turn.items]);
  const pinnedCompactionItemIds = useMemo(() => new Set([
    primaryUserItem?.id,
    hideFinalAgentMessage ? null : finalAgentItem?.id,
  ].filter((itemId): itemId is string => Boolean(itemId))), [finalAgentItem?.id, hideFinalAgentMessage, primaryUserItem?.id]);
  const compactionRenderPlan = useMemo(() => createThreadTurnCompactionRenderPlan({
    itemTimeline,
    items: turn.items,
    pinnedItemIds: pinnedCompactionItemIds,
  }), [itemTimeline, pinnedCompactionItemIds, turn.items]);
  const turnBrowseScreenshotEntries = browseScreenshotEntries;
  const renderableBlocks = useMemo(() => buildRenderableBlocks(turn.items, hiddenItemIds), [hiddenItemIds, turn.items]);
  const allBlocks = useStableRenderableBlocks(renderableBlocks);

  const renderBlock = (
    block: ThreadRenderableBlock,
    index: number,
    blockList: ThreadRenderableBlock[],
    primaryUserBlock: ThreadRenderableBlock | null,
  ) => (
    <ThreadRenderableBlockView
      key={block.kind === "commandSequence"
        ? `commands:${block.items[0]?.id ?? index}`
        : block.kind === "fileChangeSequence"
          ? `fileChanges:${block.items[0]?.id ?? index}`
          : block.kind === "reasoningSequence"
            ? `reasoning:${block.items[0]?.id ?? index}`
            : block.kind === "webSearchSequence"
              ? `webSearches:${block.items[0]?.id ?? index}`
              : `item:${block.item.id}`}
      block={block}
      browseScreenshotEntries={turnBrowseScreenshotEntries}
      finalAgentMessageId={finalAgentMessageId}
      inlineMentionSources={inlineMentionSources}
      isMostRecentBlock={block === blockList[blockList.length - 1]}
      knownSkills={knownSkills}
      primaryUserBlock={primaryUserBlock}
      threadCwdPath={threadCwdPath}
      threadId={threadId}
      projectFilePaths={projectFilePaths}
      projectId={projectId}
      projectRootPath={projectRootPath}
      relatedThreadsById={relatedThreadsById}
      turnCompletedAt={turn.completedAt}
      turnStartedAt={turn.startedAt}
      turnStatus={turn.status}
      workspaceRoots={workspaceRoots}
    />
  );

  const buildBlocksForItems = (items: ThreadItem[]) => buildRenderableBlocks(items, hiddenItemIds);
  const renderBlocks = (
    blocks: ThreadRenderableBlock[],
    primaryUserBlock: ThreadRenderableBlock | null,
  ) => blocks.map((block, index) => renderBlock(block, index, blocks, primaryUserBlock));
  const renderItems = (
    items: ThreadItem[],
    primaryUserBlock: ThreadRenderableBlock | null,
  ) => renderBlocks(buildBlocksForItems(items), primaryUserBlock);

  if (compactionRenderPlan) {
    const primaryUserBlocks = primaryUserItem ? buildBlocksForItems([primaryUserItem]) : [];
    const primaryUserBlock = primaryUserBlocks.find((block) => isUserMessageBlock(block)) ?? null;
    const finalAgentBlocks = isCompleted && finalAgentItem && !hideFinalAgentMessage
      ? buildBlocksForItems([finalAgentItem]).filter((block) => isFinalAgentMessageBlock(block, finalAgentMessageId))
      : [];
    const hasWorkedContent = Boolean(compactionRenderPlan.collapsedEarlierSection || compactionRenderPlan.visibleItems.length);
    if (isCompleted && hideFinalAgentMessage && hideWorkbenchControlUserMessages && !primaryUserBlock && !hasWorkedContent && !finalAgentBlocks.length) {
      return null;
    }

    const renderCollapsedEarlierSection = () => {
      const collapsedSection = compactionRenderPlan.collapsedEarlierSection;
      if (!collapsedSection) {
        return null;
      }

      return (
        <ThreadDisclosure
          key={collapsedSection.id}
          className="py-2"
          contentClassName="mt-2 space-y-2 pl-6"
          renderContent={() => (
            <div className="space-y-2">
              {renderItems(collapsedSection.items, primaryUserBlock)}
            </div>
          )}
          summary={getWorkedSummaryForDuration(collapsedSection.durationMs)}
          summaryClassName="text-[0.92em] leading-[1.6] text-muted"
        />
      );
    };

    const renderCompactionWorkContent = () => {
      const visibleWorkBlocks = buildBlocksForItems(compactionRenderPlan.visibleItems);
      return (
        <div className="space-y-2">
          {renderCollapsedEarlierSection()}
          {visibleWorkBlocks.length ? renderBlocks(visibleWorkBlocks, primaryUserBlock) : null}
          {!compactionRenderPlan.collapsedEarlierSection && !visibleWorkBlocks.length ? (
            <p className="m-0 text-[0.92em] leading-[1.6] text-muted">No intermediate work captured.</p>
          ) : null}
        </div>
      );
    };

    return (
      <section className={hideTopBorder ? "py-3" : "border-t border-[color-mix(in_srgb,var(--text)_10%,transparent)] py-3"}>
        {isCompleted && flattenCompletedWork ? (
          <div className="space-y-2">
            {primaryUserBlock ? renderBlock(primaryUserBlock, 0, primaryUserBlocks, primaryUserBlock) : null}
            {renderCompactionWorkContent()}
            {renderBlocks(finalAgentBlocks, primaryUserBlock)}
          </div>
        ) : isCompleted ? (
          <div className="space-y-2">
            {primaryUserBlock ? renderBlock(primaryUserBlock, 0, primaryUserBlocks, primaryUserBlock) : null}
            <ThreadDisclosure
              className="py-2"
              contentClassName="mt-2 space-y-2 pl-6"
              renderContent={renderCompactionWorkContent}
              summary={getWorkedSummary(turn)}
              summaryClassName="text-[0.92em] leading-[1.6] text-muted"
            />
            {renderBlocks(finalAgentBlocks, primaryUserBlock)}
          </div>
        ) : (
          <div className="space-y-2">
            {primaryUserBlock ? renderBlock(primaryUserBlock, 0, primaryUserBlocks, primaryUserBlock) : null}
            {hasWorkedContent ? renderCompactionWorkContent() : null}
          </div>
        )}
      </section>
    );
  }

  if (isCompleted && !flattenCompletedWork) {
    const primaryUserBlocks = primaryUserItem ? buildBlocksForItems([primaryUserItem]) : [];
    const primaryUserBlock = primaryUserBlocks.find((block) => isUserMessageBlock(block)) ?? null;
    const finalAgentBlocks = finalAgentItem && !hideFinalAgentMessage
      ? buildBlocksForItems([finalAgentItem]).filter((block) => isFinalAgentMessageBlock(block, finalAgentMessageId))
      : [];
    const completedPinnedItemIds = new Set([
      primaryUserItem?.id,
      finalAgentItem?.id,
    ].filter((itemId): itemId is string => Boolean(itemId)));
    const workedItems = turn.items.filter((item) => !completedPinnedItemIds.has(item.id));
    if (hideFinalAgentMessage && hideWorkbenchControlUserMessages && !primaryUserBlock && !workedItems.length && !finalAgentBlocks.length) {
      return null;
    }

    const renderCompletedWorkedContent = () => {
      const workedBlocks = buildBlocksForItems(workedItems);
      return (
        <div className="space-y-2">
          {workedBlocks.length ? renderBlocks(workedBlocks, primaryUserBlock) : (
            <p className="m-0 text-[0.92em] leading-[1.6] text-muted">No intermediate work captured.</p>
          )}
        </div>
      );
    };

    return (
      <section className={hideTopBorder ? "py-3" : "border-t border-[color-mix(in_srgb,var(--text)_10%,transparent)] py-3"}>
        <div className="space-y-2">
          {primaryUserBlock ? renderBlock(primaryUserBlock, 0, primaryUserBlocks, primaryUserBlock) : null}
          <ThreadDisclosure
            className="py-2"
            contentClassName="mt-2 space-y-2 pl-6"
            renderContent={renderCompletedWorkedContent}
            summary={getWorkedSummary(turn)}
            summaryClassName="text-[0.92em] leading-[1.6] text-muted"
          />
          {renderBlocks(finalAgentBlocks, primaryUserBlock)}
        </div>
      </section>
    );
  }

  const blocks = allBlocks;
  const primaryUserBlock = isCompleted
    ? blocks.find((block) => isUserMessageBlock(block)) ?? null
    : null;
  const finalAgentBlocks = isCompleted
    ? hideFinalAgentMessage ? [] : blocks.filter((block) => isFinalAgentMessageBlock(block, finalAgentMessageId))
    : [];
  const workedBlocks = isCompleted
    ? blocks.filter((block) => block !== primaryUserBlock && !isFinalAgentMessageBlock(block, finalAgentMessageId))
    : blocks;
  if (isCompleted && hideFinalAgentMessage && hideWorkbenchControlUserMessages && !primaryUserBlock && !workedBlocks.length && !finalAgentBlocks.length) {
    return null;
  }

  return (
    <section className={hideTopBorder ? "py-3" : "border-t border-[color-mix(in_srgb,var(--text)_10%,transparent)] py-3"}>
      {isCompleted && flattenCompletedWork ? (
        <div className="space-y-2">
          {primaryUserBlock ? renderBlock(primaryUserBlock, 0, blocks, primaryUserBlock) : null}
          {renderBlocks(workedBlocks, primaryUserBlock)}
          {renderBlocks(finalAgentBlocks, primaryUserBlock)}
        </div>
      ) : (
        <div className="space-y-2">
          {/* <p className="m-0 text-[0.67em] uppercase tracking-[0.18em] text-muted">
            {humanizeThreadLabel(turn.status)}
          </p> */}
          {workedBlocks.length ? renderBlocks(workedBlocks, primaryUserBlock) : (
            <></> // <p className="m-0 text-[0.92em] leading-[1.6] text-muted">No captured items.</p>
          )}
        </div>
      )}
    </section>
  );
}

function areThreadTurnDetailsPropsEqual (
  left: Readonly<Parameters<typeof ThreadTurnDetailsComponent>[0]>,
  right: Readonly<Parameters<typeof ThreadTurnDetailsComponent>[0]>,
) {
  return left.turn === right.turn
    && left.flattenCompletedWork === right.flattenCompletedWork
    && left.hiddenCollabAgentToolCallItemIds === right.hiddenCollabAgentToolCallItemIds
    && left.hiddenDynamicToolCallItemIds === right.hiddenDynamicToolCallItemIds
    && left.hideFinalAgentMessage === right.hideFinalAgentMessage
    && left.hideTopBorder === right.hideTopBorder
    && left.hideWorkbenchControlAgentMessages === right.hideWorkbenchControlAgentMessages
    && left.hideWorkbenchControlUserMessages === right.hideWorkbenchControlUserMessages
    && left.hiddenReasoningItemId === right.hiddenReasoningItemId
    && left.hiddenWebSearchItemIds === right.hiddenWebSearchItemIds
    && left.browseScreenshotEntries === right.browseScreenshotEntries
    && left.inlineMentionSources === right.inlineMentionSources
    && left.itemTimeline === right.itemTimeline
    && left.knownSkills === right.knownSkills
    && left.threadCwdPath === right.threadCwdPath
    && left.threadId === right.threadId
    && left.projectFilePaths === right.projectFilePaths
    && left.projectId === right.projectId
    && left.projectRootPath === right.projectRootPath
    && left.relatedThreadsById === right.relatedThreadsById;
}

export const ThreadTurnDetails = memo(ThreadTurnDetailsComponent, areThreadTurnDetailsPropsEqual);

export function ThreadThreadContent ({
  browseScreenshotEntries = EMPTY_BROWSE_SCREENSHOT_ENTRIES,
  emptyMessage = "No subagent activity was captured yet.",
  flattenCompletedWork = false,
  hiddenCollabAgentToolCallItemIds = [],
  hiddenDynamicToolCallItemIds = [],
  hideFinalAgentMessage = false,
  hideFirstTurnTopBorder = false,
  hideWorkbenchControlAgentMessages = false,
  hideWorkbenchControlUserMessages = false,
  hiddenReasoningItemId = null,
  hiddenWebSearchItemIds = [],
  inlineMentionSources = null,
  knownSkills = [],
  threadCwdPath,
  projectFilePaths,
  projectId,
  projectRoots,
  projectRootPath,
  relatedThreadsById = {},
  thread,
}: {
  browseScreenshotEntries?: readonly WorkbenchBrowseScreenshotEntry[];
  emptyMessage?: string;
  flattenCompletedWork?: boolean;
  hiddenCollabAgentToolCallItemIds?: readonly string[];
  hiddenDynamicToolCallItemIds?: readonly string[];
  hideFinalAgentMessage?: boolean;
  hideFirstTurnTopBorder?: boolean;
  hideWorkbenchControlAgentMessages?: boolean;
  hideWorkbenchControlUserMessages?: boolean;
  hiddenReasoningItemId?: string | null;
  hiddenWebSearchItemIds?: readonly string[];
  inlineMentionSources?: InlineMentionHighlightSources | null;
  knownSkills?: WorkbenchSkillSummary[];
  threadCwdPath?: string;
  projectFilePaths?: readonly string[];
  projectId?: string | null;
  projectRoots?: readonly { id: string; rootPath: string }[];
  projectRootPath?: string;
  relatedThreadsById?: RelatedThreadsById;
  thread: ThreadPayload | null | undefined;
}) {
  const browseScreenshotEntriesByTurnId = useStableBrowseScreenshotEntriesByTurn(browseScreenshotEntries);

  if (!thread) {
    return <ThreadContentLoadingSkeleton />;
  }

  if (!thread.turns.length) {
    const unloadedEntry = thread.turnHistory.find((entry) => entry.loadState !== "loaded");
    if (unloadedEntry) {
      return <ThreadTurnLoadingSkeleton entry={unloadedEntry} />;
    }

    return (
      <p className="m-0 text-[0.92em] leading-[1.6] text-muted">
        {emptyMessage}
      </p>
    );
  }

  const loadedTurnsById = new Map(thread.turns.map((turn) => [turn.id, turn]));
  const visibleEntries = (thread.turnHistory.length ? thread.turnHistory : thread.turns.map((turn) => ({
    completedAt: turn.completedAt,
    durationMs: turn.durationMs,
    itemCount: turn.items.length,
    itemIds: turn.items.map((item) => item.id),
    itemTimeline: undefined,
    loadState: "loaded" as const,
    startedAt: turn.startedAt,
    status: turn.status,
    turnId: turn.id,
  }))).filter((entry) => loadedTurnsById.has(entry.turnId) || entry.loadState !== "loaded").slice(-4);

  return (
    <>
      {visibleEntries.map((entry, index) => {
        const turn = loadedTurnsById.get(entry.turnId);
        return turn ? (
          <ThreadTurnDetails
            key={entry.turnId}
            browseScreenshotEntries={browseScreenshotEntriesByTurnId.get(entry.turnId) ?? EMPTY_BROWSE_SCREENSHOT_ENTRIES}
            flattenCompletedWork={flattenCompletedWork}
            hiddenCollabAgentToolCallItemIds={hiddenCollabAgentToolCallItemIds}
            hiddenDynamicToolCallItemIds={hiddenDynamicToolCallItemIds}
            hideFinalAgentMessage={hideFinalAgentMessage}
            hideTopBorder={hideFirstTurnTopBorder && index === 0}
            hideWorkbenchControlAgentMessages={hideWorkbenchControlAgentMessages}
            hideWorkbenchControlUserMessages={hideWorkbenchControlUserMessages}
            hiddenReasoningItemId={hiddenReasoningItemId}
            hiddenWebSearchItemIds={hiddenWebSearchItemIds}
            inlineMentionSources={inlineMentionSources}
            itemTimeline={entry.itemTimeline}
            knownSkills={knownSkills}
            threadCwdPath={threadCwdPath ?? thread.cwd}
            threadId={thread.id}
            projectFilePaths={projectFilePaths}
            projectId={projectId}
            projectRootPath={projectRootPath}
            relatedThreadsById={relatedThreadsById}
            turn={turn}
            workspaceRoots={projectRoots}
          />
        ) : (
          <ThreadTurnLoadingSkeleton key={entry.turnId} entry={entry} />
        );
      })}
    </>
  );
}
