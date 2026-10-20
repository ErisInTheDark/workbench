/*
 * Exports:
 * - default ThreadViewContent: render draft launch previews, admitted thread content, or the subagent message board.
 */
"use client";
import { useThread } from "../use-thread";
import { TranscriptBodiesContext, useTranscript } from "../use-transcript";

import { memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode, type RefObject } from "react";
import { WorkbenchThreadDisplaySettingsContext } from "./WorkbenchThreadDisplaySettingsContext";

import type { WorkbenchUserInput as UserInput } from "workbench-shared/workbench/provider/provider-input";
import type { WorkbenchComposerInputDraft, WorkbenchProjectRoot, WorkbenchSendThreadMessageOptions, WorkbenchSkillSummary } from "workbench-shared/types";
import type { Turn } from "workbench-shared/workbench/thread/workbench-thread-turn";
import { isThreadStatusActive } from "workbench-shared/workbench/thread/thread-runtime-state";
import { readWorkbenchSkillActivationMismatch } from "workbench-shared/workbench/thread/thread-skill-mentions";
import { useWorkbenchDaemonClient } from "../WorkbenchWorkspaceContext";
import { writeTextToClipboard } from "../../../workbench/dom/clipboard";
import type { WorkspaceFileLinkRoot } from "../../../workbench/markdown/markdown-links";
import { createThreadRoute } from "workbench-shared/workbench/navigation/workbench-route";
import { useWorkbenchProjectNavigation } from "../../../workbench/navigation/use-workbench-project-navigation";
import type { ProjectTreeFileCandidate } from "workbench-shared/workbench/project/ProjectTreeFileIndex";
import { useBackgroundInlineMentionSources, useBackgroundProjectFilePathDisambiguationIndex } from "./use-background-thread-indexes";
import useThreadHistoryPaging from "./use-thread-history-paging";
import resolveThreadComposerProfileSlot from "../../../workbench/thread/thread-composer-profile-slot";
import { ProjectIdSchema, ThreadReferenceSchema } from "workbench-shared/workbench/identity";
import { ThreadMessageNotSentError } from "../../../workbench/thread/thread-message-submission";
import { deriveThreadItemApprovals, ThreadItemApprovalsContext } from "../../../workbench/thread/thread-item-approvals";
import { deriveThreadItemShellQueue, ThreadItemShellQueueContext } from "../../../workbench/thread/thread-item-shell-queue";
import ThreadItemActionsContext, { type ThreadItemActions } from "./ThreadItemActionsContext";
import type {
  WorkbenchGitArcLifecycleState,
  WorkbenchGitArcPlanState,
  WorkbenchThreadGitCommitRef,
  WorkbenchThreadLifecycle,
  WorkbenchThreadRouteTarget as WorkbenchThreadTarget,
} from "workbench-shared/workbench/thread/thread-state";
import {
  filterSubagentsByParentThreadId,
  getSubagentHarness,
  getSubagentSummary,
  getSubagentTabLayout,
  getSubagentThreadIds,
  getThreadAgentTabLabel,
  reconcileSubagentTabOrder,
  sortWorkbenchSubagents,
  type SubagentTabOrder,
} from "../../../workbench/thread/thread-subagents";
import type { WorkbenchTranscriptProjection } from "workbench-shared/workbench/transcript/workbench-transcript-projection";
import ContextualProjectProvider from "../ContextualProjectProvider";
import { useThreads } from "../use-threads";
import { useWorkbenchComposerProfiles } from "../WorkbenchComposerProfileContext";
import WorkbenchApprovalModeMenu, { ApprovalReviewerSetupNotice, useApprovalReviewerReady } from "../WorkbenchApprovalModeMenu";
import { ThreadTurnLoadFailure, ThreadTurnLoadingSkeleton } from "./transcript/ThreadTurnLoadStates";
import getThreadGitArcProposalPresentation, { getThreadGitArcWork } from "./thread-git-arc-presentation";
import { ThreadStoreGitArcObservationProvider } from "./ThreadGitArcObservationContext";
import ThreadAgentTabs from "./ThreadAgentTabs";
import ThreadComposer from "./ThreadComposer";
import type DraftSessionController from "./DraftSessionController";
import useComposer from "../use-composer";
import ThreadContextStatus from "./ThreadContextStatus";
import ThreadErrorCard from "./ThreadErrorCard";
import ThreadStatusArea from "./ThreadStatusArea";
import ThreadTodoPanel from "./ThreadTodoPanel";
import { ThreadTodoControlsContext, type ThreadTodoControls } from "./thread-todo-controls";
import { WorkbenchFeedbackAddressingContext, type WorkbenchFeedbackAddressing } from "../address-feedback-context";
import { attachComposerDraftReference } from "../../../workbench/state/draft-persistence";
import ThreadAddressedFeedback from "./ThreadAddressedFeedback";
import { workbenchThreadTodoReference } from "workbench-shared/workbench/thread/thread-todo";
import useThreadLiveActivity from "./use-thread-live-activity";
import useThreadReferenceSelection from "./use-thread-reference-selection";
import ThreadCheckpointCommitActions from "./ThreadCheckpointCommitActions";
import useWorkspaceObservation from "../../../workbench/app/use-workspace-observation";
import WorkbenchWorkspaceContext from "../WorkbenchWorkspaceContext";
import ThreadGitArcPresentationContext from "./ThreadGitArcPresentationContext";
import WorkbenchLoadingSpinner from "../WorkbenchLoadingSpinner";
import ThreadMessageBoard from "./ThreadMessageBoard";
import { getLiveThreadActivity, getThreadTerminalEntries } from "./thread-live-activity";
import ThreadRateLimits from "./ThreadRateLimits";
import ThreadEntryMotionController, { getProjectedEntryMotionIdentities } from "./ThreadEntryMotionController";
import ThreadActivityRunController from "./ThreadActivityRunController";
import {
  ThreadScrollViewportContext,
  useThreadScrollViewportContext,
} from "./thread-scroll-viewport-context";
import ThreadTranscriptProjection from "./ThreadTranscriptProjection";

const CODE_BLOCK_COPY_FEEDBACK_MS = 1500;
const EMPTY_TURNS: readonly Turn[] = [];

function joinClasses (...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
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


export default memo(function ThreadViewContent ({
  approvalModeSettings = null,
  composerSpellCheck,
  draftLeadingContent = null,
  draftTargetControl = null,
  threadOwnerContent = null,
  onDraftSessionChange,
  mobileFullBleed = false,
  fontSizeRem,
  getThreadHref,
  hideFinalAgentMessage = false,
  hideWorkbenchControlAgentMessages = false,
  hideWorkbenchControlUserMessages = true,
  onThreadCodeBlockWrapChange,
  onThreadSettled,
  onSelectedThreadChange,
  projectId,
  projectFileCandidates: browseFileCandidates,
  projectFileIndexId: browseFileIndexId,
  projectFileLinkRoots,
  projectFilePaths: browseFilePaths,
  useOwnerFileIndex = false,
  projectRootPath,
  projectRoots,
  scrollViewportRef,
  selectedThreadId,
  threadCodeBlockWrap,
  threadCodeDetails = null,
  rootTarget,
  threadTarget,
  viewInstanceKey = rootTarget.kind === "draft" ? rootTarget.draftId : rootTarget.threadId,
}: {
  /** Daemon projects replace the folder picker with an approval mode menu on drafts and threads. */
  approvalModeSettings?: { onOpenSettings: () => void } | null;
  composerSpellCheck: boolean;
  draftLeadingContent?: ReactNode;
  draftTargetControl?: ReactNode;
  threadOwnerContent?: ReactNode;
  onDraftSessionChange?: (session: DraftSessionController<WorkbenchComposerInputDraft> | null) => void;
  mobileFullBleed?: boolean;
  fontSizeRem: number;
  getThreadHref?: (target: WorkbenchThreadTarget) => string | undefined;
  hideFinalAgentMessage?: boolean;
  hideWorkbenchControlAgentMessages?: boolean;
  hideWorkbenchControlUserMessages?: boolean;
  onThreadCodeBlockWrapChange: (nextValue: boolean) => void;
  onThreadSettled?: (target: WorkbenchThreadTarget, ownerProjectId: string) => void;
  onSelectedThreadChange?: (threadId: string) => void;
  projectId: string;
  projectFileCandidates: readonly ProjectTreeFileCandidate[];
  projectFileIndexId: string;
  projectFileLinkRoots?: readonly WorkspaceFileLinkRoot[];
  projectFilePaths: readonly string[];
  useOwnerFileIndex?: boolean;
  projectRootPath: string;
  projectRoots?: readonly WorkbenchProjectRoot[];
  scrollViewportRef: RefObject<HTMLDivElement | null>;
  selectedThreadId?: string;
  threadCodeBlockWrap: boolean;
  threadCodeDetails?: boolean | null;
  rootTarget: Exclude<WorkbenchThreadTarget, { kind: "new" }>;
  threadTarget: WorkbenchThreadTarget | null;
  viewInstanceKey?: string;
}) {
  const rootThread = useThread(projectId, rootTarget);
  // ThreadView admits this subtree only while the root head is available.
  const thread = rootThread.head!;
  const ownedFileIndex = useThread.fileIndex(thread.id, useOwnerFileIndex);
  const projectFileCandidates = useOwnerFileIndex ? ownedFileIndex.snapshot.candidates : browseFileCandidates;
  const projectFileIndexId = useOwnerFileIndex ? ownedFileIndex.snapshot.id : browseFileIndexId;
  const projectFilePaths = useOwnerFileIndex ? ownedFileIndex.snapshot.paths : browseFilePaths;
  const daemon = useWorkbenchDaemonClient();
  const projectHref = useWorkbenchProjectNavigation();
  const { controller: composerProfileController, snapshot: composerProfileSnapshot } = useWorkbenchComposerProfiles();
  const activeThreadId = selectedThreadId ?? thread.id;
  const threads = useThreads(undefined, thread.id);
  const activeTarget: WorkbenchThreadTarget = activeThreadId === thread.id ? rootTarget
    : { kind: "subagent", parentThreadId: ThreadReferenceSchema.parse(thread.id), threadId: ThreadReferenceSchema.parse(activeThreadId) };
  const active = useThread(projectId, activeTarget, "view");
  const activeTurns = useTranscript.turns(active.store);
  const visQuery = useMemo(() => ({ kind: "threadVis" as const, threadId: ThreadReferenceSchema.parse(activeThreadId) }), [activeThreadId]);
  const vis = useWorkspaceObservation(useContext(WorkbenchWorkspaceContext), visQuery).value?.data ?? null;
  const visActions = useMemo(() => ({
    onEnd: (sessionId: string) => { void daemon?.threads.vis.end({ threadId: activeThreadId, sessionId }).catch((error: unknown) => console.error("Ending the vis session failed.", error)); },
    // The card reports a change that was not saved, so a failure reaches the user there.
    onControl: async (sessionId: string, controlId: string, value: string) => {
      if (!daemon) throw new Error("Workbench is not connected.");
      await daemon.threads.vis.control({ threadId: activeThreadId, sessionId, controlId, value });
    },
  }), [activeThreadId, daemon]);
  const { pending: activePendingUserInputRequest } = useThread.questionnaire(active.store);
  const { entries: activeApprovalEntries } = useTranscript.approvals(active.store);
  const transcriptSource = activeTurns.transcript;
  const threadScrollViewport = useThreadScrollViewportContext();
  const rateLimits = active.rateLimits;
  const [areSettledSubagentsVisible, setAreSettledSubagentsVisible] = useState(false);
  const [checkpointCommitActions] = useState(() => new ThreadCheckpointCommitActions());
  const [isMessageBoardOpen, setIsMessageBoardOpen] = useState(false);
  const [isCompactSendHolding, setIsCompactSendHolding] = useState(false);
  useEffect(() => { setIsMessageBoardOpen(false); }, [thread.id]);
  const [workbenchSkills, setWorkbenchSkills] = useState<WorkbenchSkillSummary[]>([]);
  const threadViewRef = useRef<HTMLDivElement>(null);
  const codeBlockCopyResetTimersRef = useRef<Map<HTMLButtonElement, number>>(new Map());
  const knownDirectSubagents = useMemo(
    () => filterSubagentsByParentThreadId(rootThread.subagents, thread.id),
    [rootThread.subagents, thread.id],
  );
  const pinnedSubagentThreadIdSet = useMemo(
    () => new Set(knownDirectSubagents.filter((subagent) => subagent.pinned).map((subagent) => subagent.threadId)),
    [knownDirectSubagents],
  );
  const subagents = useMemo(() => sortWorkbenchSubagents(knownDirectSubagents), [knownDirectSubagents]);
  const hasSettledSubagents = useMemo(() => subagents.some((subagent) => subagent.lifecycle?.settled), [subagents]);
  // Display state: tabs keep their slot across activity; only new or unsettled children move to the front.
  const subagentTabOrderRef = useRef<{ threadId: string; value: SubagentTabOrder } | null>(null);
  const subagentTabOrder = useMemo(() => reconcileSubagentTabOrder(
    subagentTabOrderRef.current?.threadId === thread.id ? subagentTabOrderRef.current.value : null,
    subagents,
  ), [subagents, thread.id]);
  useEffect(() => {
    subagentTabOrderRef.current = { threadId: thread.id, value: subagentTabOrder };
  }, [subagentTabOrder, thread.id]);
  const subagentTabLayout = useMemo(() => {
    const revealedThreadIds = new Set<string>(
      areSettledSubagentsVisible
        ? subagents.filter((subagent) => subagent.lifecycle?.settled).map((subagent) => subagent.threadId)
        : [],
    );
    if (activeThreadId !== thread.id) revealedThreadIds.add(activeThreadId);
    return getSubagentTabLayout(subagents, { order: subagentTabOrder.order, revealedThreadIds });
  }, [activeThreadId, areSettledSubagentsVisible, subagentTabOrder, subagents, thread.id]);
  const visibleSubagents = subagentTabLayout.visible;
  const visibleSubagentThreadIds = useMemo(() => getSubagentThreadIds(visibleSubagents), [visibleSubagents]);
  const relatedThreadsById = rootThread.relatedHeads;
  const activeThread = active.head;
  const usesSqlTranscript = Boolean(activeThread && !activeThread.isDraft);
  const activeTranscriptSource = activeThread
    && "threadId" in transcriptSource
    && transcriptSource.threadId === activeThread.id
    ? transcriptSource
    : null;
  const activeTranscriptProjection: WorkbenchTranscriptProjection | null = activeTranscriptSource
    && "projection" in activeTranscriptSource
    ? activeTranscriptSource.projection
    : null;
  const entryMotionOwnerKey = activeTarget.kind === "subagent"
    ? `${viewInstanceKey}:subagent:${activeThreadId}`
    : viewInstanceKey;
  const entryMotionOwnerRef = useRef<{
    controller: ThreadEntryMotionController;
    activityRunController: ThreadActivityRunController;
    key: string;
    initialThreadId: string;
    threadId: string;
    seeded: boolean;
    admitted: WorkbenchTranscriptProjection["turns"] | null;
  } | null>(null);
  // Items already present when the turns first arrive are history, not new activity: they never animate in.
  // Seeded from the rendered projection: the provider-item turns omit generic and interaction items.
  const motionTurns = activeTranscriptProjection?.turns ?? null;
  const motionIdentities = (turns: NonNullable<typeof motionTurns>) => turns.flatMap(turn => turn.items.flatMap(getProjectedEntryMotionIdentities));
  const isLaunchHandoff = entryMotionOwnerRef.current?.key === entryMotionOwnerKey
    && entryMotionOwnerRef.current.threadId !== activeThreadId;
  if (entryMotionOwnerRef.current?.key !== entryMotionOwnerKey) {
    entryMotionOwnerRef.current = {
      controller: new ThreadEntryMotionController(motionTurns ? motionIdentities(motionTurns) : undefined),
      activityRunController: new ThreadActivityRunController(),
      key: entryMotionOwnerKey,
      initialThreadId: activeThreadId,
      threadId: activeThreadId,
      seeded: Boolean(motionTurns),
      admitted: null,
    };
  } else if (motionTurns && (!entryMotionOwnerRef.current.seeded || isLaunchHandoff)) {
    entryMotionOwnerRef.current.controller.seed(motionIdentities(motionTurns));
    entryMotionOwnerRef.current.seeded = true;
    entryMotionOwnerRef.current.threadId = activeThreadId;
  } else if (motionTurns && entryMotionOwnerRef.current.admitted !== motionTurns) {
    entryMotionOwnerRef.current.controller.admit(motionIdentities(motionTurns));
  }
  if (entryMotionOwnerRef.current.seeded) entryMotionOwnerRef.current.admitted = motionTurns;
  const entryMotionController = entryMotionOwnerRef.current.controller;
  const activityRunController = entryMotionOwnerRef.current.activityRunController;
  const entryMotionContext = useMemo(() => ({
    ...threadScrollViewport,
    activityRuns: activityRunController,
    entryMotion: entryMotionController,
  }), [activityRunController, entryMotionController, threadScrollViewport]);
  const activeProvider = activeThread?.harness ?? thread.harness;
  const activeSidebarEntry = active.entry;
  const activeThreadSnoozed = activeSidebarEntry?.entryKind === "thread"
    && activeSidebarEntry.metadata.snoozed;
  const activeGitArcSelection = useMemo<{
    gitArc: WorkbenchGitArcLifecycleState | null;
    gitArcPlan: WorkbenchGitArcPlanState | null;
    gitCommits: WorkbenchThreadGitCommitRef[];
    lifecycle: WorkbenchThreadLifecycle;
  } | null>(() => activeSidebarEntry ? {
    gitArc: activeSidebarEntry.gitArc ?? null,
    gitArcPlan: activeSidebarEntry.gitArcPlan ?? null,
    gitCommits: activeSidebarEntry.gitCommits ?? [],
    lifecycle: activeSidebarEntry.lifecycle,
  } : null, [activeSidebarEntry]);
  // A draft route whose saved draft is gone composes as new again, so its next words recreate it.
  const routeDraftSaved = Boolean(useComposer(projectId, activeThread?.id ?? "", threadTarget ?? null).getDraft());
  const composerTarget = useMemo(() => activeThread?.isDraft && !routeDraftSaved && threadTarget?.kind === "draft"
    ? { kind: "new" as const } : threadTarget, [activeThread?.isDraft, routeDraftSaved, threadTarget]);
  const activeProfileSlot = useMemo(() => activeThread
    ? resolveThreadComposerProfileSlot(ProjectIdSchema.parse(projectId), composerTarget, activeThread)
    : null, [activeThread?.harness, activeThread?.id, projectId, composerTarget]);
  const resolvedActiveThread = activeThread && activeProfileSlot
    ? composerProfileController.resolveThread(activeProfileSlot, activeThread)
    : activeThread;
  void composerProfileSnapshot;
  useEffect(() => {
    if (activeProfileSlot) void composerProfileController.loadSelection(activeProfileSlot);
  }, [activeProfileSlot, composerProfileController]);
  const projectedProfile = activeSidebarEntry && "profile" in activeSidebarEntry ? activeSidebarEntry.profile : undefined;
  useEffect(() => {
    if (activeProfileSlot && projectedProfile !== undefined) composerProfileController.observeSelection(activeProfileSlot, projectedProfile);
  }, [activeProfileSlot, composerProfileController, projectedProfile]);
  const loadedTurns = activeThread?.isDraft || activeTranscriptProjection ? activeTurns.turns : EMPTY_TURNS;
  const renderedHistoryTurnIds = useMemo(() => loadedTurns.map(({ id }) => id), [loadedTurns]);
  const activeItemApprovals = useMemo(
    () => deriveThreadItemApprovals(activeThread ? activeApprovalEntries : [], activePendingUserInputRequest),
    [activeApprovalEntries, activePendingUserInputRequest, activeThread],
  );
  const activeShellQueue = activeThread?.shellQueue;
  const activeItemShellQueue = useMemo(() => deriveThreadItemShellQueue(activeShellQueue), [activeShellQueue]);
  const activeItemActions = useMemo<ThreadItemActions>(() => ({
    resendSteer: itemId => active.actions.resendSteer(itemId),
    dismissSteer: itemId => active.actions.dismissSteer(itemId),
    stopShell: itemId => active.actions.stopShell(itemId),
    startShellNow: itemId => active.actions.startShellNow(itemId),
  }), [active.actions]);
  const isDraftThreadView = Boolean(activeThread?.isDraft);
  const isLaunchingDraft = isDraftThreadView && loadedTurns.length > 0;
  const showDraftComposer = isDraftThreadView && !isLaunchingDraft;
  const activityTurn = loadedTurns.at(-1) ?? null;
  const currentTurn = activityTurn;
  // The thread's lifecycle decides liveness; a provider's turn status never does.
  const liveTurn = activityTurn && activityTurn.id === activeTurns.liveTurnId ? activityTurn : null;
  // The turn just before the loaded window, when the catalog lists one, anchors the older-turn skeleton.
  const firstLoadedHistoryIndex = activeTranscriptProjection?.turnHistory.findIndex(entry => entry.turnId === loadedTurns[0]?.id) ?? -1;
  const previousTurnEntry = firstLoadedHistoryIndex > 0
    ? activeTranscriptProjection?.turnHistory[firstLoadedHistoryIndex - 1] ?? null
    : null;
  const canLoadPreviousTurn = activeTurns.canLoadOlder;
  const workspaceFileLinkRoots = useMemo(() => (
    projectFileLinkRoots ?? (projectRoots && projectRoots.length > 1
      ? projectRoots.map((root) => ({ id: root.id, rootPath: root.rootPath }))
      : [])
  ), [projectFileLinkRoots, projectRoots]);
  const terminalContext = useMemo(() => ({
    cwd: activeThread?.cwd || projectRootPath || ".",
    knownSkills: workbenchSkills, projectRootPath, workspaceRoots: workspaceFileLinkRoots,
  }), [activeThread?.cwd, projectRootPath, workbenchSkills, workspaceFileLinkRoots]);
  const terminalRetention = useMemo(() => ({
    itemTimeline: activeTranscriptProjection?.turns.at(-1)?.itemTimeline,
    turnStartedAt: activityTurn?.startedAt,
  }), [activeTranscriptProjection, activityTurn]);
  const terminalCommands = useMemo(() => getThreadTerminalEntries(
    liveTurn ? liveTurn.items.filter(item => "status" in item && item.status === "inProgress") : [],
    { ...terminalContext, includeOutput: false },
  ), [liveTurn, terminalContext]);
  const liveActivity = useMemo(() => getLiveThreadActivity({
    pendingUserInputRequest: activePendingUserInputRequest, turn: liveTurn, commands: terminalCommands,
  }), [activePendingUserInputRequest, liveTurn, terminalCommands]);
  const inlineMentionSources = useBackgroundInlineMentionSources({
    files: projectFileCandidates,
    filesIdentity: projectFileIndexId,
    threadCwdPath: activeThread?.cwd || undefined,
    projectRootPath,
    skills: workbenchSkills,
    workspaceRoots: workspaceFileLinkRoots,
  });
  const liveActivityView = useThreadLiveActivity({
    activity: liveActivity,
    items: liveTurn?.items ?? [],
    terminalContext,
    terminalRetention,
    presentationSource: activeThread ? { kind: "sqlite", sourceKey: `${activeThread.harness}:${activeThread.id}` } : null,
    threadId: activeThread?.id ?? "",
    turnId: liveTurn?.id ?? null,
  });
  const headTodos = active.head?.todos;
  const headFeedback = active.head?.addressedFeedback;
  const pickableReferences = useMemo(
    () => [...(headTodos ?? []).map(workbenchThreadTodoReference), ...(headFeedback ?? [])],
    [headFeedback, headTodos],
  );
  const referenceSelection = useThreadReferenceSelection(activeThread?.id ?? "", pickableReferences);
  const { removeTodo, setTodoRequired, setTodoText } = active.actions;
  const todoControls = useMemo<ThreadTodoControls>(() => ({
    todos: headTodos ?? [], selection: referenceSelection, remove: removeTodo, setRequired: setTodoRequired, setText: setTodoText,
  }), [headTodos, referenceSelection, removeTodo, setTodoRequired, setTodoText]);
  // The composer's live draft session, so feedback addressed here joins its next message as an ordinary edit.
  const composerSessionRef = useRef<DraftSessionController<WorkbenchComposerInputDraft> | null>(null);
  const trackDraftSession = useCallback((session: DraftSessionController<WorkbenchComposerInputDraft> | null) => {
    composerSessionRef.current = session;
    onDraftSessionChange?.(session);
  }, [onDraftSessionChange]);
  const appFeedbackAddressing = useContext(WorkbenchFeedbackAddressingContext);
  const feedbackAddressing = useMemo<WorkbenchFeedbackAddressing>(() => ({
    ...appFeedbackAddressing,
    here: isDraftThreadView ? null : (report) => {
      const session = composerSessionRef.current;
      if (!session) throw new Error("This thread's composer is unavailable.");
      session.edit(draft => attachComposerDraftReference(draft, report));
    },
  }), [appFeedbackAddressing, isDraftThreadView]);
  const projectFilePathDisambiguationIndex = useBackgroundProjectFilePathDisambiguationIndex(
    projectFilePaths,
    projectFileIndexId,
  );
  const visibleGitArcProposalPresentation = useMemo(() => getThreadGitArcProposalPresentation({
    knownSkills: workbenchSkills,
    projectRootPath,
    turns: activeTranscriptProjection?.turns ?? [],
    workspaceRoots: workspaceFileLinkRoots,
  }), [
    activeTranscriptProjection?.turns,
    projectRootPath,
    workbenchSkills,
    workspaceFileLinkRoots,
  ]);

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

  // Reconciles after every commit, including SQL's later prepend and skeleton removal.
  const historyPaging = useThreadHistoryPaging({
    thread: activeThread ? { id: activeThread.id, harness: activeThread.harness } : null,
    viewKey: `${projectId}\0${viewInstanceKey}`,
    canLoadOlder: canLoadPreviousTurn,
    renderedTurnIds: renderedHistoryTurnIds,
    sourceReady: !usesSqlTranscript || activeTranscriptSource?.status === "ready",
    loadOlder: active.actions.loadOlder,
    scrollViewportRef,
    reconcileLayout: threadScrollViewport.reconcileLayout,
  });
  const previousTurnLoadStatus = historyPaging.status;

  useEffect(() => {
    let cancelled = false;
    void daemon.skills.read({ projectId: projectId || null, provider: activeProvider }).then((payload) => {
      if (!cancelled) {
        setWorkbenchSkills(payload.data ?? []);
      }
    }).catch((error: unknown) => {
      if (!cancelled) {
        console.warn("Provider skill catalogue read failed.", (error instanceof Error ? error.message : String(error)).slice(0, 500));
        setWorkbenchSkills([]);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [daemon, projectId, activeProvider]);


  useEffect(() => () => {
    codeBlockCopyResetTimersRef.current.forEach((timeoutId) => {
      window.clearTimeout(timeoutId);
    });
    codeBlockCopyResetTimersRef.current.clear();
  }, []);

  const handleSubthreadSelection = useCallback((threadId: string) => {
    setIsMessageBoardOpen(false);
    onSelectedThreadChange?.(threadId);
  }, [onSelectedThreadChange]);
  const handleOpenMessageBoard = useCallback(() => {
    setIsMessageBoardOpen(true);
  }, []);
  const getSubthreadHref = useCallback((threadId: string) => {
    const target: WorkbenchThreadTarget = threadId === thread.id
      ? { harness: thread.harness, kind: "provider", threadId: ThreadReferenceSchema.parse(thread.id) }
      : { harness: getSubagentHarness(subagents, threadId, thread.harness), kind: "subagent", parentThreadId: ThreadReferenceSchema.parse(thread.id), threadId: ThreadReferenceSchema.parse(threadId) };
    return getThreadHref?.(target) ?? projectHref(createThreadRoute(projectId, target));
  }, [getThreadHref, projectHref, projectId, subagents, thread.harness, thread.id]);

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

  const onSendMessage = useComposer.send(composerProfileController);
  const handleSendMessage = useCallback(async (
    _threadId: string,
    input: UserInput[],
    options?: Pick<WorkbenchSendThreadMessageOptions, "activatedSkillPaths" | "skipAutoCompact" | "onThreadLaunched" | "stayInCreate">,
  ) => {
    if (!resolvedActiveThread || !activeProfileSlot) {
      throw new ThreadMessageNotSentError();
    }
    const draftDocument = active.draftDocument;
    if (draftDocument) {
      await onSendMessage(composerProfileController.resolveThread(activeProfileSlot, draftDocument), input, {
        ...options,
        composerProfileSlot: activeProfileSlot,
        selectThread: draftDocument.id === thread.id,
      });
      return;
    }
    // The daemon starts turns with the persisted profile selection, so a pending selection lands first.
    if (!isThreadStatusActive(resolvedActiveThread.status)) await composerProfileController.waitForSelection(activeProfileSlot);
    await active.actions.send(input, options);
  }, [active.actions, active.draftDocument, activeProfileSlot, composerProfileController, onSendMessage, resolvedActiveThread, thread.id]);

  // The daemon rejects skill activations its catalog disagrees with and sends the activatable skills; adopt them.
  const reconcileRejectedSkills = useCallback((error: unknown) => {
    const mismatch = readWorkbenchSkillActivationMismatch(error);
    if (mismatch) setWorkbenchSkills(mismatch.activatableSkills);
  }, []);

  const handleStopThread = useCallback(async () => {
    await active.actions.stop();
  }, [active.actions]);

  const handleCompactThread = useCallback(async () => {
    await active.actions.compact();
  }, [active.actions]);

  const actionsFor = useCallback((threadId: string) => (threadId === thread.id ? rootThread : active).actions,
    [active, rootThread, thread.id]);
  const handleThreadModelChange = useCallback((threadId: string, model: string) => {
    actionsFor(threadId).changeModel(model);
  }, [actionsFor]);

  const handleThreadAgentChange = useCallback((threadId: string, agentPath: string | null) => {
    actionsFor(threadId).changeAgent(agentPath);
  }, [actionsFor]);

  const handleThreadReasoningEffortChange = useCallback((threadId: string, effort: string | null) => {
    actionsFor(threadId).changeReasoningEffort(effort);
  }, [actionsFor]);

  const handleThreadServiceTierChange = useCallback((threadId: string, serviceTier: string | null) => {
    actionsFor(threadId).changeServiceTier(serviceTier);
  }, [actionsFor]);

  const handleThreadSettingsChange = useComposer.settings();
  // A draft's provider comes from its selection: move the draft document harness to match so
  // dispatch and the account rate-limit row agree. The target identity does not move.
  useEffect(() => {
    if (!activeThread?.isDraft || !activeProfileSlot) return;
    if (activeProfileSlot.kind !== "draft" && activeProfileSlot.kind !== "new-thread") return;
    const resolvedHarness = resolvedActiveThread?.harness;
    if (!resolvedHarness || resolvedHarness === activeThread.harness) return;
    const settings = composerProfileController.resolveSettings(activeProfileSlot);
    if (settings) handleThreadSettingsChange(activeThread.id, settings);
  }, [activeProfileSlot, activeThread?.harness, activeThread?.id, activeThread?.isDraft, composerProfileController, handleThreadSettingsChange, resolvedActiveThread?.harness]);

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

  const composerStatus = activeThread ? (
    <ThreadRateLimits
      harness={resolvedActiveThread?.harness ?? activeThread.harness}
      leadingContent={threadOwnerContent}
      rateLimits={rateLimits}
      trailingContent={(
        <ThreadContextStatus
          launching={isLaunchingDraft}
          lifecycle={activeSidebarEntry?.lifecycle}
          onCompactThread={handleCompactThread}
          sendHolding={isCompactSendHolding}
          snoozed={activeThreadSnoozed}
          thread={activeThread}
        />
      )}
    />
  ) : null;
  const fileIndexError = useOwnerFileIndex && ownedFileIndex.snapshot.status === "error"
    ? <p role="alert" className="m-0 py-2 text-[0.76rem] text-danger">
      File suggestions unavailable: {ownedFileIndex.snapshot.error}
      {ownedFileIndex.canRetry ? <button className="ml-2 rounded px-1 hover:bg-accent-soft" type="button"
        onClick={() => { void ownedFileIndex.retry(); }}>Retry</button> : null}
    </p> : null;
  const approvalMode = approvalModeSettings && activeProfileSlot ? composerProfileController.getApprovalMode(activeProfileSlot) : null;
  const approvalReviewer = useApprovalReviewerReady(approvalMode !== null);
  const approvalModeControl = approvalMode && activeProfileSlot ? (
    <WorkbenchApprovalModeMenu
      mode={approvalMode}
      onOpen={approvalReviewer.refresh}
      onSelect={mode => {
        const harness = resolvedActiveThread?.harness ?? activeThread?.harness;
        if (!harness) return;
        void composerProfileController.setApprovalMode(activeProfileSlot, mode, {
          harness, loadModels: () => threads.listModels(harness),
        });
      }}
    />
  ) : null;
  const approvalNotice = approvalMode === "auto" && approvalReviewer.ready === false && approvalModeSettings
    ? <ApprovalReviewerSetupNotice onOpenSettings={approvalModeSettings.onOpenSettings} /> : null;
  const bottomPaddingClassName = mobileFullBleed
    ? "pb-[min(0.75rem,var(--workbench-safe-area-bottom,0px))]"
    : "pb-16";
  const renderComposer = (bottomBefore?: ReactNode) => activeThread ? (
    <ThreadComposer
      autoFocusOnEntry={entryMotionOwnerRef.current?.initialThreadId === activeThreadId}
      onDraftSessionChange={trackDraftSession}
      targetControl={approvalModeControl ?? (showDraftComposer ? draftTargetControl : null)}
      controlNotice={approvalNotice}
      header={fileIndexError}
      key={activeTarget.kind === "subagent" ? activeThread.id : viewInstanceKey}
      composerSpellCheck={composerSpellCheck}
      onListModels={threads.listModels}
      subscribeModelUpdates={threads.subscribeModelUpdates}
      highlightSources={inlineMentionSources}
      onSubmitRejected={reconcileRejectedSkills}
      onCompactSendHoldChange={setIsCompactSendHolding}
      onSendMessage={handleSendMessage}
      onStopThread={handleStopThread}
      onThreadSettled={onThreadSettled}
      onThreadAgentChange={handleThreadAgentChange}
      onThreadReasoningEffortChange={handleThreadReasoningEffortChange}
      onThreadServiceTierChange={handleThreadServiceTierChange}
      onThreadSettingsChange={handleThreadSettingsChange}
      onThreadModelChange={handleThreadModelChange}
      projectId={projectId}
      profileSlot={activeProfileSlot!}
      rateLimits={rateLimits}
      stickyMode={!showDraftComposer}
      bottomUi={!showDraftComposer ? {
        before: bottomBefore,
        after: composerStatus,
        paddingClassName: bottomPaddingClassName,
      } : undefined}
      thread={resolvedActiveThread!}
      turns={loadedTurns}
      threadTarget={activeThread.isDraft ? composerTarget : activeTarget}
      selectedReferences={referenceSelection.selected}
      onReferenceDeselect={reference => referenceSelection.deselect([reference])}
      onReferencesSent={referenceSelection.deselect}
    >
      {showDraftComposer ? (
        <ThreadRateLimits
          harness={resolvedActiveThread?.harness ?? activeThread.harness}
          leadingContent={draftLeadingContent}
          rateLimits={rateLimits}
          trailingContent={<ThreadContextStatus lifecycle={activeSidebarEntry?.lifecycle} onCompactThread={handleCompactThread} sendHolding={isCompactSendHolding} snoozed={activeThreadSnoozed} thread={activeThread} />}
        />
      ) : null}
    </ThreadComposer>
  ) : null;

  const agentTabs = tabDefinitions.length || hasSettledSubagents ? (
    <ThreadAgentTabs
      activeThreadId={activeThreadId}
      getThreadHref={getSubthreadHref}
      hasSettledSubagents={hasSettledSubagents}
      isMessageBoardOpen={isMessageBoardOpen}
      isSettledSubagentsVisible={areSettledSubagentsVisible}
      isRevealingMore={false}
      mainThreadHarness={thread.harness}
      mainThreadId={thread.id}
      onOpenMessageBoard={handleOpenMessageBoard}
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
  const gitArcWork = getThreadGitArcWork({
    gitArc: activeGitArcSelection?.gitArc ?? null,
    proposalObservations: active.gitArcProposals,
  });
  const transcriptSourceMessage = activeTranscriptSource?.status === "failed"
    ? activeTranscriptSource.message
    : activeTranscriptSource?.status === "absent"
      ? "No SQLite transcript exists for this window."
      : activeTranscriptSource?.status === "unavailable"
        ? "The SQLite transcript source is unavailable."
        : null;
  // Thread chrome under the transcript waits for it, so opening goes skeleton -> whole view in one step.
  const transcriptCanRender = !usesSqlTranscript || activeTranscriptProjection !== null || transcriptSourceMessage !== null;
  const initialThreadContentReady = Boolean(
    activeThread && (!usesSqlTranscript || activeTranscriptProjection || transcriptSourceMessage),
  );
  return (
    <WorkbenchThreadDisplaySettingsContext.Provider value={threadCodeDetails}>
    <ThreadScrollViewportContext.Provider value={entryMotionContext}>
    <ContextualProjectProvider
      cwd={activeThread?.cwd}
      filePaths={projectFilePaths}
      id={projectId}
      mentions={inlineMentionSources}
      pathDisambiguation={projectFileIndexId === undefined ? undefined
        : { index: projectFilePathDisambiguationIndex ?? null, key: projectFileIndexId }}
      rootPath={projectRootPath}
      skills={workbenchSkills}
      workspaceRoots={workspaceFileLinkRoots}
    >
      <ThreadStoreGitArcObservationProvider thread={active}>
      <ThreadGitArcPresentationContext.Provider value={{
        gitArcPlan: activeGitArcSelection?.gitArcPlan ?? null,
        harness: activeThread?.harness ?? thread.harness,
        hasActiveGitArc: activeGitArcSelection?.gitArc?.phase === "active",
        projectId,
        threadId: activeThread?.id ?? thread.id,
        proposalIntents: visibleGitArcProposalPresentation.intents,
      }}>
      <>
        <div
          ref={threadViewRef}
          data-thread-history-above={canLoadPreviousTurn ? "true" : undefined}
          data-thread-codeblock-wrap={threadCodeBlockWrap ? "true" : "false"}
          data-thread-project-file-link-boundary="true"
          className={joinClasses(
            "mx-auto min-h-full w-full min-w-0 max-w-content overflow-x-clip md:overflow-x-visible",
            showDraftComposer
              ? "flex flex-col"
              : "grid grid-cols-1 grid-rows-[1fr auto]",
            mobileFullBleed && "px-5",
            showDraftComposer && bottomPaddingClassName,
          )}
          onClick={handleThreadViewClick}
          style={{ fontSize: `${fontSizeRem}rem` }}
        >
        <div
          hidden={showDraftComposer}
          data-thread-transcript="true"
          className={showDraftComposer
            ? undefined
            : "col-start-1 row-start-1 flex min-w-0 flex-col justify-end"}
        >
          <div>
          {isMessageBoardOpen ? (
            <ThreadMessageBoard
              projectId={projectId}
              subagents={subagents}
            />
          ) : <>
          {activeThread && usesSqlTranscript && previousTurnEntry ? (
            previousTurnLoadStatus === "loading" ? (
              <ThreadTurnLoadingSkeleton entry={previousTurnEntry} isLoading />
            ) : previousTurnLoadStatus === "failed" ? (
              <ThreadTurnLoadFailure
                entry={previousTurnEntry}
                onRetry={() => void historyPaging.load({ retry: true })}
              />
            ) : null
          ) : null}
          {activeThread ? (
            usesSqlTranscript || isLaunchingDraft ? (
              activeTranscriptProjection ? (
                <>
                  {activeTranscriptSource?.status === "failed" ? (
                    <div role="alert" className="mx-auto max-w-content px-5 py-3 text-sm text-danger md:px-6">
                      {activeTranscriptSource.message}
                    </div>
                  ) : null}
                  <TranscriptBodiesContext.Provider value={active.store?.transcriptBodies ?? null}>
                  <ThreadItemApprovalsContext.Provider value={activeItemApprovals}>
                  <ThreadItemShellQueueContext.Provider value={activeItemShellQueue}>
                  <ThreadItemActionsContext.Provider value={activeItemActions}>
                  <ThreadTodoControlsContext.Provider value={active.entry && !isDraftThreadView ? todoControls : null}>
                  <WorkbenchFeedbackAddressingContext.Provider value={feedbackAddressing}>
                  <ThreadTranscriptProjection
                    canLoadPreviousTurn={canLoadPreviousTurn}
                    hiddenReasoningStep={null}
                    historySentinelRef={historyPaging.setSentinel}
                    presentationSource={{
                      kind: "sqlite",
                      sourceKey: `${activeThread.harness}:${activeTranscriptProjection.thread.id}`,
                    }}
                    projection={activeTranscriptProjection}
                    liveTurnId={activeTurns.liveTurnId}
                    relatedThreadsById={relatedThreadsById}
                    subagents={subagents}
                  />
                  </WorkbenchFeedbackAddressingContext.Provider>
                  </ThreadTodoControlsContext.Provider>
                  </ThreadItemActionsContext.Provider>
                  </ThreadItemShellQueueContext.Provider>
                  </ThreadItemApprovalsContext.Provider>
                  </TranscriptBodiesContext.Provider>
                </>
              ) : (
                transcriptSourceMessage ? (
                  <div className="flex min-h-48 items-center justify-center px-4 text-center text-sm text-fg/muted">
                    {transcriptSourceMessage}
                  </div>
                ) : (
                  <WorkbenchLoadingSpinner label="Loading thread" />
                )
              )
            ) : null
          ) : (
            <div className="border-t border-[color-mix(in srgb, var(--text) 10%, transparent)] py-4">
              <p className="m-0 text-[0.92em] leading-[1.6] text-fg/muted">Loading subagent thread...</p>
            </div>
          )}
          </>}
        </div>
        </div>
        {activeThread ? (
          <div className={showDraftComposer
            ? "flex w-full flex-1 items-center"
            : "contents"}>
            <div className={showDraftComposer ? "w-full" : "contents"}>
              {showDraftComposer ? <header className="pb-4">
                <h2 className="m-0 text-[1.55em] font-semibold leading-[1.1] tracking-tight text-text">
                  Create new thread
                </h2>
              </header> : null}
              {renderComposer(<>
        {activeThread && transcriptCanRender && !isMessageBoardOpen && (liveActivityView || !isDraftThreadView) ? (
          <ThreadStatusArea
            // Observed heads learn the working directory with the transcript; the arc panel's Git requests need it.
            gitArc={!isDraftThreadView && activeThread.cwd && (gitArcWork || activeGitArcSelection?.gitCommits.length) ? {
              claim: gitArcWork,
              commitActions: checkpointCommitActions,
              cwd: activeThread.cwd,
              harness: activeThread.harness,
              running: liveTurn !== null,
            } : null}
            gitCommits={activeGitArcSelection?.gitCommits ?? []}
            harness={activeThread.harness}
            key={activeThread.id}
            live={liveActivityView}
            skills={active.entry && !isDraftThreadView ? { onDeactivate: active.actions.deactivateSkill, skills: active.head?.skills ?? [] } : null}
            threadId={activeThread.id}
            threadLifecycle={activeGitArcSelection?.lifecycle ?? active.entry?.lifecycle ?? null}
            vis={!isDraftThreadView && vis?.sessions.length ? { sessions: vis.sessions, ...visActions } : null}
            todos={active.entry && !isDraftThreadView ? {
              goalSet: Boolean(active.head?.goal),
              count: headTodos?.length ?? 0,
              feedbackCount: headFeedback?.length ?? 0,
              renderPanel: () => (
                <>
                  <ThreadTodoPanel
                    controls={todoControls}
                    goal={active.head?.goal ?? null}
                    onAddTodo={active.actions.addTodo}
                    onClearGoal={active.actions.clearGoal}
                    onSetGoal={active.actions.setGoal}
                  />
                  <ThreadAddressedFeedback
                    feedback={headFeedback ?? []}
                    onDetach={active.actions.detachAddressedFeedback}
                    selection={referenceSelection}
                  />
                </>
              ),
            } : null}
          />
        ) : null}
        {activeThread && transcriptCanRender && !isDraftThreadView ? <ThreadErrorCard lifecycle={activeSidebarEntry?.lifecycle} /> : null}
        {agentTabs ? (
          <div className="mt-6">{agentTabs}</div>
        ) : null}
              </>)}
            </div>
          </div>
        ) : null}
        </div>
        <div
          ref={initialThreadContentReady ? threadScrollViewport.setEndTarget : null}
          aria-hidden="true"
          className={joinClasses(
            "h-px w-full shrink-0",
            !showDraftComposer && "relative bottom-4",
            initialThreadContentReady && "[scroll-margin-block-start:var(--thread-scroll-snap-distance)] snap-end",
          )}
          data-thread-scroll-end={initialThreadContentReady ? "true" : undefined}
        />
      </>
      </ThreadGitArcPresentationContext.Provider>
      </ThreadStoreGitArcObservationProvider>
    </ContextualProjectProvider>
    </ThreadScrollViewportContext.Provider>
    </WorkbenchThreadDisplaySettingsContext.Provider>
  );
});
