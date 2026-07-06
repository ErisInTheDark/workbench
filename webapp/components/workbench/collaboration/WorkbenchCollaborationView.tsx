/*
 * Exports:
 * - default WorkbenchCollaborationView: compose threaded Collaboration state, tags, prompt materialization, collaborator runs, and tree UI wiring. Keywords: collaboration, threaded, posts, tags, runs.
 * - Local helpers: create prompt drafts and coordinate post prompt materialization. Keywords: collaboration, prompt, endpoint.
 */
"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps, type PointerEvent as ReactPointerEvent } from "react";

import type { UserInput } from "../../../lib/codex/generated/app-server/v2/UserInput";
import type {
  ChangeSummary,
  ThreadPayload,
  ThreadSummary,
  WorkbenchCollaborationPost,
  WorkbenchCollaborationState,
  WorkbenchCollaborationAdminPostMutation,
  WorkbenchControls,
  WorkbenchHarness,
  WorkbenchThreadComposerDraft,
} from "../../../lib/types";
import {
  COLLABORATION_IMPORTED_SCRATCHPAD_POST_ID,
  createWorkbenchCollaborationPostId,
  ensureImportedScratchpadPost,
  normalizeWorkbenchCollaborationState,
} from "../../../lib/workbench/collaboration/collaboration-state";
import {
  mutateWorkbenchCollaborationAdminPost,
} from "../../../lib/workbench/collaboration/collaboration-registry-api";
import {
  readStoredWorkbenchCollaborationLayout,
  writeStoredWorkbenchCollaborationLayout,
} from "../../../lib/workbench/collaboration/collaboration-layout";
import {
  createCollaborationStateTag,
  createCollaborationPost,
  deleteCollaborationSubtree,
  materializeCollaborationPostPromptThread,
  moveCollaborationPost,
  removeCollaborationPostTag,
  restoreCollaborationPostRevision,
  setCollaborationPostCollapsed,
  tagCollaborationPost,
  updateCollaborationPost,
  updateCollaborationPostPrompt,
  type CollaborationPostDropIntent,
  type WorkbenchCollaborationPostDraft,
} from "../../../lib/workbench/collaboration/collaboration-tree-mutations";
import { areDeeplyEqual } from "../../../lib/workbench/deep-equality";
import type { WorkbenchDragPayload } from "../../../lib/workbench/layout/workbench-drag";
import {
  buildInlineMentionCandidates,
} from "../../../lib/workbench/thread/inline-mention-highlights";
import WorkbenchMainLayout from "../../../lib/workbench/layout/workbench-layout";
import WorkbenchMainLayoutView from "../layout/WorkbenchMainLayoutView";
import { ThreadThreadContent } from "../thread-view/thread-view-items";
import ThreadComposer from "../thread-view/ThreadComposer";
import ThreadRateLimits from "../thread-view/ThreadRateLimits";
import ThreadView from "../thread-view/ThreadView";
import CollaborationRunController from "./CollaborationRunController";
import CollaborationRevisionHistoryDialog from "./CollaborationRevisionHistoryDialog";
import CollaborationRunPanel from "./CollaborationRunPanel";
import CollaborationThreadedView from "./CollaborationThreadedView";

type ThreadViewProps = ComponentProps<typeof ThreadView>;

type WorkbenchCollaborationPromptStartResult =
  | {
    readonly error: string;
    readonly status: "failed";
  }
  | {
    readonly status: "started";
    readonly threadId: string;
  };

function joinClasses(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

interface WorkbenchCollaborationViewProps extends Omit<ThreadViewProps, "contained" | "fontSizeRem" | "hideFinalAgentMessage" | "hideWorkbenchControlAgentMessages" | "hideWorkbenchControlUserMessages" | "projectId" | "thread"> {
  activeDrag: { payload: WorkbenchDragPayload; x: number; y: number } | null;
  collaborationState: WorkbenchCollaborationState;
  collaborationThreadSummaries: ThreadSummary[];
  controls: WorkbenchControls | null;
  editorFontClassName: string;
  fontSizeRem: number;
  harness: WorkbenchHarness;
  isMobile: boolean;
  isProjectLoading: boolean;
  onClaimAutoWake: (projectId: string, ownerId: string) => Promise<{ acquired: boolean; state: WorkbenchCollaborationState }>;
  onCollaborationStateChange: (state: WorkbenchCollaborationState, options?: { persist?: boolean }) => void;
  onOpenThreadFromPromptPost: (threadId: string) => void;
  onPointerDrop: () => void;
  onPostPointerDragStart: (event: ReactPointerEvent<HTMLElement>, post: WorkbenchCollaborationPost) => void;
  onStartThreadFromPrompt: (input: UserInput[], thread: ThreadPayload) => Promise<WorkbenchCollaborationPromptStartResult>;
  projectChanges: Record<string, ChangeSummary>;
  projectId: string;
  scratchpadPath: string;
  scratchpadWritableRoot: string;
}

function createPromptDraftThreadId(projectId: string, postId: string) {
  const safeProjectId = projectId.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "project";
  const safePostId = postId.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "post";
  return `draft:collaboration-prompt:${safeProjectId}:${safePostId}`;
}

function getPromptTextFromInput(input: readonly UserInput[]) {
  return input
    .flatMap((entry) => entry.type === "text" ? [entry.text] : [])
    .join("\n")
    .trim();
}

export default function WorkbenchCollaborationView({
  activeDrag,
  collaborationState,
  collaborationThreadSummaries,
  composerSpellCheck,
  controls,
  editorFontClassName: _editorFontClassName,
  fontSizeRem,
  harness,
  isMobile,
  isProjectLoading,
  onClaimAutoWake,
  onCollaborationStateChange,
  onOpenThreadFromPromptPost,
  onPointerDrop,
  onPostPointerDragStart,
  onReadThread,
  onSendMessage,
  onStartThreadFromPrompt,
  projectChanges,
  projectFileCandidates,
  projectFileIndexId,
  projectFileLinkRoots,
  projectId,
  projectRootPath,
  rateLimits,
  scratchpadPath,
  scratchpadWritableRoot,
  threadDocuments,
  threadSavedComposerDrafts,
  ...threadViewProps
}: WorkbenchCollaborationViewProps) {
  const [promptDraftThreadsByPostId, setPromptDraftThreadsByPostId] = useState<Record<string, ThreadPayload | undefined>>({});
  const [promptComposerDraftsByPostId, setPromptComposerDraftsByPostId] = useState<Record<string, WorkbenchThreadComposerDraft | undefined>>({});
  const [promptStartErrorsByPostId, setPromptStartErrorsByPostId] = useState<Record<string, string | undefined>>({});
  const [mobilePane, setMobilePane] = useState<"scratchpad" | "collaborator">("scratchpad");
  const [collaborationLayout, setCollaborationLayout] = useState(() => readStoredWorkbenchCollaborationLayout(projectId));
  const [revisionPostId, setRevisionPostId] = useState<string | null>(null);
  const stateRef = useRef(normalizeWorkbenchCollaborationState(collaborationState));
  const adminPostMutationQueueRef = useRef<Promise<WorkbenchCollaborationState>>(Promise.resolve(stateRef.current));
  const adminPostMutationSerialRef = useRef(0);
  const attemptedScratchpadImportKeyRef = useRef("");
  const promptSaveTimeoutsByPostIdRef = useRef<Record<string, number | undefined>>({});
  const promptSaveValuesByPostIdRef = useRef<Record<string, string | undefined>>({});

  useEffect(() => {
    stateRef.current = normalizeWorkbenchCollaborationState(collaborationState);
  }, [collaborationState]);

  useEffect(() => {
    setCollaborationLayout(readStoredWorkbenchCollaborationLayout(projectId));
    adminPostMutationQueueRef.current = Promise.resolve(stateRef.current);
    adminPostMutationSerialRef.current += 1;
    for (const timeoutId of Object.values(promptSaveTimeoutsByPostIdRef.current)) {
      if (timeoutId !== undefined) {
        window.clearTimeout(timeoutId);
      }
    }
    promptSaveTimeoutsByPostIdRef.current = {};
    promptSaveValuesByPostIdRef.current = {};
    setPromptDraftThreadsByPostId({});
    setPromptComposerDraftsByPostId({});
    setPromptStartErrorsByPostId({});
  }, [projectId]);

  useEffect(() => () => {
    for (const timeoutId of Object.values(promptSaveTimeoutsByPostIdRef.current)) {
      if (timeoutId !== undefined) {
        window.clearTimeout(timeoutId);
      }
    }
  }, []);

  const setAndStoreCollaborationLayout = useCallback((nextLayout: typeof collaborationLayout) => {
    setCollaborationLayout(nextLayout);
    writeStoredWorkbenchCollaborationLayout(projectId, nextLayout);
  }, [projectId]);

  const focusCollaborationPanel = useCallback((panelId: string) => {
    setCollaborationLayout((current) => {
      if (current.focusedPanelId === panelId) {
        return current;
      }

      const nextLayout = {
        ...current,
        focusedPanelId: panelId,
      };
      writeStoredWorkbenchCollaborationLayout(projectId, nextLayout);
      return nextLayout;
    });
  }, [projectId]);

  const resizeCollaborationSplit = useCallback((splitId: string, firstPercent: number) => {
    setCollaborationLayout((current) => {
      const nextLayout = WorkbenchMainLayout.resizeSplit(current, splitId, firstPercent);
      writeStoredWorkbenchCollaborationLayout(projectId, nextLayout);
      return nextLayout;
    });
  }, [projectId]);

  const activeDragPayload = activeDrag?.payload ?? null;
  const composerWorkspaceRoots = projectFileLinkRoots ?? [];
  const highlightSources = useMemo(() => buildInlineMentionCandidates({
    files: projectFileCandidates,
    filesIdentity: projectFileIndexId,
    projectRootPath,
    skills: [],
    workspaceRoots: composerWorkspaceRoots,
  }), [composerWorkspaceRoots, projectFileCandidates, projectFileIndexId, projectRootPath]);
  const publishStateIfChanged = useCallback((nextState: WorkbenchCollaborationState, options?: { persist?: boolean }) => {
    const normalizedState = normalizeWorkbenchCollaborationState(nextState);
    if (areDeeplyEqual(stateRef.current, normalizedState)) {
      return;
    }

    stateRef.current = normalizedState;
    onCollaborationStateChange(normalizedState, options);
  }, [onCollaborationStateChange]);

  const getCurrentCollaborationState = useCallback(() => stateRef.current, []);

  const runController = CollaborationRunController({
    collaborationState,
    collaborationThreadSummaries,
    controls,
    getCurrentCollaborationState,
    harness,
    isProjectLoading,
    livePendingUserInputRequestsByThreadId: threadViewProps.livePendingUserInputRequestsByThreadId,
    onClaimAutoWake,
    onPauseThread: threadViewProps.onPauseThread,
    onReadThread,
    onResumeThread: threadViewProps.onResumeThread,
    onSendMessage,
    onStopThread: threadViewProps.onStopThread,
    projectChanges,
    projectId,
    publishStateIfChanged,
    scratchpadWritableRoot,
    threadDocuments,
  });
  const { recordCollaborationActivity } = runController;
  const revisionPost = revisionPostId ? collaborationState.posts[revisionPostId] ?? null : null;

  useEffect(() => {
    if (!scratchpadPath || collaborationState.posts[COLLABORATION_IMPORTED_SCRATCHPAD_POST_ID]) {
      return;
    }

    const importKey = `${projectId}:${scratchpadPath}`;
    if (attemptedScratchpadImportKeyRef.current === importKey) {
      return;
    }

    attemptedScratchpadImportKeyRef.current = importKey;
    let cancelled = false;
    void fetch(`/api/collaboration/scratchpad?projectId=${encodeURIComponent(projectId)}&path=${encodeURIComponent(scratchpadPath)}`, { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) {
          return null;
        }

        return await response.json().catch(() => null) as { content?: unknown } | null;
      })
      .then((payload) => {
        if (cancelled || typeof payload?.content !== "string" || !payload.content.trim()) {
          return;
        }

        publishStateIfChanged(ensureImportedScratchpadPost(stateRef.current, payload.content));
      })
      .catch(() => {
        // Scratchpad import is best-effort; the threaded view remains usable without legacy notes.
      });
    return () => {
      cancelled = true;
    };
  }, [collaborationState.posts, projectId, publishStateIfChanged, scratchpadPath]);

  const mutateAdminPostState = useCallback((
    mutation: WorkbenchCollaborationAdminPostMutation,
    mutator: (state: WorkbenchCollaborationState) => WorkbenchCollaborationState,
  ) => {
    const baseState = stateRef.current;
    const optimisticState = mutator(baseState);
    const serial = adminPostMutationSerialRef.current + 1;
    adminPostMutationSerialRef.current = serial;
    publishStateIfChanged(optimisticState, { persist: false });
    recordCollaborationActivity();
    const nextMutation = adminPostMutationQueueRef.current
      .catch(() => stateRef.current)
      .then(() => mutateWorkbenchCollaborationAdminPost(projectId, mutation));
    adminPostMutationQueueRef.current = nextMutation
      .then((savedState) => {
        if (serial === adminPostMutationSerialRef.current) {
          publishStateIfChanged(savedState, { persist: false });
        }
        return savedState;
      })
      .catch(() => {
        // Browser-local Collaboration state remains usable when admin post mutation persistence is unavailable.
        return optimisticState;
      });
    void adminPostMutationQueueRef.current;
  }, [projectId, publishStateIfChanged, recordCollaborationActivity]);

  const ensurePromptDraftThread = useCallback((post: WorkbenchCollaborationPost) => {
    if (!controls) {
      setPromptStartErrorsByPostId((current) => ({
        ...current,
        [post.id]: "Workbench controls are not ready.",
      }));
      return null;
    }

    const existing = promptDraftThreadsByPostId[post.id];
    if (existing) {
      return existing;
    }

    const draftThread = controls.createThreadDraft(harness, {
      select: false,
      threadId: createPromptDraftThreadId(projectId, post.id),
    });
    setPromptDraftThreadsByPostId((current) => ({
      ...current,
      [post.id]: draftThread,
    }));
    setPromptComposerDraftsByPostId((current) => current[post.id] ? current : {
      ...current,
      [post.id]: {
        attachments: [],
        text: post.prompt ?? "",
        updatedAt: post.updatedAt,
      },
    });
    setPromptStartErrorsByPostId((current) => {
      if (!current[post.id]) {
        return current;
      }

      const next = { ...current };
      delete next[post.id];
      return next;
    });
    return draftThread;
  }, [controls, harness, projectId, promptDraftThreadsByPostId]);

  const updatePromptDraftThread = useCallback((postId: string, threadId: string, update: (thread: ThreadPayload) => ThreadPayload) => {
    setPromptDraftThreadsByPostId((current) => {
      const existing = current[postId];
      if (!existing || existing.id !== threadId) {
        return current;
      }

      const nextThread = update(existing);
      return nextThread === existing
        ? current
        : {
          ...current,
          [postId]: nextThread,
        };
    });
  }, []);

  const clearScheduledPromptSave = useCallback((postId: string) => {
    const timeoutId = promptSaveTimeoutsByPostIdRef.current[postId];
    if (timeoutId !== undefined) {
      window.clearTimeout(timeoutId);
    }
    delete promptSaveTimeoutsByPostIdRef.current[postId];
    delete promptSaveValuesByPostIdRef.current[postId];
  }, []);

  const schedulePromptSave = useCallback((postId: string, prompt: string) => {
    const normalizedPrompt = prompt.trim();
    const currentPrompt = stateRef.current.posts[postId]?.prompt?.trim() ?? "";
    if (!normalizedPrompt || normalizedPrompt === currentPrompt) {
      clearScheduledPromptSave(postId);
      return;
    }

    const existingTimeoutId = promptSaveTimeoutsByPostIdRef.current[postId];
    if (existingTimeoutId !== undefined) {
      window.clearTimeout(existingTimeoutId);
    }

    promptSaveValuesByPostIdRef.current[postId] = normalizedPrompt;
    promptSaveTimeoutsByPostIdRef.current[postId] = window.setTimeout(() => {
      delete promptSaveTimeoutsByPostIdRef.current[postId];
      const promptToSave = promptSaveValuesByPostIdRef.current[postId]?.trim() ?? "";
      delete promptSaveValuesByPostIdRef.current[postId];
      const post = stateRef.current.posts[postId];
      if (!post || !promptToSave || post.prompt?.trim() === promptToSave) {
        return;
      }

      mutateAdminPostState({
        action: "updatePostPrompt",
        postId,
        prompt: promptToSave,
      }, (state) => updateCollaborationPostPrompt(state, postId, promptToSave));
    }, 500);
  }, [clearScheduledPromptSave, mutateAdminPostState]);

  const handlePromptDraftChange = useCallback((postId: string, draft: WorkbenchThreadComposerDraft) => {
    setPromptComposerDraftsByPostId((current) => ({
      ...current,
      [postId]: draft,
    }));
    schedulePromptSave(postId, draft.text);
    setPromptStartErrorsByPostId((current) => {
      if (!current[postId]) {
        return current;
      }

      const next = { ...current };
      delete next[postId];
      return next;
    });
  }, [schedulePromptSave]);

  const handlePromptDraftClear = useCallback((postId: string) => {
    setPromptComposerDraftsByPostId((current) => {
      if (!current[postId]) {
        return current;
      }

      const next = { ...current };
      delete next[postId];
      return next;
    });
    clearScheduledPromptSave(postId);
  }, [clearScheduledPromptSave]);

  const handleCreatePost = useCallback((parentId: string | null, draft: WorkbenchCollaborationPostDraft) => {
    const postId = createWorkbenchCollaborationPostId();
    mutateAdminPostState({
      action: "createPost",
      attachments: draft.attachments,
      body: draft.body,
      parentId,
      postId,
      prompt: draft.prompt,
    }, (state) => createCollaborationPost(state, parentId, draft, { id: postId }));
  }, [mutateAdminPostState]);

  const handleCreateTag = useCallback((tag: string) => {
    mutateAdminPostState({
      action: "createTag",
      tag,
    }, (state) => createCollaborationStateTag(state, tag));
  }, [mutateAdminPostState]);

  const handleEditPost = useCallback((postId: string, draft: WorkbenchCollaborationPostDraft) => {
    mutateAdminPostState({
      action: "updatePost",
      attachments: draft.attachments,
      body: draft.body,
      postId,
      prompt: draft.prompt,
    }, (state) => updateCollaborationPost(state, postId, draft));
  }, [mutateAdminPostState]);

  const handleTagPost = useCallback((postId: string, tag: string) => {
    mutateAdminPostState({
      action: "tagPost",
      postId,
      tag,
    }, (state) => tagCollaborationPost(state, postId, tag));
  }, [mutateAdminPostState]);

  const handleRemovePostTag = useCallback((postId: string, tag: string) => {
    mutateAdminPostState({
      action: "removePostTag",
      postId,
      tag,
    }, (state) => removeCollaborationPostTag(state, postId, tag));
  }, [mutateAdminPostState]);

  const handleDeletePost = useCallback((postId: string) => {
    mutateAdminPostState({
      action: "deletePost",
      postId,
    }, (state) => deleteCollaborationSubtree(state, postId));
  }, [mutateAdminPostState]);

  const handleRestoreRevision = useCallback((postId: string, revisionId: string) => {
    mutateAdminPostState({
      action: "restorePostRevision",
      postId,
      revisionId,
    }, (state) => restoreCollaborationPostRevision(state, postId, revisionId));
    setRevisionPostId(null);
  }, [mutateAdminPostState]);

  const handleSetPostCollapsed = useCallback((postId: string, isCollapsed: boolean) => {
    mutateAdminPostState({
      action: "setPostCollapsed",
      isCollapsed,
      postId,
    }, (state) => setCollaborationPostCollapsed(state, postId, isCollapsed));
  }, [mutateAdminPostState]);

  const handleMovePost = useCallback((postId: string, intent: CollaborationPostDropIntent) => {
    mutateAdminPostState({
      action: "movePost",
      intent,
      postId,
    }, (state) => moveCollaborationPost(state, postId, intent));
    onPointerDrop();
  }, [mutateAdminPostState, onPointerDrop]);

  const handleStartPromptThread = useCallback(async (postId: string, input: UserInput[], draftThread: ThreadPayload) => {
    const submittedPrompt = getPromptTextFromInput(input);
    const result = await onStartThreadFromPrompt(input, draftThread);
    if (result.status === "failed") {
      setPromptStartErrorsByPostId((current) => ({
        ...current,
        [postId]: result.error,
      }));
      throw new Error(result.error);
    }

    clearScheduledPromptSave(postId);
    mutateAdminPostState({
      action: "materializePromptThread",
      postId,
      prompt: submittedPrompt,
      promptThreadId: result.threadId,
    }, (state) => materializeCollaborationPostPromptThread(state, postId, submittedPrompt, result.threadId));
    setPromptDraftThreadsByPostId((current) => {
      if (!current[postId]) {
        return current;
      }

      const next = { ...current };
      delete next[postId];
      return next;
    });
    setPromptComposerDraftsByPostId((current) => {
      if (!current[postId]) {
        return current;
      }

      const next = { ...current };
      delete next[postId];
      return next;
    });
    setPromptStartErrorsByPostId((current) => {
      if (!current[postId]) {
        return current;
      }

      const next = { ...current };
      delete next[postId];
      return next;
    });
  }, [mutateAdminPostState, onStartThreadFromPrompt]);

  const collaboratorComposerThread = runController.collaboratorDraftThread;
  const collaboratorComposer = collaboratorComposerThread ? (
    <ThreadComposer
      key={collaboratorComposerThread.id}
      composerSpellCheck={composerSpellCheck}
      highlightSources={highlightSources}
      knownSkills={[]}
      onListModels={threadViewProps.onListModels}
      onPauseThread={() => { }}
      onResumeThread={() => { }}
      onSendMessage={runController.sendComposerMessage}
      onStopThread={() => { }}
      onSubmitUserInputRequest={threadViewProps.onSubmitUserInputRequest}
      onThreadAgentChange={runController.setCollaboratorDraftAgent}
      onThreadComposerDraftChange={runController.setCollaboratorDraftComposerDraft}
      onThreadComposerDraftClear={runController.clearCollaboratorDraft}
      onThreadModelChange={runController.setCollaboratorDraftModel}
      onThreadQuestionnaireDraftChange={threadViewProps.onThreadQuestionnaireDraftChange}
      onThreadQuestionnaireDraftClear={threadViewProps.onThreadQuestionnaireDraftClear}
      onThreadReasoningEffortChange={runController.setCollaboratorDraftReasoningEffort}
      onThreadSavedComposerDraftDelete={threadViewProps.onThreadSavedComposerDraftDelete}
      onThreadSavedComposerDraftSave={threadViewProps.onThreadSavedComposerDraftSave}
      onThreadServiceTierChange={runController.setCollaboratorDraftServiceTier}
      pendingUserInputRequest={null}
      projectId={projectId}
      projectRootPath={projectRootPath}
      rateLimits={rateLimits}
      sendLabel="Run with note"
      thread={collaboratorComposerThread}
      threadComposerDraft={runController.collaboratorDraftComposerDraft}
      threadQuestionnaireDraft={null}
      threadSavedComposerDrafts={threadSavedComposerDrafts}
      workspaceRoots={composerWorkspaceRoots}
    >
      <ThreadRateLimits
        canToggleHarness={collaboratorComposerThread.isDraft}
        harness={collaboratorComposerThread.harness}
        onHarnessToggle={runController.cycleCollaboratorDraftHarness}
        rateLimits={rateLimits}
      />
    </ThreadComposer>
  ) : (
    <p className="m-0 text-[0.86rem] leading-6 text-muted">Collaborator is not ready.</p>
  );

  const activeRunContent = runController.effectiveRunThread ? (
    runController.shouldRenderCurrentRunThread ? (
      <ThreadView
        {...threadViewProps}
        composerSpellCheck={composerSpellCheck}
        contained
        fontSizeRem={fontSizeRem}
        hideFinalAgentMessage
        hideWorkbenchControlAgentMessages
        hideWorkbenchControlUserMessages
        onPauseThread={runController.pauseRunThread}
        onReadThread={onReadThread}
        onResumeThread={runController.resumeRunThread}
        onSendMessage={runController.sendRunMessage}
        onStopThread={runController.stopRunThread}
        projectId={projectId}
        projectFileCandidates={projectFileCandidates}
        projectFileIndexId={projectFileIndexId}
        projectFileLinkRoots={projectFileLinkRoots}
        projectRootPath={projectRootPath}
        rateLimits={rateLimits}
        thread={runController.effectiveRunThread}
        threadDocuments={threadDocuments}
        threadSavedComposerDrafts={threadSavedComposerDrafts}
      />
    ) : (
      <ThreadThreadContent
        emptyMessage="No collaborator activity was captured yet."
        flattenCompletedWork
        hideFinalAgentMessage
        hideFirstTurnTopBorder
        hideWorkbenchControlAgentMessages
        hideWorkbenchControlUserMessages
        inlineMentionSources={highlightSources}
        knownSkills={[]}
        projectFilePaths={threadViewProps.projectFilePaths}
        projectId={projectId}
        projectRoots={threadViewProps.projectRoots}
        projectRootPath={projectRootPath}
        thread={runController.effectiveRunThread}
        threadCwdPath={runController.effectiveRunThread.cwd}
      />
    )
  ) : (
    <p className="m-0 text-[0.84rem] leading-6 text-muted">{runController.shouldShowRunThreadLoading || runController.collaboratorStatus === "hydrating" ? "Loading collaborator thread..." : "Select this run to load its transcript."}</p>
  );

  const runPanel = (
    <CollaborationRunPanel
      activeRunContent={activeRunContent}
      autoWakeCountdownMs={runController.autoWakeCountdownMs}
      autoWakeEnabled={collaborationState.autoWakeEnabled}
      autoWakeProgressPercent={runController.autoWakeProgressPercent}
      canContinueSelectedRunThread={runController.canContinueSelectedRunThread}
      collaboratorComposer={runController.shouldRenderCurrentRunThread ? null : collaboratorComposer}
      collaboratorStatus={runController.collaboratorStatus}
      collaboratorStatusLabel={runController.collaboratorStatusLabel}
      error={[runController.collaboratorError, ...runController.collaboratorWarnings].filter(Boolean).join("\n")}
      isAutoWakePaused={runController.isAutoWakePaused}
      isAutoWakeToggleDisabled={runController.isAutoWakeToggleDisabled}
      isRunDisabled={runController.isRunDisabled}
      recentRunIds={runController.recentRunIds}
      selectedRunThreadId={runController.selectedRunThreadId}
      summariesById={runController.summariesById}
      onContinueSelectedRunThread={runController.continueSelectedRunThread}
      onRunNow={() => {
        void runController.startCollaboratorRun();
      }}
      onSelectRunThread={runController.selectRunThread}
      onToggleAutoRun={runController.toggleAutoRun}
    />
  );

  const threadedPanel = (
    <CollaborationThreadedView
      activeDrag={activeDragPayload}
      composerSpellCheck={composerSpellCheck}
      harness={harness}
      highlightSources={highlightSources}
      projectId={projectId}
      projectRootPath={projectRootPath}
      promptComposerDraftsByPostId={promptComposerDraftsByPostId}
      promptDraftThreadsByPostId={promptDraftThreadsByPostId}
      promptStartErrorsByPostId={promptStartErrorsByPostId}
      rateLimits={rateLimits}
      state={collaborationState}
      workspaceRoots={composerWorkspaceRoots}
      onCreatePost={handleCreatePost}
      onCreateTag={handleCreateTag}
      onDeletePost={handleDeletePost}
      onEditPost={handleEditPost}
      onEnsurePromptDraftThread={ensurePromptDraftThread}
      onMovePost={handleMovePost}
      onOpenPromptThread={onOpenThreadFromPromptPost}
      onOpenRevisionHistory={setRevisionPostId}
      onPostPointerDragStart={onPostPointerDragStart}
      onPromptDraftChange={handlePromptDraftChange}
      onPromptDraftClear={handlePromptDraftClear}
      onRemovePostTag={handleRemovePostTag}
      onSetPostCollapsed={handleSetPostCollapsed}
      onStartPromptThread={handleStartPromptThread}
      onTagPost={handleTagPost}
      onSubmitUserInputRequest={threadViewProps.onSubmitUserInputRequest}
      onThreadAgentChange={(postId, threadId, agentPath) => {
        updatePromptDraftThread(postId, threadId, (thread) => ({ ...thread, agentPath }));
      }}
      onThreadModelChange={(postId, threadId, model) => {
        updatePromptDraftThread(postId, threadId, (thread) => ({ ...thread, model }));
      }}
      onThreadQuestionnaireDraftChange={threadViewProps.onThreadQuestionnaireDraftChange}
      onThreadQuestionnaireDraftClear={threadViewProps.onThreadQuestionnaireDraftClear}
      onThreadReasoningEffortChange={(postId, threadId, reasoningEffort) => {
        updatePromptDraftThread(postId, threadId, (thread) => ({ ...thread, reasoningEffort }));
      }}
      onThreadSavedComposerDraftDelete={threadViewProps.onThreadSavedComposerDraftDelete}
      onThreadSavedComposerDraftSave={threadViewProps.onThreadSavedComposerDraftSave}
      onThreadServiceTierChange={(postId, threadId, serviceTier) => {
        updatePromptDraftThread(postId, threadId, (thread) => ({ ...thread, serviceTier }));
      }}
      onListModels={threadViewProps.onListModels}
    />
  );

  const content = isMobile ? (
    <div className="h-full min-h-0">
      <div className="flex gap-2 px-4 pt-4" role="tablist" aria-label="Collaboration panes">
        <button
          type="button"
          aria-selected={mobilePane === "scratchpad"}
          className={joinClasses(
            "rounded-lg px-3 py-2 text-[0.84rem] font-semibold transition",
            mobilePane === "scratchpad"
              ? "bg-accent-soft text-accent"
              : "text-muted hover:bg-[color-mix(in_srgb,var(--text)_4%,transparent)] hover:text-text",
          )}
          onClick={() => {
            setMobilePane("scratchpad");
          }}
        >
          Discussion
        </button>
        <button
          type="button"
          aria-selected={mobilePane === "collaborator"}
          className={joinClasses(
            "rounded-lg px-3 py-2 text-[0.84rem] font-semibold transition",
            mobilePane === "collaborator"
              ? "bg-accent-soft text-accent"
              : "text-muted hover:bg-[color-mix(in_srgb,var(--text)_4%,transparent)] hover:text-text",
          )}
          onClick={() => {
            setMobilePane("collaborator");
          }}
        >
          Collaborator
        </button>
      </div>
      {mobilePane === "scratchpad" ? (
        <section className="h-[calc(100%-3.25rem)] min-h-0 min-w-0 overflow-hidden">
          {threadedPanel}
        </section>
      ) : (
        <section className="explorer-scrollbar h-[calc(100%-3.25rem)] min-h-0 min-w-0 overflow-y-auto">
          {runPanel}
        </section>
      )}
    </div>
  ) : (
    <div className="h-full min-h-0 min-w-0">
      <WorkbenchMainLayoutView
        activeDrag={null}
        layout={collaborationLayout}
        onFocusPanel={focusCollaborationPanel}
        onLayoutChange={setAndStoreCollaborationLayout}
        onPointerDrop={() => { }}
        onSplitResize={resizeCollaborationSplit}
        renderPanel={({ isFocused, panelId, target }) => {
          if (target.kind === "collaborationScratchpad") {
            return (
              <div
                className="h-full min-h-0"
                onPointerDown={() => {
                  if (!isFocused) {
                    focusCollaborationPanel(panelId);
                  }
                }}
              >
                {threadedPanel}
              </div>
            );
          }
          if (target.kind === "collaborationCollaborator") {
            return runPanel;
          }

          return (
            <div className="flex min-h-full items-center justify-center p-6">
              <p className="m-0 text-[0.86rem] leading-6 text-muted">Collaboration panel unavailable.</p>
            </div>
          );
        }}
      />
    </div>
  );

  return (
    <>
      {content}
      <CollaborationRevisionHistoryDialog
        post={revisionPost}
        onClose={() => {
          setRevisionPostId(null);
        }}
        onRestore={(revisionId) => {
          if (revisionPost) {
            handleRestoreRevision(revisionPost.id, revisionId);
          }
        }}
      />
    </>
  );
}
