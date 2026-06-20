/*
 * Exports:
 * - default ThreadView: render the main thread, subthread tabs, live activity, and polled turn history. Keywords: thread view, subthread, polling, workbench.
 */
"use client";

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";

import type { RateLimitSnapshot } from "../../../lib/codex/generated/app-server/v2/RateLimitSnapshot";
import type { UserInput } from "../../../lib/codex/generated/app-server/v2/UserInput";
import { getCurrentInProgressTurn, mergeTurnsPreservingLiveItems } from "../../../lib/codex/thread-state";
import type {
  ThreadPayload,
  ThreadUnreadBadge,
  WorkbenchHarness,
  WorkbenchModelOption,
  WorkbenchPendingUserInputRequest,
  WorkbenchProjectRoot,
  WorkbenchQuestionnaireDraft,
  WorkbenchReadThreadOptions,
  WorkbenchSendThreadMessageOptions,
  WorkbenchSkillSummary,
  WorkbenchSubmitUserInputRequestOptions,
  WorkbenchThreadComposerDraft,
  WorkbenchThreadSavedComposerDraft,
  WorkbenchThreadTurnHistoryEntry,
  WorkbenchUserInputResponse,
} from "../../../lib/types";
import type { WorkspaceFileLinkRoot } from "../../../lib/workbench/markdown/markdown-links";
import type { ProjectTreeFileCandidate } from "../../../lib/workbench/project/ProjectTreeFileIndex";
import {
  createProjectFilePathDisambiguationIndexCooperatively,
  readCachedProjectFilePathDisambiguationIndex,
  writeProjectFilePathDisambiguationIndexCache,
  type ProjectFilePathDisambiguationIndex,
} from "../../../lib/workbench/project/project-file-path";
import {
  persistThreadLiveActivityOpen,
  readStoredThreadLiveActivityOpen,
} from "../../../lib/workbench/state/browser-state";
import CooperativeRebuildQueue from "../../../lib/workbench/state/CooperativeRebuildQueue";
import {
  buildInlineMentionCandidates,
  buildInlineMentionCandidatesCooperatively,
  readCachedInlineMentionCandidates,
  type BuildInlineMentionCandidatesOptions,
  type InlineMentionHighlightSources,
} from "../../../lib/workbench/thread/inline-mention-highlights";
import {
  getCollabAgentThreadIds,
  getThreadAgentTabLabel,
} from "../../../lib/workbench/thread/thread-collab-agents";
import { ThreadQuestionBadge, ThreadUnreadBadge as ThreadUnreadBadgeView } from "../ThreadStatusBadges";
import ThreadAgentName from "./ThreadAgentName";
import ThreadComposer from "./ThreadComposer";
import ThreadContextStatus from "./ThreadContextStatus";
import ThreadDisclosure from "./ThreadDisclosure";
import ThreadMarkdown from "./ThreadMarkdown";
import ThreadPreviewFrame from "./ThreadPreviewFrame";
import ThreadRateLimits from "./ThreadRateLimits";
import {
  getThreadWebSearchLiveLabel,
  isThreadWebSearchPlaceholder,
  ThreadWebSearchActionRow,
} from "./ThreadWebSearchItem";
import { ProjectFilePathDisplayProvider } from "../ProjectFilePath";
import { ThreadThreadContent, ThreadTurnDetails, ThreadTurnLoadingSkeleton } from "./thread-view-items";

const SUBTHREAD_POLL_INTERVAL_MS = 1500;
const CODE_BLOCK_COPY_FEEDBACK_MS = 1500;
const MAX_VISIBLE_HISTORY_ENTRIES = 8;
const EMPTY_HIDDEN_COLLAB_AGENT_TOOL_CALL_ITEM_IDS: readonly string[] = [];
const EMPTY_PROJECT_FILE_CANDIDATES: readonly ProjectTreeFileCandidate[] = [];
const THREAD_VIEW_BACKGROUND_REBUILD_SLICE_MS = 20;
const threadViewBackgroundRebuildQueue = new CooperativeRebuildQueue();

type LiveThreadActivity =
  | {
    body: string | null;
    hiddenItemId: string | null;
    kind: "reasoning";
    title: string;
  }
  | {
    kind: "subagentWaits";
    waits: Array<{
      hiddenItemId: string;
      receiverThreadId: string;
    }>;
  }
  | {
    contextItems: Extract<ThreadPayload["turns"][number]["items"][number], { type: "webSearch" }>[];
    hiddenItemIds: string[];
    kind: "webSearch";
    title: string;
  };

function joinClasses (...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

function countThreadItems (thread: Pick<ThreadPayload, "turns">) {
  return thread.turns.reduce((total, turn) => total + turn.items.length, 0);
}

function orderTurnsByHistory (turns: ThreadPayload["turns"], history: WorkbenchThreadTurnHistoryEntry[]) {
  const indexesById = new Map(history.map((entry, index) => [entry.turnId, index]));
  return [...turns].sort((left, right) => {
    const leftIndex = indexesById.get(left.id) ?? Number.MAX_SAFE_INTEGER;
    const rightIndex = indexesById.get(right.id) ?? Number.MAX_SAFE_INTEGER;
    if (leftIndex !== rightIndex) {
      return leftIndex - rightIndex;
    }

    return left.id.localeCompare(right.id);
  });
}

function mergeThreadHistory (
  incomingHistory: WorkbenchThreadTurnHistoryEntry[],
  existingHistory: WorkbenchThreadTurnHistoryEntry[],
) {
  if (!existingHistory.length) {
    return incomingHistory;
  }

  const incomingById = new Map(incomingHistory.map((entry) => [entry.turnId, entry]));
  const merged = existingHistory.map((entry) => {
    const incomingEntry = incomingById.get(entry.turnId);
    if (!incomingEntry) {
      return entry;
    }

    incomingById.delete(entry.turnId);
    return entry.loadState === "loaded" && incomingEntry.loadState !== "loaded"
      ? { ...incomingEntry, itemIds: incomingEntry.itemIds ?? entry.itemIds, loadState: entry.loadState }
      : incomingEntry;
  });

  return [...merged, ...incomingById.values()];
}

function mergeLazyThreadPayload (incomingThread: ThreadPayload, existingThread: ThreadPayload | undefined) {
  if (!existingThread || existingThread.id !== incomingThread.id || existingThread.harness !== incomingThread.harness) {
    return incomingThread;
  }

  const history = mergeThreadHistory(incomingThread.turnHistory, existingThread.turnHistory);
  const existingTurnsById = new Set(existingThread.turns.map((turn) => turn.id));
  const turns = orderTurnsByHistory([
    ...existingThread.turns.map((turn) => incomingThread.turns.find((incomingTurn) => incomingTurn.id === turn.id) ?? turn),
    ...incomingThread.turns.filter((turn) => !existingTurnsById.has(turn.id)),
  ], history);

  return {
    ...incomingThread,
    serviceTier: incomingThread.serviceTier ?? existingThread.serviceTier,
    turnHistory: history,
    turns,
  };
}

function getVisibleHistoryEntries (thread: ThreadPayload) {
  const loadedTurnIds = new Set(thread.turns.map((turn) => turn.id));
  const history = thread.turnHistory.length
    ? thread.turnHistory
    : thread.turns.map((turn) => ({
      completedAt: turn.completedAt,
      durationMs: turn.durationMs,
      itemCount: turn.items.length,
      itemIds: turn.items.map((item) => item.id),
      loadState: "loaded" as const,
      startedAt: turn.startedAt,
      status: turn.status,
      turnId: turn.id,
    }));
  if (!history.length) {
    return [];
  }
  const lastLoadedIndex = Math.max(...history.map((entry, index) => loadedTurnIds.has(entry.turnId) ? index : -1));
  if (lastLoadedIndex < 0) {
    return history.slice(-1);
  }

  const firstLoadedIndex = history.findIndex((entry) => loadedTurnIds.has(entry.turnId));
  const startIndex = Math.max(0, firstLoadedIndex - 1, lastLoadedIndex - MAX_VISIBLE_HISTORY_ENTRIES + 1);
  return history.slice(startIndex, lastLoadedIndex + 1);
}

function areThreadPayloadsEquivalent (left: ThreadPayload | null | undefined, right: ThreadPayload | null | undefined) {
  if (left === right) {
    return true;
  }

  if (!left || !right) {
    return false;
  }

  return JSON.stringify(left) === JSON.stringify(right);
}

function mergeSubthreadTurnSnapshots (
  incomingThread: ThreadPayload,
  existingThread: ThreadPayload | undefined,
) {
  if (!existingThread || existingThread.id !== incomingThread.id || existingThread.harness !== incomingThread.harness) {
    return incomingThread;
  }

  const mergedThread = mergeLazyThreadPayload(incomingThread, existingThread);
  const existingTurnsById = new Map(existingThread.turns.map((turn) => [turn.id, turn]));
  let changed = false;
  const mergedTurns = mergeTurnsPreservingLiveItems(mergedThread.turns, existingThread.turns);
  if (mergedTurns !== mergedThread.turns) {
    changed = true;
  }

  const turns = mergedTurns.map((incomingTurn) => {
    const existingTurn = existingTurnsById.get(incomingTurn.id);
    if (!existingTurn || incomingTurn.status !== "inProgress" || existingTurn.status !== "inProgress") {
      return incomingTurn;
    }

    const incomingItemIds = new Set(incomingTurn.items.map((item) => item.id));
    const missingActiveCommandItems = existingTurn.items.filter((item) => (
      item.type === "commandExecution"
      && item.status === "inProgress"
      && !incomingItemIds.has(item.id)
    ));
    if (!missingActiveCommandItems.length) {
      return incomingTurn;
    }

    changed = true;
    return {
      ...incomingTurn,
      items: [
        ...incomingTurn.items,
        ...missingActiveCommandItems,
      ],
    };
  });

  const serviceTier = mergedThread.serviceTier ?? existingThread.serviceTier;

  if (changed || serviceTier !== mergedThread.serviceTier || turns !== mergedThread.turns) {
    return { ...mergedThread, serviceTier, turns };
  }

  return mergedThread;
}

function hasExpandedSelectionWithin (root: HTMLElement | null) {
  if (!root || typeof window === "undefined" || typeof window.getSelection !== "function") {
    return false;
  }

  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return false;
  }

  const anchorNode = selection.anchorNode;
  const focusNode = selection.focusNode;
  return Boolean(anchorNode && focusNode && root.contains(anchorNode) && root.contains(focusNode));
}

async function writeTextToClipboard (text: string) {
  if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
    return false;
  }

  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function setCodeBlockCopyButtonState (button: HTMLButtonElement, isCopied: boolean) {
  button.setAttribute("data-thread-codeblock-copy-state", isCopied ? "copied" : "idle");
  button.setAttribute("aria-label", isCopied ? "Copied code block" : "Copy code block");
  button.title = isCopied ? "Copied" : "Copy code block";
}

function cleanReasoningTitleLine (value: string) {
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

function getReasoningStepBody (sections: string[]) {
  const bodySections: string[] = [];
  let removedTitle = false;

  for (const section of sections) {
    const lines = section.split(/\r?\n/);
    if (!removedTitle) {
      const firstTextLineIndex = lines.findIndex((line) => line.trim());
      if (firstTextLineIndex !== -1) {
        lines.splice(firstTextLineIndex, 1);
        removedTitle = true;
      }
    }

    const bodySection = lines.join("\n").trim();
    if (bodySection) {
      bodySections.push(bodySection);
    }
  }

  return bodySections.join("\n\n").trim() || null;
}

function getCurrentReasoningStep (turn: ThreadPayload["turns"][number] | null) {
  if (!turn || turn.status !== "inProgress") {
    return null;
  }

  const latestItem = turn.items.at(-1);
  if (!latestItem || latestItem.type !== "reasoning") {
    return null;
  }

  const visibleSections = latestItem.summary.length ? latestItem.summary : latestItem.content;
  for (const section of visibleSections) {
    const title = cleanReasoningTitleLine(section);
    if (title) {
      return {
        body: getReasoningStepBody(visibleSections),
        id: latestItem.id,
        title,
      };
    }
  }

  return {
    body: getReasoningStepBody(visibleSections),
    id: latestItem.id,
    title: "Thinking",
  };
}

function getLiveThreadActivity ({
  pendingUserInputRequest,
  turn,
}: {
  pendingUserInputRequest: WorkbenchPendingUserInputRequest | null;
  turn: ThreadPayload["turns"][number] | null;
}): LiveThreadActivity | null {
  if (!turn || turn.status !== "inProgress" || pendingUserInputRequest) {
    return null;
  }

  const waits: Array<{ hiddenItemId: string; receiverThreadId: string }> = [];
  const seenWaitKeys = new Set<string>();
  for (let index = turn.items.length - 1; index >= 0; index -= 1) {
    const item = turn.items[index];
    if (item.type !== "collabAgentToolCall" || item.tool !== "wait" || item.status !== "inProgress") {
      break;
    }

    for (const receiverThreadId of item.receiverThreadIds) {
      const trimmedReceiverThreadId = receiverThreadId.trim();
      if (!trimmedReceiverThreadId) {
        continue;
      }

      const waitKey = `${item.id}:${trimmedReceiverThreadId}`;
      if (seenWaitKeys.has(waitKey)) {
        continue;
      }

      seenWaitKeys.add(waitKey);
      waits.unshift({
        hiddenItemId: item.id,
        receiverThreadId: trimmedReceiverThreadId,
      });
    }
  }

  if (waits.length) {
    return {
      kind: "subagentWaits",
      waits,
    };
  }

  const reasoningStep = getCurrentReasoningStep(turn);
  if (reasoningStep) {
    return {
      body: reasoningStep.body,
      hiddenItemId: reasoningStep.id,
      kind: "reasoning",
      title: reasoningStep.title,
    };
  }

  const latestItem = turn.items.at(-1);
  if (latestItem?.type === "webSearch" && isThreadWebSearchPlaceholder(latestItem)) {
    const contextItems: Extract<ThreadPayload["turns"][number]["items"][number], { type: "webSearch" }>[] = [];
    for (let index = turn.items.length - 2; index >= 0; index -= 1) {
      const item = turn.items[index];
      if (item.type === "reasoning" && !item.summary.some((section) => section.trim()) && !item.content.some((section) => section.trim())) {
        continue;
      }

      if (item.type === "agentMessage" && !item.text.trim()) {
        continue;
      }

      if (item.type !== "webSearch") {
        break;
      }

      if (!isThreadWebSearchPlaceholder(item)) {
        contextItems.unshift(item);
      }
    }

    return {
      contextItems,
      hiddenItemIds: [
        latestItem.id,
        ...contextItems.map((item) => item.id),
      ],
      kind: "webSearch",
      title: getThreadWebSearchLiveLabel(latestItem),
    };
  }

  return {
    body: null,
    hiddenItemId: null,
    kind: "reasoning",
    title: "Thinking",
  };
}

function useBackgroundInlineMentionSources({
  files,
  filesIdentity,
  projectRootPath,
  skills,
  threadCwdPath,
  workspaceRoots = [],
}: BuildInlineMentionCandidatesOptions): InlineMentionHighlightSources {
  const fallbackSources = useMemo(() => buildInlineMentionCandidates({
    files: EMPTY_PROJECT_FILE_CANDIDATES,
    filesIdentity: "thread-view:empty-project-files",
    projectRootPath,
    skills,
    threadCwdPath,
    workspaceRoots,
  }), [projectRootPath, skills, threadCwdPath, workspaceRoots]);
  const [sources, setSources] = useState<InlineMentionHighlightSources>(() => (
    readCachedInlineMentionCandidates({
      files,
      filesIdentity,
      projectRootPath,
      skills,
      threadCwdPath,
      workspaceRoots,
    }) ?? fallbackSources
  ));
  const generationRef = useRef(0);

  useEffect(() => {
    generationRef.current += 1;
    const generation = generationRef.current;
    const cachedSources = readCachedInlineMentionCandidates({
      files,
      filesIdentity,
      projectRootPath,
      skills,
      threadCwdPath,
      workspaceRoots,
    });
    if (cachedSources) {
      setSources(cachedSources);
      return;
    }

    threadViewBackgroundRebuildQueue.enqueue({
      key: "thread-view:inline-mention-sources",
      run: (budget) => buildInlineMentionCandidatesCooperatively({
        files,
        filesIdentity,
        projectRootPath,
        skills,
        threadCwdPath,
        workspaceRoots,
      }, budget),
      commit(result) {
        if (generationRef.current === generation) {
          setSources(result);
        }
      },
      onError(error) {
        console.error("Failed to rebuild inline mention sources", error);
      },
      sliceMs: THREAD_VIEW_BACKGROUND_REBUILD_SLICE_MS,
    });
  }, [fallbackSources, files, filesIdentity, projectRootPath, skills, threadCwdPath, workspaceRoots]);

  return sources;
}

function useBackgroundProjectFilePathDisambiguationIndex(
  disambiguationPaths: readonly string[],
  disambiguationKey: string,
): ProjectFilePathDisambiguationIndex | null {
  const [disambiguationIndex, setDisambiguationIndex] = useState<ProjectFilePathDisambiguationIndex | null>(() => (
    readCachedProjectFilePathDisambiguationIndex(disambiguationPaths, disambiguationKey)
  ));
  const generationRef = useRef(0);

  useEffect(() => {
    generationRef.current += 1;
    const generation = generationRef.current;
    const cachedIndex = readCachedProjectFilePathDisambiguationIndex(disambiguationPaths, disambiguationKey);
    if (cachedIndex) {
      setDisambiguationIndex(cachedIndex);
      return;
    }

    threadViewBackgroundRebuildQueue.enqueue({
      key: "thread-view:project-file-path-disambiguation",
      async run(budget) {
        const index = await createProjectFilePathDisambiguationIndexCooperatively(disambiguationPaths, budget);
        writeProjectFilePathDisambiguationIndexCache(disambiguationPaths, disambiguationKey, index);
        return index;
      },
      commit(result) {
        if (generationRef.current === generation) {
          setDisambiguationIndex(result);
        }
      },
      onError(error) {
        console.error("Failed to rebuild project file path disambiguation index", error);
      },
      sliceMs: THREAD_VIEW_BACKGROUND_REBUILD_SLICE_MS,
    });
  }, [disambiguationKey, disambiguationPaths]);

  return disambiguationIndex;
}

export default memo(function ThreadView ({
  composerSpellCheck,
  contained = false,
  fontSizeRem,
  livePendingUserInputRequestsByThreadId,
  onDraftHarnessChange,
  onThreadCodeBlockWrapChange,
  onListModels,
  onReadThread,
  onThreadSeen,
  onCompactThread,
  onSendMessage,
  onStopThread,
  onSubmitUserInputRequest,
  onThreadComposerDraftChange,
  onThreadComposerDraftClear,
  onThreadQuestionnaireDraftChange,
  onThreadQuestionnaireDraftClear,
  onThreadSavedComposerDraftDelete,
  onThreadSavedComposerDraftSave,
  onThreadAgentChange,
  onThreadReasoningEffortChange,
  onThreadServiceTierChange,
  onThreadModelChange,
  projectId,
  projectFileCandidates,
  projectFileIndexId,
  projectFileLinkRoots,
  projectFilePaths,
  projectRootPath,
  projectRoots,
  rateLimits,
  threadCodeBlockWrap,
  threadComposerDraftsByThreadId,
  threadQuestionnaireDraftsByKey,
  threadSavedComposerDrafts,
  thread,
}: {
  composerSpellCheck: boolean;
  contained?: boolean;
  fontSizeRem: number;
  livePendingUserInputRequestsByThreadId: Record<string, WorkbenchPendingUserInputRequest>;
  onDraftHarnessChange: (harness: WorkbenchHarness) => void;
  onThreadCodeBlockWrapChange: (nextValue: boolean) => void;
  onListModels: (harness: WorkbenchHarness) => Promise<WorkbenchModelOption[]>;
  onReadThread: (threadId: string, harness?: WorkbenchHarness, options?: WorkbenchReadThreadOptions) => Promise<ThreadPayload | null>;
  onThreadSeen: (thread: ThreadPayload) => void;
  onCompactThread: (thread: ThreadPayload) => Promise<ThreadPayload | null>;
  onSendMessage: (
    thread: ThreadPayload,
    input: UserInput[],
    options?: WorkbenchSendThreadMessageOptions,
  ) => Promise<ThreadPayload | null>;
  onStopThread: (thread: ThreadPayload) => Promise<ThreadPayload | null>;
  onSubmitUserInputRequest: (
    threadId: string,
    response: WorkbenchUserInputResponse,
    options?: WorkbenchSubmitUserInputRequestOptions,
  ) => Promise<void>;
  onThreadComposerDraftChange: (threadId: string, draft: WorkbenchThreadComposerDraft) => void;
  onThreadComposerDraftClear: (threadId: string) => void;
  onThreadQuestionnaireDraftChange: (threadId: string, requestKey: string, draft: WorkbenchQuestionnaireDraft) => void;
  onThreadQuestionnaireDraftClear: (threadId: string, requestKey: string) => void;
  onThreadSavedComposerDraftDelete: (draftId: string) => void;
  onThreadSavedComposerDraftSave: (draft: WorkbenchThreadSavedComposerDraft) => void;
  onThreadAgentChange: (threadId: string, agentPath: string | null) => void;
  onThreadReasoningEffortChange: (threadId: string, effort: string | null) => void;
  onThreadServiceTierChange: (threadId: string, serviceTier: string | null) => void;
  onThreadModelChange: (threadId: string, model: string) => void;
  projectId: string;
  projectFileCandidates: readonly ProjectTreeFileCandidate[];
  projectFileIndexId: string;
  projectFileLinkRoots?: readonly WorkspaceFileLinkRoot[];
  projectFilePaths: readonly string[];
  projectRootPath: string;
  projectRoots?: readonly WorkbenchProjectRoot[];
  rateLimits: RateLimitSnapshot | null;
  threadCodeBlockWrap: boolean;
  threadComposerDraftsByThreadId: Record<string, WorkbenchThreadComposerDraft | undefined>;
  threadQuestionnaireDraftsByKey: Record<string, WorkbenchQuestionnaireDraft | undefined>;
  threadSavedComposerDrafts: WorkbenchThreadSavedComposerDraft[];
  thread: ThreadPayload;
}) {
  const [activeThreadId, setActiveThreadId] = useState(thread.id);
  const [subthreadsById, setSubthreadsById] = useState<Record<string, ThreadPayload>>({});
  const [loadingThreadIds, setLoadingThreadIds] = useState<Record<string, true>>({});
  const [loadingPreviousTurnKeys, setLoadingPreviousTurnKeys] = useState<Record<string, true>>({});
  const [seenItemCountsByThreadId, setSeenItemCountsByThreadId] = useState<Record<string, number>>({});
  const [isLiveActivityOpen, setIsLiveActivityOpen] = useState(readStoredThreadLiveActivityOpen);
  const [workbenchSkills, setWorkbenchSkills] = useState<WorkbenchSkillSummary[]>([]);
  const [draftSavedDraftShelfPortalHost, setDraftSavedDraftShelfPortalHost] = useState<HTMLDivElement | null>(null);
  const threadViewRef = useRef<HTMLDivElement>(null);
  const historySentinelRef = useRef<HTMLDivElement>(null);
  const bottomSentinelRef = useRef<HTMLDivElement>(null);
  const codeBlockCopyResetTimersRef = useRef<Map<HTMLButtonElement, number>>(new Map());
  const hasMountedActiveThreadScrollRef = useRef(false);
  const subthreadLoadGenerationRef = useRef(0);
  const subagentThreadIds = useMemo(() => getCollabAgentThreadIds(thread.turns), [thread.turns]);
  const activeThread = activeThreadId === thread.id
    ? thread
    : subthreadsById[activeThreadId] ?? null;
  const activeHarnessUserInputRequest = activeThread
    ? livePendingUserInputRequestsByThreadId[activeThread.id] ?? null
    : null;
  const activePendingUserInputRequest = activeHarnessUserInputRequest;
  const currentTurn = activeThread?.turns.at(-1) ?? null;
  const visibleHistoryEntries = useMemo(() => activeThread ? getVisibleHistoryEntries(activeThread) : [], [activeThread]);
  const loadedTurnsById = useMemo(() => new Map(activeThread?.turns.map((turn) => [turn.id, turn]) ?? []), [activeThread?.turns]);
  const firstVisibleLoadedEntry = visibleHistoryEntries.find((entry) => loadedTurnsById.has(entry.turnId)) ?? null;
  const previousTurnLoadKey = activeThread && firstVisibleLoadedEntry
    ? `${activeThread.id}:${firstVisibleLoadedEntry.turnId}`
    : "";
  const canLoadPreviousTurn = Boolean(
    activeThread
    && firstVisibleLoadedEntry
    && visibleHistoryEntries.some((entry) => entry.turnId !== firstVisibleLoadedEntry.turnId && entry.loadState === "unloaded" && !loadedTurnsById.has(entry.turnId)),
  );
  const liveActivity = useMemo(() => getLiveThreadActivity({
    pendingUserInputRequest: activePendingUserInputRequest,
    turn: currentTurn,
  }), [activePendingUserInputRequest, currentTurn]);
  const hiddenCollabAgentToolCallItemIds = useMemo(() => {
    if (liveActivity?.kind !== "subagentWaits") {
      return EMPTY_HIDDEN_COLLAB_AGENT_TOOL_CALL_ITEM_IDS;
    }

    return Array.from(new Set(liveActivity.waits.map((wait) => wait.hiddenItemId)));
  }, [liveActivity]);
  const workspaceFileLinkRoots = useMemo(() => (
    projectFileLinkRoots ?? (projectRoots && projectRoots.length > 1
      ? projectRoots.map((root) => ({ id: root.id, rootPath: root.rootPath }))
      : [])
  ), [projectFileLinkRoots, projectRoots]);
  const inlineMentionSources = useBackgroundInlineMentionSources({
    files: projectFileCandidates,
    filesIdentity: projectFileIndexId,
    threadCwdPath: activeThread?.cwd,
    projectRootPath,
    skills: workbenchSkills,
    workspaceRoots: workspaceFileLinkRoots,
  });
  const projectFilePathDisambiguationIndex = useBackgroundProjectFilePathDisambiguationIndex(
    projectFilePaths,
    projectFileIndexId,
  );

  const tabDefinitions = useMemo(() => {
    const baseLabelCounts = new Map<string, number>();
    for (const threadId of subagentThreadIds) {
      const label = getThreadAgentTabLabel(subthreadsById[threadId]);
      baseLabelCounts.set(label, (baseLabelCounts.get(label) ?? 0) + 1);
    }

    const usedLabels = new Map<string, number>();
    return subagentThreadIds.map((threadId) => {
      const baseLabel = getThreadAgentTabLabel(subthreadsById[threadId]);
      const totalCount = baseLabelCounts.get(baseLabel) ?? 0;
      const nextCount = (usedLabels.get(baseLabel) ?? 0) + 1;
      usedLabels.set(baseLabel, nextCount);
      return {
        id: threadId,
        isLoading: Boolean(loadingThreadIds[threadId]) && !subthreadsById[threadId],
        suffix: totalCount > 1 ? ` ${nextCount}` : "",
      };
    });
  }, [loadingThreadIds, subagentThreadIds, subthreadsById]);

  const markThreadSeen = useCallback((threadId: string, payload: ThreadPayload | null | undefined) => {
    if (!payload) {
      return;
    }

    const totalItems = countThreadItems(payload);
    setSeenItemCountsByThreadId((current) => (
      current[threadId] === totalItems
        ? current
        : {
          ...current,
          [threadId]: totalItems,
        }
    ));
  }, []);

  const loadSubthread = useCallback(async (threadId: string, harness: WorkbenchHarness = thread.harness) => {
    if (!threadId.trim() || threadId === thread.id) {
      return null;
    }

    const loadGeneration = subthreadLoadGenerationRef.current;
    setLoadingThreadIds((current) => (
      current[threadId]
        ? current
        : {
          ...current,
          [threadId]: true,
        }
    ));

    try {
      const payload = await onReadThread(threadId, harness, { hydration: { mode: "latest" } });
      if (!payload) {
        return null;
      }
      if (loadGeneration !== subthreadLoadGenerationRef.current) {
        return null;
      }

      setSubthreadsById((current) => {
        if (loadGeneration !== subthreadLoadGenerationRef.current) {
          return current;
        }

        const existing = current[threadId];
        const mergedPayload = mergeSubthreadTurnSnapshots(payload, existing);
        if (areThreadPayloadsEquivalent(existing, mergedPayload)) {
          return current;
        }

        return {
          ...current,
          [threadId]: mergedPayload,
        };
      });
      setSeenItemCountsByThreadId((current) => (
        current[threadId] !== undefined
          ? current
          : {
            ...current,
            [threadId]: countThreadItems(payload),
          }
      ));
      return payload;
    } finally {
      setLoadingThreadIds((current) => {
        if (loadGeneration !== subthreadLoadGenerationRef.current) {
          return current;
        }

        if (!current[threadId]) {
          return current;
        }

        const next = { ...current };
        delete next[threadId];
        return next;
      });
    }
  }, [onReadThread, projectId, thread.harness, thread.id]);

  const loadPreviousTurn = useCallback(async () => {
    if (!activeThread || !firstVisibleLoadedEntry || !previousTurnLoadKey || loadingPreviousTurnKeys[previousTurnLoadKey]) {
      return;
    }

    const loadGeneration = subthreadLoadGenerationRef.current;
    const targetThreadId = activeThread.id;
    const targetHarness = activeThread.harness;
    setLoadingPreviousTurnKeys((current) => (
      current[previousTurnLoadKey]
        ? current
        : {
          ...current,
          [previousTurnLoadKey]: true,
        }
    ));

    try {
      const payload = await onReadThread(targetThreadId, targetHarness, {
        hydration: {
          beforeTurnId: firstVisibleLoadedEntry.turnId,
          mode: "previous",
        },
      });
      if (!payload || loadGeneration !== subthreadLoadGenerationRef.current) {
        return;
      }

      if (targetThreadId !== thread.id) {
        setSubthreadsById((current) => {
          const existing = current[targetThreadId];
          const mergedPayload = mergeLazyThreadPayload(payload, existing);
          if (areThreadPayloadsEquivalent(existing, mergedPayload)) {
            return current;
          }

          return {
            ...current,
            [targetThreadId]: mergedPayload,
          };
        });
      }
    } finally {
      setLoadingPreviousTurnKeys((current) => {
        if (!current[previousTurnLoadKey]) {
          return current;
        }

        const next = { ...current };
        delete next[previousTurnLoadKey];
        return next;
      });
    }
  }, [activeThread, firstVisibleLoadedEntry, loadingPreviousTurnKeys, onReadThread, previousTurnLoadKey, thread.id]);

  useEffect(() => {
    subthreadLoadGenerationRef.current += 1;
    setActiveThreadId(thread.id);
    setSubthreadsById({});
    setLoadingThreadIds({});
    setLoadingPreviousTurnKeys({});
    setSeenItemCountsByThreadId({
      [thread.id]: countThreadItems(thread),
    });
  }, [projectId, thread.id]);

  useEffect(() => {
    let cancelled = false;
    const url = projectId
      ? `/api/workbench-library/skills?projectId=${encodeURIComponent(projectId)}`
      : "/api/workbench-library/skills";
    void fetch(url, { cache: "no-store" }).then(async (response) => {
      if (!response.ok) {
        throw new Error("Unable to load skills.");
      }

      const payload = await response.json() as { data?: WorkbenchSkillSummary[] };
      if (!cancelled) {
        setWorkbenchSkills(payload.data ?? []);
      }
    }).catch(() => {
      if (!cancelled) {
        setWorkbenchSkills([]);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [projectId]);

  useEffect(() => {
    for (const threadId of subagentThreadIds) {
      if (threadId === thread.id || subthreadsById[threadId] || loadingThreadIds[threadId]) {
        continue;
      }

      void loadSubthread(threadId);
    }
  }, [loadSubthread, loadingThreadIds, subagentThreadIds, subthreadsById, thread.id]);

  const pollingThreadIds = useMemo(() => subagentThreadIds.filter((threadId) => {
    const payload = subthreadsById[threadId];
    return Boolean(payload && getCurrentInProgressTurn(payload));
  }), [subagentThreadIds, subthreadsById]);

  useEffect(() => {
    if (!pollingThreadIds.length) {
      return;
    }

    const intervalId = window.setInterval(() => {
      for (const threadId of pollingThreadIds) {
        void loadSubthread(threadId);
      }
    }, SUBTHREAD_POLL_INTERVAL_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [loadSubthread, pollingThreadIds]);

  useEffect(() => {
    const sentinel = historySentinelRef.current;
    if (!sentinel || !canLoadPreviousTurn || !previousTurnLoadKey || loadingPreviousTurnKeys[previousTurnLoadKey]) {
      return;
    }

    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        void loadPreviousTurn();
      }
    }, {
      root: null,
      rootMargin: "160px 0px 0px 0px",
      threshold: 0.1,
    });
    observer.observe(sentinel);
    return () => {
      observer.disconnect();
    };
  }, [canLoadPreviousTurn, loadPreviousTurn, loadingPreviousTurnKeys, previousTurnLoadKey]);

  useLayoutEffect(() => {
    if (!hasMountedActiveThreadScrollRef.current) {
      hasMountedActiveThreadScrollRef.current = true;
      return;
    }

    if (hasExpandedSelectionWithin(threadViewRef.current)) {
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      bottomSentinelRef.current?.scrollIntoView({ block: "end" });
    });

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [activeThread?.id]);

  useEffect(() => {
    onThreadSeen(thread);
  }, [onThreadSeen, thread]);

  useEffect(() => () => {
    codeBlockCopyResetTimersRef.current.forEach((timeoutId) => {
      window.clearTimeout(timeoutId);
    });
    codeBlockCopyResetTimersRef.current.clear();
  }, []);

  useEffect(() => {
    if (!activeThread) {
      return;
    }

    markThreadSeen(activeThread.id, activeThread);
  }, [activeThread, markThreadSeen]);

  const handleSubthreadSelection = useCallback((threadId: string) => {
    setActiveThreadId(threadId);
    if (threadId !== thread.id) {
      void loadSubthread(threadId);
    }
  }, [loadSubthread, thread.id]);

  const handleSendMessage = useCallback(async (_threadId: string, input: UserInput[]) => {
    if (!activeThread) {
      return;
    }

    const payload = await onSendMessage(activeThread, input, {
      selectThread: activeThread.id === thread.id,
    });
    if (payload && activeThread.id !== thread.id) {
      setSubthreadsById((current) => ({
        ...current,
        [activeThread.id]: payload,
      }));
    }
  }, [activeThread, onSendMessage, thread.id]);

  const handleStopThread = useCallback(async () => {
    if (!activeThread) {
      return;
    }

    const payload = await onStopThread(activeThread);
    if (payload && activeThread.id !== thread.id) {
      setSubthreadsById((current) => ({
        ...current,
        [activeThread.id]: payload,
      }));
    }
  }, [activeThread, onStopThread, thread.id]);

  const handleThreadModelChange = useCallback((threadId: string, model: string) => {
    if (threadId === thread.id) {
      onThreadModelChange(threadId, model);
      return;
    }

    setSubthreadsById((current) => {
      const existing = current[threadId];
      if (!existing) {
        return current;
      }

      return {
        ...current,
        [threadId]: {
          ...existing,
          model,
          reasoningEffort: null,
          serviceTier: null,
        },
      };
    });
  }, [onThreadModelChange, thread.id]);

  const handleThreadAgentChange = useCallback((threadId: string, agentPath: string | null) => {
    if (threadId === thread.id) {
      onThreadAgentChange(threadId, agentPath);
      return;
    }

    setSubthreadsById((current) => {
      const existing = current[threadId];
      if (!existing) {
        return current;
      }

      return {
        ...current,
        [threadId]: {
          ...existing,
          agentPath,
        },
      };
    });
  }, [onThreadAgentChange, thread.id]);

  const handleThreadReasoningEffortChange = useCallback((threadId: string, effort: string | null) => {
    if (threadId === thread.id) {
      onThreadReasoningEffortChange(threadId, effort);
      return;
    }

    setSubthreadsById((current) => {
      const existing = current[threadId];
      if (!existing) {
        return current;
      }

      return {
        ...current,
        [threadId]: {
          ...existing,
          reasoningEffort: effort,
        },
      };
    });
  }, [onThreadReasoningEffortChange, thread.id]);

  const handleThreadServiceTierChange = useCallback((threadId: string, serviceTier: string | null) => {
    if (threadId === thread.id) {
      onThreadServiceTierChange(threadId, serviceTier);
      return;
    }

    setSubthreadsById((current) => {
      const existing = current[threadId];
      if (!existing || existing.harness !== "codex") {
        return current;
      }

      return {
        ...current,
        [threadId]: {
          ...existing,
          serviceTier,
        },
      };
    });
  }, [onThreadServiceTierChange, thread.id]);

  const syncCodeBlockWrapDomState = useCallback((nextValue: boolean) => {
    const root = threadViewRef.current;
    if (!root) {
      return;
    }

    root.setAttribute("data-thread-codeblock-wrap", nextValue ? "true" : "false");
    root.querySelectorAll<HTMLButtonElement>("button[data-thread-codeblock-wrap-toggle]").forEach((button) => {
      button.setAttribute("aria-pressed", nextValue ? "true" : "false");
    });
  }, []);

  useLayoutEffect(() => {
    syncCodeBlockWrapDomState(threadCodeBlockWrap);
  }, [syncCodeBlockWrapDomState, threadCodeBlockWrap]);

  const showCodeBlockCopyFeedback = useCallback((button: HTMLButtonElement) => {
    const existingTimeoutId = codeBlockCopyResetTimersRef.current.get(button);
    if (existingTimeoutId !== undefined) {
      window.clearTimeout(existingTimeoutId);
    }

    setCodeBlockCopyButtonState(button, true);
    const timeoutId = window.setTimeout(() => {
      setCodeBlockCopyButtonState(button, false);
      codeBlockCopyResetTimersRef.current.delete(button);
    }, CODE_BLOCK_COPY_FEEDBACK_MS);
    codeBlockCopyResetTimersRef.current.set(button, timeoutId);
  }, []);

  const handleCodeBlockCopy = useCallback(async (button: HTMLButtonElement) => {
    const root = threadViewRef.current;
    const codeBlock = button.closest<HTMLElement>("[data-thread-codeblock='true']");
    const code = codeBlock?.querySelector<HTMLElement>("[data-thread-codeblock-code='true']");
    if (!root || !root.contains(button) || !code) {
      return;
    }

    const didCopy = await writeTextToClipboard(code.textContent ?? "");
    if (!didCopy || !root.contains(button)) {
      return;
    }

    showCodeBlockCopyFeedback(button);
  }, [showCodeBlockCopyFeedback]);

  const handleThreadViewClick = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    const target = event.target instanceof Element ? event.target : null;
    const copyButton = target?.closest<HTMLButtonElement>("button[data-thread-codeblock-copy]") ?? null;
    if (copyButton && threadViewRef.current?.contains(copyButton)) {
      void handleCodeBlockCopy(copyButton);
      return;
    }

    const toggle = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>("button[data-thread-codeblock-wrap-toggle]")
      : null;
    if (!toggle || !threadViewRef.current?.contains(toggle)) {
      return;
    }

    const nextValue = threadViewRef.current.getAttribute("data-thread-codeblock-wrap") !== "true";
    syncCodeBlockWrapDomState(nextValue);
    onThreadCodeBlockWrapChange(nextValue);
  }, [handleCodeBlockCopy, onThreadCodeBlockWrapChange, syncCodeBlockWrapDomState]);

  const getTabBadge = useCallback((threadId: string, payload: ThreadPayload | null | undefined): { isQuestion: boolean; unreadBadge: ThreadUnreadBadge | null } => {
    const hasPendingQuestion = Boolean(livePendingUserInputRequestsByThreadId[threadId]);
    if (hasPendingQuestion) {
      return {
        isQuestion: true,
        unreadBadge: null,
      };
    }

    if (!payload) {
      return {
        isQuestion: false,
        unreadBadge: null,
      };
    }

    const hasActiveTurn = Boolean(getCurrentInProgressTurn(payload));
    const totalItems = countThreadItems(payload);
    const seenItemCount = seenItemCountsByThreadId[threadId] ?? totalItems;
    const unreadCount = Math.max(0, totalItems - seenItemCount);

    if (hasActiveTurn) {
      return {
        isQuestion: false,
        unreadBadge: {
          unreadCount,
          hasActiveTurn: true,
        },
      };
    }

    if (threadId === thread.id && unreadCount > 0) {
      return {
        isQuestion: false,
        unreadBadge: {
          unreadCount,
          hasActiveTurn: false,
        },
      };
    }

    return {
      isQuestion: false,
      unreadBadge: null,
    };
  }, [livePendingUserInputRequestsByThreadId, seenItemCountsByThreadId, thread.id]);

  const mainThreadBadge = getTabBadge(thread.id, thread);
  const isDraftThreadView = Boolean(activeThread?.isDraft);
  const composer = activeThread ? (
    <ThreadComposer
      key={activeThread.id}
      composerSpellCheck={composerSpellCheck}
      onListModels={onListModels}
      highlightSources={inlineMentionSources}
      onSendMessage={handleSendMessage}
      onStopThread={() => {
        void handleStopThread();
      }}
      onThreadComposerDraftChange={onThreadComposerDraftChange}
      onThreadComposerDraftClear={onThreadComposerDraftClear}
      onThreadQuestionnaireDraftChange={onThreadQuestionnaireDraftChange}
      onThreadQuestionnaireDraftClear={onThreadQuestionnaireDraftClear}
      onThreadSavedComposerDraftDelete={onThreadSavedComposerDraftDelete}
      onThreadSavedComposerDraftSave={onThreadSavedComposerDraftSave}
      onSubmitUserInputRequest={onSubmitUserInputRequest}
      onThreadAgentChange={handleThreadAgentChange}
      onThreadReasoningEffortChange={handleThreadReasoningEffortChange}
      onThreadServiceTierChange={handleThreadServiceTierChange}
      onThreadModelChange={handleThreadModelChange}
      pendingUserInputRequest={activePendingUserInputRequest}
      projectId={projectId}
      projectRootPath={projectRootPath}
      workspaceRoots={workspaceFileLinkRoots}
      rateLimits={rateLimits}
      autoExpandSavedDraftShelf={!isDraftThreadView}
      savedDraftShelfPortalHost={isDraftThreadView ? draftSavedDraftShelfPortalHost : null}
      threadComposerDraft={threadComposerDraftsByThreadId[activeThread.id] ?? null}
      threadQuestionnaireDraft={activePendingUserInputRequest
        ? threadQuestionnaireDraftsByKey[`${activeThread.id}:${activePendingUserInputRequest.requestKey}`] ?? null
        : null}
      threadSavedComposerDrafts={threadSavedComposerDrafts}
      useSavedDraftShelfPortal={isDraftThreadView}
      knownSkills={workbenchSkills}
      thread={activeThread}
    >
      <ThreadRateLimits
        canToggleHarness={activeThread.isDraft}
        harness={activeThread.harness}
        onHarnessToggle={() => {
          onDraftHarnessChange(activeThread.harness === "codex" ? "copilot" : "codex");
        }}
        rateLimits={rateLimits}
        trailingContent={(
          <ThreadContextStatus
            onCompactThread={onCompactThread}
            thread={activeThread}
          />
        )}
      />
    </ThreadComposer>
  ) : null;

  return (
    <ProjectFilePathDisplayProvider
      disambiguationIndex={projectFilePathDisambiguationIndex}
      disambiguationKey={projectFileIndexId}
      disambiguationPaths={projectFilePaths}
    >
      <div
        ref={threadViewRef}
        data-thread-codeblock-wrap={threadCodeBlockWrap ? "true" : "false"}
        data-thread-project-file-link-boundary="true"
        className={joinClasses(
          "mx-auto w-full min-w-0 max-w-[56rem] overflow-x-hidden md:overflow-x-visible",
          contained ? "pb-8" : "pb-16",
        )}
        onClick={handleThreadViewClick}
        style={{ fontSize: `${fontSizeRem}rem` }}
      >
      {isDraftThreadView ? (
        <>
          <div className={joinClasses(
            "flex w-full items-center",
            contained ? "min-h-0 py-4" : "min-h-[calc(100dvh-8rem)]",
          )}>
            <div className="w-full">
              <header className="pb-4">
                <h2 className="m-0 text-[1.55em] font-semibold leading-[1.1] tracking-tight text-text">
                  Create new thread
                </h2>
              </header>
              {composer}
            </div>
          </div>
          <div
            ref={setDraftSavedDraftShelfPortalHost}
            className="mt-4 min-h-0 overflow-visible"
          />
        </>
      ) : null}

      <div hidden={isDraftThreadView}>
        {activeThread ? (
          visibleHistoryEntries.length ? (
            <>
              {canLoadPreviousTurn ? (
                <div ref={historySentinelRef} className="h-px" aria-hidden="true" />
              ) : null}
              {visibleHistoryEntries.map((entry) => {
                const turn = loadedTurnsById.get(entry.turnId);
                return turn ? (
                  <ThreadTurnDetails
                    key={entry.turnId}
                    hiddenCollabAgentToolCallItemIds={turn.id === currentTurn?.id ? hiddenCollabAgentToolCallItemIds : EMPTY_HIDDEN_COLLAB_AGENT_TOOL_CALL_ITEM_IDS}
                    inlineMentionSources={inlineMentionSources}
                    knownSkills={workbenchSkills}
                    threadCwdPath={activeThread.cwd}
                    projectFilePaths={projectFilePaths}
                    projectId={projectId}
                    projectRootPath={projectRootPath}
                    relatedThreadsById={subthreadsById}
                    turn={turn}
                    workspaceRoots={workspaceFileLinkRoots}
                    hiddenReasoningItemId={turn.id === currentTurn?.id && liveActivity?.kind === "reasoning" ? liveActivity.hiddenItemId : null}
                    hiddenWebSearchItemIds={turn.id === currentTurn?.id && liveActivity?.kind === "webSearch" ? liveActivity.hiddenItemIds : undefined}
                  />
                ) : (
                  <ThreadTurnLoadingSkeleton
                    key={entry.turnId}
                    entry={entry}
                    isLoading={Boolean(firstVisibleLoadedEntry && loadingPreviousTurnKeys[`${activeThread.id}:${firstVisibleLoadedEntry.turnId}`])}
                  />
                );
              })}
            </>
          ) : (
            !activeThread.isDraft ? (
              <p className="m-0 border-t border-[color-mix(in_srgb,var(--text)_10%,transparent)] py-4 text-[0.92em] leading-[1.6] text-muted">
                No turns were returned for this thread yet.
              </p>
            ) : null
          )
        ) : (
          <div className="border-t border-[color-mix(in_srgb,var(--text)_10%,transparent)] py-4">
            <p className="m-0 text-[0.92em] leading-[1.6] text-muted">Loading subagent thread...</p>
          </div>
        )}
      </div>
      {liveActivity ? (
        <div className="py-4" aria-live="polite">
          {liveActivity.kind === "webSearch" ? (
            liveActivity.contextItems.length ? (
              <ThreadDisclosure
                contentClassName="mt-2 space-y-1 pl-6"
                open={isLiveActivityOpen}
                onToggle={(event) => {
                  const nextIsOpen = event.currentTarget.open;
                  setIsLiveActivityOpen(nextIsOpen);
                  persistThreadLiveActivityOpen(nextIsOpen);
                }}
                summary={<span className="thread-thinking-text">{liveActivity.title}</span>}
                summaryClassName="text-[0.92em] font-medium leading-[1.6]"
              >
                {liveActivity.contextItems.map((item) => (
                  <p key={item.id} className="m-0 text-[0.92em] leading-[1.6] text-muted">
                    <ThreadWebSearchActionRow item={item} />
                  </p>
                ))}
              </ThreadDisclosure>
            ) : (
              <p className="thread-thinking-text m-0 text-[0.92em] font-medium leading-[1.6]">
                {liveActivity.title}
              </p>
            )
          ) : liveActivity.kind === "reasoning" && liveActivity.body ? (
            <ThreadDisclosure
              contentClassName="mt-2"
              open={isLiveActivityOpen}
              onToggle={(event) => {
                const nextIsOpen = event.currentTarget.open;
                setIsLiveActivityOpen(nextIsOpen);
                persistThreadLiveActivityOpen(nextIsOpen);
              }}
              summaryClassName="text-[0.92em] font-medium leading-[1.6]"
              summary={<span className="thread-thinking-text">{liveActivity.title}</span>}
            >
              <ThreadMarkdown
                className="text-[0.8em] text-muted"
                inlineMentionSources={inlineMentionSources}
                markdown={liveActivity.body}
                threadCwdPath={activeThread.cwd}
                projectFilePaths={projectFilePaths}
                projectId={projectId}
                projectRootPath={projectRootPath}
                workspaceRoots={workspaceFileLinkRoots}
              />
            </ThreadDisclosure>
          ) : liveActivity.kind === "reasoning" ? (
            <p className="thread-thinking-text m-0 text-[0.92em] font-medium leading-[1.6]">
              {liveActivity.title}
            </p>
          ) : (
            <div className="space-y-3">
              {liveActivity.waits.map((wait) => {
                const liveSubagentThread = subthreadsById[wait.receiverThreadId] ?? null;
                const summary = (
                  <span>
                    <span className="thread-thinking-text">waiting for</span>{" "}
                    <ThreadAgentName
                      fallbackKey={wait.receiverThreadId}
                      thread={liveSubagentThread}
                    />
                  </span>
                );
                if (!liveSubagentThread?.turns.length) {
                  return (
                    <p key={`${wait.hiddenItemId}:${wait.receiverThreadId}`} className="m-0 text-[0.92em] font-medium leading-[1.6]">
                      {summary}
                    </p>
                  );
                }

                return (
                  <ThreadDisclosure
                    key={`${wait.hiddenItemId}:${wait.receiverThreadId}`}
                    contentClassName="mt-2"
                    open={isLiveActivityOpen}
                    onToggle={(event) => {
                      const nextIsOpen = event.currentTarget.open;
                      setIsLiveActivityOpen(nextIsOpen);
                      persistThreadLiveActivityOpen(nextIsOpen);
                    }}
                    summary={summary}
                    summaryClassName="text-[0.92em] font-medium leading-[1.6]"
                  >
                    <ThreadPreviewFrame height="22rem" scale={0.9}>
                      <ThreadThreadContent
                        inlineMentionSources={inlineMentionSources}
                        knownSkills={workbenchSkills}
                        projectFilePaths={projectFilePaths}
                        projectId={projectId}
                        projectRoots={projectRoots}
                        projectRootPath={projectRootPath}
                        relatedThreadsById={subthreadsById}
                        thread={liveSubagentThread}
                      />
                    </ThreadPreviewFrame>
                  </ThreadDisclosure>
                );
              })}
            </div>
          )}
        </div>
      ) : null}
      {tabDefinitions.length ? (
        <div className="mt-6">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className={joinClasses(
                "inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-[0.78em] font-medium leading-none transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft",
                activeThreadId === thread.id
                  ? "border-[color-mix(in_srgb,var(--text)_18%,transparent)] bg-[color-mix(in_srgb,var(--text)_7%,transparent)] text-text"
                  : "border-[color-mix(in_srgb,var(--text)_12%,transparent)] bg-[color-mix(in_srgb,var(--text)_4%,transparent)] text-muted hover:text-text",
              )}
              onClick={() => {
                handleSubthreadSelection(thread.id);
              }}
            >
              <span>Main agent</span>
              {mainThreadBadge.isQuestion ? <ThreadQuestionBadge /> : mainThreadBadge.unreadBadge ? <ThreadUnreadBadgeView badge={mainThreadBadge.unreadBadge} /> : null}
            </button>
            <span className="text-[0.84em] text-muted" aria-hidden="true">|</span>
            {tabDefinitions.map((tab) => {
              const tabThread = subthreadsById[tab.id];
              const badge = getTabBadge(tab.id, tabThread);

              return (
                <button
                  key={tab.id}
                  type="button"
                  aria-busy={tab.isLoading}
                  className={joinClasses(
                    "inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-[0.78em] font-medium leading-none transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft",
                    activeThreadId === tab.id
                      ? "border-[color-mix(in_srgb,var(--text)_18%,transparent)] bg-[color-mix(in_srgb,var(--text)_7%,transparent)] text-text"
                      : "border-[color-mix(in_srgb,var(--text)_12%,transparent)] bg-[color-mix(in_srgb,var(--text)_4%,transparent)] text-muted hover:text-text",
                    tab.isLoading && activeThreadId !== tab.id && "opacity-70",
                  )}
                  onClick={() => {
                    handleSubthreadSelection(tab.id);
                  }}
                >
                  <ThreadAgentName
                    fallbackKey={tab.id}
                    thread={tabThread}
                  />
                  {tab.suffix ? <span className="text-muted">{tab.suffix}</span> : null}
                  {badge.isQuestion ? <ThreadQuestionBadge /> : badge.unreadBadge ? <ThreadUnreadBadgeView badge={badge.unreadBadge} /> : null}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
      {activeThread && !isDraftThreadView ? (
        <>
          {composer}
        </>
      ) : null}
        <div ref={bottomSentinelRef} aria-hidden="true" className="h-px w-full" />
      </div>
    </ProjectFilePathDisplayProvider>
  );
});
