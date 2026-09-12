/*
 * Exports:
 * - default ThreadViewContent: render admitted thread content and source-local transcript state.
 */
"use client";
import { useWorkbenchThread } from "../use-workbench-thread";

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore, type MouseEvent as ReactMouseEvent, type ReactNode, type RefObject } from "react";

import type { UserInput } from "workbench-shared/codex/generated/app-server/v2/UserInput";
import type {
  ThreadPayload,
  WorkbenchBrowseResultEntry,
  WorkbenchComposerInputDraft,
  WorkbenchComposerSettings,
  WorkbenchHarness,
  WorkbenchPendingUserInputRequest,
  WorkbenchProjectRoot,
  WorkbenchSendThreadMessageOptions,
  WorkbenchSkillSummary,
  WorkbenchSubagentSummary,
} from "workbench-shared/types";
import { useWorkbenchDaemonClient } from "../WorkbenchDaemonClientContext";
import { writeTextToClipboard } from "../../../workbench/dom/clipboard";
import type { WorkspaceFileLinkRoot } from "../../../workbench/markdown/markdown-links";
import { createThreadHref } from "workbench-shared/workbench/navigation/workbench-route";
import {
  createProjectFilePathDisambiguationIndexCooperatively,
  readCachedProjectFilePathDisambiguationIndex,
  writeProjectFilePathDisambiguationIndexCache,
  type ProjectFilePathDisambiguationIndex,
} from "../../../workbench/project/project-file-path";
import type { ProjectTreeFileCandidate } from "workbench-shared/workbench/project/ProjectTreeFileIndex";
import CooperativeRebuildQueue from "../../../workbench/state/CooperativeRebuildQueue";
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
} from "../../../workbench/thread/inline-mention-highlights";
import resolveThreadComposerProfileSlot from "../../../workbench/thread/thread-composer-profile-slot";
import { ProjectIdSchema, ThreadReferenceSchema } from "workbench-shared/workbench/identity";
import { ThreadMessageNotSentError } from "../../../workbench/thread/thread-message-submission";
import type { WorkbenchGitArcLifecycleState, WorkbenchGitArcPlanState, WorkbenchThreadLifecycle, WorkbenchThreadRouteTarget as WorkbenchThreadTarget } from "workbench-shared/workbench/thread/thread-state";
import {
  filterSubagentsByParentThreadId,
  getSubagentHarness,
  getSubagentSummary,
  getSubagentTabLayout,
  getSubagentThreadIds,
  getThreadAgentTabLabel,
  sortWorkbenchSubagents,
} from "../../../workbench/thread/thread-subagents";
import { isPendingInitialOptimisticInputItem } from "../../../workbench/thread/ThreadOptimisticInputStore";
import type { WorkbenchTranscriptProjection } from "workbench-shared/workbench/transcript/workbench-transcript-projection";
import { ProjectFilePathDisplayProvider } from "../ProjectFilePath";
import { useWorkbenchThreads } from "../use-workbench-client";
import { useWorkbenchComposerProfiles } from "../WorkbenchComposerProfileContext";
import previousTurnLoadReducer from "./previous-turn-load-state";
import ThreadHistoryPagingController, { type HistoryPagingOptions } from "./ThreadHistoryPagingController";
import { getWorkbenchTurnAdmission } from "workbench-shared/workbench/thread/thread-admission";
import { ThreadTurnLoadFailure, ThreadTurnLoadingSkeleton } from "./thread-view-items";
import projectThreadRenderTurns from "./thread-render-turns";
import getThreadGitArcProposalPresentation, { getHoistedThreadGitArc } from "./thread-git-arc-presentation";
import { ThreadGitArcObservationProvider } from "./ThreadGitArcObservationContext";
import { getThreadVisibleHistoryEntries } from "./thread-visible-history";
import {
  getThreadWebSearchLiveLabel,
  isThreadWebSearchPlaceholder,
} from "./thread-web-search-state";
import ThreadAgentTabs from "./ThreadAgentTabs";
import ThreadComposer from "./ThreadComposer";
import type { DraftUpdate } from "./DraftSessionController";
import ThreadContextStatus from "./ThreadContextStatus";
import ThreadErrorCard from "./ThreadErrorCard";
import ThreadGoalControl from "./ThreadGoalControl";
import ThreadGitArcLifecycleCard from "./ThreadGitArcLifecycleCard";
import ThreadGitArcPresentationContext from "./ThreadGitArcPresentationContext";
import ThreadLoadingSkeleton from "./ThreadLoadingSkeleton";
import ThreadLiveActivity, { type LiveThreadActivity } from "./ThreadLiveActivity";
import ThreadGitArcIntersectionCard from "./ThreadGitArcIntersectionCard";
import ThreadRateLimits from "./ThreadRateLimits";
import ThreadTranscript from "./ThreadTranscript";
import ThreadTranscriptProjection from "./ThreadTranscriptProjection";
import {
  getCurrentThreadReasoningActivity,
} from "./thread-reasoning-display";

const CODE_BLOCK_COPY_FEEDBACK_MS = 1500;
const EMPTY_HIDDEN_DYNAMIC_TOOL_CALL_ITEM_IDS: readonly string[] = [];
const EMPTY_HOISTED_GIT_ARC_PROPOSAL_IDS: ReadonlySet<string> = new Set();
const EMPTY_BROWSE_RESULT_ENTRIES: readonly WorkbenchBrowseResultEntry[] = [];
const EMPTY_PROJECT_FILE_CANDIDATES: readonly ProjectTreeFileCandidate[] = [];
const THREAD_VIEW_BACKGROUND_REBUILD_SLICE_MS = 20;
const threadViewBackgroundRebuildQueue = new CooperativeRebuildQueue();

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
      hiddenStep: null,
      kind: "reasoning",
      markdown: null,
      title: "Connecting",
    };
  }

  const reasoningStep = getCurrentThreadReasoningActivity(turn);
  if (reasoningStep) {
    return {
      body: reasoningStep.body,
      hiddenStep: reasoningStep.hiddenStep,
      kind: "reasoning",
      markdown: reasoningStep.markdown,
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
    hiddenStep: null,
    kind: "reasoning",
    markdown: null,
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

export default memo(function ThreadViewContent ({
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
  onQuestionnaireError,
  onThreadSettingsChange,
  onSelectedThreadChange,
  projectId,
  projectFileCandidates,
  projectFileIndexId,
  projectFileLinkRoots,
  projectFilePaths,
  projectRootPath,
  projectRoots,
  scrollViewportRef,
  selectedThreadId,
  threadCodeBlockWrap,
  threadComposerDraft,
  threadComposerDraftsByThreadId,
  rootTarget,
  threadTarget,
  viewInstanceKey = rootTarget.kind === "draft" ? rootTarget.draftId : rootTarget.threadId,
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
  onThreadComposerDraftChange: (projectId: string, threadId: string, update: DraftUpdate<WorkbenchComposerInputDraft>, reason?: "autosave" | "submission", target?: WorkbenchThreadTarget, detached?: boolean) => Promise<WorkbenchComposerInputDraft | null>;
  onThreadComposerDraftClear: (projectId: string, threadId: string, target?: WorkbenchThreadTarget) => Promise<void> | void;
  onQuestionnaireError?: (message: string) => void;
  onThreadSettingsChange: (threadId: string, settings: WorkbenchComposerSettings) => void;
  onSelectedThreadChange?: (threadId: string) => void;
  projectId: string;
  projectFileCandidates: readonly ProjectTreeFileCandidate[];
  projectFileIndexId: string;
  projectFileLinkRoots?: readonly WorkspaceFileLinkRoot[];
  projectFilePaths: readonly string[];
  projectRootPath: string;
  projectRoots?: readonly WorkbenchProjectRoot[];
  scrollViewportRef: RefObject<HTMLDivElement | null>;
  selectedThreadId?: string;
  threadCodeBlockWrap: boolean;
  threadComposerDraft: WorkbenchComposerInputDraft | null;
  threadComposerDraftsByThreadId: Record<string, WorkbenchComposerInputDraft | undefined>;
  rootTarget: Exclude<WorkbenchThreadTarget, { kind: "new" }>;
  threadTarget: WorkbenchThreadTarget | null;
  viewInstanceKey?: string;
}) {
  const rootThreadController = useWorkbenchThread(projectId, rootTarget);
  // ThreadView admits this subtree only while this owner's document is available.
  const thread = rootThreadController.state.document!;
  const daemon = useWorkbenchDaemonClient();
  const clientStateController = useWorkbenchClientStateController();
  const clientState = useWorkbenchClientStateSnapshot();
  const { controller: composerProfileController, snapshot: composerProfileSnapshot } = useWorkbenchComposerProfiles();
  const activeThreadId = selectedThreadId ?? thread.id;
  const threads = useWorkbenchThreads();
  const activeTarget: WorkbenchThreadTarget = activeThreadId === thread.id ? rootTarget
    : { kind: "subagent", parentThreadId: ThreadReferenceSchema.parse(thread.id), threadId: ThreadReferenceSchema.parse(activeThreadId) };
  const activeThreadController = useWorkbenchThread(projectId, activeTarget, undefined, "view");
  const transcriptSource = activeThreadController.state.transcript;
  const threadGoalControls = threads.goals;
  const rateLimits = activeThreadController.state.rateLimits;
  const [areSettledSubagentsVisible, setAreSettledSubagentsVisible] = useState(false);
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
  const [historySentinel, setHistorySentinel] = useState<HTMLDivElement | null>(null);
  const historyPagingRef = useRef<ThreadHistoryPagingController | null>(null);
  const historyPagingBindingsRef = useRef<HistoryPagingOptions | null>(null);
  const codeBlockCopyResetTimersRef = useRef<Map<HTMLButtonElement, number>>(new Map());
  const historyLoadGenerationRef = useRef(0);
  const knownDirectSubagents = useMemo(
    () => filterSubagentsByParentThreadId(rootThreadController.state.subagents, thread.id),
    [rootThreadController.state.subagents, thread.id],
  );
  const pinnedSubagentThreadIdSet = useMemo(
    () => new Set(knownDirectSubagents.filter((subagent) => subagent.pinned).map((subagent) => subagent.threadId)),
    [knownDirectSubagents],
  );
  const subagents = useMemo(() => sortWorkbenchSubagents(knownDirectSubagents), [knownDirectSubagents]);
  const hasSettledSubagents = useMemo(() => subagents.some((subagent) => subagent.lifecycle?.settled), [subagents]);
  const subagentTabLayout = useMemo(() => {
    const revealedThreadIds = new Set<string>(
      areSettledSubagentsVisible
        ? subagents.filter((subagent) => subagent.lifecycle?.settled).map((subagent) => subagent.threadId)
        : [],
    );
    if (activeThreadId !== thread.id) revealedThreadIds.add(activeThreadId);
    return getSubagentTabLayout(subagents, { revealedThreadIds });
  }, [activeThreadId, areSettledSubagentsVisible, subagents, thread.id]);
  const visibleSubagents = subagentTabLayout.visible;
  const visibleSubagentThreadIds = useMemo(() => getSubagentThreadIds(visibleSubagents), [visibleSubagents]);
  const relatedThreadsById = rootThreadController.state.relatedDocuments;
  const activeThread = activeThreadController.state.document;
  const activeSidebarEntry = activeThreadController.state.entry;
  const activeGitArcSelection = useMemo<{
    gitArc: WorkbenchGitArcLifecycleState | null;
    gitArcPlan: WorkbenchGitArcPlanState | null;
    lifecycle: WorkbenchThreadLifecycle;
  } | null>(() => activeSidebarEntry ? {
    gitArc: activeSidebarEntry.gitArc ?? null,
    gitArcPlan: activeSidebarEntry.gitArcPlan ?? null,
    lifecycle: activeSidebarEntry.lifecycle,
  } : null, [activeSidebarEntry]);
  const activeProfileSlot = useMemo(() => activeThread
    ? resolveThreadComposerProfileSlot(ProjectIdSchema.parse(projectId), threadTarget, activeThread)
    : null, [activeThread?.harness, activeThread?.id, projectId, threadTarget]);
  const resolvedActiveThread = activeThread && activeProfileSlot
    ? composerProfileController.resolveThread(activeProfileSlot, activeThread)
    : activeThread;
  const canSelectHarness = Boolean(activeThread?.isDraft && activeProfileSlot
    && composerProfileController.getSelection(activeProfileSlot).kind === "custom");
  void composerProfileSnapshot;
  useEffect(() => {
    if (activeProfileSlot) void composerProfileController.loadSelection(activeProfileSlot);
  }, [activeProfileSlot, composerProfileController]);
  const projectedProfile = activeSidebarEntry && "profile" in activeSidebarEntry ? activeSidebarEntry.profile : undefined;
  useEffect(() => {
    if (activeProfileSlot && projectedProfile !== undefined) composerProfileController.observeSelection(activeProfileSlot, projectedProfile);
  }, [activeProfileSlot, composerProfileController, projectedProfile]);
  const activeThreadRenderProjection = useMemo(
    () => activeThread ? projectThreadRenderTurns(activeThread) : null,
    [activeThread],
  );
  const renderActiveThread = activeThreadRenderProjection?.thread ?? null;
  const usesSqlTranscript = activeThread?.harness === "codex" && !activeThread.isDraft;
  const activeTranscriptSource = usesSqlTranscript
    && renderActiveThread
    && "threadId" in transcriptSource
    && transcriptSource.threadId === renderActiveThread.id
    ? transcriptSource
    : null;
  const activeTranscriptProjection: WorkbenchTranscriptProjection | null = activeTranscriptSource
    && "projection" in activeTranscriptSource
    ? activeTranscriptSource.projection
    : null;
  const historyPagingIdentity = useMemo(() => ({}), [projectId, viewInstanceKey, activeThread?.id]);
  const renderedHistoryTurnIds = useMemo(() => (
    usesSqlTranscript
      ? activeTranscriptProjection?.turns ?? []
      : renderActiveThread?.turns ?? []
  ).map(({ id }) => id), [activeTranscriptProjection?.turns, renderActiveThread?.turns, usesSqlTranscript]);
  const activeThreadBrowseResultEntries = activeThreadRenderProjection?.browseResultEntries ?? EMPTY_BROWSE_RESULT_ENTRIES;
  const activeHarnessUserInputRequest = activeThread
    ? activeThreadController.state.pendingQuestionnaire
    : null;
  const activePendingUserInputRequest = activeHarnessUserInputRequest;
  const isDraftThreadView = Boolean(activeThread?.isDraft);
  const currentTurn = activeThread?.turns.at(-1) ?? null;
  const activityTurn = useMemo(() => {
    if (!usesSqlTranscript) return currentTurn;
    const turn = activeTranscriptProjection?.turns.at(-1);
    return turn ? {
      ...turn,
      items: turn.items.filter((item): item is ThreadPayload["turns"][number]["items"][number] => (
        item.type !== "generic" && !("requestKey" in item)
      )),
    } : null;
  }, [activeTranscriptProjection, currentTurn, usesSqlTranscript]);
  const visibleHistoryEntries = useMemo(() => renderActiveThread ? getThreadVisibleHistoryEntries(renderActiveThread) : [], [renderActiveThread]);
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
    turn: activityTurn,
  }), [activePendingUserInputRequest, activityTurn]);
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
  const visibleGitArcProposalPresentation = useMemo(() => getThreadGitArcProposalPresentation({
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
        isLoading: !relatedThreadsById[threadId],
        suffix: totalCount > 1 ? ` ${nextCount}` : "",
      };
    });
  }, [relatedThreadsById, subagents, visibleSubagentThreadIds]);

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

    const loadGeneration = historyLoadGenerationRef.current;
    const targetThreadId = activeThread.id;
    const targetHarness = activeThread.harness;
    const historyPaging = historyPagingRef.current;
    const transaction = historyPaging?.begin();
    if (!historyPaging || transaction === null || transaction === undefined) return;
    dispatchPreviousTurnLoad({ type: "start", key: previousTurnLoadKey });

    try {
      const subagentCwd = getSubagentSummary(subagents, targetThreadId)?.cwd.trim();
      const payload = await activeThreadController.actions.read(targetHarness, {
        ...(subagentCwd ? { cwd: subagentCwd } : {}),
        cursor: activeThread.nextPageCursor,
      });
      if (loadGeneration !== historyLoadGenerationRef.current) {
        return;
      }
      if (!payload) {
        historyPaging.fail(transaction);
        dispatchPreviousTurnLoad({ type: "fail", key: previousTurnLoadKey });
        return;
      }

      historyPaging.succeed(transaction, payload.turns
        .filter((turn) => getWorkbenchTurnAdmission(turn) !== "connecting")
        .map(({ id }) => id));
      dispatchPreviousTurnLoad({ type: "succeed", key: previousTurnLoadKey });
    } catch (error) {
      if (loadGeneration !== historyLoadGenerationRef.current) {
        return;
      }
      historyPaging.fail(transaction);
      dispatchPreviousTurnLoad({ type: "fail", key: previousTurnLoadKey });
      console.error("Previous thread turn load failed.", error);
    }
  }, [activeThread, activeThreadController.actions.read, previousTurnLoadKey, previousTurnLoadStatus, subagents]);

  useEffect(() => {
    historyLoadGenerationRef.current += 1;
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

  useEffect(() => rootThreadController.owner?.acquireChildren(visibleSubagentThreadIds),
    [rootThreadController.owner, visibleSubagentThreadIds]);

  // Reconcile after every parent commit, including SQL's later prepend and skeleton removal.
  useLayoutEffect(() => {
    historyPagingBindingsRef.current = {
      readView: () => {
        const viewport = scrollViewportRef.current;
        const root = threadViewRef.current;
        if (!viewport || !root || !activeThread) return null;
        const viewportRect = viewport.getBoundingClientRect();
        const sentinelRect = historySentinel?.getBoundingClientRect();
        return {
          identity: historyPagingIdentity,
          viewport,
          boundaryKey: previousTurnLoadKey || null,
          requestStatus: previousTurnLoadStatus,
          sourceReady: !usesSqlTranscript || activeTranscriptSource?.status === "ready",
          renderedTurnIds: renderedHistoryTurnIds,
          nearTop: Boolean(sentinelRect && viewport.clientHeight > 0
            && sentinelRect.bottom > viewportRect.top - 160 && sentinelRect.top < viewportRect.bottom),
          mode: viewport.dataset.threadScrollMode === "bottom-following" ? "bottom-following" : "reading",
          metrics: {
            clientHeight: viewport.clientHeight,
            scrollHeight: viewport.scrollHeight,
            scrollTop: viewport.scrollTop,
          },
          get anchor() {
            const marker = [...root.querySelectorAll<HTMLElement>(THREAD_HISTORY_TURN_MARKER_SELECTOR)]
              .find((candidate) => renderedHistoryTurnIds.includes(candidate.dataset.threadHistoryTurnId ?? ""));
            return marker ? {
              turnId: marker.dataset.threadHistoryTurnId!,
              top: marker.getBoundingClientRect().top - viewportRect.top,
            } : null;
          },
          anchorTop: (turnId) => {
            const marker = findHistoryTurnMarker(root, turnId);
            return marker ? marker.getBoundingClientRect().top - viewport.getBoundingClientRect().top : null;
          },
        };
      },
      writeScrollTop: (scrollTop) => {
        const viewport = scrollViewportRef.current;
        if (viewport) viewport.scrollTop = scrollTop;
      },
      load: () => { void loadPreviousTurn(); },
      schedule: (callback, delayMs) => {
        const timer = window.setTimeout(callback, delayMs);
        return () => window.clearTimeout(timer);
      },
    };
    historyPagingRef.current ??= new ThreadHistoryPagingController({
      readView: () => historyPagingBindingsRef.current?.readView() ?? null,
      writeScrollTop: (scrollTop) => historyPagingBindingsRef.current?.writeScrollTop(scrollTop),
      load: () => historyPagingBindingsRef.current?.load(),
      schedule: historyPagingBindingsRef.current.schedule,
    });
    historyPagingRef.current.reconcile();
  });

  useLayoutEffect(() => () => {
    historyPagingRef.current?.dispose();
    historyPagingRef.current = null;
    historyPagingBindingsRef.current = null;
  }, []);

  useEffect(() => {
    const sentinel = historySentinel;
    const scrollTarget = scrollViewportRef.current;
    if (!sentinel || !scrollTarget) {
      return;
    }

    const reconcile = () => historyPagingRef.current?.reconcile();
    const interrupt = () => historyPagingRef.current?.interrupt();
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (target instanceof HTMLElement && target.closest("input, textarea, select, [contenteditable=true]")) return;
      if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) interrupt();
    };
    const handlePointerDown = (event: PointerEvent) => {
      if (event.target === scrollTarget) interrupt();
    };
    const observer = new IntersectionObserver(reconcile, {
      root: scrollTarget,
      rootMargin: "160px 0px 0px 0px",
      threshold: 0.1,
    });
    observer.observe(sentinel);
    scrollTarget.addEventListener("scroll", reconcile, { passive: true });
    scrollTarget.addEventListener("wheel", interrupt, { passive: true });
    scrollTarget.addEventListener("touchmove", interrupt, { passive: true });
    scrollTarget.addEventListener("keydown", handleKeyDown);
    scrollTarget.addEventListener("pointerdown", handlePointerDown);
    return () => {
      observer.disconnect();
      scrollTarget.removeEventListener("scroll", reconcile);
      scrollTarget.removeEventListener("wheel", interrupt);
      scrollTarget.removeEventListener("touchmove", interrupt);
      scrollTarget.removeEventListener("keydown", handleKeyDown);
      scrollTarget.removeEventListener("pointerdown", handlePointerDown);
    };
  }, [historySentinel, scrollViewportRef]);

  useEffect(() => () => {
    codeBlockCopyResetTimersRef.current.forEach((timeoutId) => {
      window.clearTimeout(timeoutId);
    });
    codeBlockCopyResetTimersRef.current.clear();
  }, []);

  const handleSubthreadSelection = useCallback((threadId: string) => {
    onSelectedThreadChange?.(threadId);
  }, [onSelectedThreadChange]);
  const getSubthreadHref = useCallback((threadId: string) => {
    const target: WorkbenchThreadTarget = threadId === thread.id
      ? { harness: thread.harness, kind: "provider", threadId: ThreadReferenceSchema.parse(thread.id) }
      : { harness: getSubagentHarness(subagents, threadId, thread.harness), kind: "subagent", parentThreadId: ThreadReferenceSchema.parse(thread.id), threadId: ThreadReferenceSchema.parse(threadId) };
    return getThreadHref?.(target) ?? createThreadHref(projectId, target);
  }, [getThreadHref, projectId, subagents, thread.harness, thread.id]);

  const handleSubagentPinToggle = useCallback((threadId: string) => {
    const subagent = getSubagentSummary(subagents, threadId);
    if (!subagent) return;
    void threads.updateState({
      identity: { harness: subagent.harness, threadId: subagent.threadId },
      method: "workbench/thread-state/pin/set",
      pinned: !subagent.pinned,
      projectId: subagent.projectId,
    });
  }, [projectId, subagents, threads.updateState]);

  const handleSubagentSettlementToggle = useCallback((threadId: string, settled: boolean) => {
    const subagent = getSubagentSummary(subagents, threadId);
    if (!subagent) return;
    void threads.updateState({
      identity: { harness: subagent.harness, threadId: subagent.threadId },
      method: settled ? "workbench/thread-state/settle" : "workbench/thread-state/restore",
      projectId: subagent.projectId,
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

    await onSendMessage(resolvedActiveThread, input, {
      ...options,
      composerProfileSlot: activeProfileSlot,
      selectThread: resolvedActiveThread.id === thread.id,
    });
  }, [activeProfileSlot, onSendMessage, resolvedActiveThread, thread.id]);

  const handleStopThread = useCallback(async () => {
    if (!activeThread) {
      return;
    }

    await activeThreadController.actions.stop(activeThread);
  }, [activeThread, activeThreadController, thread.id]);

  const handleCompactThread = useCallback(async (source: ThreadPayload) => (
    await activeThreadController.actions.compact(source)
  ), [activeThreadController]);

  const handleThreadModelChange = useCallback((threadId: string, model: string) => {
    (threadId === thread.id ? rootThreadController : activeThreadController).actions.changeModel(model);
  }, [rootThreadController, activeThreadController, thread.id]);

  const handleThreadAgentChange = useCallback((threadId: string, agentPath: string | null) => {
    (threadId === thread.id ? rootThreadController : activeThreadController).actions.changeAgent(agentPath);
  }, [rootThreadController, activeThreadController, thread.id]);

  const handleThreadReasoningEffortChange = useCallback((threadId: string, effort: string | null) => {
    (threadId === thread.id ? rootThreadController : activeThreadController).actions.changeReasoningEffort(effort);
  }, [rootThreadController, activeThreadController, thread.id]);

  const handleThreadServiceTierChange = useCallback((threadId: string, serviceTier: string | null) => {
    (threadId === thread.id ? rootThreadController : activeThreadController).actions.changeServiceTier(serviceTier);
  }, [rootThreadController, activeThreadController, thread.id]);

  const handleThreadSettingsChange = useCallback((threadId: string, settings: WorkbenchComposerSettings) => {
    onThreadSettingsChange(threadId, settings);
  }, [onThreadSettingsChange]);

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

  const handleComposerHarnessSelect = (nextHarness: WorkbenchHarness) => {
    if (!activeThread?.isDraft || !activeProfileSlot || activeThread.harness === nextHarness) return;
    const selectedThread = activeThread;
    const slot = activeProfileSlot;
    void composerProfileController.selectHarness(slot, nextHarness, () => threads.listModels(nextHarness)).then((saved) => {
      if (!saved) return;
      const settings = composerProfileController.resolveSettings(slot);
      if (settings) handleThreadSettingsChange(selectedThread.id, settings);
    });
  };
  const handleComposerHarnessToggle = () => {
    if (!activeThread?.isDraft) return;
    const harnesses: WorkbenchHarness[] = ["codex", "copilot", "opencode"];
    const nextHarness = harnesses[(harnesses.indexOf(activeThread.harness) + 1) % harnesses.length] ?? "codex";
    handleComposerHarnessSelect(nextHarness);
  };
  const composerStatus = activeThread ? (
    <ThreadRateLimits
      canToggleHarness={canSelectHarness}
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
      canToggleHarness={canSelectHarness}
      key={`${projectId}:${activeThread.id}`}
      composerSpellCheck={composerSpellCheck}
      onListModels={threads.listModels}
      onHarnessToggle={handleComposerHarnessToggle}
      highlightSources={inlineMentionSources}
      onHarnessSelect={handleComposerHarnessSelect}
      onSendMessage={handleSendMessage}
      onStopThread={handleStopThread}
      onThreadComposerDraftChange={onThreadComposerDraftChange}
      onThreadComposerDraftClear={onThreadComposerDraftClear}
      onQuestionnaireError={onQuestionnaireError}
      onThreadAgentChange={handleThreadAgentChange}
      onThreadReasoningEffortChange={handleThreadReasoningEffortChange}
      onThreadServiceTierChange={handleThreadServiceTierChange}
      onThreadSettingsChange={handleThreadSettingsChange}
      onThreadModelChange={handleThreadModelChange}
      projectId={projectId}
      projectRootPath={projectRootPath}
      profileSlot={activeProfileSlot!}
      workspaceRoots={workspaceFileLinkRoots}
      rateLimits={rateLimits}
      stickyMode={!isDraftThreadView}
      threadComposerDraft={activeThread.isDraft
        ? threadComposerDraft
        : threadComposerDraftsByThreadId[activeThread.id] ?? null}
      knownSkills={workbenchSkills}
      thread={resolvedActiveThread!}
      threadTarget={activeThread.isDraft ? threadTarget : activeTarget}
    >
      {isDraftThreadView ? (
        <ThreadRateLimits
          canToggleHarness={canSelectHarness}
          harness={activeThread.harness}
          leadingContent={draftLeadingContent}
          onHarnessToggle={handleComposerHarnessToggle}
          rateLimits={rateLimits}
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
      projectId={projectId}
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
  const terminalGitArc = getHoistedThreadGitArc({
    currentTurn,
    gitArc: activeGitArcSelection?.gitArc ?? null,
    proposalObservations: activeThreadController.state.gitArcProposals,
    proposalTurnIds: visibleGitArcProposalPresentation.proposalTurnIds,
  });
  const showPlanConflicts = currentTurn?.status !== "inProgress" || Boolean(activePendingUserInputRequest);
  const terminalGitArcProposalIds = useMemo(() => terminalGitArc
    ? new Set(terminalGitArc.proposals.map(({ proposalId }) => proposalId))
    : EMPTY_HOISTED_GIT_ARC_PROPOSAL_IDS, [terminalGitArc]);
  const transcriptSourceMessage = activeTranscriptSource?.status === "failed"
    ? activeTranscriptSource.message
    : activeTranscriptSource?.status === "absent"
      ? "No SQLite transcript exists for this window."
      : activeTranscriptSource?.status === "unavailable"
        ? "The SQLite transcript source is unavailable."
        : null;

  return (
    <ProjectFilePathDisplayProvider
      disambiguationIndex={projectFilePathDisambiguationIndex}
      disambiguationKey={projectFileIndexId}
      disambiguationPaths={projectFilePaths}
    >
      <ThreadGitArcObservationProvider proposals={activeThreadController.state.gitArcProposals}>
      <ThreadGitArcPresentationContext.Provider value={{
        harness: activeThread?.harness ?? thread.harness,
        hasActiveGitArc: activeGitArcSelection?.gitArc?.phase === "active",
        hoistedProposalIds: terminalGitArcProposalIds,
        onOpenThread,
        projectId,
        proposalIntents: visibleGitArcProposalPresentation.intents,
      }}>
      <div
        ref={threadViewRef}
        data-thread-codeblock-wrap={threadCodeBlockWrap ? "true" : "false"}
        data-thread-project-file-link-boundary="true"
        className={joinClasses(
          "mx-auto flex min-h-full w-full min-w-0 max-w-content flex-col overflow-x-clip md:overflow-x-visible",
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
          {activeThread && usesSqlTranscript && renderActiveThread && previousTurnEntry ? (
            previousTurnLoadStatus === "loading" ? (
              <ThreadTurnLoadingSkeleton entry={previousTurnEntry} isLoading />
            ) : previousTurnLoadStatus === "failed" ? (
              <ThreadTurnLoadFailure
                entry={previousTurnEntry}
                onRetry={() => void loadPreviousTurn({ retry: true })}
              />
            ) : null
          ) : null}
          {activeThread ? (
            usesSqlTranscript && renderActiveThread ? (
              activeTranscriptProjection ? (
                  <ThreadTranscriptProjection
                    canLoadPreviousTurn={canLoadPreviousTurn}
                    hiddenReasoningStep={liveActivity?.kind === "reasoning" ? liveActivity.hiddenStep : null}
                    historySentinelRef={setHistorySentinel}
                    inlineMentionSources={inlineMentionSources}
                    knownSkills={workbenchSkills}
                    projectFilePaths={projectFilePaths}
                    projectId={projectId}
                    projectRootPath={projectRootPath}
                    presentationSource={{
                      kind: "sqlite",
                      sourceKey: `codex:${activeTranscriptProjection.thread.id}`,
                    }}
                    projection={activeTranscriptProjection}
                    relatedThreadsById={relatedThreadsById}
                    subagents={subagents}
                    workspaceRoots={workspaceFileLinkRoots}
                  />
              ) : (
                transcriptSourceMessage ? (
                  <div className="flex min-h-48 items-center justify-center px-4 text-center text-sm text-muted">
                    {transcriptSourceMessage}
                  </div>
                ) : (
                  <ThreadLoadingSkeleton contained />
                )
              )
            ) : (
              <ThreadTranscript
                browseResultEntries={activeThreadBrowseResultEntries}
                canLoadPreviousTurn={canLoadPreviousTurn}
                currentTurnId={currentTurn?.id ?? null}
                hiddenDynamicToolCallItemIds={hiddenDynamicToolCallItemIds}
                hiddenReasoningStep={liveActivity?.kind === "reasoning" ? liveActivity.hiddenStep : null}
                hiddenWebSearchItemIds={liveActivity?.kind === "webSearch" ? liveActivity.hiddenItemIds : undefined}
                hideFinalAgentMessage={hideFinalAgentMessage}
                hideTerminalReasoning={activeGitArcSelection?.lifecycle.kind === "completed"}
                hideWorkbenchControlAgentMessages={hideWorkbenchControlAgentMessages}
                hideWorkbenchControlUserMessages={hideWorkbenchControlUserMessages}
                historySentinelRef={setHistorySentinel}
                inlineMentionSources={inlineMentionSources}
                knownSkills={workbenchSkills}
                onRetryPreviousTurn={() => void loadPreviousTurn({ retry: true })}
                previousTurnEntry={previousTurnEntry}
                previousTurnLoadStatus={previousTurnLoadStatus}
                presentationSource={{
                  kind: "json",
                  sourceKey: `${(renderActiveThread ?? activeThread).harness}:${(renderActiveThread ?? activeThread).id}`,
                }}
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
        {liveActivity && activeThread && activityTurn ? (
          <ThreadLiveActivity
            activity={liveActivity}
            inlineMentionSources={inlineMentionSources}
            isOpen={isLiveActivityOpen}
            onOpenChange={persistLiveActivityOpen}
            presentationSource={{
              kind: usesSqlTranscript ? "sqlite" : "json",
              sourceKey: `${activeThread.harness}:${activeThread.id}`,
            }}
            projectFilePaths={projectFilePaths}
            projectId={projectId}
            projectRootPath={projectRootPath}
            threadCwdPath={activeThread.cwd}
            threadId={activeThread.id}
            turnId={activityTurn.id}
            workspaceRoots={workspaceFileLinkRoots}
          />
        ) : null}
        {activeThread && !isDraftThreadView && showPlanConflicts ? (
          <ThreadGitArcIntersectionCard
            harness={activeThread.harness}
            onOpenThread={onOpenThread}
            projectId={projectId}
            threadId={activeThread.id}
          />
        ) : null}
        {terminalGitArc && activeThread && activeGitArcSelection ? (
          <ThreadGitArcLifecycleCard
            claim={terminalGitArc}
            cwd={activeThread.cwd}
            harness={activeThread.harness}
            onReleased={async () => await threads.updateState({ method: "workbench/thread-state/refresh", projectId: ProjectIdSchema.parse(projectId) })}
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
      </ThreadGitArcObservationProvider>
    </ProjectFilePathDisplayProvider>
  );
});
