/*
 * Exports:
 * - ThreadTranscriptItemDetails: render one provider or relational transcript item.
 * - ThreadTranscriptItemsDetails: render shared item groups with optional SQL-only off-screen worked runs.
 * - ThreadTurnDetails: render one turn with grouped commands and typed item sections.
 * - ThreadThreadContent: render all turns without composer chrome.
 * - ThreadTurnLoadingSkeleton: render a placeholder for unloaded history turns.
 * - ThreadTurnLoadFailure: render retry controls for a failed history read.
 * Keep runtime exports component-only for React Refresh.
 */
"use client";

import {
  memo, useCallback, useContext, useEffect, useMemo, useRef, useState,
  type ComponentProps, type ReactNode,
} from "react";

import type { ThreadItem, UserInput } from "workbench-shared/workbench/thread/workbench-thread-items";
import type { Turn } from "workbench-shared/workbench/thread/workbench-thread-turn";
import { useThread } from "../use-thread";
import type { RelatedThread } from "../../../workbench/thread/ThreadStore";
import WorkbenchClientContext from "../workbench-client-context";
import type { ThreadPayload, WorkbenchBrowseResultEntry, WorkbenchSkillSummary, WorkbenchSubagentSummary, WorkbenchThreadTurnHistoryEntry } from "workbench-shared/types";
import {
  findWorkbenchThreadItemTimelineEntry,
  getThreadItemTimelineDurationMs,
  upsertWorkbenchThreadItemTimelineEntry,
  type WorkbenchThreadItemTimelineEntry,
} from "workbench-shared/workbench/thread/thread-item-timeline";
import type { WorkbenchThreadRecallOutputRecord } from "../../../workbench/thread/thread-recall-output";
import { getThreadItemsRenderChunkSignature } from "../../../workbench/thread/thread-item-signature";
import type { WorkspaceFileLinkRoot } from "../../../workbench/markdown/markdown-links";
import type {
  WorkbenchProjectedInteractionItem,
  WorkbenchProjectedTranscriptItem,
  WorkbenchProjectedGenericItem,
} from "workbench-shared/workbench/transcript/workbench-transcript-projection";
import type { InlineMentionHighlightSources } from "../../../workbench/thread/inline-mention-highlights";
import type { ThreadTextPresentationSource } from "../../../workbench/thread/ThreadTextPresentationController";
import { enterMotionClassName } from "../../../tailwind/enter-motion-classes";
import {
  WORKBENCH_QUESTIONNAIRE_TOOL_NAME,
} from "workbench-shared/workbench/thread/thread-questionnaire-history";

import {
  getAgentScreenshotSteerImages,
  isAgentScreenshotSteerUserMessage,
} from "workbench-shared/workbench/thread/thread-steer-markers";
import { getWorkbenchInputState } from "workbench-shared/workbench/thread/thread-input-item";
import { parseGitArcEditText } from "workbench-shared/workbench/git/git-arc-edit-contracts";
import { isUndeliveredInitialOptimisticInputItem } from "../../../workbench/thread/thread-optimistic-items";
import {
  readWorkbenchAgentMessageInput,
  readWorkbenchAgentMessageItem,
} from "workbench-shared/workbench/thread/thread-agent-message";
import { readWorkbenchToolOutput } from "workbench-shared/workbench/thread/thread-tool-output";
import {
  isVisibleWorkbenchAgentMessageText, isWorkbenchHiddenSystemSteerInput, stripWorkbenchTurnEndMarker,
} from "workbench-shared/workbench/thread/thread-recovery-message";
import { unwrapWorkbenchSteerDisplayInput } from "workbench-shared/workbench/thread/thread-steer-display";
import {
  getThreadCommandBlockDisplay,
  getThreadCommandDisplay,
  getThreadCommandExecutionOutcome,
  isThreadMcpWaitInterruptedBySteer,
  getThreadCommandOutcomeDisplay,
  getWorkbenchMcpCommandDisplay,
  getWorkbenchMcpCommandRoute,
  getNativeToolDisplay,
  shouldUseWorkbenchMcpSpecializedRenderer,
  getGitArcMatcherAction,
  isBrowseCommandMatcherClaim,
  isGitCheckpointCompareMatcherClaim,
  isGitCheckpointDiffMatcherClaim,
  parseWorkbenchMessageCommand,
  parseWorkbenchSubagentCommand,
  parseBrowseSequenceCommandOutput,
  parseGitCheckpointCompareOutput,
  parseGitCheckpointDiffArtifactId,
  parseGitCheckpointDiffOutput,
  parseGitArcCommand,
  parseGitArcReceipt,
  parseWorkbenchFeedbackCommand,
  parseWorkbenchFeedbackId,
  parseWorkbenchVisCommand,
  type ThreadCommandSummaryDisplay,
  type ThreadCommandDetailRow,
} from "../../../workbench/thread/thread-command-matchers";
import {
  getSubagentSummary,
  resolveWorkbenchSubagentCommandTargets,
} from "../../../workbench/thread/thread-subagents";
import { formatDuration } from "workbench-shared/workbench/format-duration";
import {
  humanizeThreadLabel,
  truncateThreadText,
} from "./thread-view-formatters";
import { ThreadCommandSummary } from "./thread-view-primitives";
import { ThreadItemApprovalsContext, useThreadItemApproval } from "../../../workbench/thread/thread-item-approvals";
import ThreadGitArcProposalItem from "./ThreadGitArcProposalItem";
import ThreadCheckpointCompareItem from "./ThreadCheckpointCompareItem";
import ThreadCheckpointDiffItem from "./ThreadCheckpointDiffItem";
import { getThreadEntryMotionIdentity } from "./ThreadEntryMotionController";
import { ThreadEntryMotion } from "./thread-scroll-viewport-context";
import {
  createThreadGitArcCompareSummaryRows,
  createThreadGitArcDiffSummaryRows,
} from "./ThreadGitArcCollapsedSummary";
import ThreadGitArcItem from "./ThreadGitArcItem";
import { readThreadGitArcProposalTranscriptItem } from "./thread-git-arc-presentation";
import ThreadCodeDisplay, { ThreadCommandHeader } from "./ThreadCodeDisplay";
import ThreadCommandDisplay from "./ThreadCommandDisplay";
import ThreadCommandDetailRows from "./ThreadCommandDetailRows";
import ThreadContextCompactionItem from "./ThreadContextCompactionItem";
import ThreadContextCommandItem from "./ThreadContextCommandItem";
import ThreadDisclosure, { ThreadDisclosureStaticRow } from "./ThreadDisclosure";
import ThreadMeasuredContent from "./ThreadMeasuredContent";
import ThreadProgressiveWindow, { type ThreadProgressiveWindowChunk } from "./ThreadProgressiveWindow";
import ThreadGenericItem from "./ThreadGenericItem";
import ThreadDurationText from "./ThreadDurationText";
import ThreadDynamicToolCallItem from "./ThreadDynamicToolCallItem";
import ThreadFileChangeItem from "./ThreadFileChangeItem";
import ThreadFeedbackCommandItem from "./ThreadFeedbackCommandItem";
import ThreadVisCommandItem from "./ThreadVisCommandItem";
import ThreadMarkdown from "./ThreadMarkdown";
import ThreadMcpToolCallItem from "./ThreadMcpToolCallItem";
import ThreadPlanSummary from "./ThreadPlanSummary";
import ThreadReasoningItem from "./ThreadReasoningItem";
import ThreadSummaryText from "./ThreadSummaryText";
import ThreadSubagentCreateItem from "./ThreadSubagentCreateItem";
import ThreadSentAgentMessageItem, {
  ThreadAgentMessageBubble,
  ThreadAgentMessageClaimAction,
  ThreadAgentMessageTarget,
} from "./ThreadAgentMessageItem";
import ThreadAgentMessageBody from "./ThreadAgentMessageBody";
import ThreadAgentName from "./ThreadAgentName";
import ThreadIncomingAgentMessageGroup from "./ThreadIncomingAgentMessageGroup";
import ThreadIncomingAgentMessageItem from "./ThreadIncomingAgentMessageItem";
import ThreadAgentScreenshotItem from "./ThreadAgentScreenshotItem";
import ThreadToolOutputItem from "./ThreadToolOutputItem";
import ThreadSubagentTargetActionItem from "./ThreadSubagentTargetActionItem";
import ThreadSubagentCoordinationItem from "./ThreadSubagentCoordinationItem";
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
  projectThreadReasoningMarkdown,
  type ThreadReasoningStepReference,
} from "./thread-reasoning-display";
import {
  getThreadSubagentWaitTiming,
  type ThreadSubagentWaitRenderEntry,
  type ThreadSubagentWaitTiming,
} from "./thread-subagent-wait-groups";
import {
  groupThreadSubagentCoordinationConversation,
  readThreadSubagentCoordinationClaimAction,
  readThreadSubagentCoordinationCreate,
  readThreadSubagentCoordinationOutgoingMessage,
  readThreadSubagentCoordinationWait,
  type ThreadSubagentCoordinationTarget,
} from "./thread-subagent-coordination";
import { createThreadTurnCompactionRenderPlan } from "./thread-turn-compaction-sections";
import { partitionCompletedThreadWork } from "./thread-completed-work";
import getFinishedThreadTailHiddenItemIds from "./thread-finished-tail";
import projectThreadRenderTurns from "./thread-render-turns";
import { useStableBrowseResultEntriesByTurn } from "./stable-browse-result-entries";
import { getUserMessageCopyMarkdown } from "./bubble-copy";
import ThreadBubbleCopyButton, { threadBubbleControlClassName } from "./ThreadBubbleCopyButton";
import ThreadSteerDecoration from "./ThreadSteerDecoration";
import ThreadItemActionsContext from "./ThreadItemActionsContext";
import { RefreshCwIcon, StopIcon, XIcon } from "../workbench-icons";
import ThreadMessageTimestamp from "./ThreadMessageTimestamp";
import ThreadCommentaryActionRow from "./ThreadCommentaryActionRow";
import { ThreadMarkdownSectionActionsProvider } from "./ThreadMarkdownSectionActions";
import { buildThreadCommentaryRuns, type ThreadCommentaryRunActions } from "./thread-commentary-runs";
import { splitUserMessageBubbles } from "./user-message-bubbles";
import ComposerReferencePills from "./ComposerReferencePills";
import { readComposerReferenceMessage, type ComposerReference } from "workbench-shared/workbench/thread/composer-reference";
import useThreadPresentedText from "./use-thread-presented-text";
import { useThreadItemLiveDuration } from "./use-thread-live-duration";
import {
  buildRenderableBlocks, buildCommandSequenceRenderSegments, getWorkedBlockRows,
  getRenderableBlockItems, getRenderableBlockKey, getUserMessageDeliveryState, groupIncomingAgentMessageRuns,
  hasReasoningSteps, hasSameBlockTimeline, isBrowseCommandItem, reuseRenderableBlocks,
  type AgentCommentaryItem, type CommandItem, type CommandSequenceItem, type HiddenThreadItemIds, type IncomingAgentMessageItem,
  type SubagentWaitItem, type ThreadRenderableBlock,
} from "./thread-render-blocks";
import ThreadWorkedRun from "./ThreadWorkedRun";
import { getThreadFileChangeTotals } from "./ThreadFileChangeItem";
import { partitionWorkedRows } from "./thread-worked-run";

const EMPTY_BROWSE_SCREENSHOT_ENTRIES: readonly WorkbenchBrowseResultEntry[] = [];

type CommandBlockItem =
  | Pick<CommandItem, "command" | "commandActions" | "cwd" | "shell">
  | { display: ThreadCommandSummaryDisplay };
type ReasoningItem = Extract<ThreadItem, { type: "reasoning" }>;
type RelatedThreadsById = Record<string, RelatedThread | undefined>;

function getActiveItemStartedAtMs(
  item: { id: string; status?: string },
  itemTimeline: readonly WorkbenchThreadItemTimelineEntry[] | null | undefined,
) {
  if (item.status !== "inProgress") return null;
  const timeline = findWorkbenchThreadItemTimelineEntry(item.id, itemTimeline);
  return timeline?.startedAt ?? timeline?.firstSeenAt ?? null;
}

type ThreadCommandDisplay = ReturnType<typeof getThreadCommandDisplay>;

const THREAD_WINDOW_CHUNK_SIZE = 6;
const gitCheckpointPresentationByItem = new WeakMap<CommandItem, {
  artifactId: ReturnType<typeof parseGitCheckpointDiffArtifactId>;
  claimedBy: ThreadCommandDisplay["claimedBy"];
  compareChanges: ReturnType<typeof parseGitCheckpointCompareOutput> | null;
  diffChanges: ReturnType<typeof parseGitCheckpointDiffOutput> | null;
  output: string;
  summaryRows: ReturnType<typeof createThreadGitArcCompareSummaryRows>;
}>();

function readGitCheckpointPresentation(item: CommandItem, claimedBy: ThreadCommandDisplay["claimedBy"]) {
  const cached = gitCheckpointPresentationByItem.get(item);
  const output = item.aggregatedOutput ?? "";
  if (cached?.claimedBy === claimedBy && cached.output === output) return cached;
  const compareChanges = isGitCheckpointCompareMatcherClaim(claimedBy)
    ? parseGitCheckpointCompareOutput(output)
    : null;
  const diffChanges = isGitCheckpointDiffMatcherClaim(claimedBy)
    ? parseGitCheckpointDiffOutput(output)
    : null;
  const presentation = {
    artifactId: isGitCheckpointDiffMatcherClaim(claimedBy)
      ? parseGitCheckpointDiffArtifactId(output)
      : null,
    compareChanges,
    diffChanges,
    summaryRows: compareChanges?.length
      ? createThreadGitArcCompareSummaryRows(compareChanges)
      : diffChanges?.length ? createThreadGitArcDiffSummaryRows(diffChanges) : [],
    claimedBy,
    output,
  };
  gitCheckpointPresentationByItem.set(item, presentation);
  return presentation;
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
    <section className="border-t border-[color-mix(in srgb, var(--text) 10%, transparent)] py-3" data-thread-turn-load-state={entry.loadState}>
      <div className="space-y-2" aria-busy={isLoading ? "true" : undefined}>
        <div className="h-3 w-28 animate-pulse rounded bg-[color-mix(in srgb, var(--text) 10%, transparent)]" />
        <div className="space-y-1.5">
          <div className="h-3 w-[82%] animate-pulse rounded bg-[color-mix(in srgb, var(--text) 8%, transparent)]" />
          <div className="h-3 w-[64%] animate-pulse rounded bg-[color-mix(in srgb, var(--text) 7%, transparent)]" />
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
      className="border-t border-[color-mix(in srgb, var(--text) 10%, transparent)] py-3"
      data-thread-turn-load-state={entry.loadState}
    >
      <div className="flex items-center justify-between gap-3 text-[0.88em] leading-[1.5] text-fg/muted" role="status">
        <span>Could not load this previous turn.</span>
        <button
          type="button"
          className="shrink-0 rounded px-2 py-1 font-medium text-text transition-colors hover:bg-[color-mix(in srgb, var(--text) 8%, transparent)]"
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
    if (item.type !== "agentMessage" || !isVisibleWorkbenchAgentMessageText(item.text)) {
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


function isFinalAgentMessageBlock (block: ThreadRenderableBlock, finalAgentMessageId: string | null) {
  return block.kind === "item"
    && block.item.type === "agentMessage"
    && block.item.id === finalAgentMessageId;
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

interface StableRenderableBlockEntry {
  block: ThreadRenderableBlock;
  blockKey: string;
  signature: string;
}

function getRenderableBlockSignature(block: ThreadRenderableBlock) {
  return [
    block.kind,
    getThreadItemsRenderChunkSignature(getRenderableBlockItems(block)),
  ].join("\n");
}

function useStableRenderableBlocks(blocks: ThreadRenderableBlock[], mode: "signature" | "identity" = "signature") {
  const previousEntriesRef = useRef<StableRenderableBlockEntry[]>([]);
  const stableEntries = useMemo(() => {
    if (mode === "identity") {
      return reuseRenderableBlocks(previousEntriesRef.current.map(entry => entry.block), blocks)
        .map(block => ({ block, blockKey: getRenderableBlockKey(block), signature: "" }));
    }
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
  }, [blocks, mode]);

  useEffect(() => {
    previousEntriesRef.current = stableEntries;
  }, [stableEntries]);

  return useMemo(() => stableEntries.map((entry) => entry.block), [stableEntries]);
}

function useEntryMotionAfterMount(enabled: boolean) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return enabled && mounted;
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
          className="[&>p]:mb-[0.45em]"
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
        <p className="m-0 break-all font-mono text-[0.78em] leading-[1.6] text-fg/muted">
          Local image: {input.path}
        </p>
      );
    case "skill":
      return (
        <p className="m-0 text-[0.92em] leading-[1.6] text-fg/muted">
          Skill: <span className="text-text">{input.name}</span>{" "}
          <span className="break-all font-mono text-[0.78em]">({input.path})</span>
        </p>
      );
    case "mention":
      return (
        <p className="m-0 text-[0.92em] leading-[1.6] text-fg/muted">
          Mention: <span className="text-text">{input.name}</span>{" "}
          <span className="break-all font-mono text-[0.78em]">({input.path})</span>
        </p>
      );
    default:
      return null;
  }
}

/** Stored steers the daemon reports undelivered; optimistic browser-only input has nothing to resend or dismiss. */
function storedUndeliveredSteerIds(items: readonly Extract<ThreadItem, { type: "userMessage" }>[]) {
  return items.flatMap((item) => {
    const input = getWorkbenchInputState(item);
    return input?.kind === "steer" && (input.status === "failed" || input.status === "interrupted") ? [item.id] : [];
  });
}

/** Resend or dismiss every undelivered steer in one bubble, in their original order. */
/** Runs one item action at a time, keeping its bounded failure for the hover row's alert. */
function useThreadItemActionRun() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        await action();
      } catch (failure) {
        setError((failure instanceof Error ? failure.message : String(failure)).slice(0, 400));
      } finally {
        setBusy(false);
      }
    })();
  };
  return { busy, error, run };
}

function ThreadItemActionError({ error }: { error: string | null }) {
  return error ? (
    <span
      className="max-w-[18rem] truncate rounded-full bg-[color-mix(in_srgb,var(--text)_4%,var(--bg))] px-2 py-1 text-[0.72em] leading-tight text-danger"
      role="alert"
      title={error}
    >
      {error}
    </span>
  ) : null;
}

function UndeliveredSteerActions({ itemIds }: { itemIds: readonly string[] }) {
  const actions = useContext(ThreadItemActionsContext);
  const { busy, error, run } = useThreadItemActionRun();
  if (!actions || !itemIds.length) return null;
  const runAll = (action: (itemId: string) => Promise<void>) => run(async () => {
    for (const itemId of itemIds) await action(itemId);
  });
  const label = itemIds.length > 1 ? "steers" : "steer";
  return (
    <>
      <button
        type="button"
        aria-label={`Resend ${label}`}
        className={`${threadBubbleControlClassName} disabled:opacity-50`}
        disabled={busy}
        onClick={() => runAll(actions.resendSteer)}
        title={`Resend ${label}`}
      >
        <RefreshCwIcon size={16} />
      </button>
      <button
        type="button"
        aria-label={`Dismiss ${label}`}
        className={`${threadBubbleControlClassName} disabled:opacity-50`}
        disabled={busy}
        onClick={() => runAll(actions.dismissSteer)}
        title={`Dismiss ${label}`}
      >
        <XIcon size={16} />
      </button>
      <ThreadItemActionError error={error} />
    </>
  );
}

/** Stops a running wb shell call; the transcript then shows the agent's stopped result. */
function ThreadShellStopAction({ itemId }: { itemId: string }) {
  const actions = useContext(ThreadItemActionsContext);
  const { busy, error, run } = useThreadItemActionRun();
  if (!actions) return null;
  return (
    <>
      <button
        type="button"
        aria-label="Stop command"
        className={`${threadBubbleControlClassName} hover:text-danger focus-visible:text-danger disabled:opacity-50`}
        disabled={busy}
        onClick={() => run(() => actions.stopShell(itemId))}
        title="Stop command"
      >
        <StopIcon size={14} />
      </button>
      <ThreadItemActionError error={error} />
    </>
  );
}

type ThreadMessageMarkdownProps = Pick<
  ComponentProps<typeof ThreadMarkdown>,
  "inlineMentionSources" | "projectFilePaths" | "projectId" | "projectRootPath" | "threadCwdPath" | "workspaceRoots"
>;

/** One bubble per run of consecutive same-sender messages, stamped with the run's latest message. */
function ThreadIncomingAgentMessageRuns ({
  items,
  itemTimeline,
  subagents,
  ...markdownProps
}: ThreadMessageMarkdownProps & {
  items: readonly IncomingAgentMessageItem[];
  itemTimeline?: readonly WorkbenchThreadItemTimelineEntry[];
  subagents: readonly WorkbenchSubagentSummary[];
}) {
  return (
    <>
      {groupIncomingAgentMessageRuns(items).map((run) => {
        const last = run.items.at(-1)!;
        const timeline = findWorkbenchThreadItemTimelineEntry(last.id, itemTimeline);
        const timestampMs = timeline?.firstSeenAt ?? (last.type === "functionCallOutput"
          ? readWorkbenchToolOutput(last)?.workbenchInjectionAcceptedAt
          : timeline?.startedAt);
        const userItems = run.items.filter((item): item is Extract<ThreadItem, { type: "userMessage" }> => item.type === "userMessage");
        return (
          <ThreadIncomingAgentMessageItem
            {...markdownProps}
            key={run.items[0]!.id}
            messages={run.messages}
            steerActions={run.deliveryState === "unsent" ? <UndeliveredSteerActions itemIds={storedUndeliveredSteerIds(userItems)} /> : undefined}
            steerState={run.deliveryState}
            subagent={getSubagentSummary(subagents, run.messages[0].senderThreadId)}
            timestamp={timestampMs === undefined || timestampMs === null
              ? undefined
              : <ThreadMessageTimestamp className="mt-1" timestampSeconds={timestampMs / 1_000} />}
          />
        );
      })}
    </>
  );
}

/** Text a settled wait returned for the user; a wait an incoming message cut short returned agent guidance only. */
function getSubagentWaitResultText(item: SubagentWaitItem) {
  if (item.type === "commandExecution") {
    return getThreadCommandExecutionOutcome(item.status, item.exitCode) === "completed" ? item.aggregatedOutput?.trim() || null : null;
  }
  if (item.status !== "completed" || item.error || isThreadMcpWaitInterruptedBySteer(item)) return null;
  return formatToolCallOutput({ content: item.result?.content, fallback: item.result?.structuredContent ?? item.result?._meta })?.trim() || null;
}

/** Settled waits that ping-ponged with incoming messages: one wait row for every target, then one message group. */
function ThreadSubagentWaitExchange ({
  block,
  itemTimeline,
  relatedThreadsById,
  subagents,
  ...markdownProps
}: ThreadMessageMarkdownProps & {
  block: Extract<ThreadRenderableBlock, { kind: "subagentWaitExchange" }>;
  itemTimeline?: readonly WorkbenchThreadItemTimelineEntry[];
  relatedThreadsById: RelatedThreadsById;
  subagents: readonly WorkbenchSubagentSummary[];
}) {
  const entries = block.waits.map((item) => ({ item, outcome: block.outcome, targetKeys: [] }));
  const timing = getThreadSubagentWaitTiming({ anchor: entries.at(-1)!, entries }, itemTimeline ?? []);
  const results = block.waits.flatMap((item) => {
    const text = getSubagentWaitResultText(item);
    return text ? [{ id: item.id, text }] : [];
  });
  return (
    <>
      <ThreadSubagentWaitItem
        disclosureContent={results.length ? (
          <div className="space-y-3">
            {results.map((result) => <ThreadMarkdown {...markdownProps} key={result.id} markdown={result.text} />)}
          </div>
        ) : undefined}
        durationMs={timing.durationMs}
        entries={resolveWorkbenchSubagentCommandTargets(subagents, block.targets).map((target) => ({
          fallbackName: target.fallbackName,
          subagent: target.subagent,
          targetKey: target.targetKey,
          thread: target.threadId ? relatedThreadsById[target.threadId] : undefined,
        }))}
        outcome={block.outcome}
      />
      {block.messages.length ? (
        <ThreadIncomingAgentMessageGroup items={block.messages} state="delivered" subagents={subagents}>
          <ThreadIncomingAgentMessageRuns {...markdownProps} itemTimeline={itemTimeline} items={block.messages} subagents={subagents} />
        </ThreadIncomingAgentMessageGroup>
      ) : null}
    </>
  );
}

function getCoordinationParticipants(
  items: readonly ThreadItem[],
  relatedThreadsById: RelatedThreadsById,
  subagents: readonly WorkbenchSubagentSummary[],
) {
  const participants = new Map<string, { key: string; label: ReactNode }>();
  const add = ({
    fallbackName,
    kind,
    value,
  }: {
    fallbackName: string;
    kind: "id" | "name" | "parent";
    value: string | null;
  }) => {
    const resolved = kind === "parent" || !value
      ? null
      : resolveWorkbenchSubagentCommandTargets(subagents, [{ kind, value }])[0] ?? null;
    const key = resolved?.threadId ?? `${kind}:${value ?? ""}`;
    if (participants.has(key)) return;
    participants.set(key, {
      key,
      label: (
        <ThreadAgentName
          subagent={resolved?.subagent}
          thread={resolved?.threadId
            ? relatedThreadsById[resolved.threadId] ?? { agentNickname: resolved.fallbackName, agentRole: null }
            : { agentNickname: fallbackName, agentRole: null }}
        />
      ),
    });
  };

  for (const item of items) {
    const outgoing = readThreadSubagentCoordinationOutgoingMessage(item);
    if (outgoing) {
      add({
        fallbackName: outgoing.target.kind === "parent" ? "parent" : outgoing.target.value ?? "thread",
        kind: outgoing.target.kind === "thread" ? "id" : outgoing.target.kind,
        value: outgoing.target.value,
      });
      continue;
    }
    const claimAction = readThreadSubagentCoordinationClaimAction(item);
    if (claimAction) {
      add({
        fallbackName: claimAction.target.value,
        kind: claimAction.target.kind,
        value: claimAction.target.value,
      });
      continue;
    }
    const create = readThreadSubagentCoordinationCreate(item);
    if (create) {
      add({ fallbackName: create.name, kind: "name", value: create.name });
      continue;
    }
    const wait = readThreadSubagentCoordinationWait(item);
    if (wait) {
      for (const target of wait.targets) {
        add({ fallbackName: target.value, kind: target.kind, value: target.value });
      }
      continue;
    }
    const incoming = readWorkbenchAgentMessageItem(item);
    if (incoming) {
      add({ fallbackName: incoming.senderName, kind: "id", value: incoming.senderThreadId });
    }
  }
  return [...participants.values()];
}

function resolveCoordinationTarget(
  target: ThreadSubagentCoordinationTarget,
  subagents: readonly WorkbenchSubagentSummary[],
) {
  if (target.kind === "parent" || !target.value) return null;
  return resolveWorkbenchSubagentCommandTargets(subagents, [{
    kind: target.kind,
    value: target.value,
  }])[0] ?? null;
}

function getCoordinationTargetKey(
  target: ThreadSubagentCoordinationTarget,
  subagents: readonly WorkbenchSubagentSummary[],
) {
  return resolveCoordinationTarget(target, subagents)?.threadId
    ?? `${target.kind}:${target.value ?? ""}`;
}

function ThreadCoordinationOutgoingChannel({
  items,
  relatedThreadsById,
  subagents,
  target,
  threadId,
  ...markdownProps
}: ThreadMessageMarkdownProps & {
  items: readonly ThreadItem[];
  relatedThreadsById: RelatedThreadsById;
  subagents: readonly WorkbenchSubagentSummary[];
  target: ThreadSubagentCoordinationTarget;
  threadId: string;
}) {
  const resolved = resolveCoordinationTarget(target, subagents);
  const recipient = (
    <ThreadAgentMessageTarget
      fallbackName={target.kind === "parent" ? "parent" : resolved?.fallbackName ?? target.value}
      subagent={resolved?.subagent}
      target={target.kind === "parent"
        ? { relation: "parent", threadId }
        : resolved?.threadId ? { relation: "self", threadId: resolved.threadId } : null}
      thread={resolved?.threadId ? relatedThreadsById[resolved.threadId] : undefined}
    />
  );
  return (
    <ThreadAgentMessageBubble recipient={recipient}>
      {items.map((item) => {
        const outgoing = readThreadSubagentCoordinationOutgoingMessage(item);
        if (outgoing) {
          return (
            <ThreadAgentMessageBody
              {...markdownProps}
              key={item.id}
              parts={[{
                markdown: outgoing.message,
                userVisibleSimpleVersion: outgoing.userVisibleSimpleVersion,
              }]}
              threadCwdPath={item.type === "commandExecution" ? item.cwd : markdownProps.threadCwdPath}
            />
          );
        }
        const claimAction = readThreadSubagentCoordinationClaimAction(item);
        return claimAction ? (
          <ThreadAgentMessageClaimAction
            action={claimAction.action}
            key={item.id}
            paths={claimAction.paths}
            projectFilePaths={markdownProps.projectFilePaths}
            projectId={markdownProps.projectId}
            projectRootPath={markdownProps.projectRootPath}
            workspaceRoots={markdownProps.workspaceRoots}
          />
        ) : null;
      })}
    </ThreadAgentMessageBubble>
  );
}

function ThreadCoordinationCreate({
  activeStartedAtMs,
  item,
  knownSkills,
  relatedThreadsById,
  subagents,
  threadId,
  ...markdownProps
}: ThreadMessageMarkdownProps & {
  activeStartedAtMs?: number | null;
  item: Extract<ThreadItem, { type: "commandExecution" | "mcpToolCall" }>;
  knownSkills?: WorkbenchSkillSummary[];
  relatedThreadsById: RelatedThreadsById;
  subagents: readonly WorkbenchSubagentSummary[];
  threadId: string;
}) {
  if (item.type === "commandExecution") {
    return (
      <ThreadCommandExecutionDetails
        activeStartedAtMs={activeStartedAtMs}
        inlineMentionSources={markdownProps.inlineMentionSources}
        item={item}
        knownSkills={knownSkills}
        projectFilePaths={markdownProps.projectFilePaths}
        projectId={markdownProps.projectId}
        projectRootPath={markdownProps.projectRootPath}
        relatedThreadsById={relatedThreadsById}
        subagents={subagents}
        threadId={threadId}
        workspaceRoots={markdownProps.workspaceRoots}
        unwrapSubagentCreate
      />
    );
  }
  const route = getWorkbenchMcpCommandRoute({
    argumentsValue: item.arguments,
    server: item.server,
    tool: item.tool,
  });
  if (route?.kind !== "specialized") return null;
  return (
    <ThreadWorkbenchCommandItem
      activeStartedAtMs={activeStartedAtMs}
      inlineMentionSources={markdownProps.inlineMentionSources}
      item={item}
      projectFilePaths={markdownProps.projectFilePaths}
      projectId={markdownProps.projectId}
      projectRootPath={markdownProps.projectRootPath}
      relatedThreadsById={relatedThreadsById}
      renderRecallRecord={() => null}
      route={route}
      subagents={subagents}
      threadCwdPath={markdownProps.threadCwdPath}
      threadId={threadId}
      workspaceRoots={markdownProps.workspaceRoots}
      unwrapSubagentCreate
    />
  );
}

function ThreadSubagentCoordination({
  block,
  isMostRecent,
  itemTimeline,
  knownSkills,
  relatedThreadsById,
  subagents,
  threadId,
  ...markdownProps
}: ThreadMessageMarkdownProps & {
  block: Extract<ThreadRenderableBlock, { kind: "subagentCoordination" }>;
  isMostRecent: boolean;
  itemTimeline?: readonly WorkbenchThreadItemTimelineEntry[];
  knownSkills?: WorkbenchSkillSummary[];
  relatedThreadsById: RelatedThreadsById;
  subagents: readonly WorkbenchSubagentSummary[];
  threadId: string;
}) {
  const waits = block.items.flatMap(item => {
    const wait = readThreadSubagentCoordinationWait(item);
    return wait ? [{
      item: wait.item,
      outcome: wait.outcome,
      targetKeys: wait.targetKeys,
    } satisfies ThreadSubagentWaitRenderEntry<SubagentWaitItem>] : [];
  });
  const waitGroup = waits.length ? { anchor: waits.at(-1)!, entries: waits } : null;
  const timing = waitGroup ? getThreadSubagentWaitTiming(waitGroup, itemTimeline ?? []) : null;
  const conversation = groupThreadSubagentCoordinationConversation(
    block.items,
    (target) => getCoordinationTargetKey(target, subagents),
  );
  return (
    <ThreadSubagentCoordinationItem
      active={waitGroup?.anchor.outcome === "inProgress"}
      activeStartedAtMs={timing?.activeStartedAtMs}
      durationMs={timing?.durationMs}
      participants={getCoordinationParticipants(block.items, relatedThreadsById, subagents)}
    >
      {conversation.map((run) => {
        if (run.kind === "incoming") {
          return (
            <ThreadIncomingAgentMessageRuns
              {...markdownProps}
              itemTimeline={itemTimeline}
              items={run.items}
              key={run.items[0]!.id}
              subagents={subagents}
            />
          );
        }
        if (run.kind === "create") {
          return (
            <ThreadCoordinationCreate
              {...markdownProps}
              activeStartedAtMs={getActiveItemStartedAtMs(run.items[0], itemTimeline)}
              item={run.items[0]}
              key={run.items[0].id}
              knownSkills={knownSkills}
              relatedThreadsById={relatedThreadsById}
              subagents={subagents}
              threadId={threadId}
            />
          );
        }
        if (run.kind === "queueCheck") {
          return (
            <ThreadRegularCommandItem
              inlineMentionSources={markdownProps.inlineMentionSources}
              isMostRecent={isMostRecent && block.items.at(-1)?.id === run.items[0].id}
              item={run.items[0]}
              itemTimeline={itemTimeline}
              key={run.items[0].id}
              knownSkills={knownSkills}
              projectFilePaths={markdownProps.projectFilePaths}
              projectId={markdownProps.projectId}
              projectRootPath={markdownProps.projectRootPath}
              relatedThreadsById={relatedThreadsById}
              subagents={subagents}
              threadCwdPath={markdownProps.threadCwdPath}
              threadId={threadId}
              workspaceRoots={markdownProps.workspaceRoots}
            />
          );
        }
        return (
          <ThreadCoordinationOutgoingChannel
            {...markdownProps}
            items={run.items}
            key={run.items[0]!.id}
            relatedThreadsById={relatedThreadsById}
            subagents={subagents}
            target={run.target}
            threadId={threadId}
          />
        );
      })}
    </ThreadSubagentCoordinationItem>
  );
}

function ThreadUserMessageItem ({
  inlineMentionSources,
  item,
  sourceItems,
  threadCwdPath,
  projectFilePaths,
  projectId,
  projectRootPath,
  startedAt,
  subagents = [],
  workspaceRoots,
}: {
  inlineMentionSources?: InlineMentionHighlightSources | null;
  item: Extract<ThreadItem, { type: "userMessage" }>;
  /** The stored messages a merged bubble shows; defaults to `item` itself. */
  sourceItems?: readonly Extract<ThreadItem, { type: "userMessage" }>[];
  threadCwdPath?: string;
  projectFilePaths?: readonly string[];
  projectId?: string | null;
  projectRootPath?: string;
  startedAt: number | null;
  subagents?: readonly WorkbenchSubagentSummary[];
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
}) {
  const agentMessage = readWorkbenchAgentMessageInput(item.content);
  if (agentMessage) {
    const steerState = getUserMessageDeliveryState(item);
    return (
      <ThreadIncomingAgentMessageItem
        messages={[agentMessage]}
        steerState={steerState}
        steerActions={steerState === "unsent" ? <UndeliveredSteerActions itemIds={storedUndeliveredSteerIds(sourceItems ?? [item])} /> : undefined}
        subagent={getSubagentSummary(subagents, agentMessage.senderThreadId)}
        timestamp={<ThreadMessageTimestamp className="mt-1" timestampSeconds={startedAt} />}
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
        timestamp={<ThreadMessageTimestamp className="mt-1" timestampSeconds={startedAt} />}
      />
    );
  }

  const steerState = getUserMessageDeliveryState(item);
  const isPendingInitial = isUndeliveredInitialOptimisticInputItem(item);
  const { content: displayContent, references } = splitLeadingComposerReferences(unwrapWorkbenchSteerDisplayInput(item.content));
  // `=====` lines split one stored message into several bubbles; the agent still receives the whole message.
  const bubbles = splitUserMessageBubbles(displayContent);
  return (
    <section
      className="flex flex-col items-end gap-2 py-2"
      data-thread-user-message-state={isPendingInitial ? "pending-initial" : steerState ? `${steerState}-steer` : undefined}
    >
      {(bubbles.length ? bubbles : [[]]).map((bubble, bubbleIndex) => (
        <div className="group/thread-bubble relative w-fit max-w-[min(100%,42rem)]" key={`${item.id}:bubble:${bubbleIndex}`}>
          <ThreadSteerDecoration className="space-y-2 text-left" state={isPendingInitial ? "pending" : steerState}>
            {/* References lead the first bubble like its opening paragraph. */}
            {bubbleIndex === 0 ? <ComposerReferencePills references={references} /> : null}
            {bubble.length ? bubble.map((content, index) => (
              <ThreadUserInputLine
                key={`${item.id}:content:${bubbleIndex}:${index}:${content.type}`}
                input={content}
                inlineMentionSources={inlineMentionSources}
                threadCwdPath={threadCwdPath}
                projectFilePaths={projectFilePaths}
                projectId={projectId}
                projectRootPath={projectRootPath}
                workspaceRoots={workspaceRoots}
              />
            )) : references.length ? null : (
              <p className="m-0 text-[0.92em] leading-[1.6] text-fg/muted">No user content captured.</p>
            )}
          </ThreadSteerDecoration>
          <ThreadBubbleCopyButton
            actions={steerState === "unsent" && bubbleIndex === bubbles.length - 1
              ? <UndeliveredSteerActions itemIds={storedUndeliveredSteerIds(sourceItems ?? [item])} />
              : undefined}
            markdown={getUserMessageCopyMarkdown(bubble)}
            side="right"
          />
        </div>
      ))}
      <ThreadMessageTimestamp align="right" className="-mt-1" timestampSeconds={startedAt} />
    </section>
  );
}

/** References lead a message's first text part; the rest of that part is the user's own words. */
function splitLeadingComposerReferences(content: UserInput[]): { content: UserInput[]; references: ComposerReference[] } {
  const [first, ...rest] = content;
  const read = first?.type === "text" ? readComposerReferenceMessage(first.text) : null;
  if (!first || first.type !== "text" || !read) return { content, references: [] };
  return {
    content: read.message ? [{ ...first, text: read.message, text_elements: [] }, ...rest] : rest,
    references: read.references,
  };
}

function mergeSteerUserMessages(items: Extract<ThreadItem, { type: "userMessage" }>[]) {
  const first = items[0]!;
  const last = items.at(-1)!;
  return {
    ...last,
    content: [{
      text: items
        .map((item) => getUserMessageCopyMarkdown(unwrapWorkbenchSteerDisplayInput(item.content)))
        .join("\n\n"),
      text_elements: [],
      type: "text" as const,
    }],
    id: `${first.id}:through:${last.id}`,
  };
}

function ThreadAgentMessageItem ({
  completedAt,
  copyRuns,
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
  /** Commentary prose runs this item ends; each gets a copy row. */
  copyRuns?: ThreadCommentaryRunActions;
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
  const text = stripWorkbenchTurnEndMarker(useThreadPresentedText({
    canonicalText: item.text,
    field: "agentMessageText",
    itemId: item.id,
    source: presentationSource,
    threadId,
    turnId,
  }));
  const breakCopyMarkdown = copyRuns?.breakCopyMarkdown;
  const renderBreakActions = useCallback((breakIndex: number) => {
    const markdown = breakCopyMarkdown?.[breakIndex];
    return markdown ? <ThreadCommentaryActionRow markdown={markdown} placement="break" /> : null;
  }, [breakCopyMarkdown]);
  if (!text.trim()) return null;
  return (
    <section className={copyRuns ? "relative py-2" : "py-2"}>
      <ThreadMarkdownSectionActionsProvider value={copyRuns ? renderBreakActions : null}>
        <ThreadMarkdown
          inlineMentionSources={inlineMentionSources}
          markdown={text}
          threadCwdPath={threadCwdPath}
          projectFilePaths={projectFilePaths}
          projectId={projectId}
          projectRootPath={projectRootPath}
          revealAppends={Boolean(presentationSource)}
          workspaceRoots={workspaceRoots}
        />
      </ThreadMarkdownSectionActionsProvider>
      {copyRuns?.endCopyMarkdown ? <ThreadCommentaryActionRow markdown={copyRuns.endCopyMarkdown} placement="end" /> : null}
      {isFinal ? <ThreadMessageTimestamp className="mt-1" timestampSeconds={completedAt} /> : null}
    </section>
  );
}

/** Consecutive commentary items render as one hover group so a merged prose run's copy row appears from any of its items. */
function ThreadAgentCommentarySequence ({
  animateEntries,
  items,
  ...itemProps
}: Omit<Parameters<typeof ThreadAgentMessageItem>[0], "copyRuns" | "isFinal" | "item"> & {
  animateEntries: boolean;
  items: readonly AgentCommentaryItem[];
}) {
  const copyRuns = useMemo(() => buildThreadCommentaryRuns(items.map(item => stripWorkbenchTurnEndMarker(item.text))), [items]);
  return (
    <div className="group/commentary space-y-2">
      {items.map((item, index) => (
        <ThreadEntryMotion enabled={animateEntries && index > 0} identity={getThreadEntryMotionIdentity(item)} key={item.id}>
          {(animate) => (
            <div className={animate ? `block ${enterMotionClassName}` : undefined}>
              <ThreadAgentMessageItem {...itemProps} copyRuns={copyRuns[index]} isFinal={false} item={item} />
            </div>
          )}
        </ThreadEntryMotion>
      ))}
    </div>
  );
}

function ThreadRecallPlanItem ({
  inlineMentionSources,
  markdown,
  threadCwdPath,
  projectFilePaths,
  projectId,
  projectRootPath,
  workspaceRoots,
}: {
  inlineMentionSources?: InlineMentionHighlightSources | null;
  markdown: string;
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
      summary={<ThreadPlanSummary markdown={markdown} />}
      summaryClassName="text-[0.92em] leading-[1.6] text-fg/muted"
    >
      <ThreadMarkdown
        inlineMentionSources={inlineMentionSources}
        markdown={markdown}
        threadCwdPath={threadCwdPath}
        projectFilePaths={projectFilePaths}
        projectId={projectId}
        projectRootPath={projectRootPath}
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
        summaryClassName="text-[0.92em] leading-[1.6] text-fg/muted"
      />
    );
  }

  const content = onlyStep && steps.length === 1 ? (
    <ThreadMarkdown
      className="text-[0.8em] text-fg/muted"
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
          className={index ? "border-t border-[color-mix(in srgb, var(--text) 10%, transparent)] pt-4" : undefined}
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
      summaryClassName="text-[0.92em] leading-[1.6] text-fg/muted"
    >
      {content}
    </ThreadDisclosure>
  );
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
      && formatDuration(durationMs) === row.target.text;

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

/** Enough recent context to follow a working child; older turn content stays one tab-click away. */
const SUBAGENT_ACTIVITY_WINDOW_BLOCKS = 24;
const NO_BLOCKS: ThreadRenderableBlock[] = [];

interface ThreadSubagentActivityWindowProps {
  fallbackThread: RelatedThread | undefined;
  inlineMentionSources?: InlineMentionHighlightSources | null;
  knownSkills?: WorkbenchSkillSummary[];
  projectFilePaths?: readonly string[];
  projectId?: string | null;
  projectRootPath?: string;
  relatedThreadsById: RelatedThreadsById;
  subagent: WorkbenchSubagentSummary | null | undefined;
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
}

/**
 * Live tail of a child's current turn for wait previews. Holding "view" interest keeps the child's
 * own owner refreshing it while it works; the parent's related documents are only loaded once.
 * Transcripts also render without a mounted client, where only the passed document can show.
 */
function ThreadSubagentActivityWindow (props: ThreadSubagentActivityWindowProps) {
  return useContext(WorkbenchClientContext) && props.subagent
    ? <LiveThreadSubagentActivityWindow {...props} subagent={props.subagent} />
    : <ThreadSubagentActivityWindowBody {...props} thread={props.fallbackThread} />;
}

function LiveThreadSubagentActivityWindow (props: ThreadSubagentActivityWindowProps & { subagent: WorkbenchSubagentSummary }) {
  const { subagent } = props;
  const live = useThread(props.projectId ?? "", {
    harness: subagent.harness, kind: "subagent", parentThreadId: subagent.parentThreadId, threadId: subagent.threadId,
  }, "view");
  const { turns } = useThread.turns(live.store);
  const thread = useMemo(() => live.head && turns.length ? { ...live.head, turns } : props.fallbackThread,
    [live.head, props.fallbackThread, turns]);
  return <ThreadSubagentActivityWindowBody {...props} thread={thread} />;
}

function ThreadSubagentActivityWindowBody ({
  inlineMentionSources,
  knownSkills,
  projectFilePaths,
  projectId,
  projectRootPath,
  relatedThreadsById,
  thread,
  workspaceRoots,
}: ThreadSubagentActivityWindowProps & { thread: RelatedThread | undefined }) {
  const currentTurn = thread?.turns?.at(-1) ?? null;
  const turnItems = currentTurn?.items;
  const cwd = thread?.cwd;
  const recentBlocks = useMemo(
    () => turnItems ? buildRenderableBlocks(turnItems, {}, cwd).slice(-SUBAGENT_ACTIVITY_WINDOW_BLOCKS) : NO_BLOCKS,
    [cwd, turnItems],
  );
  const blocks = useStableRenderableBlocks(recentBlocks);
  if (!thread || !currentTurn) {
    return <ThreadContentLoadingSkeleton />;
  }
  if (!blocks.length) {
    return (
      <p className="m-0 text-[0.92em] leading-[1.6] text-fg/muted">
        No subagent activity was captured yet.
      </p>
    );
  }

  const finalAgentMessageId = getFinalAgentMessageId(currentTurn);
  return (
    <div className="flex flex-col gap-1">
      {blocks.map((block) => (
        <ThreadRenderableBlockView
          animateEntries={false}
          block={block}
          finalAgentMessageId={finalAgentMessageId}
          inlineMentionSources={inlineMentionSources}
          isMostRecentBlock={block === blocks.at(-1)}
          key={getRenderableBlockKey(block)}
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
      ))}
    </div>
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
        <ThreadRecallPlanItem
          inlineMentionSources={inlineMentionSources}
          markdown={record.text}
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
  activeStartedAtMs,
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
  unwrapSubagentCreate = false,
  workspaceRoots,
}: {
  activeStartedAtMs?: number | null;
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
  unwrapSubagentCreate?: boolean;
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
  const visibleDurationMs = useThreadItemLiveDuration(item.durationMs, activeStartedAtMs);
  const outcomeCommandDisplay = useMemo(
    () => getThreadCommandOutcomeDisplay(commandDisplay, commandOutcome),
    [commandDisplay, commandOutcome],
  );
  const approval = useThreadItemApproval(item.id);
  const messageCommand = parseWorkbenchMessageCommand(commandDisplay.unwrappedCommand, item.commandActions);
  const subagentCommand = parseWorkbenchSubagentCommand(commandDisplay.unwrappedCommand, item.commandActions);
  const resolvedSubagentTargets = subagentCommand
    ? resolveWorkbenchSubagentCommandTargets(subagents, subagentCommand.targets)
    : [];
  const {
    artifactId: checkpointDiffArtifactId,
    compareChanges: checkpointCompareChanges,
    diffChanges: checkpointDiffChanges,
    summaryRows: checkpointSummaryRows,
  } = readGitCheckpointPresentation(item, commandDisplay.claimedBy);
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
  const feedbackCommand = parseWorkbenchFeedbackCommand(commandDisplay.unwrappedCommand);
  if (feedbackCommand && (commandOutcome === "completed" || commandOutcome === "inProgress")) {
    return (
      <ThreadFeedbackCommandItem
        durationMs={visibleDurationMs ?? null}
        feedbackId={parseWorkbenchFeedbackId(item.aggregatedOutput ?? "")}
        operation={feedbackCommand}
        outcome={commandOutcome}
        projectId={projectId}
        threadId={threadId}
      />
    );
  }
  const visCommand = parseWorkbenchVisCommand(commandDisplay.unwrappedCommand);
  if (visCommand) {
    return (
      <ThreadVisCommandItem
        durationMs={visibleDurationMs ?? null}
        operation={visCommand}
        outcome={commandOutcome === "inProgress" ? "inProgress" : commandOutcome === "completed" ? "completed" : "failed"}
        output={item.aggregatedOutput ?? ""}
        threadId={threadId}
      />
    );
  }
  if (gitArcAction === "propose") {
    return (
      <ThreadGitArcProposalItem
        durationMs={visibleDurationMs ?? null}
        failureReason={commandOutcome === "failed" || commandOutcome === "declined" || commandOutcome === "timedOut" ? item.aggregatedOutput : null}
        intent={gitArcProposal?.intent ?? null}
        outcome={commandOutcome}
        projectFilePaths={projectFilePaths}
        projectId={projectId}
        projectRootPath={projectRootPath}
        proposalId={gitArcProposal?.proposalId ?? null}
        sourceItemId={item.id}
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
        statusOutput={gitArcCommandIntent.action === "status" ? item.aggregatedOutput ?? "" : undefined}
        durationMs={visibleDurationMs ?? null}
        editResult={gitArcCommandIntent.action === "edit" ? parseGitArcEditText(item.aggregatedOutput ?? "") : null}
        failureReason={commandOutcome === "failed" || commandOutcome === "declined" || commandOutcome === "timedOut"
          ? item.aggregatedOutput
          : null}
        operationDetails={operationDetails}
        operationSummaryRows={checkpointSummaryRows}
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
        durationMs={subagentWaitTiming ? subagentWaitTiming.durationMs : visibleDurationMs}
        entries={resolvedSubagentTargets.map((target) => {
          const childThread = target.threadId ? relatedThreadsById[target.threadId] : undefined;
          return {
            content: target.threadId ? (
              <ThreadSubagentActivityWindow
                fallbackThread={childThread}
                inlineMentionSources={inlineMentionSources}
                knownSkills={knownSkills}
                projectFilePaths={projectFilePaths}
                projectId={projectId}
                projectRootPath={projectRootPath}
                relatedThreadsById={relatedThreadsById}
                subagent={target.subagent}
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
        unwrapped={unwrapSubagentCreate}
      >
        <ThreadAgentMessageBody
          inlineMentionSources={inlineMentionSources}
          parts={[{
            markdown: subagentCommand.message,
            userVisibleSimpleVersion: subagentCommand.userVisibleSimpleVersion,
          }]}
          projectFilePaths={projectFilePaths}
          projectId={projectId}
          projectRootPath={projectRootPath}
          threadCwdPath={item.cwd}
          workspaceRoots={workspaceRoots}
        />
      </ThreadSubagentCreateItem>
    );
  }
  if (messageCommand && (item.status === "inProgress" || item.status === "completed") && (item.exitCode === null || item.exitCode === 0)) {
    const descriptor = messageCommand.target.kind === "parent" || !messageCommand.target.value
      ? null
      : {
        kind: messageCommand.target.kind === "name" ? "name" as const : "id" as const,
        value: messageCommand.target.value,
      };
    const target = descriptor ? resolveWorkbenchSubagentCommandTargets(subagents, [descriptor])[0] ?? null : null;
    const childThread = target?.threadId ? relatedThreadsById[target.threadId] : undefined;
    return (
      <ThreadSentAgentMessageItem
        fallbackName={messageCommand.target.kind === "parent" ? "parent" : target?.fallbackName ?? messageCommand.target.value}
        subagent={target?.subagent}
        target={messageCommand.target.kind === "parent"
          ? { relation: "parent", threadId }
          : target?.threadId ? { relation: "self", threadId: target.threadId } : null}
        thread={childThread}
      >
        <ThreadMarkdown
          inlineMentionSources={inlineMentionSources}
          markdown={messageCommand.message}
          projectFilePaths={projectFilePaths}
          projectId={projectId}
          projectRootPath={projectRootPath}
          threadCwdPath={item.cwd}
          workspaceRoots={workspaceRoots}
        />
      </ThreadSentAgentMessageItem>
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

  if (visibleDurationMs !== null && visibleDurationMs !== undefined) {
    metaParts.push(
      <ThreadDurationText
        key={`${item.id}:duration`}
        durationMs={visibleDurationMs}
      />,
    );
  }

  const commandDisplayView = (
    <ThreadCommandDisplay
      approval={approval}
      command={item.command}
      display={commandDisplay}
      summaryDisplay={outcomeCommandDisplay}
      detailRows={commandDetailRows}
      output={item.aggregatedOutput}
      browse={isBrowseCommand}
      projectFilePaths={projectFilePaths}
      projectId={projectId}
      meta={metaParts.length ? (
            <span className="ml-2 text-[0.78em] text-fg/muted">
              {metaParts.map((part, index) => (
                <span key={`${item.id}:meta:${index}`}>
                  {index ? <span className="text-fg/muted"> | </span> : null}
                  {part}
                </span>
              ))}
            </span>
          ) : null}
    >
        {isBrowseCommand || shouldHideCommandOutput ? undefined : checkpointCompareChanges && commandOutcome === "completed" ? (
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
        ) : undefined}
    </ThreadCommandDisplay>
  );
  if (!item.workbenchShell || item.status !== "inProgress") return commandDisplayView;
  return (
    <div className="group/thread-bubble relative">
      {commandDisplayView}
      <ThreadBubbleCopyButton actions={<ThreadShellStopAction itemId={item.id} />} markdown="" side="right" />
    </div>
  );
}

function ThreadApprovalAwareMcpToolCallItem ({
  activeStartedAtMs,
  ...props
}: Omit<Parameters<typeof ThreadMcpToolCallItem>[0], "approval"> & {
  activeStartedAtMs?: number | null;
}) {
  const durationMs = useThreadItemLiveDuration(props.item.durationMs, activeStartedAtMs);
  return <ThreadMcpToolCallItem {...props} approval={useThreadItemApproval(props.item.id)} durationMs={durationMs ?? null} />;
}

function ThreadRegularCommandItem ({
  browseResultEntries = EMPTY_BROWSE_SCREENSHOT_ENTRIES,
  inlineMentionSources,
  isMostRecent,
  item,
  itemTimeline,
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
  itemTimeline?: readonly WorkbenchThreadItemTimelineEntry[];
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
      context: { knownSkills, ...(threadCwdPath ? { cwd: threadCwdPath, projectRootPath, workspaceRoots } : {}) },
      server: item.server,
      tool: item.tool,
    });
    return (
      <ThreadApprovalAwareMcpToolCallItem
        activeStartedAtMs={getActiveItemStartedAtMs(item, itemTimeline)}
        item={item}
        projectFilePaths={projectFilePaths}
        projectId={projectId}
        route={route}
      />
    );
  }

  if (item.type === "dynamicToolCall") {
    return (
      <ThreadDynamicToolCallItem
        activeStartedAtMs={getActiveItemStartedAtMs(item, itemTimeline)}
        inlineMentionSources={inlineMentionSources}
        item={item}
        knownSkills={knownSkills}
        threadCwdPath={threadCwdPath}
        projectFilePaths={projectFilePaths}
        projectId={projectId}
        projectRootPath={projectRootPath}
        workspaceRoots={workspaceRoots}
      />
    );
  }

  return (
    <ThreadCommandExecutionDetails
      activeStartedAtMs={getActiveItemStartedAtMs(item, itemTimeline)}
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
  itemTimeline,
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
  itemTimeline?: readonly WorkbenchThreadItemTimelineEntry[];
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
    if (item.type === "dynamicToolCall") {
      const display = getNativeToolDisplay(item, { knownSkills });
      return display ? [{ display }] : [];
    }
    const display = getWorkbenchMcpCommandDisplay({
      argumentsValue: item.arguments,
      context: { knownSkills, ...(threadCwdPath ? { cwd: threadCwdPath, projectRootPath, workspaceRoots } : {}) },
      server: item.server,
      tool: item.tool,
    });
    return display ? [{ display }] : [];
  }), [items, knownSkills, projectRootPath, threadCwdPath, workspaceRoots]);
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
    return <ThreadRegularCommandItem browseResultEntries={browseResultEntries} inlineMentionSources={inlineMentionSources} isMostRecent={isMostRecent} item={items[0]} itemTimeline={itemTimeline} knownSkills={knownSkills} projectFilePaths={projectFilePaths} projectId={projectId} projectRootPath={projectRootPath} relatedThreadsById={relatedThreadsById} subagents={subagents} threadCwdPath={threadCwdPath} threadId={threadId} workspaceRoots={workspaceRoots} />;
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
            itemTimeline={itemTimeline}
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
      summaryClassName="text-[0.92em] leading-[1.6] text-fg/muted"
      summary={<ThreadCommandSummary display={commandBlockDisplay} projectFilePaths={projectFilePaths} projectId={projectId} />}
    >
      <>
        {items.map((item, index) => (
          <ThreadRegularCommandItem
            browseResultEntries={browseResultEntries}
            inlineMentionSources={inlineMentionSources}
            isMostRecent={isMostRecent && index === items.length - 1}
            item={item}
            itemTimeline={itemTimeline}
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
  const approvals = useContext(ThreadItemApprovalsContext);
  const renderSegments = useMemo(() => buildCommandSequenceRenderSegments({
    approvalItemIds: approvals,
    items,
    knownSkills,
    projectRootPath,
    workspaceRoots,
  }), [approvals, items, knownSkills, projectRootPath, workspaceRoots]);
  const hasStandaloneCommandSegment = renderSegments.some((segment) => segment.kind !== "commands");

  if (!hasStandaloneCommandSegment) {
    return (
      <ThreadRegularCommandSequence
        browseResultEntries={browseResultEntries}
        inlineMentionSources={inlineMentionSources}
        isMostRecent={isMostRecent}
        itemTimeline={itemTimeline}
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
            activeStartedAtMs={getActiveItemStartedAtMs(segment.item, itemTimeline)}
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
            operation={segment.operation}
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
        ) : segment.kind === "gitArc" || segment.kind === "message" || segment.kind === "subagent" ? (
          <ThreadCommandExecutionDetails
            activeStartedAtMs={getActiveItemStartedAtMs(segment.item, itemTimeline)}
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
        ) : segment.kind === "subagentQueueCheck" ? (
          <ThreadRegularCommandItem
            browseResultEntries={browseResultEntries}
            inlineMentionSources={inlineMentionSources}
            isMostRecent={isMostRecent && index === renderSegments.length - 1}
            item={segment.item}
            itemTimeline={itemTimeline}
            key={`subagent-queue-check:${segment.item.id}`}
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
            itemTimeline={itemTimeline}
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

function ThreadRenderableBlockViewComponent ({
  animateEntries,
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
  animateEntries: boolean;
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
  if (block.kind === "subagentCoordination") {
    return (
      <ThreadSubagentCoordination
        block={block}
        inlineMentionSources={inlineMentionSources}
        itemTimeline={itemTimeline}
        isMostRecent={isMostRecentBlock}
        knownSkills={knownSkills}
        projectFilePaths={projectFilePaths}
        projectId={projectId}
        projectRootPath={projectRootPath}
        relatedThreadsById={relatedThreadsById}
        subagents={subagents}
        threadId={threadId}
        threadCwdPath={threadCwdPath}
        workspaceRoots={workspaceRoots}
      />
    );
  }
  if (block.kind === "agentMessageSequence") {
    return (
      <ThreadIncomingAgentMessageGroup items={block.items} state={block.state} subagents={subagents}>
        <ThreadIncomingAgentMessageRuns
          inlineMentionSources={inlineMentionSources}
          itemTimeline={itemTimeline}
          items={block.items}
          projectFilePaths={projectFilePaths}
          projectId={projectId}
          projectRootPath={projectRootPath}
          subagents={subagents}
          threadCwdPath={threadCwdPath}
          workspaceRoots={workspaceRoots}
        />
      </ThreadIncomingAgentMessageGroup>
    );
  }
  if (block.kind === "agentCommentarySequence") {
    return (
      <ThreadAgentCommentarySequence
        animateEntries={animateEntries}
        completedAt={turnCompletedAt}
        inlineMentionSources={inlineMentionSources}
        items={block.items}
        presentationSource={presentationSource}
        projectFilePaths={projectFilePaths}
        projectId={projectId}
        projectRootPath={projectRootPath}
        threadCwdPath={threadCwdPath}
        threadId={threadId}
        turnId={turnId}
        workspaceRoots={workspaceRoots}
      />
    );
  }
  if (block.kind === "subagentWaitExchange") {
    return (
      <ThreadSubagentWaitExchange
        block={block}
        inlineMentionSources={inlineMentionSources}
        itemTimeline={itemTimeline}
        projectFilePaths={projectFilePaths}
        projectId={projectId}
        projectRootPath={projectRootPath}
        relatedThreadsById={relatedThreadsById}
        subagents={subagents}
        threadCwdPath={threadCwdPath}
        workspaceRoots={workspaceRoots}
      />
    );
  }
  if (block.kind === "userMessageSequence") {
    const lastItem = block.items.at(-1)!;
    const timeline = findWorkbenchThreadItemTimelineEntry(lastItem.id, itemTimeline);
    const timestampMs = timeline?.firstSeenAt ?? timeline?.startedAt;
    return (
      <ThreadUserMessageItem
        item={mergeSteerUserMessages(block.items)}
        sourceItems={block.items}
        inlineMentionSources={inlineMentionSources}
        projectFilePaths={projectFilePaths}
        projectId={projectId}
        threadCwdPath={threadCwdPath}
        projectRootPath={projectRootPath}
        subagents={subagents}
        workspaceRoots={workspaceRoots}
        startedAt={timestampMs !== undefined && timestampMs !== null ? timestampMs / 1_000 : null}
      />
    );
  }

  if (block.kind === "commandSequence") {
    return <ThreadCommandSequence browseResultEntries={browseResultEntries} inlineMentionSources={inlineMentionSources} isMostRecent={isMostRecentBlock} itemTimeline={itemTimeline} items={block.items} knownSkills={knownSkills} presentationSource={presentationSource} projectFilePaths={projectFilePaths} projectId={projectId} projectRootPath={projectRootPath} relatedThreadsById={relatedThreadsById} subagents={subagents} threadCwdPath={threadCwdPath} threadId={threadId} turnId={turnId} workspaceRoots={workspaceRoots} />;
  }

  if (block.kind === "fileChangeSequence") {
    return <ThreadFileChangeItem animateEntries={animateEntries} items={block.items} projectFilePaths={projectFilePaths} projectId={projectId} projectRootPath={projectRootPath} workspaceRoots={workspaceRoots} />;
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
      if (!item) return <ThreadGenericItem item={block.item} />;
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
    case "userMessage": {
      const timeline = findWorkbenchThreadItemTimelineEntry(block.item.id, itemTimeline);
      const timestampMs = timeline?.firstSeenAt ?? timeline?.startedAt;
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
          startedAt={timestampMs !== undefined && timestampMs !== null
            ? timestampMs / 1_000
            : block.item.id === (primaryUserBlock?.kind === "item" ? primaryUserBlock.item.id : null) ? turnStartedAt : null}
        />
      );
    }
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
      return null;
    case "contextCompaction": {
      const timelineEntry = findWorkbenchThreadItemTimelineEntry(block.item.id, itemTimeline);
      // Workbench owns compaction status; only status-less items from older daemons fall back to turn activity.
      const isActive = block.item.status
        ? block.item.status === "inProgress"
        : turnStatus === "inProgress" && (!timelineEntry || timelineEntry.completedAt === null);
      return (
        <ThreadContextCompactionItem
          completedAt={timelineEntry?.completedAt}
          isActive={isActive}
          item={block.item}
          startedAt={timelineEntry?.startedAt ?? timelineEntry?.firstSeenAt}
        />
      );
    }
    case "mcpToolCall": {
      const route = getWorkbenchMcpCommandRoute({
        argumentsValue: block.item.arguments,
        context: { knownSkills, ...(threadCwdPath ? { cwd: threadCwdPath, projectRootPath, workspaceRoots } : {}) },
        server: block.item.server,
        tool: block.item.tool,
      });
      const isMcpFailure = block.item.status === "failed" || Boolean(block.item.error);
      if (shouldUseWorkbenchMcpSpecializedRenderer(route, isMcpFailure) && route?.kind === "specialized" && (
        threadCwdPath || route.operation.kind === "feedback" || route.operation.kind === "gitArc" || route.operation.kind === "gitArcWait"
      )) {
        return (
          <ThreadWorkbenchCommandItem
            activeStartedAtMs={getActiveItemStartedAtMs(block.item, itemTimeline)}
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
            renderSubagentActivity={({ subagent, thread }) => (
              <ThreadSubagentActivityWindow
                fallbackThread={thread}
                subagent={subagent}
                inlineMentionSources={inlineMentionSources}
                knownSkills={knownSkills}
                projectFilePaths={projectFilePaths}
                projectId={projectId}
                projectRootPath={projectRootPath}
                relatedThreadsById={relatedThreadsById}
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
        <ThreadApprovalAwareMcpToolCallItem
          activeStartedAtMs={getActiveItemStartedAtMs(block.item, itemTimeline)}
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
      return <ThreadDynamicToolCallItem activeStartedAtMs={getActiveItemStartedAtMs(block.item, itemTimeline)} hasCapturedChildren={block.hasCapturedChildren} answeredAt={findWorkbenchThreadItemTimelineEntry(block.item.id, itemTimeline)?.completedAt ?? null} inlineMentionSources={inlineMentionSources} item={block.item} knownSkills={knownSkills} threadCwdPath={threadCwdPath} projectFilePaths={projectFilePaths} projectId={projectId} projectRootPath={projectRootPath} workspaceRoots={workspaceRoots} />;
    case "webSearch":
      return <ThreadWebSearchItem item={block.item} />;
    case "collabAgentToolCall":
      return null;
    default:
      return <ThreadGenericItem item={block.item} timeline={findWorkbenchThreadItemTimelineEntry(block.item.id, itemTimeline)} turnStatus={turnStatus} />;
  }
}

const ThreadRenderableBlockView = memo(ThreadRenderableBlockViewComponent, (left, right) => (
  left.block === right.block
  && left.browseResultEntries === right.browseResultEntries
  && left.finalAgentMessageId === right.finalAgentMessageId
  && (left.inlineMentionSources?.cacheKey ?? "") === (right.inlineMentionSources?.cacheKey ?? "")
  && hasSameBlockTimeline(left.block, left.itemTimeline, right.itemTimeline)
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
  initialInactiveItemIds?: ReadonlySet<string>;
  initialUserItemId?: string | null;
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

export const ThreadTranscriptItemsDetails = memo(function ThreadTranscriptItemsDetails({
  initialInactiveItemIds,
  initialUserItemId = null,
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
  const animateEntries = useEntryMotionAfterMount(turnStatus === "inProgress");
  type RenderEntry =
    | { block: ThreadRenderableBlock; kind: "block"; eligible: boolean }
    | { item: WorkbenchProjectedGenericItem; kind: "generic"; eligible: false };
  const entries: RenderEntry[] = [];
  const renderItemTimeline = useMemo(() => {
    let timeline = itemTimeline ?? [];
    for (const item of items) {
      if (!isProjectedInteractionItem(item)) continue;
      timeline = upsertWorkbenchThreadItemTimelineEntry(timeline, {
        completedAt: item.resolvedAt,
        firstSeenAt: null,
        itemId: item.id,
        lastSeenAt: null,
        startedAt: null,
      });
    }
    return timeline;
  }, [items, itemTimeline]);
  let pendingItems: ThreadItem[] = [];
  const flushItems = () => {
    if (!pendingItems.length) return;
    entries.push(...buildRenderableBlocks(
      pendingItems,
      { reasoningStep: hiddenReasoningStep },
      threadCwdPath,
    ).flatMap((block) => initialInactiveItemIds
      ? getWorkedBlockRows(block, { knownSkills, projectRootPath, workspaceRoots }).map(row => ({ ...row, kind: "block" as const }))
      : [{ block, eligible: false, kind: "block" as const }]));
    pendingItems = [];
  };
  for (const item of items) {
    if (item.type === "generic") {
      flushItems();
      entries.push({ item, kind: "generic", eligible: false });
    } else {
      pendingItems.push(isProjectedInteractionItem(item)
        ? adaptProjectedInteractionItem(item)
        : item);
    }
  }
  flushItems();
  const stableBlocks = useStableRenderableBlocks(entries.flatMap(entry => entry.kind === "block" ? [entry.block] : []), "identity");
  let stableBlockIndex = 0;
  const stableEntries = entries.map(entry => entry.kind === "block"
    ? { ...entry, block: stableBlocks[stableBlockIndex++]! } : entry);

  const primaryUserBlock = stableEntries.flatMap((entry) => (
    entry.kind === "block" && entry.block.kind === "item" && entry.block.item.id === initialUserItemId
      ? [entry.block] : []
  )).at(0) ?? null;
  const finalAgentMessageId = [...items].reverse().find((item) => (
    item.type === "agentMessage" && item.phase === "final_answer"
  ))?.id
    ?? null;
  const getRenderEntryKey = (entry: RenderEntry, index: number) => {
    const firstItem = entry.kind === "block" ? getRenderableBlockItems(entry.block)[0] : null;
    return entry.kind === "generic" ? `generic:${entry.item.id}` : initialInactiveItemIds
      ? `${entry.block.kind}:${firstItem?.id}`
      : `${getRenderableBlockKey(entry.block)}:${index}`;
  };
  const renderEntry = (entry: RenderEntry, index: number) => {
    const firstItem = entry.kind === "block" ? getRenderableBlockItems(entry.block)[0] : null;
    const identity = entry.kind === "generic"
      ? `item:${entry.item.id}`
      : firstItem
        ? getThreadEntryMotionIdentity(firstItem)
        : `empty:${turnId}:${index}`;
    return <ThreadEntryMotion
      enabled={animateEntries && !(entry.kind === "block" && entry.block.kind === "fileChangeSequence")}
      identity={identity}
      key={getRenderEntryKey(entry, index)}
    >
      {(animate) => <div className={animate ? `block ${enterMotionClassName}` : undefined}>
        {entry.kind === "generic" ? (
          <ThreadGenericItem item={entry.item} timeline={findWorkbenchThreadItemTimelineEntry(entry.item.id, renderItemTimeline)} turnStatus={turnStatus} />
        ) : (
          <ThreadRenderableBlockView
            animateEntries={animateEntries}
            block={entry.block}
            browseResultEntries={browseResultEntries}
            finalAgentMessageId={finalAgentMessageId}
            inlineMentionSources={inlineMentionSources}
            itemTimeline={renderItemTimeline}
            isMostRecentBlock={index === stableEntries.length - 1}
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
        )}
      </div>}
    </ThreadEntryMotion>;
  };
  const renderWindowedEntries = (windowEntries: RenderEntry[], start: number) => {
    const chunks: RenderEntry[][] = [];
    for (let index = 0; index < windowEntries.length; index += THREAD_WINDOW_CHUNK_SIZE) {
      chunks.push(windowEntries.slice(index, index + THREAD_WINDOW_CHUNK_SIZE));
    }
    let chunkOffset = 0;
    const progressiveChunks: ThreadProgressiveWindowChunk[] = chunks.map((chunk) => {
      const chunkStart = start + chunkOffset;
      chunkOffset += chunk.length;
      const firstEntry = chunk[0]!;
      const key = `window:${getRenderEntryKey(firstEntry, chunkStart)}`;
      return {
        key,
        content: (
          <ThreadMeasuredContent
            key={key}
            visibilityRange="approaching"
            windowed
          >
            <div className="space-y-2">
              {chunk.map((entry, index) => renderEntry(entry, chunkStart + index))}
            </div>
          </ThreadMeasuredContent>
        ),
      };
    });
    return (
      <ThreadProgressiveWindow
        key={`progressive:${turnId}:${start}`}
        chunks={progressiveChunks}
        identity={`${turnId}:${start}`}
      />
    );
  };
  let offset = 0;
  const groups = initialInactiveItemIds ? partitionWorkedRows(stableEntries) : [stableEntries];
  const progressiveGroups: ThreadProgressiveWindowChunk[] = groups.map(group => {
    const start = offset;
    offset += group.length;
    const children = renderWindowedEntries(group, start);
    const firstEntry = group[0];
    const key = firstEntry ? `group:${getRenderEntryKey(firstEntry, start)}` : `group:${turnId}:${start}`;
    if (!firstEntry?.eligible) return { key, content: children };
    const ids = group.flatMap(entry => entry.kind === "block" ? getRenderableBlockItems(entry.block).map(item => item.id) : [entry.item.id]);
    const activity = ids.map(id => {
      const timeline = findWorkbenchThreadItemTimelineEntry(id, renderItemTimeline);
      const times = timeline ? [timeline.startedAt, timeline.firstSeenAt, timeline.completedAt, timeline.lastSeenAt].filter((time): time is number => time !== null) : [];
      return times.length ? Math.max(...times) : null;
    });
    return {
      key,
      content: (
        <ThreadWorkedRun
          identity={ids[0]!}
          count={group.length}
          durationMs={getThreadItemTimelineDurationMs(ids, renderItemTimeline)}
          fileTotals={getThreadFileChangeTotals(group.flatMap(entry => entry.kind === "block"
            ? getRenderableBlockItems(entry.block).filter((item): item is Extract<ThreadItem, { type: "fileChange" | "dynamicToolCall" }> => item.type === "fileChange" || item.type === "dynamicToolCall")
            : []))}
          initialInactive={ids.every(id => initialInactiveItemIds?.has(id) ?? false)}
          newestActivityAt={activity.some(time => time === null) ? null : Math.max(...activity as number[])}
        >
          {children}
        </ThreadWorkedRun>
      ),
    };
  });
  return <ThreadProgressiveWindow chunks={progressiveGroups} identity={`${turnId}:groups`} />;
});

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
  const animateEntries = useEntryMotionAfterMount(turn.status === "inProgress");
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
    itemGroups: baseRenderableBlocks
      .filter((block) => block.kind !== "item" || block.item.type !== "collabAgentToolCall")
      .map(getRenderableBlockItems),
  }), [baseRenderableBlocks, hideTerminalReasoning]);
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
    <ThreadEntryMotion
      enabled={animateEntries && block.kind !== "fileChangeSequence"}
      identity={getThreadEntryMotionIdentity(getRenderableBlockItems(block)[0]!)}
      key={block.kind === "commandSequence"
        ? `commands:${block.items[0]?.id ?? index}`
        : block.kind === "fileChangeSequence"
          ? `fileChanges:${block.items[0]?.id ?? index}`
          : block.kind === "reasoningSequence"
            ? `reasoning:${block.items[0]?.id ?? index}`
            : block.kind === "userMessageSequence"
              ? `userMessages:${block.items[0]?.id ?? index}`
            : block.kind === "agentMessageSequence"
              ? `agentMessages:${block.state}:${block.items[0]?.id ?? index}`
            : block.kind === "agentCommentarySequence"
              ? `commentary:${block.items[0]?.id ?? index}`
            : block.kind === "subagentWaitExchange"
              ? `waitExchange:${block.items[0]?.id ?? index}`
            : block.kind === "subagentCoordination"
              ? `coordination:${block.items[0]?.id ?? index}`
            : block.kind === "webSearchSequence"
              ? `webSearches:${block.items[0]?.id ?? index}`
              : `item:${block.item.id}`}>
      {(animate) => <div className={animate ? `block ${enterMotionClassName}` : undefined}>
        <ThreadMeasuredContent>
          <ThreadRenderableBlockView
            animateEntries={animateEntries}
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
        </ThreadMeasuredContent>
      </div>}
    </ThreadEntryMotion>
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
          summaryClassName="text-[0.92em] leading-[1.6] text-fg/muted"
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
            <p className="m-0 text-[0.92em] leading-[1.6] text-fg/muted">No intermediate work captured.</p>
          ) : null}
        </div>
      );
    };

    return (
      <section className={hideTopBorder ? "py-3" : "border-t border-[color-mix(in srgb, var(--text) 10%, transparent)] py-3"}>
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
              summaryClassName="text-[0.92em] leading-[1.6] text-fg/muted"
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
            <p className="m-0 text-[0.92em] leading-[1.6] text-fg/muted">No intermediate work captured.</p>
          )}
        </div>
      );
    };

    return (
      <section className={hideTopBorder ? "py-3" : "border-t border-[color-mix(in srgb, var(--text) 10%, transparent)] py-3"}>
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
            summaryClassName="text-[0.92em] leading-[1.6] text-fg/muted"
          />
          {renderBlocks(terminalBlocks, primaryUserBlock)}
        </div>
      </section>
    );
  }

  const blocks = allBlocks;
  const primaryUserBlock = blocks.find((block) => isUserMessageBlock(block)) ?? null;
  const terminalBlocks = isCompleted ? buildBlocksForItems(visibleTerminalItems) : [];
  const workedBlocks = isCompleted
    ? buildBlocksForItems(completedWorkPartition?.workedItems ?? [])
    : blocks;
  if (isCompleted && hideFinalAgentMessage && hideWorkbenchControlUserMessages && !primaryUserBlock && !workedBlocks.length && !terminalBlocks.length) {
    return null;
  }

  return (
    <section className={hideTopBorder ? "py-3" : "border-t border-[color-mix(in srgb, var(--text) 10%, transparent)] py-3"}>
      {isCompleted && flattenCompletedWork ? (
        <div className="space-y-2">
          {primaryUserBlock ? renderBlock(primaryUserBlock, 0, blocks, primaryUserBlock) : null}
          {renderBlocks(workedBlocks, primaryUserBlock)}
          {renderBlocks(terminalBlocks, primaryUserBlock)}
        </div>
      ) : (
        <div className="space-y-2">
          {/* <p className="m-0 text-[0.67em] uppercase tracking-[0.18em] text-fg/muted">
            {humanizeThreadLabel(turn.status)}
          </p> */}
          {workedBlocks.length ? renderBlocks(workedBlocks, primaryUserBlock) : (
            <></> // <p className="m-0 text-[0.92em] leading-[1.6] text-fg/muted">No captured items.</p>
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
      <p className="m-0 text-[0.92em] leading-[1.6] text-fg/muted">
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
