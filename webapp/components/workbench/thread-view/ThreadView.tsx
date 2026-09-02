/*
 * Exports:
 * - default ThreadView: render the main thread, subthread tabs, live activity, and polled turn history through identity-bound thread controllers. Keywords: thread view, domain hook, subthread, polling, workbench.
 * - Local helpers: merge thread history, derive render state, delegate thread interactions, and locate stable lazy-history turn markers. Keywords: thread, history, rendering, interaction.
 */
"use client";

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore, type MouseEvent as ReactMouseEvent, type ReactNode, type RefObject } from "react";

import type { UserInput } from "../../../lib/codex/generated/app-server/v2/UserInput";
import { getCurrentInProgressTurn, mergeTurnsPreservingLiveItems } from "../../../lib/codex/thread-state";
import type {
  ThreadPayload,
  WorkbenchBrowseResultEntry,
  WorkbenchComposerInputDraft,
  WorkbenchComposerSettings,
  WorkbenchHarness,
  WorkbenchPendingUserInputRequest,
  WorkbenchProjectRoot,
  WorkbenchQuestionnaireDraft,
  WorkbenchSendThreadMessageOptions,
  WorkbenchSkillSummary,
  WorkbenchSubagentSummary,
  WorkbenchThreadDocumentSnapshot,
  WorkbenchThreadTurnHistoryEntry,
} from "../../../lib/types";
import { useWorkbenchDaemonClient } from "../WorkbenchDaemonClientContext";
import { areDeeplyEqual } from "../../../lib/workbench/deep-equality";
import { writeTextToClipboard } from "../../../lib/workbench/dom/clipboard";
import type { WorkspaceFileLinkRoot } from "../../../lib/workbench/markdown/markdown-links";
import { createThreadHref } from "../../../lib/workbench/navigation/workbench-route";
import {
  createProjectFilePathDisambiguationIndexCooperatively,
  readCachedProjectFilePathDisambiguationIndex,
  writeProjectFilePathDisambiguationIndexCache,
  type ProjectFilePathDisambiguationIndex,
} from "../../../lib/workbench/project/project-file-path";
import type { ProjectTreeFileCandidate } from "../../../lib/workbench/project/ProjectTreeFileIndex";
import CooperativeRebuildQueue from "../../../lib/workbench/state/CooperativeRebuildQueue";
import {
  useWorkbenchClientStateController,
  useWorkbenchClientStateSnapshot,
} from "../workbench-client-state-context";
import {
  buildInlineMentionCandidates,
  buildInlineMentionCandidatesCooperatively,
  readCachedInlineMentionCandidates,
  type BuildInlineMentionCandidatesOptions,
  type InlineMentionHighlightSources,
} from "../../../lib/workbench/thread/inline-mention-highlights";
import { getThreadDocumentFromSnapshot } from "../../../lib/workbench/thread/thread-document-keys";
import resolveThreadComposerProfileSlot from "../../../lib/workbench/thread/thread-composer-profile-slot";
import { ThreadMessageNotSentError } from "../../../lib/workbench/thread/thread-message-submission";
import type { WorkbenchGitArcLifecycleState, WorkbenchGitArcPlanState, WorkbenchThreadLifecycle, WorkbenchThreadTarget } from "../../../lib/workbench/thread/thread-state";
import { isWorkbenchPendingSteerUserMessage } from "../../../lib/workbench/thread/thread-steer-history";
import {
  filterSubagentsByParentThreadId,
  getNextSubagentHydrationBatch,
  getSubagentHarness,
  getSubagentSummary,
  getSubagentTabLayout,
  getSubagentThreadIds,
  getThreadAgentTabLabel,
  sortWorkbenchSubagents,
} from "../../../lib/workbench/thread/thread-subagents";
import { isPendingInitialOptimisticInputItem } from "../../../lib/workbench/thread/ThreadOptimisticInputStore";
import type { WorkbenchTranscriptProjection } from "../../../lib/workbench/transcript/workbench-transcript-projection";
import { ProjectFilePathDisplayProvider } from "../ProjectFilePath";
import { useWorkbenchThread } from "../WorkbenchClientProvider";
import { useWorkbenchComposerProfiles } from "../WorkbenchComposerProfileContext";
import previousTurnLoadReducer from "./previous-turn-load-state";
import projectThreadRenderTurns from "./thread-render-turns";
import getThreadGitArcProposalIntents from "./thread-git-arc-proposal-intents";
import { getThreadVisibleHistoryEntries } from "./thread-visible-history";
import {
  getThreadWebSearchLiveLabel,
  isThreadWebSearchPlaceholder,
} from "./thread-web-search-state";
import ThreadAgentTabs from "./ThreadAgentTabs";
import ThreadComposer from "./ThreadComposer";
import ThreadContextStatus from "./ThreadContextStatus";
import ThreadDisclosure from "./ThreadDisclosure";
import ThreadErrorCard from "./ThreadErrorCard";
import ThreadGoalControl from "./ThreadGoalControl";
import ThreadGitArcLifecycleCard from "./ThreadGitArcLifecycleCard";
import ThreadGitArcPresentationContext from "./ThreadGitArcPresentationContext";
import ThreadMarkdown from "./ThreadMarkdown";
import ThreadGitArcIntersectionCard from "./ThreadGitArcIntersectionCard";
import ThreadRateLimits from "./ThreadRateLimits";
import ThreadTranscript from "./ThreadTranscript";
import ThreadTranscriptComparison from "./ThreadTranscriptComparison";
import {
  ThreadWebSearchActionRow,
} from "./ThreadWebSearchItem";

const SUBTHREAD_POLL_INTERVAL_MS = 1500;
const CODE_BLOCK_COPY_FEEDBACK_MS = 1500;
const EMPTY_HIDDEN_DYNAMIC_TOOL_CALL_ITEM_IDS: readonly string[] = [];
const EMPTY_HOISTED_GIT_ARC_PROPOSAL_IDS: ReadonlySet<string> = new Set();
const EMPTY_BROWSE_RESULT_ENTRIES: readonly WorkbenchBrowseResultEntry[] = [];
const EMPTY_PROJECT_FILE_CANDIDATES: readonly ProjectTreeFileCandidate[] = [];
const EMPTY_THREAD_SIDEBAR_SUBSCRIBE = () => () => undefined;
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
    contextItems: Extract<ThreadPayload["turns"][number]["items"][number], { type: "webSearch" }>[];
    hiddenItemIds: string[];
    kind: "webSearch";
    title: string;
  };

type RelatedThreadRecord = Record<string, ThreadPayload | undefined>;

interface PendingPreviousTurnScrollRestore {
  readonly anchorTop: number;
  readonly beforeTurnId: string;
  readonly scrollTop: number;
  readonly target: HTMLDivElement;
}

const THREAD_HISTORY_TURN_MARKER_SELECTOR = "[data-thread-history-turn-id]";

function joinClasses (...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

function findHistoryTurnMarker (root: HTMLElement | null, turnId: string) {
  if (!root) return null;
  for (const marker of root.querySelectorAll<HTMLElement>(THREAD_HISTORY_TURN_MARKER_SELECTOR)) {
    if (marker.dataset.threadHistoryTurnId === turnId) return marker;
  }
  return null;
}

function areRelatedThreadRecordsShallowEqual (left: RelatedThreadRecord, right: RelatedThreadRecord) {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }

  for (const key of leftKeys) {
    if (!Object.prototype.hasOwnProperty.call(right, key) || left[key] !== right[key]) {
      return false;
    }
  }

  return true;
}

function useStableRelatedThreadsById ({
  subagentThreadIds,
  subthreadsById,
  threadDocuments,
}: {
  subagentThreadIds: readonly string[];
  subthreadsById: Record<string, ThreadPayload>;
  threadDocuments: WorkbenchThreadDocumentSnapshot;
}) {
  const previousRef = useRef<RelatedThreadRecord>({});

  const candidateThreadsById = useMemo(() => {
    const nextThreadsById: RelatedThreadRecord = { ...subthreadsById };
    for (const threadId of subagentThreadIds) {
      const documentThread = getThreadDocumentFromSnapshot(threadDocuments, threadId);
      if (documentThread) {
        nextThreadsById[threadId] = documentThread;
      }
    }

    return nextThreadsById;
  }, [subagentThreadIds, subthreadsById, threadDocuments]);
  const stableThreadsById = areRelatedThreadRecordsShallowEqual(previousRef.current, candidateThreadsById)
    ? previousRef.current
    : candidateThreadsById;

  useLayoutEffect(() => {
    previousRef.current = stableThreadsById;
  }, [stableThreadsById]);

  return stableThreadsById;
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

function areThreadPayloadsEquivalent (left: ThreadPayload | null | undefined, right: ThreadPayload | null | undefined) {
  if (left === right) {
    return true;
  }

  if (!left || !right) {
    return false;
  }

  return areDeeplyEqual(left, right);
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

  const serviceTier = mergedThread.serviceTier ?? existingThread.serviceTier;

  if (changed || serviceTier !== mergedThread.serviceTier || mergedTurns !== mergedThread.turns) {
    return { ...mergedThread, serviceTier, turns: mergedTurns };
  }

  return mergedThread;
}

type CodeBlockCopyState = "copied" | "failed" | "idle";

function setCodeBlockCopyButtonState (button: HTMLButtonElement, state: CodeBlockCopyState) {
  button.setAttribute("data-thread-codeblock-copy-state", state);
  button.setAttribute(
    "aria-label",
    state === "copied" ? "Copied code block" : state === "failed" ? "Code block copy failed" : "Copy code block",
  );
  button.title = state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : "Copy code block";
}

function setCodeBlockToggleButtonState (button: HTMLButtonElement, isActive: boolean) {
  button.setAttribute("aria-pressed", isActive ? "true" : "false");
  button.setAttribute("data-thread-codeblock-toggle-state", isActive ? "active" : "idle");
}

function setSvgCodeBlockPreviewButtonState (button: HTMLButtonElement, isPreviewing: boolean) {
  setCodeBlockToggleButtonState(button, isPreviewing);
  button.setAttribute("aria-label", isPreviewing ? "Show SVG source" : "Preview SVG code block");
  button.title = isPreviewing ? "Show SVG source" : "Preview SVG code block";
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

  let latestActivityItemIndex = turn.items.length - 1;
  while (
    latestActivityItemIndex >= 0
    && isWorkbenchPendingSteerUserMessage(turn.items[latestActivityItemIndex]!)
  ) {
    latestActivityItemIndex -= 1;
  }

  const latestItem = turn.items[latestActivityItemIndex];
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

  if (turn.items.some(isPendingInitialOptimisticInputItem)) {
    return {
      body: null,
      hiddenItemId: null,
      kind: "reasoning",
      title: "Connecting",
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
  if (latestItem?.type === "contextCompaction") {
    return null;
  }

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

function useBackgroundInlineMentionSources ({
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
      commit (result) {
        if (generationRef.current === generation) {
          setSources(result);
        }
      },
      onError (error) {
        console.error("Failed to rebuild inline mention sources", error);
      },
      sliceMs: THREAD_VIEW_BACKGROUND_REBUILD_SLICE_MS,
    });
  }, [fallbackSources, files, filesIdentity, projectRootPath, skills, threadCwdPath, workspaceRoots]);

  return sources;
}

function useBackgroundProjectFilePathDisambiguationIndex (
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
      async run (budget) {
        const index = await createProjectFilePathDisambiguationIndexCooperatively(disambiguationPaths, budget);
        writeProjectFilePathDisambiguationIndexCache(disambiguationPaths, disambiguationKey, index);
        return index;
      },
      commit (result) {
        if (generationRef.current === generation) {
          setDisambiguationIndex(result);
        }
      },
      onError (error) {
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
  draftLeadingContent = null,
  mobileFullBleed = false,
  fontSizeRem,
  getThreadHref,
  hideFinalAgentMessage = false,
  hideWorkbenchControlAgentMessages = false,
  hideWorkbenchControlUserMessages = true,
  onDraftHarnessChange,
  onThreadCodeBlockWrapChange,
  onOpenThread,
  onSendMessage,
  onThreadComposerDraftChange,
  onThreadComposerDraftClear,
  onThreadQuestionnaireDraftChange,
  onThreadQuestionnaireDraftClear,
  onThreadSettingsChange,
  onSelectedThreadChange,
  projectId,
  projectFileCandidates,
  projectFileIndexId,
  projectFileLinkRoots,
  projectFilePaths,
  projectRootPath,
  projectRoots,
  knownSubagents,
  scrollViewportRef,
  selectedThreadId,
  threadCodeBlockWrap,
  threadComposerDraft,
  threadComposerDraftsByThreadId,
  threadQuestionnaireDraftsByKey,
  transcriptComparisonOpen = false,
  transcriptComparisonProjection = null,
  thread,
  threadTarget,
  viewInstanceKey = thread.id,
}: {
  composerSpellCheck: boolean;
  contained?: boolean;
  draftLeadingContent?: ReactNode;
  mobileFullBleed?: boolean;
  fontSizeRem: number;
  getThreadHref?: (target: WorkbenchThreadTarget) => string;
  hideFinalAgentMessage?: boolean;
  hideWorkbenchControlAgentMessages?: boolean;
  hideWorkbenchControlUserMessages?: boolean;
  onDraftHarnessChange: (harness: WorkbenchHarness) => void;
  onThreadCodeBlockWrapChange: (nextValue: boolean) => void;
  onOpenThread: (target: WorkbenchThreadTarget) => void;
  onSendMessage: (
    thread: ThreadPayload,
    input: UserInput[],
    options?: WorkbenchSendThreadMessageOptions,
  ) => Promise<ThreadPayload | null>;
  onThreadComposerDraftChange: (threadId: string, draft: WorkbenchComposerInputDraft, reason?: "autosave" | "submission") => void;
  onThreadComposerDraftClear: (threadId: string) => void;
  onThreadQuestionnaireDraftChange: (threadId: string, requestKey: string, draft: WorkbenchQuestionnaireDraft) => void;
  onThreadQuestionnaireDraftClear: (threadId: string, requestKey: string) => void;
  onThreadSettingsChange: (threadId: string, settings: WorkbenchComposerSettings) => void;
  onSelectedThreadChange?: (threadId: string) => void;
  projectId: string;
  projectFileCandidates: readonly ProjectTreeFileCandidate[];
  projectFileIndexId: string;
  projectFileLinkRoots?: readonly WorkspaceFileLinkRoot[];
  projectFilePaths: readonly string[];
  projectRootPath: string;
  projectRoots?: readonly WorkbenchProjectRoot[];
  knownSubagents: readonly WorkbenchSubagentSummary[];
  scrollViewportRef: RefObject<HTMLDivElement | null>;
  selectedThreadId?: string;
  threadCodeBlockWrap: boolean;
  threadComposerDraft: WorkbenchComposerInputDraft | null;
  threadComposerDraftsByThreadId: Record<string, WorkbenchComposerInputDraft | undefined>;
  threadQuestionnaireDraftsByKey: Record<string, WorkbenchQuestionnaireDraft | undefined>;
  transcriptComparisonOpen?: boolean;
  transcriptComparisonProjection?: WorkbenchTranscriptProjection | null;
  thread: ThreadPayload;
  threadTarget: WorkbenchThreadTarget | null;
  viewInstanceKey?: string;
}) {
  const daemon = useWorkbenchDaemonClient();
  const clientStateController = useWorkbenchClientStateController();
  const clientState = useWorkbenchClientStateSnapshot();
  const { controller: composerProfileController, snapshot: composerProfileSnapshot } = useWorkbenchComposerProfiles();
  const [activeThreadId, setActiveThreadId] = useState(selectedThreadId ?? thread.id);
  const activeThreadController = useWorkbenchThread(activeThreadId);
  const rootThreadController = useWorkbenchThread(thread.id);
  const threads = activeThreadController.threads;
  const threadDocuments = threads.documents;
  const threadGoalControls = threads.goals;
  const threadSidebarStore = threads.sidebar;
  const rateLimits = threads.rateLimits;
  const [areSettledSubagentsVisible, setAreSettledSubagentsVisible] = useState(false);
  const [subthreadsById, setSubthreadsById] = useState<Record<string, ThreadPayload>>({});
  const [loadingThreadIds, setLoadingThreadIds] = useState<Record<string, true>>({});
  const [previousTurnLoadStates, dispatchPreviousTurnLoad] = useReducer(previousTurnLoadReducer, {});
  const liveActivityPreference = clientState.records.find((record) => (
    record.kind === "globalPreference" && record.preference.key === "threadLiveActivityOpen"
  ));
  const isLiveActivityOpen = liveActivityPreference?.kind === "globalPreference"
    && typeof liveActivityPreference.preference.value === "boolean"
    ? liveActivityPreference.preference.value
    : true;
  const persistLiveActivityOpen = useCallback((open: boolean) => {
    if (open === isLiveActivityOpen) return;
    void clientStateController.put({
      kind: "globalPreference",
      preference: { key: "threadLiveActivityOpen", value: open },
    });
  }, [clientStateController, isLiveActivityOpen]);
  const [workbenchSkills, setWorkbenchSkills] = useState<WorkbenchSkillSummary[]>([]);
  const threadViewRef = useRef<HTMLDivElement>(null);
  const historySentinelRef = useRef<HTMLDivElement>(null);
  const historyBoundaryArmedRef = useRef(true);
  const pendingPreviousTurnScrollRestoreRef = useRef<PendingPreviousTurnScrollRestore | null>(null);
  const codeBlockCopyResetTimersRef = useRef<Map<HTMLButtonElement, number>>(new Map());
  const subthreadLoadGenerationRef = useRef(0);
  useEffect(() => {
    setActiveThreadId(selectedThreadId ?? thread.id);
  }, [selectedThreadId, thread.id]);
  const knownDirectSubagents = useMemo(
    () => filterSubagentsByParentThreadId(knownSubagents, thread.id),
    [knownSubagents, thread.id],
  );
  const pinnedSubagentThreadIdSet = useMemo(
    () => new Set(knownDirectSubagents.filter((subagent) => subagent.pinned).map((subagent) => subagent.threadId)),
    [knownDirectSubagents],
  );
  const subagents = useMemo(() => sortWorkbenchSubagents(knownDirectSubagents), [knownDirectSubagents]);
  const subagentThreadIds = useMemo(() => getSubagentThreadIds(subagents), [subagents]);
  const hasSettledSubagents = useMemo(() => subagents.some((subagent) => subagent.lifecycle?.settled), [subagents]);
  const subagentTabLayout = useMemo(() => {
    const revealedThreadIds = new Set(
      areSettledSubagentsVisible
        ? subagents.filter((subagent) => subagent.lifecycle?.settled).map((subagent) => subagent.threadId)
        : [],
    );
    if (activeThreadId !== thread.id) revealedThreadIds.add(activeThreadId);
    return getSubagentTabLayout(subagents, { revealedThreadIds });
  }, [activeThreadId, areSettledSubagentsVisible, subagents, thread.id]);
  const visibleSubagents = subagentTabLayout.visible;
  const visibleSubagentThreadIds = useMemo(() => getSubagentThreadIds(visibleSubagents), [visibleSubagents]);
  const relatedThreadsById = useStableRelatedThreadsById({
    subagentThreadIds,
    subthreadsById,
    threadDocuments,
  });
  const activeThread = activeThreadId === thread.id
    ? getThreadDocumentFromSnapshot(threadDocuments, thread.id) ?? thread
    : relatedThreadsById[activeThreadId] ?? null;
  const activeGitArcSelectionRef = useRef<{ gitArc: WorkbenchGitArcLifecycleState | null; gitArcPlan: WorkbenchGitArcPlanState | null; lifecycle: WorkbenchThreadLifecycle } | null>(null);
  const getActiveGitArcSelection = useCallback(() => {
    if (!activeThread) return null;
    const entry = threadSidebarStore?.getSnapshot()?.entries.find((candidate) => (
      candidate.entryKind !== "draft"
      && candidate.identity.harness === activeThread.harness
      && candidate.identity.threadId === activeThread.id
    ));
    const next = entry && entry.entryKind !== "draft"
      ? { gitArc: entry.gitArc ?? null, gitArcPlan: entry.gitArcPlan ?? null, lifecycle: entry.lifecycle }
      : null;
    if (areDeeplyEqual(activeGitArcSelectionRef.current, next)) return activeGitArcSelectionRef.current;
    activeGitArcSelectionRef.current = next;
    return next;
  }, [activeThread, threadSidebarStore]);
  const activeGitArcSelection = useSyncExternalStore(
    threadSidebarStore?.subscribe ?? EMPTY_THREAD_SIDEBAR_SUBSCRIBE,
    getActiveGitArcSelection,
    getActiveGitArcSelection,
  );
  const activeProfileSlot = useMemo(() => activeThread
    ? resolveThreadComposerProfileSlot(projectId, threadTarget, activeThread)
    : null, [activeThread?.harness, activeThread?.id, projectId, threadTarget]);
  const profileResolvedActiveThread = activeThread && activeProfileSlot
    ? composerProfileController.resolveThread(activeProfileSlot, activeThread)
    : activeThread;
  const activeSubagentSummary = activeThread ? getSubagentSummary(subagents, activeThread.id) : null;
  const resolvedActiveThread = profileResolvedActiveThread && !profileResolvedActiveThread.reasoningEffort && activeSubagentSummary
    ? {
      ...profileResolvedActiveThread,
      reasoningEffort: composerProfileController.getProfileReasoningEffort(
        activeSubagentSummary.profileId,
        profileResolvedActiveThread.harness,
      ),
    }
    : profileResolvedActiveThread;
  void composerProfileSnapshot;
  useEffect(() => {
    if (activeProfileSlot) void composerProfileController.loadSelection(activeProfileSlot);
  }, [activeProfileSlot, composerProfileController]);
  const activeThreadRenderProjection = useMemo(
    () => activeThread ? projectThreadRenderTurns(activeThread) : null,
    [activeThread],
  );
  const renderActiveThread = activeThreadRenderProjection?.thread ?? null;
  const activeThreadBrowseResultEntries = activeThreadRenderProjection?.browseResultEntries ?? EMPTY_BROWSE_RESULT_ENTRIES;
  const activeHarnessUserInputRequest = activeThread
    ? threads.pendingQuestionnaire(activeThread.id)
    : null;
  const activePendingUserInputRequest = activeHarnessUserInputRequest;
  const isDraftThreadView = Boolean(activeThread?.isDraft);
  const currentTurn = activeThread?.turns.at(-1) ?? null;
  const visibleHistoryEntries = useMemo(() => renderActiveThread ? getThreadVisibleHistoryEntries(renderActiveThread) : [], [renderActiveThread]);
  const visibleLoadedTurnIds = useMemo(() => new Set(
    visibleHistoryEntries
      .filter((entry) => entry.loadState === "loaded")
      .map((entry) => entry.turnId),
  ), [visibleHistoryEntries]);
  const loadedTurnsById = useMemo(() => new Map(renderActiveThread?.turns.map((turn) => [turn.id, turn]) ?? []), [renderActiveThread?.turns]);
  const firstVisibleLoadedEntry = visibleHistoryEntries.find((entry) => loadedTurnsById.has(entry.turnId)) ?? null;
  const pageBoundaryIndex = renderActiveThread?.nextPageCursor
    ? visibleHistoryEntries.findIndex((entry) => entry.turnId === renderActiveThread.nextPageCursor)
    : -1;
  const previousTurnEntry = pageBoundaryIndex > 0
    ? visibleHistoryEntries[pageBoundaryIndex - 1] ?? null
    : null;
  const previousTurnLoadKey = activeThread?.nextPageCursor
    ? `${activeThread.id}:${activeThread.nextPageCursor}`
    : "";
  const previousTurnLoadStatus = previousTurnLoadKey
    ? previousTurnLoadStates[previousTurnLoadKey]
    : undefined;
  const canLoadPreviousTurn = Boolean(
    activeThread?.nextPageCursor,
  );
  const liveActivity = useMemo(() => getLiveThreadActivity({
    pendingUserInputRequest: activePendingUserInputRequest,
    turn: currentTurn,
  }), [activePendingUserInputRequest, currentTurn]);
  const hiddenDynamicToolCallItemIds = useMemo(() => {
    if (!currentTurn || activePendingUserInputRequest?.harness !== "opencode") {
      return EMPTY_HIDDEN_DYNAMIC_TOOL_CALL_ITEM_IDS;
    }

    const itemIds = currentTurn.items
      .filter((item) => item.type === "dynamicToolCall" && item.namespace === "opencode" && item.tool === "question")
      .map((item) => item.id);
    return itemIds.length ? Array.from(new Set(itemIds)) : EMPTY_HIDDEN_DYNAMIC_TOOL_CALL_ITEM_IDS;
  }, [activePendingUserInputRequest?.harness, currentTurn]);
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
  const visibleGitArcProposalIntents = useMemo(() => getThreadGitArcProposalIntents({
    knownSkills: workbenchSkills,
    projectRootPath,
    turns: activeThread?.turns ?? [],
    workspaceRoots: workspaceFileLinkRoots,
  }), [activeThread?.turns, projectRootPath, workbenchSkills, workspaceFileLinkRoots]);

  const tabDefinitions = useMemo(() => {
    const baseLabelCounts = new Map<string, number>();
    for (const threadId of visibleSubagentThreadIds) {
      const label = getThreadAgentTabLabel(relatedThreadsById[threadId], getSubagentSummary(subagents, threadId));
      baseLabelCounts.set(label, (baseLabelCounts.get(label) ?? 0) + 1);
    }

    const usedLabels = new Map<string, number>();
    return visibleSubagentThreadIds.map((threadId) => {
      const baseLabel = getThreadAgentTabLabel(relatedThreadsById[threadId], getSubagentSummary(subagents, threadId));
      const totalCount = baseLabelCounts.get(baseLabel) ?? 0;
      const nextCount = (usedLabels.get(baseLabel) ?? 0) + 1;
      usedLabels.set(baseLabel, nextCount);
      return {
        id: threadId,
        isLoading: Boolean(loadingThreadIds[threadId]) && !relatedThreadsById[threadId],
        suffix: totalCount > 1 ? ` ${nextCount}` : "",
      };
    });
  }, [loadingThreadIds, relatedThreadsById, subagents, visibleSubagentThreadIds]);

  const loadSubthread = useCallback(async (
    threadId: string,
    harness: WorkbenchHarness,
    options: { background?: boolean } = {},
  ) => {
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
      const subagentCwd = getSubagentSummary(subagents, threadId)?.cwd.trim();
      const payload = await threads.read(threadId, harness, {
        ...(subagentCwd ? { cwd: subagentCwd } : {}),
        cursor: null,
        ...(options.background ? { readScope: "subagentBackground" as const } : {}),
      });
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
  }, [projectId, subagents, thread.harness, thread.id, threads.read]);

  const handleToggleSettledSubagents = useCallback(() => {
    setAreSettledSubagentsVisible((current) => !current);
  }, []);

  const loadPreviousTurn = useCallback(async ({ retry = false }: { retry?: boolean } = {}) => {
    if (
      !activeThread
      || !activeThread.nextPageCursor
      || !previousTurnLoadKey
      || previousTurnLoadStatus === "loading"
      || (previousTurnLoadStatus === "failed" && !retry)
    ) {
      return;
    }

    const loadGeneration = subthreadLoadGenerationRef.current;
    const targetThreadId = activeThread.id;
    const targetHarness = activeThread.harness;
    const scrollTarget = scrollViewportRef.current;
    const historyTurnMarker = firstVisibleLoadedEntry
      ? findHistoryTurnMarker(threadViewRef.current, firstVisibleLoadedEntry.turnId)
      : null;
    if (
      scrollTarget
      && scrollTarget.dataset.threadScrollMode === "reading"
      && firstVisibleLoadedEntry
      && historyTurnMarker
    ) {
      pendingPreviousTurnScrollRestoreRef.current = {
        anchorTop: historyTurnMarker.getBoundingClientRect().top,
        beforeTurnId: firstVisibleLoadedEntry.turnId,
        scrollTop: scrollTarget.scrollTop,
        target: scrollTarget,
      };
    }
    dispatchPreviousTurnLoad({ type: "start", key: previousTurnLoadKey });

    try {
      const subagentCwd = getSubagentSummary(subagents, targetThreadId)?.cwd.trim();
      const payload = await threads.read(targetThreadId, targetHarness, {
        ...(subagentCwd ? { cwd: subagentCwd } : {}),
        cursor: activeThread.nextPageCursor,
      });
      if (loadGeneration !== subthreadLoadGenerationRef.current) {
        return;
      }
      if (!payload) {
        pendingPreviousTurnScrollRestoreRef.current = null;
        dispatchPreviousTurnLoad({ type: "fail", key: previousTurnLoadKey });
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
      dispatchPreviousTurnLoad({ type: "succeed", key: previousTurnLoadKey });
    } catch (error) {
      if (loadGeneration !== subthreadLoadGenerationRef.current) {
        return;
      }
      pendingPreviousTurnScrollRestoreRef.current = null;
      dispatchPreviousTurnLoad({ type: "fail", key: previousTurnLoadKey });
      console.error("Previous thread turn load failed.", error);
    }
  }, [activeThread, firstVisibleLoadedEntry, previousTurnLoadKey, previousTurnLoadStatus, scrollViewportRef, subagents, thread.id, threads.read]);

  useEffect(() => {
    subthreadLoadGenerationRef.current += 1;
    historyBoundaryArmedRef.current = true;
    pendingPreviousTurnScrollRestoreRef.current = null;
    setActiveThreadId(selectedThreadId ?? thread.id);
    setSubthreadsById({});
    setLoadingThreadIds({});
    dispatchPreviousTurnLoad({ type: "reset" });
  }, [projectId, viewInstanceKey]);

  useEffect(() => {
    let cancelled = false;
    void daemon.request("skills/read", { projectId: projectId || null }).then((payload) => {
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
  }, [daemon, projectId]);

  useEffect(() => {
    const preloadBatch = getNextSubagentHydrationBatch({
      loadedThreadIds: new Set(Object.keys(relatedThreadsById)),
      loadingThreadIds: new Set(Object.keys(loadingThreadIds)),
      threadIds: visibleSubagentThreadIds.filter((threadId) => threadId !== thread.id),
    });
    for (const threadId of preloadBatch) {
      void loadSubthread(threadId, getSubagentHarness(subagents, threadId, thread.harness), { background: true });
    }
  }, [loadSubthread, loadingThreadIds, relatedThreadsById, subagents, thread.harness, thread.id, visibleSubagentThreadIds]);

  const pollingThreadId = activeThreadId !== thread.id && activeThread && getCurrentInProgressTurn(activeThread)
    ? activeThreadId
    : null;

  useEffect(() => {
    if (!pollingThreadId) {
      return;
    }

    let cancelled = false;
    let timerId: number | null = null;
    const poll = async () => {
      try {
        await loadSubthread(
          pollingThreadId,
          getSubagentHarness(subagents, pollingThreadId, thread.harness),
          { background: true },
        );
      } catch (error) {
        console.error("Subthread polling failed.", error);
      } finally {
        if (!cancelled) {
          timerId = window.setTimeout(() => { void poll(); }, SUBTHREAD_POLL_INTERVAL_MS);
        }
      }
    };
    timerId = window.setTimeout(() => { void poll(); }, SUBTHREAD_POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      if (timerId !== null) window.clearTimeout(timerId);
    };
  }, [loadSubthread, pollingThreadId, subagents, thread.harness]);

  useEffect(() => {
    const sentinel = historySentinelRef.current;
    const scrollTarget = scrollViewportRef.current;
    if (!sentinel || !scrollTarget || !canLoadPreviousTurn || !previousTurnLoadKey || previousTurnLoadStatus) {
      return;
    }

    const observer = new IntersectionObserver((entries) => {
      let shouldLoadPreviousTurn = false;
      for (const entry of entries) {
        if (!entry.isIntersecting) {
          historyBoundaryArmedRef.current = true;
          continue;
        }
        if (historyBoundaryArmedRef.current) {
          historyBoundaryArmedRef.current = false;
          shouldLoadPreviousTurn = true;
        }
      }
      if (shouldLoadPreviousTurn) {
        void loadPreviousTurn();
      }
    }, {
      root: scrollTarget,
      rootMargin: "160px 0px 0px 0px",
      threshold: 0.1,
    });
    observer.observe(sentinel);
    return () => {
      observer.disconnect();
    };
  }, [canLoadPreviousTurn, loadPreviousTurn, previousTurnLoadKey, previousTurnLoadStatus, scrollViewportRef]);

  useLayoutEffect(() => {
    const pendingRestore = pendingPreviousTurnScrollRestoreRef.current;
    if (!pendingRestore || firstVisibleLoadedEntry?.turnId === pendingRestore.beforeTurnId) return;

    pendingPreviousTurnScrollRestoreRef.current = null;
    const scrollTarget = scrollViewportRef.current;
    if (
      !scrollTarget
      || scrollTarget !== pendingRestore.target
      || scrollTarget.dataset.threadScrollMode !== "reading"
      || Math.abs(scrollTarget.scrollTop - pendingRestore.scrollTop) > 1
    ) {
      return;
    }

    const historyTurnMarker = findHistoryTurnMarker(threadViewRef.current, pendingRestore.beforeTurnId);
    if (!historyTurnMarker) return;
    scrollTarget.scrollTop += historyTurnMarker.getBoundingClientRect().top - pendingRestore.anchorTop;
  }, [firstVisibleLoadedEntry?.turnId, scrollViewportRef]);

  useEffect(() => () => {
    codeBlockCopyResetTimersRef.current.forEach((timeoutId) => {
      window.clearTimeout(timeoutId);
    });
    codeBlockCopyResetTimersRef.current.clear();
  }, []);

  const handleSubthreadSelection = useCallback((threadId: string) => {
    setActiveThreadId(threadId);
    onSelectedThreadChange?.(threadId);
    if (threadId !== thread.id) {
      void loadSubthread(threadId, getSubagentHarness(subagents, threadId, thread.harness));
    }
  }, [loadSubthread, onSelectedThreadChange, subagents, thread.harness, thread.id]);
  const getSubthreadHref = useCallback((threadId: string) => {
    const target: WorkbenchThreadTarget = threadId === thread.id
      ? { harness: thread.harness, kind: "provider", threadId: thread.id }
      : { harness: getSubagentHarness(subagents, threadId, thread.harness), kind: "subagent", parentThreadId: thread.id, threadId };
    return getThreadHref?.(target) ?? createThreadHref(projectId, target);
  }, [getThreadHref, projectId, subagents, thread.harness, thread.id]);

  const handleSubagentPinToggle = useCallback((threadId: string) => {
    const subagent = getSubagentSummary(subagents, threadId);
    if (!subagent) return;
    void threads.updateState({
      identity: { harness: subagent.harness, threadId },
      method: "workbench/thread-state/pin/set",
      pinned: !subagent.pinned,
      projectId,
    });
  }, [projectId, subagents, threads.updateState]);

  const handleSubagentSettlementToggle = useCallback((threadId: string, settled: boolean) => {
    const subagent = getSubagentSummary(subagents, threadId);
    if (!subagent) return;
    void threads.updateState({
      identity: { harness: subagent.harness, threadId },
      method: settled ? "workbench/thread-state/settle" : "workbench/thread-state/restore",
      projectId,
    });
  }, [projectId, subagents, threads.updateState]);

  const handleSendMessage = useCallback(async (
    _threadId: string,
    input: UserInput[],
    options?: { activatedSkillPaths?: string[] },
  ) => {
    if (!resolvedActiveThread || !activeProfileSlot) {
      throw new ThreadMessageNotSentError();
    }

    await composerProfileController.synchronizeSelection(activeProfileSlot, {
      agentPath: resolvedActiveThread.agentPath,
      agentSource: null,
      harness: resolvedActiveThread.harness,
      model: resolvedActiveThread.model ?? "",
      reasoningEffort: resolvedActiveThread.reasoningEffort,
      serviceTier: resolvedActiveThread.serviceTier === "fast" ? "fast" : null,
    });
    const payload = await onSendMessage(resolvedActiveThread, input, {
      ...options,
      composerProfileSlot: activeProfileSlot,
      selectThread: resolvedActiveThread.id === thread.id,
    });
    if (payload && resolvedActiveThread.id !== thread.id) {
      setSubthreadsById((current) => ({
        ...current,
        [resolvedActiveThread.id]: payload,
      }));
    }
  }, [activeProfileSlot, composerProfileController, onSendMessage, resolvedActiveThread, thread.id]);

  const handleStopThread = useCallback(async () => {
    if (!activeThread) {
      return;
    }

    const payload = await activeThreadController.stop(activeThread);
    if (payload && activeThread.id !== thread.id) {
      setSubthreadsById((current) => ({
        ...current,
        [activeThread.id]: payload,
      }));
    }
  }, [activeThread, activeThreadController, thread.id]);

  const handleCompactThread = useCallback(async (source: ThreadPayload) => (
    await activeThreadController.compact(source)
  ), [activeThreadController]);

  const handleThreadModelChange = useCallback((threadId: string, model: string) => {
    if (threadId === thread.id) {
      rootThreadController.changeModel(model);
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
  }, [rootThreadController, thread.id]);

  const handleThreadAgentChange = useCallback((threadId: string, agentPath: string | null) => {
    if (threadId === thread.id) {
      rootThreadController.changeAgent(agentPath);
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
  }, [rootThreadController, thread.id]);

  const handleThreadReasoningEffortChange = useCallback((threadId: string, effort: string | null) => {
    if (threadId === thread.id) {
      rootThreadController.changeReasoningEffort(effort);
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
  }, [rootThreadController, thread.id]);

  const handleThreadServiceTierChange = useCallback((threadId: string, serviceTier: string | null) => {
    if (threadId === thread.id) {
      rootThreadController.changeServiceTier(serviceTier);
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
  }, [rootThreadController, thread.id]);

  const handleThreadSettingsChange = useCallback((threadId: string, settings: WorkbenchComposerSettings) => {
    if (threadId === thread.id) {
      onThreadSettingsChange(threadId, settings);
      return;
    }

    setSubthreadsById((current) => {
      const existing = current[threadId];
      if (!existing || (!existing.isDraft && existing.harness !== settings.harness)) {
        return current;
      }

      return {
        ...current,
        [threadId]: {
          ...existing,
          agentPath: settings.agentPath,
          harness: settings.harness,
          model: settings.model,
          reasoningEffort: settings.reasoningEffort,
          serviceTier: settings.serviceTier,
        },
      };
    });
  }, [onThreadSettingsChange, thread.id]);

  const syncCodeBlockWrapDomState = useCallback((nextValue: boolean) => {
    const root = threadViewRef.current;
    if (!root) {
      return;
    }

    root.setAttribute("data-thread-codeblock-wrap", nextValue ? "true" : "false");
    root.querySelectorAll<HTMLButtonElement>("button[data-thread-codeblock-wrap-toggle]").forEach((button) => {
      setCodeBlockToggleButtonState(button, nextValue);
    });
  }, []);

  useLayoutEffect(() => {
    syncCodeBlockWrapDomState(threadCodeBlockWrap);
  }, [syncCodeBlockWrapDomState, threadCodeBlockWrap]);

  const showCodeBlockCopyFeedback = useCallback((button: HTMLButtonElement, state: Exclude<CodeBlockCopyState, "idle">) => {
    const existingTimeoutId = codeBlockCopyResetTimersRef.current.get(button);
    if (existingTimeoutId !== undefined) {
      window.clearTimeout(existingTimeoutId);
    }

    setCodeBlockCopyButtonState(button, state);
    const timeoutId = window.setTimeout(() => {
      setCodeBlockCopyButtonState(button, "idle");
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
    if (!root.contains(button)) {
      return;
    }

    showCodeBlockCopyFeedback(button, didCopy ? "copied" : "failed");
  }, [showCodeBlockCopyFeedback]);

  const handleSvgCodeBlockPreviewToggle = useCallback((button: HTMLButtonElement) => {
    const root = threadViewRef.current;
    const codeBlock = button.closest<HTMLElement>("[data-thread-codeblock='true']");
    if (!root || !root.contains(button) || !codeBlock) {
      return;
    }

    const isPreviewing = codeBlock.getAttribute("data-thread-codeblock-svg-preview-state") === "preview";
    const nextIsPreviewing = !isPreviewing;
    codeBlock.setAttribute("data-thread-codeblock-svg-preview-state", nextIsPreviewing ? "preview" : "code");
    setSvgCodeBlockPreviewButtonState(button, nextIsPreviewing);
  }, []);

  const handleThreadViewClick = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    const target = event.target instanceof Element ? event.target : null;
    const copyButton = target?.closest<HTMLButtonElement>("button[data-thread-codeblock-copy]") ?? null;
    if (copyButton && threadViewRef.current?.contains(copyButton)) {
      void handleCodeBlockCopy(copyButton);
      return;
    }

    const svgPreviewButton = target?.closest<HTMLButtonElement>("button[data-thread-codeblock-svg-preview]") ?? null;
    if (svgPreviewButton && threadViewRef.current?.contains(svgPreviewButton)) {
      handleSvgCodeBlockPreviewToggle(svgPreviewButton);
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
  }, [handleCodeBlockCopy, handleSvgCodeBlockPreviewToggle, onThreadCodeBlockWrapChange, syncCodeBlockWrapDomState]);

  const handleComposerHarnessToggle = () => {
    if (!activeThread?.isDraft) return;
    const harnesses: WorkbenchHarness[] = ["codex", "copilot", "opencode"];
    const nextHarness = harnesses[(harnesses.indexOf(activeThread.harness) + 1) % harnesses.length] ?? "codex";
    if (activeProfileSlot && resolvedActiveThread?.model && composerProfileController.getSelection(activeProfileSlot).kind === "profile") {
      const settings = { agentPath: resolvedActiveThread.agentPath, agentSource: null, harness: resolvedActiveThread.harness, model: resolvedActiveThread.model, reasoningEffort: resolvedActiveThread.reasoningEffort, serviceTier: resolvedActiveThread.serviceTier === "fast" ? "fast" as const : null };
      handleThreadSettingsChange(activeThread.id, settings);
      composerProfileController.selectCustom(activeProfileSlot, settings);
    }
    onDraftHarnessChange(nextHarness);
  };
  const composerStatus = activeThread ? (
    <ThreadRateLimits
      canToggleHarness={activeThread.isDraft}
      harness={activeThread.harness}
      onHarnessToggle={handleComposerHarnessToggle}
      rateLimits={rateLimits}
      trailingContent={(
        <ThreadContextStatus
          onCompactThread={handleCompactThread}
          thread={activeThread}
        />
      )}
    />
  ) : null;
  const composer = activeThread ? (
    <ThreadComposer
      canToggleHarness={activeThread.isDraft}
      key={activeThread.id}
      composerSpellCheck={composerSpellCheck}
      onListModels={threads.listModels}
      onHarnessToggle={handleComposerHarnessToggle}
      highlightSources={inlineMentionSources}
      onSendMessage={handleSendMessage}
      onStopThread={() => {
        void handleStopThread();
      }}
      onThreadComposerDraftChange={onThreadComposerDraftChange}
      onThreadComposerDraftClear={onThreadComposerDraftClear}
      onThreadQuestionnaireDraftChange={onThreadQuestionnaireDraftChange}
      onThreadQuestionnaireDraftClear={onThreadQuestionnaireDraftClear}
      onSubmitUserInputRequest={async (_threadId, response, options) => {
        await activeThreadController.submitQuestionnaire(response, options);
      }}
      onThreadAgentChange={handleThreadAgentChange}
      onThreadReasoningEffortChange={handleThreadReasoningEffortChange}
      onThreadServiceTierChange={handleThreadServiceTierChange}
      onThreadSettingsChange={handleThreadSettingsChange}
      onThreadModelChange={handleThreadModelChange}
      pendingUserInputRequest={activePendingUserInputRequest}
      projectId={projectId}
      projectRootPath={projectRootPath}
      profileSlot={activeProfileSlot!}
      workspaceRoots={workspaceFileLinkRoots}
      rateLimits={rateLimits}
      stickyMode={!isDraftThreadView}
      threadComposerDraft={activeThread.isDraft
        ? threadComposerDraft
        : threadComposerDraftsByThreadId[activeThread.id] ?? null}
      threadQuestionnaireDraft={activePendingUserInputRequest
        ? threadQuestionnaireDraftsByKey[`${activeThread.id}:${activePendingUserInputRequest.requestKey}`] ?? null
        : null}
      knownSkills={workbenchSkills}
      thread={resolvedActiveThread!}
      threadLifecycle={activeGitArcSelection?.lifecycle ?? null}
    >
      {isDraftThreadView ? ({ isProfilePickerOpen }) => (
        <ThreadRateLimits
          canToggleHarness
          harness={activeThread.harness}
          leadingContent={draftLeadingContent}
          onHarnessToggle={handleComposerHarnessToggle}
          rateLimits={rateLimits}
          showsHarnessControl={!isProfilePickerOpen}
          trailingContent={<ThreadContextStatus onCompactThread={handleCompactThread} thread={activeThread} />}
        />
      ) : null}
    </ThreadComposer>
  ) : null;

  const agentTabs = tabDefinitions.length || hasSettledSubagents ? (
    <ThreadAgentTabs
      activeThreadId={activeThreadId}
      getThreadHref={getSubthreadHref}
      hasSettledSubagents={hasSettledSubagents}
      isSettledSubagentsVisible={areSettledSubagentsVisible}
      isRevealingMore={false}
      mainThreadHarness={thread.harness}
      mainThreadId={thread.id}
      onToggleSettledSubagents={handleToggleSettledSubagents}
      onSelectThread={handleSubthreadSelection}
      onTogglePin={handleSubagentPinToggle}
      onToggleSettlement={handleSubagentSettlementToggle}
      threadSidebarStore={threadSidebarStore}
      tabs={tabDefinitions.map((tab) => {
        const tabThread = relatedThreadsById[tab.id] ?? null;
        return {
          ...tab,
          isPinned: pinnedSubagentThreadIdSet.has(tab.id),
          subagent: getSubagentSummary(subagents, tab.id),
          thread: tabThread,
        };
      })}
    />
  ) : null;
  const terminalGitArc = activeGitArcSelection && currentTurn?.status !== "inProgress"
    ? activeGitArcSelection.gitArc
    : null;
  const showPlanConflicts = currentTurn?.status !== "inProgress" || Boolean(activePendingUserInputRequest);
  const terminalGitArcProposalIds = useMemo(() => terminalGitArc
    ? new Set(terminalGitArc.proposals.map(({ proposalId }) => proposalId))
    : EMPTY_HOISTED_GIT_ARC_PROPOSAL_IDS, [terminalGitArc]);
  const activeTranscriptComparisonProjection = transcriptComparisonOpen
    && renderActiveThread
    && transcriptComparisonProjection?.thread.id === renderActiveThread.id
    ? transcriptComparisonProjection
    : null;

  return (
    <ProjectFilePathDisplayProvider
      disambiguationIndex={projectFilePathDisambiguationIndex}
      disambiguationKey={projectFileIndexId}
      disambiguationPaths={projectFilePaths}
    >
      <ThreadGitArcPresentationContext.Provider value={{
        harness: activeThread?.harness ?? thread.harness,
        hasActiveGitArc: activeGitArcSelection?.gitArc?.phase === "active",
        hoistedProposalIds: terminalGitArcProposalIds,
        onOpenThread,
        projectId,
        proposalIntents: visibleGitArcProposalIntents,
        threadSidebarStore,
      }}>
      <div
        ref={threadViewRef}
        data-thread-codeblock-wrap={threadCodeBlockWrap ? "true" : "false"}
        data-thread-project-file-link-boundary="true"
        className={joinClasses(
          "mx-auto flex min-h-full w-full min-w-0 max-w-[56rem] flex-col overflow-x-clip md:overflow-x-visible",
          mobileFullBleed ? "px-5 pb-0" : contained ? "pb-8" : "pb-16",
          !isDraftThreadView && "justify-end",
        )}
        onClick={handleThreadViewClick}
        style={{ fontSize: `${fontSizeRem}rem` }}
      >
        {isDraftThreadView ? (
          <>
            <div className={joinClasses(
              "flex w-full flex-1 items-center",
              contained ? "py-4" : null,
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
          </>
        ) : null}

        <div hidden={isDraftThreadView}>
          {activeThread ? (
            transcriptComparisonOpen && renderActiveThread ? (
              <>
                {canLoadPreviousTurn ? (
                  <div ref={historySentinelRef} className="h-px" aria-hidden="true" />
                ) : null}
                {activeTranscriptComparisonProjection ? (
                  <ThreadTranscriptComparison
                    inlineMentionSources={inlineMentionSources}
                    jsonBrowseResultEntries={activeThreadBrowseResultEntries}
                    jsonThread={renderActiveThread}
                    knownSkills={workbenchSkills}
                    projectFilePaths={projectFilePaths}
                    projectId={projectId}
                    projectRootPath={projectRootPath}
                    relatedThreadsById={relatedThreadsById}
                    sqliteProjection={activeTranscriptComparisonProjection}
                    subagents={subagents}
                    visibleTurnIds={visibleLoadedTurnIds}
                    workspaceRoots={workspaceFileLinkRoots}
                  />
                ) : (
                  <p className="m-0 py-4 text-[0.92em] leading-[1.6] text-muted" role="status">
                    Waiting for the SQLite transcript projection...
                  </p>
                )}
              </>
            ) : (
              <ThreadTranscript
                browseResultEntries={activeThreadBrowseResultEntries}
                canLoadPreviousTurn={canLoadPreviousTurn}
                currentTurnId={currentTurn?.id ?? null}
                hiddenDynamicToolCallItemIds={hiddenDynamicToolCallItemIds}
                hiddenReasoningItemId={liveActivity?.kind === "reasoning" ? liveActivity.hiddenItemId : null}
                hiddenWebSearchItemIds={liveActivity?.kind === "webSearch" ? liveActivity.hiddenItemIds : undefined}
                hideFinalAgentMessage={hideFinalAgentMessage}
                hideTerminalReasoning={activeGitArcSelection?.lifecycle.kind === "completed"}
                hideWorkbenchControlAgentMessages={hideWorkbenchControlAgentMessages}
                hideWorkbenchControlUserMessages={hideWorkbenchControlUserMessages}
                historySentinelRef={historySentinelRef}
                inlineMentionSources={inlineMentionSources}
                knownSkills={workbenchSkills}
                onRetryPreviousTurn={() => void loadPreviousTurn({ retry: true })}
                previousTurnEntry={previousTurnEntry}
                previousTurnLoadStatus={previousTurnLoadStatus}
                projectFilePaths={projectFilePaths}
                projectId={projectId}
                projectRootPath={projectRootPath}
                relatedThreadsById={relatedThreadsById}
                subagents={subagents}
                terminalGitArcProposalIds={terminalGitArcProposalIds}
                thread={renderActiveThread ?? activeThread}
                visibleHistoryEntries={visibleHistoryEntries}
                workspaceRoots={workspaceFileLinkRoots}
              />
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
                    persistLiveActivityOpen(nextIsOpen);
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
            ) : activeThread && liveActivity.kind === "reasoning" && liveActivity.body ? (
              <ThreadDisclosure
                contentClassName="mt-2"
                open={isLiveActivityOpen}
                onToggle={(event) => {
                  const nextIsOpen = event.currentTarget.open;
                  persistLiveActivityOpen(nextIsOpen);
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
            ) : null}
          </div>
        ) : null}
        {activeThread && !isDraftThreadView && showPlanConflicts ? (
          <ThreadGitArcIntersectionCard
            harness={activeThread.harness}
            onOpenThread={onOpenThread}
            projectId={projectId}
            store={threadSidebarStore}
            threadId={activeThread.id}
          />
        ) : null}
        {terminalGitArc && activeThread && activeGitArcSelection ? (
          <ThreadGitArcLifecycleCard
            claim={terminalGitArc}
            cwd={activeThread.cwd}
            harness={activeThread.harness}
            onReleased={async () => await threads.updateState({ method: "workbench/thread-state/refresh", projectId })}
            projectFilePaths={projectFilePaths}
            projectId={projectId}
            projectRootPath={projectRootPath}
            threadId={activeThread.id}
            threadLifecycle={activeGitArcSelection.lifecycle}
            workspaceRoots={workspaceFileLinkRoots}
          />
        ) : null}
        {activeThread && !isDraftThreadView ? <ThreadErrorCard thread={activeThread} /> : null}
        {activeThread?.harness === "codex" && threadGoalControls ? (
          <ThreadGoalControl controls={threadGoalControls} thread={activeThread}>
            {agentTabs}
          </ThreadGoalControl>
        ) : agentTabs ? (
          <div className="mt-6">
            <div className="flex flex-wrap items-center gap-0.5">{agentTabs}</div>
          </div>
        ) : null}
        {activeThread && !isDraftThreadView ? (
          <>
            {composer}
            {composerStatus ? (
              <div>
                {composerStatus}
              </div>
            ) : null}
          </>
        ) : null}
        <div aria-hidden="true" className="h-px w-full" />
      </div>
      </ThreadGitArcPresentationContext.Provider>
    </ProjectFilePathDisplayProvider>
  );
});
