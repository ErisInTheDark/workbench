/*
 * Keywords: transcript rendering, grouping, incoming agent, native output, hidden skill transport.
 * Exports:
 * - ThreadTranscriptItemDetails: render one provider or relational transcript item with the established item UI. Keywords: workbench, transcript, comparison, item.
 * - ThreadTranscriptItemsDetails: render adjacent provider or relational items through shared command and reasoning grouping. Keywords: workbench, transcript, grouping, items.
 * - ThreadTurnDetails: render one thread turn with grouped commands and typed item sections. Keywords: workbench, thread, turn.
 * - ThreadThreadContent: render all turns for one thread payload without composer chrome. Keywords: workbench, thread, subagent, preview.
 * - ThreadTurnLoadingSkeleton: render a lightweight placeholder for unloaded lazy-history turns. Keywords: workbench, thread, lazy history, skeleton.
 * - ThreadTurnLoadFailure: render an explicit retry surface for a failed lazy-history read. Keywords: workbench, thread, lazy history, retry.
 * - Local helpers: summarize inputs, group command, reasoning, file, and web-search sequences, and render the supported thread item variants. Keywords: thread items, command sequence, reasoning, rendering.
 * - Refresh boundary: keep runtime exports component-only; reusable hooks and helpers belong in focused modules. Keywords: React Refresh, HMR, boundary.
 */
"use client";

import { memo, useEffect, useMemo, useRef, type ReactNode } from "react";

import type { ThreadItem } from "workbench-shared/codex/generated/app-server/v2/ThreadItem";
import type { Turn } from "workbench-shared/codex/generated/app-server/v2/Turn";
import type { UserInput } from "workbench-shared/codex/generated/app-server/v2/UserInput";
import { getCodexTranscriptAssetUrl } from "workbench-shared/codex/config";
import { getCurrentTurn } from "workbench-shared/codex/thread-state";
import type { ThreadPayload, WorkbenchBrowseResultEntry, WorkbenchSkillSummary, WorkbenchSubagentSummary, WorkbenchThreadTurnHistoryEntry } from "workbench-shared/types";
import {
  findWorkbenchThreadItemTimelineEntry,
  type WorkbenchThreadItemTimelineEntry,
} from "workbench-shared/workbench/thread/thread-item-timeline";
import type { WorkbenchThreadRecallOutputRecord } from "../../../workbench/thread/thread-recall-output";
import { getThreadItemsRenderChunkSignature } from "../../../workbench/thread/thread-item-signature";
import type { WorkspaceFileLinkRoot } from "../../../workbench/markdown/markdown-links";
import type {
  WorkbenchProjectedInteractionItem,
  WorkbenchProjectedTranscriptItem,
  WorkbenchProjectedUnknownItem,
} from "workbench-shared/workbench/transcript/workbench-transcript-projection";
import type { InlineMentionHighlightSources } from "../../../workbench/thread/inline-mention-highlights";
import type { ThreadTextPresentationSource } from "../../../workbench/thread/ThreadTextPresentationController";
import {
  isSyntheticQuestionnaireHistoryItem,
  WORKBENCH_QUESTIONNAIRE_TOOL_NAME,
} from "workbench-shared/workbench/thread/thread-questionnaire-history";

import {
  getAgentScreenshotSteerImages,
  isAgentScreenshotSteerUserMessage,
} from "workbench-shared/workbench/thread/thread-steer-markers";
import { isWorkbenchPendingSteerUserMessage } from "workbench-shared/workbench/thread/thread-steer-history";
import { readWorkbenchAgentMessageInput } from "workbench-shared/workbench/thread/thread-agent-message";
import { isWorkbenchActivatedSkillsInput } from "workbench-shared/workbench/thread/thread-activated-skills";
import { readWorkbenchToolOutput } from "workbench-shared/workbench/thread/thread-tool-output";
import { isWorkbenchHiddenSystemSteerInput } from "workbench-shared/workbench/thread/thread-recovery-message";
import { unwrapWorkbenchSteerDisplayInput } from "workbench-shared/workbench/thread/thread-steer-display";
import {
  getThreadCommandBlockDisplay,
  getThreadCommandDisplay,
  getThreadCommandExecutionOutcome,
  getThreadCommandOutcomeDisplay,
  getWorkbenchMcpCommandDisplay,
  getWorkbenchMcpCommandRoute,
  getWorkbenchMcpShellCommandItem,
  shouldUseWorkbenchMcpSpecializedRenderer,
  getGitArcMatcherAction,
  isBrowseCommandMatcherClaim,
  isGitCheckpointCompareMatcherClaim,
  isGitCheckpointDiffMatcherClaim,
  isThreadContextMatcherClaim,
  isWorkbenchThreadStatusMatcherClaim,
  isWorkbenchThreadTitleSetMatcherClaim,
  parseWorkbenchSubagentCommand,
  parseWorkbenchThreadStatusCommand,
  parseWorkbenchThreadTitleCommand,
  parseBrowseSequenceCommandOutput,
  parseGitCheckpointCompareOutput,
  parseGitCheckpointDiffArtifactId,
  parseGitCheckpointDiffOutput,
  parseGitArcCommand,
  parseGitArcReceipt,
  type ThreadCommandSummaryDisplay,
  type ThreadCommandDetailRow,
  type ThreadCommandDetailTarget,
  type CommandShell,
} from "../../../workbench/thread/thread-command-matchers";
import {
  getSubagentSummary,
  getWorkbenchSubagentCommandTargetKey,
  resolveWorkbenchSubagentCommandTargets,
} from "../../../workbench/thread/thread-subagents";
import WorkbenchSpinningBorder from "../WorkbenchSpinningBorder";
import {
  formatThreadDuration,
  formatThreadTimestamp,
  humanizeThreadLabel,
  truncateThreadText,
} from "./thread-view-formatters";
import { ThreadCommandSummary } from "./thread-view-primitives";
import ThreadCheckpointCommitItem from "./ThreadCheckpointCommitItem";
import ThreadCheckpointCompareItem from "./ThreadCheckpointCompareItem";
import ThreadCheckpointDiffItem from "./ThreadCheckpointDiffItem";
import ThreadGitArcItem from "./ThreadGitArcItem";
import { readThreadGitArcProposalTranscriptItem } from "./thread-git-arc-proposal-intents";
import ThreadCodeDisplay, { ThreadCommandHeader } from "./ThreadCodeDisplay";
import ThreadCommandDetails from "./ThreadCommandDetails";
import ThreadContextCompactionItem from "./ThreadContextCompactionItem";
import ThreadContextCommandItem from "./ThreadContextCommandItem";
import ThreadDisclosure, { ThreadDisclosureStaticRow } from "./ThreadDisclosure";
import ThreadDurationText from "./ThreadDurationText";
import ThreadDynamicToolCallItem from "./ThreadDynamicToolCallItem";
import ThreadFileChangeItem from "./ThreadFileChangeItem";
import ThreadMarkdown from "./ThreadMarkdown";
import ThreadMcpToolCallItem from "./ThreadMcpToolCallItem";
import ThreadPlanSummary from "./ThreadPlanSummary";
import ThreadReasoningItem from "./ThreadReasoningItem";
import ThreadSummaryText from "./ThreadSummaryText";
import ThreadSubagentCreateItem from "./ThreadSubagentCreateItem";
import ThreadIncomingAgentMessageItem from "./ThreadIncomingAgentMessageItem";
import ThreadAgentScreenshotItem from "./ThreadAgentScreenshotItem";
import ThreadToolOutputItem from "./ThreadToolOutputItem";
import ThreadSubagentMessageItem from "./ThreadSubagentMessageItem";
import ThreadSubagentTargetActionItem from "./ThreadSubagentTargetActionItem";
import ThreadSubagentWaitItem from "./ThreadSubagentWaitItem";
import ThreadStatusCommandItem from "./ThreadStatusCommandItem";
import ThreadTitleCommandItem from "./ThreadTitleCommandItem";
import ThreadWorkbenchCommandItem from "./ThreadWorkbenchCommandItem";
import { formatToolCallOutput } from "./format-thread-tool-call";
import ThreadUserImage from "./ThreadUserImage";
import ThreadWebSearchItem, {
  ThreadWebSearchSequence,
} from "./ThreadWebSearchItem";
import {
  getThreadReasoningSteps,
  omitThreadReasoningStep,
  projectThreadReasoningMarkdown,
  type ThreadReasoningStepReference,
} from "./thread-reasoning-display";
import { isThreadWebSearchPlaceholder } from "./thread-web-search-state";
import {
  getThreadSubagentWaitTiming,
  groupThreadSubagentWaitRenderEntries,
  type ThreadSubagentWaitRenderEntry,
  type ThreadSubagentWaitRenderGroup,
  type ThreadSubagentWaitTiming,
} from "./thread-subagent-wait-groups";
import { createThreadTurnCompactionRenderPlan } from "./thread-turn-compaction-sections";
import { partitionCompletedThreadWork } from "./thread-completed-work";
import getFinishedThreadTailHiddenItemIds from "./thread-finished-tail";
import projectThreadRenderTurns from "./thread-render-turns";
import { useStableBrowseResultEntriesByTurn } from "./stable-browse-result-entries";
import { getUserMessageCopyMarkdown } from "./bubble-copy";
import ThreadBubbleCopyButton from "./ThreadBubbleCopyButton";
import useThreadPresentedText from "./use-thread-presented-text";
import { CheckIcon, ClockIcon, PlayIcon, WarningIcon } from "../workbench-icons";

const THREAD_DETAIL_INLINE_CODE_CLASS = "rounded-[0.35rem] bg-[color-mix(in_srgb,var(--text)_7%,transparent)] px-[0.34em] py-[0.08em] font-mono text-[0.88em] leading-[1.6] text-text";
const EMPTY_BROWSE_SCREENSHOT_ENTRIES: readonly WorkbenchBrowseResultEntry[] = [];
const EMPTY_HOISTED_GIT_ARC_PROPOSAL_IDS: ReadonlySet<string> = new Set();

type CommandItem = Extract<ThreadItem, { type: "commandExecution" }> & { shell?: CommandShell };
type McpCommandItem = Extract<ThreadItem, { type: "mcpToolCall" }>;
type CommandSequenceItem = CommandItem | McpCommandItem;
type CommandBlockItem =
  | Pick<CommandItem, "command" | "commandActions" | "cwd" | "shell">
  | { display: ThreadCommandSummaryDisplay };
type FileChangeItem = Extract<ThreadItem, { type: "fileChange" }>;
type ReasoningItem = Extract<ThreadItem, { type: "reasoning" }>;
type WebSearchItem = Extract<ThreadItem, { type: "webSearch" }>;
type NonGroupedItem = Exclude<ThreadItem, { type: "commandExecution" } | { type: "fileChange" } | { type: "reasoning" }>;

type ThreadRenderableBlock =
  | { kind: "commandSequence"; items: CommandSequenceItem[] }
  | { kind: "fileChangeSequence"; items: FileChangeItem[] }
  | { kind: "reasoningSequence"; items: ReasoningItem[] }
  | { kind: "webSearchSequence"; items: WebSearchItem[] }
  | { kind: "item"; item: NonGroupedItem };

type RelatedThreadsById = Record<string, ThreadPayload | undefined>;

interface HiddenThreadItemIds {
  controlAgentMessages?: boolean;
  controlUserMessages?: boolean;
  dynamicToolCallIds?: ReadonlySet<string> | null;
  itemIds?: ReadonlySet<string> | null;
  reasoningStep?: ThreadReasoningStepReference | null;
  webSearchItemIds?: ReadonlySet<string> | null;
}

function isProjectedInteractionItem(
  item: WorkbenchProjectedTranscriptItem,
): item is WorkbenchProjectedInteractionItem {
  return item.type === "questionnaire" || item.type === "approval";
}

function adaptProjectedInteractionItem(
  item: WorkbenchProjectedInteractionItem,
): Extract<ThreadItem, { type: "dynamicToolCall" }> {
  return {
    arguments: item.request as unknown as Extract<ThreadItem, { type: "dynamicToolCall" }>["arguments"],
    contentItems: [{
      text: JSON.stringify(item.response, null, 2),
      type: "inputText",
    }],
    durationMs: null,
    id: item.id,
    namespace: null,
    status: item.state === "answered" ? "completed" : "failed",
    success: item.state === "answered",
    tool: WORKBENCH_QUESTIONNAIRE_TOOL_NAME,
    type: "dynamicToolCall",
  };
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

export function ThreadTurnLoadFailure({
  entry,
  onRetry,
}: {
  entry: WorkbenchThreadTurnHistoryEntry;
  onRetry: () => void;
}) {
  return (
    <section
      className="border-t border-[color-mix(in_srgb,var(--text)_10%,transparent)] py-3"
      data-thread-turn-load-state={entry.loadState}
    >
      <div className="flex items-center justify-between gap-3 text-[0.88em] leading-[1.5] text-muted" role="status">
        <span>Could not load this previous turn.</span>
        <button
          type="button"
          className="shrink-0 rounded px-2 py-1 font-medium text-text transition-colors hover:bg-[color-mix(in_srgb,var(--text)_8%,transparent)]"
          onClick={onRetry}
        >
          Retry
        </button>
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
  return isWorkbenchHiddenSystemSteerInput(item.content);
}

function getSteerUserMessageState(item: Extract<ThreadItem, { type: "userMessage" }>) {
  if (isWorkbenchPendingSteerUserMessage(item)) {
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

function buildRenderableBlocks (
  items: ThreadItem[],
  hiddenItemIds: HiddenThreadItemIds = {},
  fallbackCommandCwd = ".",
): ThreadRenderableBlock[] {
  const blocks: ThreadRenderableBlock[] = [];
  let pendingCommands: CommandSequenceItem[] = [];
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

  const appendCommandItem = (item: CommandSequenceItem) => {
    flushPendingReasoning();
    flushPendingFileChanges();
    flushPendingWebSearches();
    pendingCommands.push(item);
  };

  for (const item of items) {
    if (hiddenItemIds.itemIds?.has(item.id)) {
      continue;
    }
    if (item.type === "userMessage" && (
      isWorkbenchHiddenSystemSteerInput(item.content)
      || (item.content.length > 0 && item.content.every(isWorkbenchActivatedSkillsInput))
    )) {
      continue;
    }
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

    if (item.type === "commandExecution") {
      if (!isHiddenCommandExecution(item.command)) appendCommandItem(item);
      continue;
    }

    if (item.type === "mcpToolCall") {
      const commandItem = getWorkbenchMcpShellCommandItem(item, fallbackCommandCwd);
      if (commandItem) {
        if (!isHiddenCommandExecution(commandItem.command)) appendCommandItem(commandItem);
        continue;
      }
      const route = getWorkbenchMcpCommandRoute({
        argumentsValue: item.arguments,
        server: item.server,
        tool: item.tool,
      });
      if (route?.kind === "simple" && route.rendering.result.omitFromDisplay) {
        continue;
      }
      if (route?.kind === "simple" && route.rendering.claimedBy !== "browse.command") {
        appendCommandItem(item);
        continue;
      }
    }

    if (item.type === "reasoning") {
      const visibleItem = omitThreadReasoningStep(item, hiddenItemIds.reasoningStep);
      if (!visibleItem || !hasReasoningSteps(visibleItem)) {
        continue;
      }

      flushPendingCommands();
      flushPendingFileChanges();
      flushPendingWebSearches();
      pendingReasoning.push(visibleItem);
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

function useStableRenderableBlocks(blocks: ThreadRenderableBlock[]) {
  const previousEntriesRef = useRef<StableRenderableBlockEntry[]>([]);
  const stableEntries = useMemo(() => {
    const previousEntriesByBlockKey = new Map(previousEntriesRef.current.map((entry) => [entry.blockKey, entry]));
    return blocks.map((block): StableRenderableBlockEntry => {
      const blockKey = getRenderableBlockKey(block);
      const signature = getRenderableBlockSignature(block);
      const matchingPreviousEntry = previousEntriesByBlockKey.get(blockKey) ?? null;
      const previousEntry = matchingPreviousEntry?.signature === signature
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

function formatBrowseResultEntryActionLabel(action: string) {
  return action
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replace(/[-_]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/^./u, (value) => value.toUpperCase()) || "BrowseMD";
}

function shouldUseBrowseResultDetailAsTarget(entry: WorkbenchBrowseResultEntry) {
  return entry.detailKind === "text"
    && !entry.detailLabel
    && Boolean(entry.detailText?.trim())
    && /\b(?:directory|file|files|working directory)\b/iu.test(entry.action);
}

function createBrowseResultEntryDetailRows(entries: readonly WorkbenchBrowseResultEntry[]): ThreadCommandDetailRow[] {
  return [...entries]
    .sort((left, right) => left.actionIndex - right.actionIndex || left.recordedAt - right.recordedAt)
    .map((entry) => {
      const label = formatBrowseResultEntryActionLabel(entry.action);
      const useDetailAsTarget = shouldUseBrowseResultDetailAsTarget(entry);
      return {
        detailKind: entry.detailKind ?? undefined,
        detailLabel: entry.detailLabel ?? null,
        detailText: useDetailAsTarget ? null : entry.detailText ?? null,
        durationMs: entry.durationMs ?? null,
        id: `browse-result:${entry.entryKey}`,
        imageUrl: entry.assetUrl ?? null,
        label,
        state: entry.state,
        summaryParts: [{ text: label, type: "text" as const }],
        target: useDetailAsTarget && entry.detailText ? { kind: "code" as const, text: entry.detailText } : null,
      };
    });
}

function isHiddenCommandExecution (command: string) {
  if (/^report_intent(?:\s|$)/i.test(command.trim())) {
    return true;
  }

  const display = getThreadCommandDisplay({
    command,
    commandActions: [],
    cwd: "",
  });
  const hasDedicatedRenderer = Boolean(
    getGitArcMatcherAction(display.claimedBy)
    || isThreadContextMatcherClaim(display.claimedBy)
    || isWorkbenchThreadStatusMatcherClaim(display.claimedBy)
    || isWorkbenchThreadTitleSetMatcherClaim(display.claimedBy)
    || display.claimedBy?.split(",").includes("workbench-cli.subagent"),
  );
  return display.omitFromDisplay && !hasDedicatedRenderer;
}

function hasReasoningSteps (item: ReasoningItem) {
  return item.summary.some((section) => section.trim())
    || item.content.some((section) => section.trim());
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
          src={getCodexTranscriptAssetUrl(input.url)}
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
  subagents = [],
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
  subagents?: readonly WorkbenchSubagentSummary[];
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
}) {
  const agentMessage = readWorkbenchAgentMessageInput(item.content);
  if (agentMessage) {
    const steerState = getSteerUserMessageState(item);
    return (
      <ThreadIncomingAgentMessageItem
        message={agentMessage}
        steerState={steerState}
        subagent={getSubagentSummary(subagents, agentMessage.senderThreadId)}
        timestamp={showStartedAt ? <ThreadMessageTimestamp className="mt-1" timestampSeconds={startedAt} /> : undefined}
        inlineMentionSources={inlineMentionSources}
        threadCwdPath={threadCwdPath}
        projectFilePaths={projectFilePaths}
        projectId={projectId}
        projectRootPath={projectRootPath}
        workspaceRoots={workspaceRoots}
      />
    );
  }

  if (isAgentScreenshotSteerUserMessage(item)) {
    return (
      <ThreadAgentScreenshotItem
        images={getAgentScreenshotSteerImages(item).map((image) => image.url)}
        timestamp={showStartedAt ? <ThreadMessageTimestamp className="mt-1" timestampSeconds={startedAt} /> : undefined}
      />
    );
  }

  const steerState = getSteerUserMessageState(item);
  const isDecoratedSteer = steerState !== null;
  const displayContent = unwrapWorkbenchSteerDisplayInput(item.content);
  const copyMarkdown = getUserMessageCopyMarkdown(displayContent);
  const steerMessageClass = steerState === "pending"
    ? " relative isolate overflow-hidden rounded-[1.4rem]"
    : steerState === "unsent"
      ? " thread-unsent-steer-message px-0.5 py-0.5"
      : "";
  const decoratedSteerSurfaceClass = steerState === "pending"
    ? " relative z-10 rounded-[1.4rem] border-[3px] border-transparent bg-[color:color-mix(in_srgb,var(--text)_6%,var(--shell-fade-bg))] [clip-path:padding-box] px-4 py-3"
    : isDecoratedSteer
      ? " relative z-10 rounded-[1.15rem] bg-[color-mix(in_srgb,var(--text)_6%,transparent)] px-4 py-3"
      : " rounded-[1.15rem] bg-[color-mix(in_srgb,var(--text)_6%,transparent)] px-4 py-3";
  return (
    <section className="flex flex-col items-end py-2" data-thread-user-message-state={steerState ? `${steerState}-steer` : undefined}>
      <div className="group/thread-bubble relative w-full max-w-[42rem]">
        <div className={isDecoratedSteer ? steerMessageClass : undefined}>
          {steerState === "pending" ? <WorkbenchSpinningBorder radius="1.4rem" /> : null}
          <div className={`space-y-2 text-left${decoratedSteerSurfaceClass}`}>
            {displayContent.length ? displayContent.map((content, index) => (
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
        <ThreadBubbleCopyButton markdown={copyMarkdown} side="right" />
      </div>
      {showStartedAt ? <ThreadMessageTimestamp align="right" className="mt-1" timestampSeconds={startedAt} /> : null}
    </section>
  );
}

function ThreadAgentMessageItem ({
  completedAt,
  inlineMentionSources,
  isFinal,
  item,
  presentationSource,
  threadCwdPath,
  threadId = "",
  turnId = "",
  projectFilePaths,
  projectId,
  projectRootPath,
  workspaceRoots,
}: {
  completedAt: number | null;
  inlineMentionSources?: InlineMentionHighlightSources | null;
  isFinal: boolean;
  item: Extract<ThreadItem, { type: "agentMessage" }>;
  presentationSource?: ThreadTextPresentationSource | null;
  threadCwdPath?: string;
  threadId?: string;
  turnId?: string;
  projectFilePaths?: readonly string[];
  projectId?: string | null;
  projectRootPath?: string;
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
}) {
  const text = useThreadPresentedText({
    canonicalText: item.text,
    field: "agentMessageText",
    itemId: item.id,
    source: presentationSource,
    threadId,
    turnId,
  });
  return (
    <section className="py-2">
      <ThreadMarkdown
        inlineMentionSources={inlineMentionSources}
        markdown={text || "No assistant text captured."}
        threadCwdPath={threadCwdPath}
        projectFilePaths={projectFilePaths}
        projectId={projectId}
        projectRootPath={projectRootPath}
        revealAppends={Boolean(presentationSource)}
        workspaceRoots={workspaceRoots}
      />
      {isFinal ? <ThreadMessageTimestamp className="mt-1" timestampSeconds={completedAt} /> : null}
    </section>
  );
}

function ThreadPlanItem ({
  inlineMentionSources,
  item,
  presentationSource,
  threadCwdPath,
  threadId = "",
  turnId = "",
  projectFilePaths,
  projectId,
  projectRootPath,
  workspaceRoots,
}: {
  inlineMentionSources?: InlineMentionHighlightSources | null;
  item: Extract<ThreadItem, { type: "plan" }>;
  presentationSource?: ThreadTextPresentationSource | null;
  threadCwdPath?: string;
  threadId?: string;
  turnId?: string;
  projectFilePaths?: readonly string[];
  projectId?: string | null;
  projectRootPath?: string;
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
}) {
  const text = useThreadPresentedText({
    canonicalText: item.text,
    field: "planText",
    itemId: item.id,
    source: presentationSource,
    threadId,
    turnId,
  });
  return (
    <ThreadDisclosure
      className="py-2"
      contentClassName="mt-2 pl-6"
      summary={<ThreadPlanSummary markdown={text} />}
      summaryClassName="text-[0.92em] leading-[1.6] text-muted"
    >
      <ThreadMarkdown
        inlineMentionSources={inlineMentionSources}
        markdown={text || "No plan text captured."}
        threadCwdPath={threadCwdPath}
        projectFilePaths={projectFilePaths}
        projectId={projectId}
        projectRootPath={projectRootPath}
        revealAppends={Boolean(presentationSource)}
        workspaceRoots={workspaceRoots}
      />
    </ThreadDisclosure>
  );
}

function ThreadReasoningSequence ({
  block,
  inlineMentionSources,
  isMostRecent,
  presentationSource,
  threadCwdPath,
  threadId,
  turnId,
  projectFilePaths,
  projectId,
  projectRootPath,
  workspaceRoots,
}: {
  block: Extract<ThreadRenderableBlock, { kind: "reasoningSequence" }>;
  inlineMentionSources?: InlineMentionHighlightSources | null;
  isMostRecent: boolean;
  presentationSource?: ThreadTextPresentationSource | null;
  threadCwdPath?: string;
  threadId: string;
  turnId: string;
  projectFilePaths?: readonly string[];
  projectId?: string | null;
  projectRootPath?: string;
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
}) {
  const visibleItems = block.items.filter(hasReasoningSteps);
  const steps = getThreadReasoningSteps(visibleItems);
  const canonicalOnlyStep = steps.length === 1 ? steps[0] : null;
  const presentedOnlyStepMarkdown = useThreadPresentedText({
    canonicalText: canonicalOnlyStep?.markdown ?? "",
    field: canonicalOnlyStep?.source === "content" ? "reasoningContent" : "reasoningSummary",
    index: canonicalOnlyStep?.sectionIndex ?? null,
    itemId: canonicalOnlyStep?.itemId ?? "",
    source: canonicalOnlyStep ? presentationSource : null,
    threadId,
    turnId,
  });
  if (!steps.length) {
    return null;
  }
  const onlyStep = canonicalOnlyStep ? {
    ...canonicalOnlyStep,
    ...projectThreadReasoningMarkdown(presentedOnlyStepMarkdown),
    markdown: presentedOnlyStepMarkdown,
  } : null;
  const summary = onlyStep && steps.length === 1 ? (<>
    <span>Reasoned: </span>
    <span className="thread-item-disclosure-prominent-text-portion font-medium text-text">{onlyStep.title}</span>
  </>) : (<>
    <span>Reasoned over </span>
    <span className="thread-item-disclosure-prominent-text-portion text-text">{steps.length}</span>
    <span> steps</span>
  </>);

  if (onlyStep && steps.length === 1 && !onlyStep.body) {
    return (
      <ThreadDisclosureStaticRow
        summary={summary}
        summaryClassName="text-[0.92em] leading-[1.6] text-muted"
      />
    );
  }

  const content = onlyStep && steps.length === 1 ? (
    <ThreadMarkdown
      className="text-[0.8em] text-muted"
      inlineMentionSources={inlineMentionSources}
      markdown={onlyStep.body ?? ""}
      threadCwdPath={threadCwdPath}
      projectFilePaths={projectFilePaths}
      projectId={projectId}
      projectRootPath={projectRootPath}
      workspaceRoots={workspaceRoots}
      revealAppends={Boolean(presentationSource)}
    />
  ) : (
    <div className="space-y-4">
      {visibleItems.map((item, index) => (
        <ThreadReasoningItem
          key={item.id}
          className={index ? "border-t border-[color-mix(in_srgb,var(--text)_10%,transparent)] pt-4" : undefined}
          item={item}
          presentationSource={presentationSource}
          inlineMentionSources={inlineMentionSources}
          threadCwdPath={threadCwdPath}
          projectFilePaths={projectFilePaths}
          projectId={projectId}
          projectRootPath={projectRootPath}
          threadId={threadId}
          turnId={turnId}
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
      summary={summary}
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
          ongoingSummaryParts: row.summaryParts,
          ongoingSummaryText: "",
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
        header={<ThreadCommandHeader command={row.target?.text ?? ""} surface="framed" />}
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
  browseResultEntries: readonly WorkbenchBrowseResultEntry[] = [],
  commandStatus: CommandItem["status"] = "completed",
) {
  if (!rows?.length) {
    return createBrowseResultEntryDetailRows(browseResultEntries);
  }

  const outputRows = parseBrowseSequenceCommandOutput(output);
  const sidecarRows = new Map<number, WorkbenchBrowseResultEntry>();
  for (const entry of browseResultEntries) {
    sidecarRows.set(entry.actionIndex, entry);
  }

  return rows.map((row, index) => {
    const sidecarRow = sidecarRows.get(index);
    const durationMs = row.durationMs ?? sidecarRow?.durationMs ?? outputRows[index]?.durationMs ?? null;
    const shouldSuppressDuplicateWaitDuration = row.label === "Wait"
      && row.target?.kind === "text"
      && durationMs !== null
      && formatThreadDuration(durationMs) === row.target.text;

    return {
      ...row,
      detailKind: row.detailKind ?? sidecarRow?.detailKind ?? outputRows[index]?.detailKind,
      detailLabel: row.detailLabel ?? sidecarRow?.detailLabel ?? outputRows[index]?.detailLabel ?? null,
      detailText: row.detailText ?? sidecarRow?.detailText ?? outputRows[index]?.detailText ?? null,
      durationMs: shouldSuppressDuplicateWaitDuration ? null : durationMs,
      imageUrl: row.imageUrl ?? sidecarRow?.assetUrl ?? null,
      state: row.state ?? sidecarRow?.state ?? getDefaultBrowseDetailRowState(rows, outputRows, commandStatus, index),
    };
  });
}

function isBrowseCommandItem({
  item,
  knownSkills,
  projectRootPath,
  workspaceRoots,
}: {
  item: CommandSequenceItem;
  knownSkills?: WorkbenchSkillSummary[];
  projectRootPath?: string;
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
}) {
  if (item.type === "mcpToolCall") {
    return false;
  }
  const display = getThreadCommandDisplay({
    command: item.command,
    commandActions: item.commandActions,
    cwd: item.cwd,
    knownSkills,
    projectRootPath,
    shell: item.shell,
    workspaceRoots,
  });
  return isBrowseCommandMatcherClaim(display.claimedBy);
}

function isThreadContextCommandItem({
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
    shell: item.shell,
    workspaceRoots,
  });
  return isThreadContextMatcherClaim(display.claimedBy);
}

type CommandSequenceRenderSegment =
  | { items: CommandSequenceItem[]; kind: "commands" }
  | { item: CommandItem; kind: "gitArc" }
  | { item: CommandItem; kind: "subagent" }
  | { group: ThreadSubagentWaitRenderGroup<CommandItem>; kind: "subagentWait" }
  | { item: CommandItem; kind: "threadContext" }
  | { item: CommandItem; kind: "threadStatus"; status: "blocked" | "completed" }
  | { item: CommandItem; kind: "threadTitle"; title: string };

function buildCommandSequenceRenderSegments({
  items,
  knownSkills,
  projectRootPath,
  workspaceRoots,
}: {
  items: CommandSequenceItem[];
  knownSkills?: WorkbenchSkillSummary[];
  projectRootPath?: string;
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
}) {
  const segments: CommandSequenceRenderSegment[] = [];
  let pendingCommands: CommandSequenceItem[] = [];
  let pendingSubagentWaits: ThreadSubagentWaitRenderEntry<CommandItem>[] = [];

  const flushPendingCommands = () => {
    if (!pendingCommands.length) {
      return;
    }

    segments.push({
      items: pendingCommands,
      kind: "commands",
    });
    pendingCommands = [];
  };

  const flushPendingSubagentWaits = () => {
    if (!pendingSubagentWaits.length) {
      return;
    }

    segments.push(...groupThreadSubagentWaitRenderEntries(pendingSubagentWaits).map((group) => ({
      group,
      kind: "subagentWait" as const,
    })));
    pendingSubagentWaits = [];
  };

  for (const item of items) {
    if (item.type === "mcpToolCall") {
      flushPendingSubagentWaits();
      if (item.status !== "completed" || item.error) {
        flushPendingCommands();
        segments.push({ items: [item], kind: "commands" });
      } else {
        pendingCommands.push(item);
      }
      continue;
    }

    const commandOutcome = getThreadCommandExecutionOutcome(item.status, item.exitCode);
    if (
      isThreadContextCommandItem({ item, knownSkills, projectRootPath, workspaceRoots })
      && (commandOutcome === "completed" || commandOutcome === "inProgress")
    ) {
      flushPendingCommands();
      flushPendingSubagentWaits();
      segments.push({
        item,
        kind: "threadContext",
      });
      continue;
    }

    const commandDisplay = getThreadCommandDisplay({
      command: item.command,
      commandActions: item.commandActions,
      cwd: item.cwd,
      knownSkills,
      projectRootPath,
      shell: item.shell,
      workspaceRoots,
    });
    const threadTitleCommand = isWorkbenchThreadTitleSetMatcherClaim(commandDisplay.claimedBy)
      ? parseWorkbenchThreadTitleCommand(commandDisplay.unwrappedCommand, item.commandActions)
      : null;
    if (threadTitleCommand?.action === "set") {
      flushPendingCommands();
      flushPendingSubagentWaits();
      segments.push({ item, kind: "threadTitle", title: threadTitleCommand.title });
      continue;
    }
    const threadStatusCommand = isWorkbenchThreadStatusMatcherClaim(commandDisplay.claimedBy)
      ? parseWorkbenchThreadStatusCommand(commandDisplay.unwrappedCommand, item.commandActions)
      : null;
    if (threadStatusCommand && (commandOutcome === "completed" || commandOutcome === "inProgress")) {
      flushPendingCommands();
      flushPendingSubagentWaits();
      segments.push({ item, kind: "threadStatus", status: threadStatusCommand.status });
      continue;
    }
    if (getGitArcMatcherAction(commandDisplay.claimedBy)) {
      flushPendingCommands();
      flushPendingSubagentWaits();
      segments.push({ item, kind: "gitArc" });
      continue;
    }
    const subagentCommand = parseWorkbenchSubagentCommand(commandDisplay.unwrappedCommand, item.commandActions);
    if (subagentCommand?.action === "wait" && subagentCommand.targets.length) {
      flushPendingCommands();
      pendingSubagentWaits.push({
        item,
        outcome: getThreadCommandExecutionOutcome(item.status, item.exitCode),
        targetKeys: subagentCommand.targets.map(getWorkbenchSubagentCommandTargetKey),
      });
      continue;
    }

    flushPendingSubagentWaits();
    if (subagentCommand) {
      flushPendingCommands();
      segments.push({
        item,
        kind: "subagent",
      });
      continue;
    }

    if (getThreadCommandExecutionOutcome(item.status, item.exitCode) !== "completed") {
      flushPendingCommands();
      segments.push({ items: [item], kind: "commands" });
      continue;
    }

    pendingCommands.push(item);
  }

  flushPendingCommands();
  flushPendingSubagentWaits();
  return segments;
}

function ThreadSubagentCurrentActivityPreview ({
  inlineMentionSources,
  knownSkills,
  projectFilePaths,
  projectId,
  projectRootPath,
  relatedThreadsById,
  thread,
  workspaceRoots,
}: {
  inlineMentionSources?: InlineMentionHighlightSources | null;
  knownSkills?: WorkbenchSkillSummary[];
  projectFilePaths?: readonly string[];
  projectId?: string | null;
  projectRootPath?: string;
  relatedThreadsById: RelatedThreadsById;
  thread: ThreadPayload | undefined;
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
}) {
  const currentTurn = getCurrentTurn(thread);
  if (!thread || !currentTurn) {
    return <ThreadContentLoadingSkeleton />;
  }

  const blocks = buildRenderableBlocks(currentTurn.items, {}, thread.cwd);
  const block = blocks.at(-1) ?? null;
  if (!block) {
    return (
      <p className="m-0 text-[0.92em] leading-[1.6] text-muted">
        No subagent activity was captured yet.
      </p>
    );
  }

  return (
    <ThreadRenderableBlockView
      block={block}
      finalAgentMessageId={getFinalAgentMessageId(currentTurn)}
      inlineMentionSources={inlineMentionSources}
      isMostRecentBlock
      knownSkills={knownSkills}
      primaryUserBlock={null}
      projectFilePaths={projectFilePaths}
      projectId={projectId}
      projectRootPath={projectRootPath}
      relatedThreadsById={relatedThreadsById}
      subagents={[]}
      threadCwdPath={thread.cwd}
      threadId={thread.id}
      turnCompletedAt={currentTurn.completedAt}
      turnId={currentTurn.id}
      turnStartedAt={currentTurn.startedAt}
      turnStatus={currentTurn.status}
      workspaceRoots={workspaceRoots}
    />
  );
}

function ThreadRecallRecordItem({
  inlineMentionSources,
  record,
  threadCwdPath,
  projectFilePaths,
  projectId,
  projectRootPath,
  workspaceRoots,
}: {
  inlineMentionSources?: InlineMentionHighlightSources | null;
  record: WorkbenchThreadRecallOutputRecord;
  threadCwdPath?: string;
  projectFilePaths?: readonly string[];
  projectId?: string | null;
  projectRootPath?: string;
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
}) {
  const id = `thread-recall:${record.ref}`;
  switch (record.kind) {
    case "user-message":
    case "user-steer":
      return (
        <ThreadUserMessageItem
          inlineMentionSources={inlineMentionSources}
          item={{
            clientId: null,
            content: [{ text: record.text, text_elements: [], type: "text" }],
            id,
            type: "userMessage",
          }}
          projectFilePaths={projectFilePaths}
          projectId={projectId}
          projectRootPath={projectRootPath}
          showStartedAt={false}
          startedAt={null}
          threadCwdPath={threadCwdPath}
          workspaceRoots={workspaceRoots}
        />
      );
    case "commentary":
    case "final-answer":
    case "agent-message":
      return (
        <ThreadAgentMessageItem
          completedAt={null}
          inlineMentionSources={inlineMentionSources}
          isFinal={record.kind === "final-answer"}
          item={{
            id,
            memoryCitation: null,
            delivery: null,
            questions: null,
            phase: record.kind === "commentary"
              ? "commentary"
              : record.kind === "final-answer" ? "final_answer" : null,
            text: record.text,
            type: "agentMessage",
          }}
          projectFilePaths={projectFilePaths}
          projectId={projectId}
          projectRootPath={projectRootPath}
          threadCwdPath={threadCwdPath}
          workspaceRoots={workspaceRoots}
        />
      );
    case "plan":
      return (
        <ThreadPlanItem
          inlineMentionSources={inlineMentionSources}
          item={{ id, text: record.text, type: "plan" }}
          projectFilePaths={projectFilePaths}
          projectId={projectId}
          projectRootPath={projectRootPath}
          threadCwdPath={threadCwdPath}
          workspaceRoots={workspaceRoots}
        />
      );
    case "questionnaire":
      return null;
  }
}

function ThreadCommandExecutionDetails ({
  browseResultEntries = EMPTY_BROWSE_SCREENSHOT_ENTRIES,
  inlineMentionSources,
  isMostRecent = false,
  item,
  knownSkills,
  projectFilePaths,
  projectId,
  projectRootPath,
  relatedThreadsById,
  subagentWaitTiming,
  subagents,
  threadId,
  workspaceRoots,
}: {
  browseResultEntries?: readonly WorkbenchBrowseResultEntry[];
  inlineMentionSources?: InlineMentionHighlightSources | null;
  isMostRecent?: boolean;
  item: CommandItem;
  knownSkills?: WorkbenchSkillSummary[];
  projectFilePaths?: readonly string[];
  projectId?: string | null;
  projectRootPath?: string;
  relatedThreadsById: RelatedThreadsById;
  subagentWaitTiming?: ThreadSubagentWaitTiming;
  subagents: readonly WorkbenchSubagentSummary[];
  threadId: string;
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
}) {
  const commandDisplay = useMemo(() => getThreadCommandDisplay({
    command: item.command,
    commandActions: item.commandActions,
    cwd: item.cwd,
    knownSkills,
    projectRootPath,
    shell: item.shell,
    workspaceRoots,
  }), [item.command, item.commandActions, item.cwd, item.shell, knownSkills, projectRootPath, workspaceRoots]);
  const commandOutcome = getThreadCommandExecutionOutcome(item.status, item.exitCode);
  const outcomeCommandDisplay = useMemo(
    () => getThreadCommandOutcomeDisplay(commandDisplay, commandOutcome),
    [commandDisplay, commandOutcome],
  );
  const subagentCommand = parseWorkbenchSubagentCommand(commandDisplay.unwrappedCommand, item.commandActions);
  const resolvedSubagentTargets = subagentCommand
    ? resolveWorkbenchSubagentCommandTargets(subagents, subagentCommand.targets)
    : [];
  const checkpointDiffChanges = isGitCheckpointDiffMatcherClaim(commandDisplay.claimedBy)
    ? parseGitCheckpointDiffOutput(item.aggregatedOutput ?? "")
    : null;
  const checkpointDiffArtifactId = isGitCheckpointDiffMatcherClaim(commandDisplay.claimedBy)
    ? parseGitCheckpointDiffArtifactId(item.aggregatedOutput ?? "")
    : null;
  const checkpointCompareChanges = isGitCheckpointCompareMatcherClaim(commandDisplay.claimedBy)
    ? parseGitCheckpointCompareOutput(item.aggregatedOutput ?? "")
    : null;
  const gitArcProposal = readThreadGitArcProposalTranscriptItem(item, commandDisplay);
  const gitArcReceipt = gitArcProposal?.receipt ?? parseGitArcReceipt(item.aggregatedOutput ?? "");
  const gitArcAction = getGitArcMatcherAction(commandDisplay.claimedBy);
  const gitArcCommandIntent = gitArcAction
    ? parseGitArcCommand(commandDisplay.unwrappedCommand) ?? {
      action: gitArcAction,
      intentName: gitArcReceipt?.intentName ?? null,
      paths: gitArcReceipt?.selectedPaths ?? [],
      proposalId: gitArcReceipt?.proposalId ?? null,
      ref: gitArcReceipt?.ref ?? null,
    }
    : null;
  const isBrowseCommand = isBrowseCommandMatcherClaim(commandDisplay.claimedBy);
  const shouldRenderCheckpointDiff = checkpointDiffChanges !== null
    && (!item.aggregatedOutput?.trim() || Boolean(checkpointDiffArtifactId) || checkpointDiffChanges.length > 0);
  const commandDetailRows = useMemo(() => (
    isBrowseCommand
      ? mergeCommandDetailRowsWithBrowseOutput(
        commandDisplay.detailRows,
        item.aggregatedOutput,
        browseResultEntries.filter((entry) => entry.commandItemId === item.id),
        item.status,
      )
      : commandDisplay.detailRows ?? []
  ), [browseResultEntries, commandDisplay.detailRows, isBrowseCommand, item.aggregatedOutput, item.id, item.status]);
  const shouldHideCommandOutput = commandDisplay.hideCommandOutput
    && (commandDetailRows.length > 0 || !item.aggregatedOutput?.trim());
  if (gitArcAction === "propose") {
    return (
      <ThreadCheckpointCommitItem
        commandOutcome={commandOutcome}
        cwd={item.cwd}
        failureReason={commandOutcome === "failed" || commandOutcome === "declined" || commandOutcome === "timedOut" ? item.aggregatedOutput : null}
        intent={gitArcProposal?.intent ?? null}
        projectFilePaths={projectFilePaths}
        projectId={projectId}
        projectRootPath={projectRootPath}
        proposalId={gitArcProposal?.proposalId ?? null}
        sourceItemId={item.id}
        threadId={threadId}
        workspaceRoots={workspaceRoots}
      />
    );
  }
  if (gitArcCommandIntent && gitArcCommandIntent.action !== "propose") {
    const operationDetails = checkpointCompareChanges?.length ? (
      <ThreadCheckpointCompareItem
        changes={checkpointCompareChanges}
        projectFilePaths={projectFilePaths}
        projectId={projectId}
        projectRootPath={projectRootPath}
        workspaceRoots={workspaceRoots}
      />
    ) : shouldRenderCheckpointDiff ? (
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
    ) : null;
    return (
      <ThreadGitArcItem
        commandIntent={gitArcCommandIntent}
        durationMs={item.durationMs}
        failureReason={commandOutcome === "failed" || commandOutcome === "declined" || commandOutcome === "timedOut"
          ? item.aggregatedOutput
          : null}
        operationDetails={operationDetails}
        outcome={commandOutcome}
        projectFilePaths={projectFilePaths}
        projectId={projectId}
        projectRootPath={projectRootPath}
        receipt={gitArcReceipt}
        workspaceRoots={workspaceRoots}
      />
    );
  }
  if (
    subagentCommand?.action === "wait"
    && resolvedSubagentTargets.length
  ) {
    return (
      <ThreadSubagentWaitItem
        activeStartedAtMs={subagentWaitTiming?.activeStartedAtMs}
        disclosureContent={commandOutcome === "completed"
          ? item.aggregatedOutput?.trim() ? (
            <ThreadMarkdown
              inlineMentionSources={inlineMentionSources}
              markdown={item.aggregatedOutput.trim()}
              projectFilePaths={projectFilePaths}
              projectId={projectId}
              projectRootPath={projectRootPath}
              threadCwdPath={item.cwd}
              workspaceRoots={workspaceRoots}
            />
          ) : undefined
          : commandOutcome === "inProgress" ? undefined : (
            <ThreadCodeDisplay
              header={<ThreadCommandHeader command={item.command} surface="framed" />}
              output={item.aggregatedOutput?.trim() || undefined}
              preview
              variant="plain"
            />
          )}
        durationMs={subagentWaitTiming ? subagentWaitTiming.durationMs : item.durationMs}
        entries={resolvedSubagentTargets.map((target) => {
          const childThread = target.threadId ? relatedThreadsById[target.threadId] : undefined;
          return {
            content: target.threadId ? (
              <ThreadSubagentCurrentActivityPreview
                inlineMentionSources={inlineMentionSources}
                knownSkills={knownSkills}
                projectFilePaths={projectFilePaths}
                projectId={projectId}
                projectRootPath={projectRootPath}
                relatedThreadsById={relatedThreadsById}
                thread={childThread}
                workspaceRoots={workspaceRoots}
              />
            ) : undefined,
            fallbackName: target.fallbackName,
            subagent: target.subagent,
            targetKey: target.targetKey,
            thread: childThread,
          };
        })}
        exitCode={item.exitCode}
        outcome={commandOutcome}
      />
    );
  }
  if (
    subagentCommand?.action === "create"
    && subagentCommand.message
    && subagentCommand.name
    && subagentCommand.profileId
    && subagentCommand.title
    && (item.status === "inProgress" || item.status === "completed")
    && (item.exitCode === null || item.exitCode === 0)
  ) {
    const createdThreadId = item.status === "completed" ? item.aggregatedOutput?.trim() || null : null;
    const createdTarget = resolveWorkbenchSubagentCommandTargets(subagents, [{
      kind: createdThreadId ? "id" : "name",
      value: createdThreadId ?? subagentCommand.name,
    }])[0] ?? null;
    return (
      <ThreadSubagentCreateItem
        active={item.status === "inProgress"}
        fallbackName={subagentCommand.name}
        profileId={subagentCommand.profileId}
        fallbackTitle={subagentCommand.title}
        subagent={createdTarget?.subagent}
      >
        <ThreadMarkdown
          inlineMentionSources={inlineMentionSources}
          markdown={subagentCommand.message}
          projectFilePaths={projectFilePaths}
          projectId={projectId}
          projectRootPath={projectRootPath}
          threadCwdPath={item.cwd}
          workspaceRoots={workspaceRoots}
        />
      </ThreadSubagentCreateItem>
    );
  }
  if (
    subagentCommand?.action === "message"
    && resolvedSubagentTargets.length === 1
    && subagentCommand.message
    && (item.status === "inProgress" || item.status === "completed")
    && (item.exitCode === null || item.exitCode === 0)
  ) {
    const target = resolvedSubagentTargets[0]!;
    const childThread = target.threadId ? relatedThreadsById[target.threadId] : undefined;
    return (
      <ThreadSubagentMessageItem
        fallbackName={target.fallbackName}
        subagent={target.subagent}
        thread={childThread}
      >
        <ThreadMarkdown
          inlineMentionSources={inlineMentionSources}
          markdown={subagentCommand.message}
          projectFilePaths={projectFilePaths}
          projectId={projectId}
          projectRootPath={projectRootPath}
          threadCwdPath={item.cwd}
          workspaceRoots={workspaceRoots}
        />
      </ThreadSubagentMessageItem>
    );
  }
  if (
    (subagentCommand?.action === "settle" || subagentCommand?.action === "stop")
    && resolvedSubagentTargets.length
    && (item.status === "inProgress" || item.status === "completed")
    && (item.exitCode === null || item.exitCode === 0)
  ) {
    return (
      <ThreadSubagentTargetActionItem
        action={subagentCommand.action}
        active={item.status === "inProgress"}
        entries={resolvedSubagentTargets.map((target) => ({
          fallbackName: target.fallbackName,
          subagent: target.subagent,
          targetKey: target.targetKey,
          thread: target.threadId ? relatedThreadsById[target.threadId] : undefined,
        }))}
      />
    );
  }
  const metaParts = [];

  if (commandOutcome === "failed" && item.exitCode !== null && item.exitCode !== 0) {
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
          <ThreadCommandSummary display={outcomeCommandDisplay} projectFilePaths={projectFilePaths} projectId={projectId} />
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
        {isBrowseCommand ? (
          <ThreadCommandDetails
            command={item.command}
            output={item.aggregatedOutput}
          />
        ) : shouldHideCommandOutput ? null : checkpointCompareChanges && commandOutcome === "completed" ? (
          <ThreadCheckpointCompareItem
            changes={checkpointCompareChanges}
            projectFilePaths={projectFilePaths}
            projectId={projectId}
            projectRootPath={projectRootPath}
            workspaceRoots={workspaceRoots}
          />
        ) : shouldRenderCheckpointDiff ? (
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

function ThreadRegularCommandItem ({
  browseResultEntries = EMPTY_BROWSE_SCREENSHOT_ENTRIES,
  inlineMentionSources,
  isMostRecent,
  item,
  knownSkills,
  projectFilePaths,
  projectId,
  projectRootPath,
  relatedThreadsById,
  subagents,
  threadCwdPath,
  threadId,
  workspaceRoots,
}: {
  browseResultEntries?: readonly WorkbenchBrowseResultEntry[];
  inlineMentionSources?: InlineMentionHighlightSources | null;
  isMostRecent: boolean;
  item: CommandSequenceItem;
  knownSkills?: WorkbenchSkillSummary[];
  projectFilePaths?: readonly string[];
  projectId?: string | null;
  projectRootPath?: string;
  relatedThreadsById: RelatedThreadsById;
  subagents: readonly WorkbenchSubagentSummary[];
  threadCwdPath?: string;
  threadId: string;
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
}) {
  if (item.type === "mcpToolCall") {
    const route = getWorkbenchMcpCommandRoute({
      argumentsValue: item.arguments,
      context: threadCwdPath ? { cwd: threadCwdPath, projectRootPath, workspaceRoots } : undefined,
      server: item.server,
      tool: item.tool,
    });
    return (
      <ThreadMcpToolCallItem
        item={item}
        projectFilePaths={projectFilePaths}
        projectId={projectId}
        route={route}
      />
    );
  }

  return (
    <ThreadCommandExecutionDetails
      browseResultEntries={browseResultEntries}
      inlineMentionSources={inlineMentionSources}
      isMostRecent={isMostRecent}
      item={item}
      knownSkills={knownSkills}
      projectFilePaths={projectFilePaths}
      projectId={projectId}
      projectRootPath={projectRootPath}
      relatedThreadsById={relatedThreadsById}
      subagents={subagents}
      threadId={threadId}
      workspaceRoots={workspaceRoots}
    />
  );
}

function ThreadRegularCommandSequence ({
  browseResultEntries = EMPTY_BROWSE_SCREENSHOT_ENTRIES,
  inlineMentionSources,
  isMostRecent,
  items,
  knownSkills,
  projectFilePaths,
  projectId,
  projectRootPath,
  relatedThreadsById,
  subagents,
  threadCwdPath,
  threadId,
  workspaceRoots,
}: {
  browseResultEntries?: readonly WorkbenchBrowseResultEntry[];
  inlineMentionSources?: InlineMentionHighlightSources | null;
  isMostRecent: boolean;
  items: CommandSequenceItem[];
  knownSkills?: WorkbenchSkillSummary[];
  projectFilePaths?: readonly string[];
  projectId?: string | null;
  projectRootPath?: string;
  relatedThreadsById: RelatedThreadsById;
  subagents: readonly WorkbenchSubagentSummary[];
  threadCwdPath?: string;
  threadId: string;
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
}) {
  const allBrowseRequests = useMemo(() => {
    if (items.length <= 1) {
      return false;
    }

    return items.every((item) => isBrowseCommandItem({
      item,
      knownSkills,
      projectRootPath,
      workspaceRoots,
    }));
  }, [items, knownSkills, projectRootPath, workspaceRoots]);
  const commandBlockItems = useMemo(() => items.flatMap<CommandBlockItem>((item) => {
    if (item.type === "commandExecution") {
      return [{
        command: item.command,
        commandActions: item.commandActions,
        cwd: item.cwd,
        shell: item.shell,
      }];
    }
    const display = getWorkbenchMcpCommandDisplay({
      argumentsValue: item.arguments,
      context: threadCwdPath ? { cwd: threadCwdPath, projectRootPath, workspaceRoots } : undefined,
      server: item.server,
      tool: item.tool,
    });
    return display ? [{ display }] : [];
  }), [items, projectRootPath, threadCwdPath, workspaceRoots]);
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
    return <ThreadRegularCommandItem browseResultEntries={browseResultEntries} inlineMentionSources={inlineMentionSources} isMostRecent={isMostRecent} item={items[0]} knownSkills={knownSkills} projectFilePaths={projectFilePaths} projectId={projectId} projectRootPath={projectRootPath} relatedThreadsById={relatedThreadsById} subagents={subagents} threadCwdPath={threadCwdPath} threadId={threadId} workspaceRoots={workspaceRoots} />;
  }

  if (allBrowseRequests) {
    return (
      <div className="space-y-1">
        {items.map((item, index) => (
          <ThreadRegularCommandItem
            browseResultEntries={browseResultEntries}
            inlineMentionSources={inlineMentionSources}
            isMostRecent={isMostRecent && index === items.length - 1}
            item={item}
            key={item.id}
            knownSkills={knownSkills}
            projectFilePaths={projectFilePaths}
            projectId={projectId}
            projectRootPath={projectRootPath}
            relatedThreadsById={relatedThreadsById}
            subagents={subagents}
            threadCwdPath={threadCwdPath}
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
          <ThreadRegularCommandItem
            browseResultEntries={browseResultEntries}
            inlineMentionSources={inlineMentionSources}
            isMostRecent={isMostRecent && index === items.length - 1}
            item={item}
            key={item.id}
            knownSkills={knownSkills}
            projectFilePaths={projectFilePaths}
            projectId={projectId}
            projectRootPath={projectRootPath}
            relatedThreadsById={relatedThreadsById}
            subagents={subagents}
            threadCwdPath={threadCwdPath}
            threadId={threadId}
            workspaceRoots={workspaceRoots}
          />
        ))}
      </>
    </ThreadDisclosure>
  );
}

function ThreadCommandSequence ({
  browseResultEntries = EMPTY_BROWSE_SCREENSHOT_ENTRIES,
  inlineMentionSources,
  isMostRecent,
  itemTimeline = [],
  items: canonicalItems,
  knownSkills,
  presentationSource,
  projectFilePaths,
  projectId,
  projectRootPath,
  relatedThreadsById,
  subagents,
  threadCwdPath,
  threadId,
  turnId,
  workspaceRoots,
}: {
  browseResultEntries?: readonly WorkbenchBrowseResultEntry[];
  inlineMentionSources?: InlineMentionHighlightSources | null;
  isMostRecent: boolean;
  itemTimeline?: readonly WorkbenchThreadItemTimelineEntry[];
  items: CommandSequenceItem[];
  knownSkills?: WorkbenchSkillSummary[];
  presentationSource?: ThreadTextPresentationSource | null;
  projectFilePaths?: readonly string[];
  projectId?: string | null;
  projectRootPath?: string;
  relatedThreadsById: RelatedThreadsById;
  subagents: readonly WorkbenchSubagentSummary[];
  threadCwdPath?: string;
  threadId: string;
  turnId: string;
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
}) {
  const activeCommand = canonicalItems.findLast((item): item is CommandItem => (
    item.type === "commandExecution" && item.status === "inProgress"
  ));
  const presentedOutput = useThreadPresentedText({
    canonicalText: activeCommand?.aggregatedOutput ?? "",
    field: "commandExecutionOutput",
    itemId: activeCommand?.id ?? "",
    source: activeCommand ? presentationSource : null,
    threadId,
    turnId,
  });
  const items = useMemo(() => activeCommand
    ? canonicalItems.map((item) => item === activeCommand
      ? { ...activeCommand, aggregatedOutput: presentedOutput }
      : item)
    : canonicalItems, [activeCommand, canonicalItems, presentedOutput]);
  const renderSegments = useMemo(() => buildCommandSequenceRenderSegments({
    items,
    knownSkills,
    projectRootPath,
    workspaceRoots,
  }), [items, knownSkills, projectRootPath, workspaceRoots]);
  const hasStandaloneCommandSegment = renderSegments.some((segment) => segment.kind !== "commands");

  if (!hasStandaloneCommandSegment) {
    return (
      <ThreadRegularCommandSequence
        browseResultEntries={browseResultEntries}
        inlineMentionSources={inlineMentionSources}
        isMostRecent={isMostRecent}
        items={items}
        knownSkills={knownSkills}
        projectFilePaths={projectFilePaths}
        projectId={projectId}
        projectRootPath={projectRootPath}
        relatedThreadsById={relatedThreadsById}
        subagents={subagents}
        threadCwdPath={threadCwdPath}
        threadId={threadId}
        workspaceRoots={workspaceRoots}
      />
    );
  }

  return (
    <div className="space-y-1">
      {renderSegments.map((segment, index) => (
        segment.kind === "threadContext" ? (
          <ThreadContextCommandItem
            defaultOpen={isMostRecent && index === renderSegments.length - 1}
            key={`thread-context:${segment.item.id}`}
            projectFilePaths={projectFilePaths}
            projectId={projectId}
            projectRootPath={projectRootPath}
            renderRecord={(record) => (
              <ThreadRecallRecordItem
                inlineMentionSources={inlineMentionSources}
                record={record}
                projectFilePaths={projectFilePaths}
                projectId={projectId}
                projectRootPath={projectRootPath}
                threadCwdPath={threadCwdPath}
                workspaceRoots={workspaceRoots}
              />
            )}
            source={{
              cwd: segment.item.cwd,
              durationMs: segment.item.durationMs,
              exitCode: segment.item.exitCode,
              id: segment.item.id,
              outcome: getThreadCommandExecutionOutcome(segment.item.status, segment.item.exitCode),
              output: segment.item.aggregatedOutput ?? "",
            }}
            threadCwdPath={threadCwdPath}
            workspaceRoots={workspaceRoots}
          />
        ) : segment.kind === "threadTitle" ? (
          <ThreadTitleCommandItem
            failureText={segment.item.aggregatedOutput}
            key={`thread-title:${segment.item.id}`}
            outcome={getThreadCommandExecutionOutcome(segment.item.status, segment.item.exitCode)}
            title={segment.title}
          />
        ) : segment.kind === "threadStatus" ? (
          <ThreadStatusCommandItem
            key={`thread-status:${segment.item.id}`}
            outcome={getThreadCommandExecutionOutcome(segment.item.status, segment.item.exitCode) as "completed" | "inProgress"}
            status={segment.status}
          />
        ) : segment.kind === "gitArc" || segment.kind === "subagent" ? (
          <ThreadCommandExecutionDetails
            browseResultEntries={browseResultEntries}
            inlineMentionSources={inlineMentionSources}
            isMostRecent={isMostRecent && index === renderSegments.length - 1}
            item={segment.item}
            key={`${segment.kind}:${segment.item.id}`}
            knownSkills={knownSkills}
            projectFilePaths={projectFilePaths}
            projectId={projectId}
            projectRootPath={projectRootPath}
            relatedThreadsById={relatedThreadsById}
            subagents={subagents}
            threadId={threadId}
            workspaceRoots={workspaceRoots}
          />
        ) : segment.kind === "subagentWait" ? (
          <ThreadCommandExecutionDetails
            browseResultEntries={browseResultEntries}
            inlineMentionSources={inlineMentionSources}
            isMostRecent={isMostRecent && index === renderSegments.length - 1}
            item={segment.group.anchor.item}
            key={`subagent-wait:${segment.group.anchor.item.id}`}
            knownSkills={knownSkills}
            projectFilePaths={projectFilePaths}
            projectId={projectId}
            projectRootPath={projectRootPath}
            relatedThreadsById={relatedThreadsById}
            subagentWaitTiming={getThreadSubagentWaitTiming(segment.group, itemTimeline)}
            subagents={subagents}
            threadId={threadId}
            workspaceRoots={workspaceRoots}
          />
        ) : (
          <ThreadRegularCommandSequence
            browseResultEntries={browseResultEntries}
            inlineMentionSources={inlineMentionSources}
            isMostRecent={isMostRecent && index === renderSegments.length - 1}
            items={segment.items}
            key={`commands:${segment.items[0]?.id ?? index}`}
            knownSkills={knownSkills}
            projectFilePaths={projectFilePaths}
            projectId={projectId}
            projectRootPath={projectRootPath}
            relatedThreadsById={relatedThreadsById}
            subagents={subagents}
            threadCwdPath={threadCwdPath}
            threadId={threadId}
            workspaceRoots={workspaceRoots}
          />
        )
      ))}
    </div>
  );
}

function ThreadFallbackItem ({ item }: { item: NonGroupedItem | WorkbenchProjectedUnknownItem }) {
  const isUnknownProjection = item.type === "unknown";
  return (
    <ThreadDisclosure
      className="py-2"
      contentClassName="mt-2 pl-6"
      summary={<ThreadSummaryText text={isUnknownProjection ? "Unknown thread item" : item.type} />}
      summaryClassName="text-[0.92em] leading-[1.6] text-muted"
    >
      <pre className="m-0 max-w-full overflow-x-auto whitespace-pre rounded-[0.9rem] bg-[color-mix(in_srgb,var(--text)_4%,transparent)] px-4 py-3 font-mono text-[0.78em] leading-[1.6] text-text">
        {JSON.stringify(isUnknownProjection ? item.safeValue : item, null, 2)}
      </pre>
    </ThreadDisclosure>
  );
}

function ThreadRenderableBlockViewComponent ({
  block,
  browseResultEntries,
  finalAgentMessageId,
  inlineMentionSources,
  itemTimeline,
  isMostRecentBlock,
  knownSkills,
  presentationSource,
  primaryUserBlock,
  threadCwdPath,
  threadId,
  projectFilePaths,
  projectId,
  projectRootPath,
  relatedThreadsById,
  subagents,
  turnCompletedAt,
  turnId,
  turnStartedAt,
  turnStatus,
  workspaceRoots,
}: {
  block: ThreadRenderableBlock;
  browseResultEntries?: readonly WorkbenchBrowseResultEntry[];
  finalAgentMessageId: string | null;
  inlineMentionSources?: InlineMentionHighlightSources | null;
  itemTimeline?: readonly WorkbenchThreadItemTimelineEntry[];
  isMostRecentBlock: boolean;
  knownSkills?: WorkbenchSkillSummary[];
  presentationSource?: ThreadTextPresentationSource | null;
  primaryUserBlock: ThreadRenderableBlock | null;
  threadCwdPath?: string;
  threadId: string;
  projectFilePaths?: readonly string[];
  projectId?: string | null;
  projectRootPath?: string;
  relatedThreadsById: RelatedThreadsById;
  subagents: readonly WorkbenchSubagentSummary[];
  turnCompletedAt: number | null;
  turnId: string;
  turnStartedAt: number | null;
  turnStatus: Turn["status"];
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
}) {
  if (block.kind === "commandSequence") {
    return <ThreadCommandSequence browseResultEntries={browseResultEntries} inlineMentionSources={inlineMentionSources} isMostRecent={isMostRecentBlock} itemTimeline={itemTimeline} items={block.items} knownSkills={knownSkills} presentationSource={presentationSource} projectFilePaths={projectFilePaths} projectId={projectId} projectRootPath={projectRootPath} relatedThreadsById={relatedThreadsById} subagents={subagents} threadCwdPath={threadCwdPath} threadId={threadId} turnId={turnId} workspaceRoots={workspaceRoots} />;
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
        presentationSource={presentationSource}
        projectFilePaths={projectFilePaths}
        projectId={projectId}
        threadCwdPath={threadCwdPath}
        threadId={threadId}
        turnId={turnId}
        projectRootPath={projectRootPath}
        workspaceRoots={workspaceRoots}
      />
    );
  }

  if (block.kind === "webSearchSequence") {
    return <ThreadWebSearchSequence items={block.items} />;
  }

  switch (block.item.type) {
    case "functionCallOutput": {
      const item = readWorkbenchToolOutput(block.item);
      if (!item) return <ThreadFallbackItem item={block.item} />;
      const timeline = findWorkbenchThreadItemTimelineEntry(item.id, itemTimeline);
      const timestamp = timeline?.firstSeenAt ?? item.workbenchInjectionAcceptedAt;
      return (
        <ThreadToolOutputItem
          item={item}
          subagents={subagents}
          timestamp={timestamp === undefined || timestamp === null ? undefined : <ThreadMessageTimestamp className="mt-1" timestampSeconds={timestamp / 1_000} />}
          inlineMentionSources={inlineMentionSources}
          projectFilePaths={projectFilePaths}
          projectId={projectId}
          threadCwdPath={threadCwdPath}
          projectRootPath={projectRootPath}
          workspaceRoots={workspaceRoots}
        />
      );
    }
    case "userMessage":
      return (
        <ThreadUserMessageItem
          item={block.item}
          inlineMentionSources={inlineMentionSources}
          projectFilePaths={projectFilePaths}
          projectId={projectId}
          threadCwdPath={threadCwdPath}
          projectRootPath={projectRootPath}
          subagents={subagents}
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
          presentationSource={presentationSource}
          inlineMentionSources={inlineMentionSources}
          projectFilePaths={projectFilePaths}
          projectId={projectId}
          threadCwdPath={threadCwdPath}
          projectRootPath={projectRootPath}
          threadId={threadId}
          turnId={turnId}
          workspaceRoots={workspaceRoots}
        />
      );
    case "plan":
      return (
        <ThreadPlanItem
          inlineMentionSources={inlineMentionSources}
          item={block.item}
          presentationSource={presentationSource}
          threadCwdPath={threadCwdPath}
          projectFilePaths={projectFilePaths}
          projectId={projectId}
          projectRootPath={projectRootPath}
          threadId={threadId}
          turnId={turnId}
          workspaceRoots={workspaceRoots}
        />
      );
    case "contextCompaction": {
      const timelineEntry = findWorkbenchThreadItemTimelineEntry(block.item.id, itemTimeline);
      const isActive = turnStatus === "inProgress" && (!timelineEntry || timelineEntry.completedAt === null);
      return <ThreadContextCompactionItem isActive={isActive} item={block.item} />;
    }
    case "mcpToolCall": {
      const route = getWorkbenchMcpCommandRoute({
        argumentsValue: block.item.arguments,
        context: threadCwdPath ? { cwd: threadCwdPath, projectRootPath, workspaceRoots } : undefined,
        server: block.item.server,
        tool: block.item.tool,
      });
      const isMcpFailure = block.item.status === "failed" || Boolean(block.item.error);
      if (shouldUseWorkbenchMcpSpecializedRenderer(route, isMcpFailure) && route?.kind === "specialized" && threadCwdPath) {
        return (
          <ThreadWorkbenchCommandItem
            inlineMentionSources={inlineMentionSources}
            item={block.item}
            projectFilePaths={projectFilePaths}
            projectId={projectId}
            projectRootPath={projectRootPath}
            relatedThreadsById={relatedThreadsById}
            renderRecallRecord={(record) => (
              <ThreadRecallRecordItem
                inlineMentionSources={inlineMentionSources}
                record={record}
                projectFilePaths={projectFilePaths}
                projectId={projectId}
                projectRootPath={projectRootPath}
                threadCwdPath={threadCwdPath}
                workspaceRoots={workspaceRoots}
              />
            )}
            renderSubagentActivity={(thread) => (
              <ThreadSubagentCurrentActivityPreview
                inlineMentionSources={inlineMentionSources}
                knownSkills={knownSkills}
                projectFilePaths={projectFilePaths}
                projectId={projectId}
                projectRootPath={projectRootPath}
                relatedThreadsById={relatedThreadsById}
                thread={thread}
                workspaceRoots={workspaceRoots}
              />
            )}
            route={route}
            subagents={subagents}
            threadCwdPath={threadCwdPath}
            threadId={threadId}
            workspaceRoots={workspaceRoots}
          />
        );
      }
      const browseDetails = route?.kind === "simple" && route.rendering.claimedBy === "browse.command"
        ? mergeCommandDetailRowsWithBrowseOutput(
          route.rendering.result.detailRows,
          formatToolCallOutput({
            content: block.item.result?.content,
            fallback: block.item.result?.structuredContent ?? block.item.result?._meta,
          }),
          (browseResultEntries ?? []).filter((entry) => entry.commandItemId === block.item.id),
          block.item.status,
        )
        : [];
      return (
        <ThreadMcpToolCallItem
          details={browseDetails.length ? (
            <ThreadCommandDetailRows rows={browseDetails} projectFilePaths={projectFilePaths} projectId={projectId} />
          ) : undefined}
          item={block.item}
          projectFilePaths={projectFilePaths}
          projectId={projectId}
          route={route}
        />
      );
    }
    case "dynamicToolCall":
      return <ThreadDynamicToolCallItem inlineMentionSources={inlineMentionSources} item={block.item} threadCwdPath={threadCwdPath} projectFilePaths={projectFilePaths} projectId={projectId} projectRootPath={projectRootPath} workspaceRoots={workspaceRoots} />;
    case "webSearch":
      return <ThreadWebSearchItem item={block.item} />;
    case "collabAgentToolCall":
      return null;
    default:
      return <ThreadFallbackItem item={block.item} />;
  }
}

const ThreadRenderableBlockView = memo(ThreadRenderableBlockViewComponent, (left, right) => (
  left.block === right.block
  && left.browseResultEntries === right.browseResultEntries
  && left.finalAgentMessageId === right.finalAgentMessageId
  && (left.inlineMentionSources?.cacheKey ?? "") === (right.inlineMentionSources?.cacheKey ?? "")
  && left.itemTimeline === right.itemTimeline
  && left.isMostRecentBlock === right.isMostRecentBlock
  && left.knownSkills === right.knownSkills
  && left.presentationSource?.kind === right.presentationSource?.kind
  && left.presentationSource?.sourceKey === right.presentationSource?.sourceKey
  && left.primaryUserBlock === right.primaryUserBlock
  && left.threadCwdPath === right.threadCwdPath
  && left.threadId === right.threadId
  && left.projectFilePaths === right.projectFilePaths
  && left.projectId === right.projectId
  && left.projectRootPath === right.projectRootPath
  && left.relatedThreadsById === right.relatedThreadsById
  && left.subagents === right.subagents
  && left.turnCompletedAt === right.turnCompletedAt
  && left.turnId === right.turnId
  && left.turnStartedAt === right.turnStartedAt
  && left.turnStatus === right.turnStatus
  && left.workspaceRoots === right.workspaceRoots
));

interface ThreadTranscriptItemsDetailsProps {
  browseResultEntries?: readonly WorkbenchBrowseResultEntry[];
  hiddenReasoningStep?: ThreadReasoningStepReference | null;
  inlineMentionSources?: InlineMentionHighlightSources | null;
  itemTimeline?: readonly WorkbenchThreadItemTimelineEntry[];
  items: readonly WorkbenchProjectedTranscriptItem[];
  knownSkills?: WorkbenchSkillSummary[];
  presentationSource?: ThreadTextPresentationSource | null;
  projectFilePaths?: readonly string[];
  projectId?: string | null;
  projectRootPath?: string;
  relatedThreadsById?: RelatedThreadsById;
  subagents?: readonly WorkbenchSubagentSummary[];
  threadCwdPath?: string;
  threadId: string;
  turnId: string;
  turnCompletedAt: number | null;
  turnStartedAt: number | null;
  turnStatus: Turn["status"];
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
}

export function ThreadTranscriptItemsDetails ({
  browseResultEntries = EMPTY_BROWSE_SCREENSHOT_ENTRIES,
  hiddenReasoningStep = null,
  inlineMentionSources,
  itemTimeline,
  items,
  knownSkills = [],
  presentationSource = null,
  projectFilePaths,
  projectId,
  projectRootPath,
  relatedThreadsById = {},
  subagents = [],
  threadCwdPath,
  threadId,
  turnId,
  turnCompletedAt,
  turnStartedAt,
  turnStatus,
  workspaceRoots,
}: ThreadTranscriptItemsDetailsProps) {
  type RenderEntry =
    | { block: ThreadRenderableBlock; kind: "block" }
    | { item: Extract<WorkbenchProjectedTranscriptItem, { type: "unknown" }>; kind: "unknown" };
  const entries: RenderEntry[] = [];
  let pendingItems: ThreadItem[] = [];
  const flushItems = () => {
    if (!pendingItems.length) return;
    entries.push(...buildRenderableBlocks(
      pendingItems,
      { reasoningStep: hiddenReasoningStep },
      threadCwdPath,
    ).map((block) => ({ block, kind: "block" as const })));
    pendingItems = [];
  };
  for (const item of items) {
    if (item.type === "unknown") {
      flushItems();
      entries.push({ item, kind: "unknown" });
    } else {
      pendingItems.push(isProjectedInteractionItem(item)
        ? adaptProjectedInteractionItem(item)
        : item);
    }
  }
  flushItems();

  const primaryUserBlock = entries.flatMap((entry) => (
    entry.kind === "block" && isUserMessageBlock(entry.block) ? [entry.block] : []
  )).at(0) ?? null;
  const finalAgentMessageId = [...items].reverse().find((item) => (
    item.type === "agentMessage" && item.phase === "final_answer"
  ))?.id
    ?? null;

  return (
    <div className="space-y-2">
      {entries.map((entry, index) => entry.kind === "unknown" ? (
        <ThreadFallbackItem key={`unknown:${entry.item.id}`} item={entry.item} />
      ) : (
        <ThreadRenderableBlockView
          key={`${getRenderableBlockKey(entry.block)}:${index}`}
          block={entry.block}
          browseResultEntries={browseResultEntries}
          finalAgentMessageId={finalAgentMessageId}
          inlineMentionSources={inlineMentionSources}
          itemTimeline={itemTimeline}
          isMostRecentBlock={index === entries.length - 1}
          knownSkills={knownSkills}
          presentationSource={presentationSource}
          primaryUserBlock={primaryUserBlock}
          threadCwdPath={threadCwdPath}
          threadId={threadId}
          projectFilePaths={projectFilePaths}
          projectId={projectId}
          projectRootPath={projectRootPath}
          relatedThreadsById={relatedThreadsById}
          subagents={subagents}
          turnCompletedAt={turnCompletedAt}
          turnId={turnId}
          turnStartedAt={turnStartedAt}
          turnStatus={turnStatus}
          workspaceRoots={workspaceRoots}
        />
      ))}
    </div>
  );
}

export function ThreadTranscriptItemDetails ({
  item,
  ...props
}: Omit<ThreadTranscriptItemsDetailsProps, "items"> & {
  item: WorkbenchProjectedTranscriptItem;
}) {
  return <ThreadTranscriptItemsDetails {...props} items={[item]} />;
}

function ThreadTurnDetailsComponent ({
  defaultOpenCompletedWork = false,
  browseResultEntries = EMPTY_BROWSE_SCREENSHOT_ENTRIES,
  flattenCompletedWork = false,
  hiddenDynamicToolCallItemIds = [],
  hideFinalAgentMessage = false,
  hideTerminalReasoning = false,
  hideTopBorder = false,
  hideWorkbenchControlAgentMessages = false,
  hideWorkbenchControlUserMessages = false,
  hiddenReasoningStep = null,
  hoistedGitArcProposalIds = EMPTY_HOISTED_GIT_ARC_PROPOSAL_IDS,
  hiddenWebSearchItemIds = [],
  inlineMentionSources = null,
  itemTimeline = [],
  knownSkills = [],
  presentationSource = null,
  threadCwdPath,
  threadId,
  projectFilePaths,
  projectId,
  projectRootPath,
  relatedThreadsById = {},
  subagents = [],
  turn,
  workspaceRoots,
}: {
  defaultOpenCompletedWork?: boolean;
  browseResultEntries?: readonly WorkbenchBrowseResultEntry[];
  flattenCompletedWork?: boolean;
  hiddenDynamicToolCallItemIds?: readonly string[];
  hideFinalAgentMessage?: boolean;
  hideTerminalReasoning?: boolean;
  hideTopBorder?: boolean;
  hideWorkbenchControlAgentMessages?: boolean;
  hideWorkbenchControlUserMessages?: boolean;
  hiddenReasoningStep?: ThreadReasoningStepReference | null;
  hoistedGitArcProposalIds?: ReadonlySet<string>;
  hiddenWebSearchItemIds?: readonly string[];
  inlineMentionSources?: InlineMentionHighlightSources | null;
  itemTimeline?: readonly WorkbenchThreadItemTimelineEntry[];
  knownSkills?: WorkbenchSkillSummary[];
  presentationSource?: ThreadTextPresentationSource | null;
  threadCwdPath?: string;
  threadId: string;
  projectFilePaths?: readonly string[];
  projectId?: string | null;
  projectRootPath?: string;
  relatedThreadsById?: RelatedThreadsById;
  subagents?: readonly WorkbenchSubagentSummary[];
  turn: Turn;
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
}) {
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
  const baseHiddenItemIds = useMemo(() => ({
    controlAgentMessages: hideWorkbenchControlAgentMessages && isWorkbenchControlTurn,
    controlUserMessages: hideWorkbenchControlUserMessages,
    dynamicToolCallIds: hiddenDynamicToolCallIds,
    reasoningStep: hiddenReasoningStep,
    webSearchItemIds: hiddenWebSearchIds,
  } satisfies HiddenThreadItemIds), [
    hiddenDynamicToolCallIds,
    hiddenReasoningStep,
    hiddenWebSearchIds,
    hideWorkbenchControlAgentMessages,
    hideWorkbenchControlUserMessages,
    isWorkbenchControlTurn,
  ]);
  const baseRenderableBlocks = useMemo(
    () => buildRenderableBlocks(turn.items, baseHiddenItemIds, threadCwdPath),
    [baseHiddenItemIds, threadCwdPath, turn.items],
  );
  const finishedTailHiddenItemIds = useMemo(() => getFinishedThreadTailHiddenItemIds({
    hideReasoning: hideTerminalReasoning,
    hoistedProposalIds: hoistedGitArcProposalIds,
    itemGroups: baseRenderableBlocks
      .filter((block) => block.kind !== "item" || block.item.type !== "collabAgentToolCall")
      .map(getRenderableBlockItems),
    knownSkills,
    projectRootPath,
    workspaceRoots,
  }), [
    baseRenderableBlocks,
    hideTerminalReasoning,
    hoistedGitArcProposalIds,
    knownSkills,
    projectRootPath,
    workspaceRoots,
  ]);
  const hiddenItemIds = useMemo(() => ({
    ...baseHiddenItemIds,
    itemIds: finishedTailHiddenItemIds,
  } satisfies HiddenThreadItemIds), [baseHiddenItemIds, finishedTailHiddenItemIds]);
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
  const completedWorkPartition = useMemo(() => (
    isCompleted
      ? partitionCompletedThreadWork({
        finalAgentMessageId,
        itemTimeline,
        items: turn.items,
        primaryUserItemId: primaryUserItem?.id ?? null,
      })
      : null
  ), [finalAgentMessageId, isCompleted, itemTimeline, primaryUserItem?.id, turn.items]);
  const visibleTerminalItems = useMemo(() => (
    completedWorkPartition?.terminalItems.filter((item) => !hideFinalAgentMessage || item.id !== finalAgentMessageId) ?? []
  ), [completedWorkPartition, finalAgentMessageId, hideFinalAgentMessage]);
  const pinnedCompactionItemIds = useMemo(() => new Set([
    completedWorkPartition ? null : primaryUserItem?.id,
    completedWorkPartition || hideFinalAgentMessage ? null : finalAgentItem?.id,
  ].filter((itemId): itemId is string => Boolean(itemId))), [completedWorkPartition, finalAgentItem?.id, hideFinalAgentMessage, primaryUserItem?.id]);
  const compactionRenderPlan = useMemo(() => createThreadTurnCompactionRenderPlan({
    itemTimeline,
    items: completedWorkPartition?.workedItems ?? turn.items,
    pinnedItemIds: pinnedCompactionItemIds,
  }), [completedWorkPartition, itemTimeline, pinnedCompactionItemIds, turn.items]);
  const turnBrowseResultEntries = browseResultEntries;
  const renderableBlocks = useMemo(
    () => buildRenderableBlocks(turn.items, hiddenItemIds, threadCwdPath),
    [hiddenItemIds, threadCwdPath, turn.items],
  );
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
      browseResultEntries={turnBrowseResultEntries}
      finalAgentMessageId={finalAgentMessageId}
      inlineMentionSources={inlineMentionSources}
      itemTimeline={itemTimeline}
      isMostRecentBlock={block === blockList[blockList.length - 1]}
      knownSkills={knownSkills}
      presentationSource={presentationSource}
      primaryUserBlock={primaryUserBlock}
      threadCwdPath={threadCwdPath}
      threadId={threadId}
      projectFilePaths={projectFilePaths}
      projectId={projectId}
      projectRootPath={projectRootPath}
      relatedThreadsById={relatedThreadsById}
      subagents={subagents}
      turnCompletedAt={turn.completedAt}
      turnId={turn.id}
      turnStartedAt={turn.startedAt}
      turnStatus={turn.status}
      workspaceRoots={workspaceRoots}
    />
  );

  const buildBlocksForItems = (items: ThreadItem[]) => buildRenderableBlocks(items, hiddenItemIds, threadCwdPath);
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
    const terminalBlocks = isCompleted ? buildBlocksForItems(visibleTerminalItems) : [];
    const hasWorkedContent = Boolean(compactionRenderPlan.collapsedEarlierSection || compactionRenderPlan.visibleItems.length);
    if (isCompleted && hideFinalAgentMessage && hideWorkbenchControlUserMessages && !primaryUserBlock && !hasWorkedContent && !terminalBlocks.length) {
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
            {renderBlocks(terminalBlocks, primaryUserBlock)}
          </div>
        ) : isCompleted ? (
          <div className="space-y-2">
            {primaryUserBlock ? renderBlock(primaryUserBlock, 0, primaryUserBlocks, primaryUserBlock) : null}
            <ThreadDisclosure
              className="py-2"
              contentClassName="mt-2 space-y-2 pl-6"
              defaultOpen={defaultOpenCompletedWork}
              renderContent={renderCompactionWorkContent}
              summary={completedWorkPartition?.statusMarkerId
                ? getWorkedSummaryForDuration(completedWorkPartition.workedDurationMs)
                : getWorkedSummary(turn)}
              summaryClassName="text-[0.92em] leading-[1.6] text-muted"
            />
            {renderBlocks(terminalBlocks, primaryUserBlock)}
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
    const terminalBlocks = buildBlocksForItems(visibleTerminalItems);
    const workedItems = completedWorkPartition?.workedItems ?? [];
    if (hideFinalAgentMessage && hideWorkbenchControlUserMessages && !primaryUserBlock && !workedItems.length && !terminalBlocks.length) {
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
            defaultOpen={defaultOpenCompletedWork}
            renderContent={renderCompletedWorkedContent}
            summary={completedWorkPartition?.statusMarkerId
              ? getWorkedSummaryForDuration(completedWorkPartition.workedDurationMs)
              : getWorkedSummary(turn)}
            summaryClassName="text-[0.92em] leading-[1.6] text-muted"
          />
          {renderBlocks(terminalBlocks, primaryUserBlock)}
        </div>
      </section>
    );
  }

  const blocks = allBlocks;
  const primaryUserBlock = isCompleted
    ? blocks.find((block) => isUserMessageBlock(block)) ?? null
    : null;
  const terminalBlocks = isCompleted ? buildBlocksForItems(visibleTerminalItems) : [];
  const workedBlocks = isCompleted
    ? buildBlocksForItems(completedWorkPartition?.workedItems ?? [])
    : blocks;
  if (isCompleted && hideFinalAgentMessage && hideWorkbenchControlUserMessages && !primaryUserBlock && !workedBlocks.length && !terminalBlocks.length) {
    return null;
  }

  return (
    <section className={hideTopBorder ? "py-3" : "border-t border-[color-mix(in_srgb,var(--text)_10%,transparent)] py-3"}>
      {isCompleted && flattenCompletedWork ? (
        <div className="space-y-2">
          {primaryUserBlock ? renderBlock(primaryUserBlock, 0, blocks, primaryUserBlock) : null}
          {renderBlocks(workedBlocks, primaryUserBlock)}
          {renderBlocks(terminalBlocks, primaryUserBlock)}
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
    && left.defaultOpenCompletedWork === right.defaultOpenCompletedWork
    && left.flattenCompletedWork === right.flattenCompletedWork
    && left.hiddenDynamicToolCallItemIds === right.hiddenDynamicToolCallItemIds
    && left.hideFinalAgentMessage === right.hideFinalAgentMessage
    && left.hideTerminalReasoning === right.hideTerminalReasoning
    && left.hideTopBorder === right.hideTopBorder
    && left.hideWorkbenchControlAgentMessages === right.hideWorkbenchControlAgentMessages
    && left.hideWorkbenchControlUserMessages === right.hideWorkbenchControlUserMessages
    && left.hiddenReasoningStep === right.hiddenReasoningStep
    && left.hoistedGitArcProposalIds === right.hoistedGitArcProposalIds
    && left.hiddenWebSearchItemIds === right.hiddenWebSearchItemIds
    && left.browseResultEntries === right.browseResultEntries
    && left.inlineMentionSources === right.inlineMentionSources
    && left.itemTimeline === right.itemTimeline
    && left.knownSkills === right.knownSkills
    && left.presentationSource?.kind === right.presentationSource?.kind
    && left.presentationSource?.sourceKey === right.presentationSource?.sourceKey
    && left.threadCwdPath === right.threadCwdPath
    && left.threadId === right.threadId
    && left.projectFilePaths === right.projectFilePaths
    && left.projectId === right.projectId
    && left.projectRootPath === right.projectRootPath
    && left.relatedThreadsById === right.relatedThreadsById
    && left.subagents === right.subagents;
}

export const ThreadTurnDetails = memo(ThreadTurnDetailsComponent, areThreadTurnDetailsPropsEqual);

export function ThreadThreadContent ({
  browseResultEntries = EMPTY_BROWSE_SCREENSHOT_ENTRIES,
  defaultOpenCompletedWork = false,
  emptyMessage = "No subagent activity was captured yet.",
  flattenCompletedWork = false,
  hiddenDynamicToolCallItemIds = [],
  hideFinalAgentMessage = false,
  hideFirstTurnTopBorder = false,
  hideWorkbenchControlAgentMessages = false,
  hideWorkbenchControlUserMessages = false,
  hiddenReasoningStep = null,
  hiddenWebSearchItemIds = [],
  inlineMentionSources = null,
  knownSkills = [],
  threadCwdPath,
  projectFilePaths,
  projectId,
  projectRoots,
  projectRootPath,
  relatedThreadsById = {},
  subagents = [],
  thread,
}: {
  browseResultEntries?: readonly WorkbenchBrowseResultEntry[];
  defaultOpenCompletedWork?: boolean;
  emptyMessage?: string;
  flattenCompletedWork?: boolean;
  hiddenDynamicToolCallItemIds?: readonly string[];
  hideFinalAgentMessage?: boolean;
  hideFirstTurnTopBorder?: boolean;
  hideWorkbenchControlAgentMessages?: boolean;
  hideWorkbenchControlUserMessages?: boolean;
  hiddenReasoningStep?: ThreadReasoningStepReference | null;
  hiddenWebSearchItemIds?: readonly string[];
  inlineMentionSources?: InlineMentionHighlightSources | null;
  knownSkills?: WorkbenchSkillSummary[];
  threadCwdPath?: string;
  projectFilePaths?: readonly string[];
  projectId?: string | null;
  projectRoots?: readonly { id: string; rootPath: string }[];
  projectRootPath?: string;
  relatedThreadsById?: RelatedThreadsById;
  subagents?: readonly WorkbenchSubagentSummary[];
  thread: ThreadPayload | null | undefined;
}) {
  const renderProjection = useMemo(
    () => thread ? projectThreadRenderTurns(thread, browseResultEntries) : null,
    [browseResultEntries, thread],
  );
  const renderThread = renderProjection?.thread ?? null;
  const browseResultEntriesByTurnId = useStableBrowseResultEntriesByTurn(renderProjection?.browseResultEntries ?? EMPTY_BROWSE_SCREENSHOT_ENTRIES);

  if (!renderThread) {
    return <ThreadContentLoadingSkeleton />;
  }

  if (!renderThread.turns.length) {
    const unloadedEntry = renderThread.turnHistory.find((entry) => entry.loadState !== "loaded");
    if (unloadedEntry) {
      return <ThreadTurnLoadingSkeleton entry={unloadedEntry} />;
    }

    return (
      <p className="m-0 text-[0.92em] leading-[1.6] text-muted">
        {emptyMessage}
      </p>
    );
  }

  const loadedTurnsById = new Map(renderThread.turns.map((turn) => [turn.id, turn]));
  const visibleEntries = (renderThread.turnHistory.length ? renderThread.turnHistory : renderThread.turns.map((turn) => ({
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
            browseResultEntries={browseResultEntriesByTurnId.get(entry.turnId) ?? EMPTY_BROWSE_SCREENSHOT_ENTRIES}
            defaultOpenCompletedWork={defaultOpenCompletedWork}
            flattenCompletedWork={flattenCompletedWork}
            hiddenDynamicToolCallItemIds={hiddenDynamicToolCallItemIds}
            hideFinalAgentMessage={hideFinalAgentMessage}
            hideTopBorder={hideFirstTurnTopBorder && index === 0}
            hideWorkbenchControlAgentMessages={hideWorkbenchControlAgentMessages}
            hideWorkbenchControlUserMessages={hideWorkbenchControlUserMessages}
            hiddenReasoningStep={hiddenReasoningStep}
            hiddenWebSearchItemIds={hiddenWebSearchItemIds}
            inlineMentionSources={inlineMentionSources}
            itemTimeline={entry.itemTimeline}
            knownSkills={knownSkills}
            threadCwdPath={threadCwdPath ?? renderThread.cwd}
            threadId={renderThread.id}
            projectFilePaths={projectFilePaths}
            projectId={projectId}
            projectRootPath={projectRootPath}
            relatedThreadsById={relatedThreadsById}
            subagents={subagents}
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
