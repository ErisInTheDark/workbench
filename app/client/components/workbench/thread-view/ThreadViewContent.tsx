/*
 * Exports:
 * - default ThreadViewContent: lay out one thread view (transcript, composer, status, agent tabs) and own the state its sections share.
 */
"use client";

import { memo, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";

import type { WorkbenchComposerInputDraft, WorkbenchProjectRoot } from "workbench-shared/types";
import { ThreadReferenceSchema } from "workbench-shared/workbench/identity";
import type { ProjectTreeFileCandidate } from "workbench-shared/workbench/project/ProjectTreeFileIndex";
import type { WorkbenchThreadRouteTarget as WorkbenchThreadTarget } from "workbench-shared/workbench/thread/thread-state";
import { workbenchThreadTodoReference } from "workbench-shared/workbench/thread/thread-todo";
import type { Turn } from "workbench-shared/workbench/thread/workbench-thread-turn";
import type { WorkspaceFileLinkRoot } from "../../../workbench/markdown/markdown-links";
import { attachComposerDraftReference } from "../../../workbench/state/draft-persistence";
import { filterSubagentsByParentThreadId, sortWorkbenchSubagents } from "../../../workbench/thread/thread-subagents";
import { WorkbenchFeedbackAddressingContext, type WorkbenchFeedbackAddressing } from "../address-feedback-context";
import ContextualProjectProvider from "../ContextualProjectProvider";
import { useThread } from "../use-thread";
import { useThreads } from "../use-threads";
import { useTranscript } from "../use-transcript";
import type DraftSessionController from "./DraftSessionController";
import ThreadCheckpointCommitActions from "./ThreadCheckpointCommitActions";
import { ThreadStoreGitArcObservationProvider } from "./ThreadGitArcObservationContext";
import ThreadGitArcPresentationContext from "./ThreadGitArcPresentationContext";
import getThreadGitArcProposalPresentation from "./thread-git-arc-presentation";
import { ThreadScrollViewportContext, useThreadScrollViewportContext } from "./thread-scroll-viewport-context";
import type { ThreadTodoControls } from "./thread-todo-controls";
import ThreadViewComposer from "./ThreadViewComposer";
import ThreadViewStatus from "./ThreadViewStatus";
import ThreadViewTranscript, { readActiveTranscript } from "./ThreadViewTranscript";
import { useBackgroundInlineMentionSources, useBackgroundProjectFilePathDisambiguationIndex } from "./use-background-thread-indexes";
import useThreadCodeBlockActions from "./use-thread-code-block-actions";
import useThreadEntryMotion from "./use-thread-entry-motion";
import useThreadReferenceSelection from "./use-thread-reference-selection";
import useThreadSubagentTabs from "./use-thread-subagent-tabs";
import useWorkbenchSkillCatalogue from "./use-workbench-skill-catalogue";
import { WorkbenchThreadDisplaySettingsContext } from "./WorkbenchThreadDisplaySettingsContext";

const EMPTY_TURNS: readonly Turn[] = [];

function joinClasses (...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
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
  const activeThreadId = selectedThreadId ?? thread.id;
  const threads = useThreads(undefined, thread.id);
  const activeTarget: WorkbenchThreadTarget = activeThreadId === thread.id ? rootTarget
    : { kind: "subagent", parentThreadId: ThreadReferenceSchema.parse(thread.id), threadId: ThreadReferenceSchema.parse(activeThreadId) };
  const active = useThread(projectId, activeTarget, "view");
  const activeThread = active.head;
  const activeTurns = useTranscript.turns(active.store);
  const threadScrollViewport = useThreadScrollViewportContext();
  const [checkpointCommitActions] = useState(() => new ThreadCheckpointCommitActions());
  const [isMessageBoardOpen, setIsMessageBoardOpen] = useState(false);
  useEffect(() => { setIsMessageBoardOpen(false); }, [thread.id]);
  const threadViewRef = useRef<HTMLDivElement>(null);
  const handleThreadViewClick = useThreadCodeBlockActions(threadViewRef, threadCodeBlockWrap, onThreadCodeBlockWrapChange);
  const subagents = useMemo(
    () => sortWorkbenchSubagents(filterSubagentsByParentThreadId(rootThread.subagents, thread.id)),
    [rootThread.subagents, thread.id],
  );
  const relatedThreadsById = rootThread.relatedHeads;
  const usesSqlTranscript = Boolean(activeThread && !activeThread.isDraft);
  const { source: activeTranscriptSource, projection: activeTranscriptProjection } = readActiveTranscript(activeThread, activeTurns.transcript);
  const entryMotion = useThreadEntryMotion(
    activeTarget.kind === "subagent" ? `${viewInstanceKey}:subagent:${activeThreadId}` : viewInstanceKey,
    activeThreadId,
    activeTranscriptProjection?.turns ?? null,
  );
  const entryMotionContext = useMemo(() => ({
    ...threadScrollViewport,
    activityRuns: entryMotion.activityRunController,
    entryMotion: entryMotion.controller,
  }), [entryMotion.activityRunController, entryMotion.controller, threadScrollViewport]);
  const [workbenchSkills, reconcileRejectedSkills] = useWorkbenchSkillCatalogue(projectId, activeThread?.harness ?? thread.harness);
  const loadedTurns = activeThread?.isDraft || activeTranscriptProjection ? activeTurns.turns : EMPTY_TURNS;
  const isDraftThreadView = Boolean(activeThread?.isDraft);
  const showDraftComposer = isDraftThreadView && loadedTurns.length === 0;
  const workspaceFileLinkRoots = useMemo(() => (
    projectFileLinkRoots ?? (projectRoots && projectRoots.length > 1
      ? projectRoots.map((root) => ({ id: root.id, rootPath: root.rootPath }))
      : [])
  ), [projectFileLinkRoots, projectRoots]);
  const inlineMentionSources = useBackgroundInlineMentionSources({
    files: projectFileCandidates,
    filesIdentity: projectFileIndexId,
    threadCwdPath: activeThread?.cwd || undefined,
    projectRootPath,
    skills: workbenchSkills,
    workspaceRoots: workspaceFileLinkRoots,
  });
  const projectFilePathDisambiguationIndex = useBackgroundProjectFilePathDisambiguationIndex(
    projectFilePaths,
    projectFileIndexId,
  );

  // Todo and feedback references are picked in the status panel and transcript, then sent by the composer.
  const headTodos = activeThread?.todos;
  const headFeedback = activeThread?.addressedFeedback;
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

  const handleSubthreadSelection = useCallback((threadId: string) => {
    setIsMessageBoardOpen(false);
    onSelectedThreadChange?.(threadId);
  }, [onSelectedThreadChange]);
  const handleOpenMessageBoard = useCallback(() => {
    setIsMessageBoardOpen(true);
  }, []);
  const agentTabs = useThreadSubagentTabs({
    activeThreadId,
    getThreadHref,
    isMessageBoardOpen,
    onOpenMessageBoard: handleOpenMessageBoard,
    onSelectThread: handleSubthreadSelection,
    projectId,
    relatedThreadsById,
    subagents,
    thread,
    updateThreadState: threads.updateState,
  });

  const fileIndexError = useOwnerFileIndex && ownedFileIndex.snapshot.status === "error"
    ? <p role="alert" className="m-0 py-2 text-[0.76rem] text-danger">
      File suggestions unavailable: {ownedFileIndex.snapshot.error}
      {ownedFileIndex.canRetry ? <button className="ml-2 rounded px-1 hover:bg-accent-soft" type="button"
        onClick={() => { void ownedFileIndex.retry(); }}>Retry</button> : null}
    </p> : null;
  const bottomPaddingClassName = mobileFullBleed
    ? "pb-[min(0.75rem,var(--workbench-safe-area-bottom,0px))]"
    : "pb-16";
  const transcriptSourceMessage = activeTranscriptSource?.status === "failed"
    ? activeTranscriptSource.message
    : activeTranscriptSource?.status === "absent" || activeTranscriptSource?.status === "unavailable"
      ? activeTranscriptSource.status
      : null;
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
        gitArcPlan: active.entry?.gitArcPlan ?? null,
        harness: activeThread?.harness ?? thread.harness,
        hasActiveGitArc: active.entry?.gitArc?.phase === "active",
        projectId,
        threadId: activeThread?.id ?? thread.id,
        proposalIntents: visibleGitArcProposalPresentation.intents,
      }}>
      <>
        <div
          ref={threadViewRef}
          data-thread-history-above={activeTurns.canLoadOlder ? "true" : undefined}
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
            <ThreadViewTranscript
              feedbackAddressing={feedbackAddressing}
              isMessageBoardOpen={isMessageBoardOpen}
              projectId={projectId}
              relatedThreadsById={relatedThreadsById}
              scrollViewportRef={scrollViewportRef}
              subagents={subagents}
              target={activeTarget}
              todoControls={active.entry && !isDraftThreadView ? todoControls : null}
              viewInstanceKey={viewInstanceKey}
            />
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
              <ThreadViewComposer
                approvalModeSettings={approvalModeSettings}
                autoFocusOnEntry={entryMotion.initialThreadId === activeThreadId}
                bottomBefore={<>
                  <ThreadViewStatus
                    checkpointCommitActions={checkpointCommitActions}
                    isMessageBoardOpen={isMessageBoardOpen}
                    projectId={projectId}
                    projectRootPath={projectRootPath}
                    referenceSelection={referenceSelection}
                    skills={workbenchSkills}
                    target={activeTarget}
                    threadId={activeThreadId}
                    todoControls={todoControls}
                    workspaceRoots={workspaceFileLinkRoots}
                  />
                  {agentTabs ? <div className="mt-6">{agentTabs}</div> : null}
                </>}
                bottomPaddingClassName={bottomPaddingClassName}
                composerSpellCheck={composerSpellCheck}
                draftLeadingContent={draftLeadingContent}
                draftTargetControl={draftTargetControl}
                header={fileIndexError}
                highlightSources={inlineMentionSources}
                onDraftSessionChange={trackDraftSession}
                onSubmitRejected={reconcileRejectedSkills}
                onThreadSettled={onThreadSettled}
                projectId={projectId}
                referenceSelection={referenceSelection}
                rootTarget={rootTarget}
                routeTarget={threadTarget}
                target={activeTarget}
                threadOwnerContent={threadOwnerContent}
                viewInstanceKey={viewInstanceKey}
              />
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
