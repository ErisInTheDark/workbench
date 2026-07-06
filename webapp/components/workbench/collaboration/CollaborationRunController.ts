/*
 * Exports:
 * - CollaboratorRunStatus: lifecycle label for the collaborator run panel. Keywords: collaboration, runs, status.
 * - CollaborationRunControllerOptions: collaborators needed by the run lifecycle owner. Keywords: collaboration, controller, options.
 * - CollaborationRunControllerState: derived state and actions for the run panel and composer. Keywords: collaboration, controller, view model.
 * - default CollaborationRunController: own collaborator run selection, hydration, polling, auto-wake, drafts, and memory. Keywords: collaboration, runs, lifecycle, controller.
 */
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { UserInput } from "../../../lib/codex/generated/app-server/v2/UserInput";
import { createTextInput } from "../../../lib/codex/protocol";
import type {
  ChangeSummary,
  ThreadPayload,
  ThreadSummary,
  WorkbenchCollaborationState,
  WorkbenchControls,
  WorkbenchHarness,
  WorkbenchPendingUserInputRequest,
  WorkbenchReadThreadOptions,
  WorkbenchSendThreadMessageOptions,
  WorkbenchThreadComposerDraft,
  WorkbenchThreadDocumentSnapshot,
} from "../../../lib/types";
import {
  isCollaborationLeafPost,
  isEditableAgentLeafPost,
} from "../../../lib/workbench/collaboration/collaboration-tree-mutations";
import { WORKBENCH_COLLABORATION_AUTO_WAKE_DELAY_MS } from "../../../lib/workbench/collaboration/collaboration-registry";
import {
  writeWorkbenchCollaborationState,
} from "../../../lib/workbench/collaboration/collaboration-registry-api";
import ActiveTabRefreshLeader from "../../../lib/workbench/state/ActiveTabRefreshLeader";
import { getThreadDocumentFromSnapshot } from "../../../lib/workbench/thread/thread-document-keys";

const COLLABORATOR_THREAD_HYDRATION: WorkbenchReadThreadOptions["hydration"] = { mode: "legacyFull" };
const COLLABORATOR_THREAD_ACTIVE_REFRESH_INTERVAL_MS = 1500;
const COLLABORATOR_THREAD_IDLE_REFRESH_INTERVAL_MS = 10000;
const COLLABORATOR_WORKFLOW_IDS = ["collaborator"] as const;
const THREAD_HARNESSES: readonly WorkbenchHarness[] = ["codex", "copilot", "opencode"];

export type CollaboratorRunStatus = "failed" | "hydrating" | "idle" | "running" | "starting";

export interface CollaborationRunControllerOptions {
  collaborationState: WorkbenchCollaborationState;
  collaborationThreadSummaries: readonly ThreadSummary[];
  controls: WorkbenchControls | null;
  getCurrentCollaborationState: () => WorkbenchCollaborationState;
  harness: WorkbenchHarness;
  isProjectLoading: boolean;
  livePendingUserInputRequestsByThreadId: Record<string, WorkbenchPendingUserInputRequest>;
  onClaimAutoWake: (projectId: string, ownerId: string) => Promise<{ acquired: boolean; state: WorkbenchCollaborationState }>;
  onPauseThread: (thread: ThreadPayload) => Promise<ThreadPayload | null>;
  onReadThread: (threadId: string, harness?: WorkbenchHarness, options?: WorkbenchReadThreadOptions) => Promise<ThreadPayload | null>;
  onResumeThread: (thread: ThreadPayload) => Promise<ThreadPayload | null>;
  onSendMessage: (thread: ThreadPayload, input: UserInput[], options?: WorkbenchSendThreadMessageOptions) => Promise<ThreadPayload | null>;
  onStopThread: (thread: ThreadPayload) => Promise<ThreadPayload | null>;
  projectChanges: Record<string, ChangeSummary>;
  projectId: string;
  publishStateIfChanged: (state: WorkbenchCollaborationState) => void;
  scratchpadWritableRoot: string;
  threadDocuments: WorkbenchThreadDocumentSnapshot;
}

export interface CollaborationRunControllerState {
  autoWakeCountdownMs: number | null;
  autoWakeProgressPercent: number;
  canContinueSelectedRunThread: boolean;
  collaboratorDraftComposerDraft: WorkbenchThreadComposerDraft | null;
  collaboratorDraftThread: ThreadPayload | null;
  collaboratorError: string;
  collaboratorStatus: CollaboratorRunStatus;
  collaboratorStatusLabel: string;
  collaboratorWarnings: readonly string[];
  currentRunSummary: ThreadSummary | null;
  effectiveRunThread: ThreadPayload | null;
  isAutoWakePaused: boolean;
  isAutoWakeToggleDisabled: boolean;
  isRunDisabled: boolean;
  recentRunIds: readonly string[];
  selectedRunThreadId: string;
  shouldRenderCurrentRunThread: boolean;
  shouldShowRunThreadLoading: boolean;
  summariesById: Map<string, ThreadSummary>;
  clearCollaboratorDraft: (threadId: string) => void;
  cycleCollaboratorDraftHarness: () => void;
  recordCollaborationActivity: () => void;
  continueSelectedRunThread: () => void;
  selectRunThread: (threadId: string) => void;
  sendComposerMessage: (threadId: string, input: UserInput[]) => Promise<void>;
  sendRunMessage: (thread: ThreadPayload, input: UserInput[], options?: WorkbenchSendThreadMessageOptions) => Promise<ThreadPayload | null>;
  setCollaboratorDraftAgent: (threadId: string, agentPath: string | null) => void;
  setCollaboratorDraftComposerDraft: (threadId: string, draft: WorkbenchThreadComposerDraft) => void;
  setCollaboratorDraftModel: (threadId: string, model: string) => void;
  setCollaboratorDraftReasoningEffort: (threadId: string, reasoningEffort: string | null) => void;
  setCollaboratorDraftServiceTier: (threadId: string, serviceTier: string | null) => void;
  startCollaboratorRun: () => Promise<void>;
  stopRunThread: (thread: ThreadPayload) => Promise<ThreadPayload | null>;
  pauseRunThread: (thread: ThreadPayload) => Promise<ThreadPayload | null>;
  resumeRunThread: (thread: ThreadPayload) => Promise<ThreadPayload | null>;
  toggleAutoRun: () => void;
}

function createDraftCollaboratorThreadId(projectId: string) {
  const safeProjectId = projectId.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "project";
  return `draft:collaboration:${safeProjectId}:${Date.now()}`;
}

function isThreadStatusActive(status: string) {
  return status === "active" || status.startsWith("active:");
}

function formatProjectDiffMapForPrompt(changes: Record<string, ChangeSummary>) {
  const entries = Object.entries(changes).sort(([leftPath], [rightPath]) => leftPath.localeCompare(rightPath));
  return entries.length
    ? entries.map(([path, change]) => `- ${path}: +${change.additions} -${change.deletions}`).join("\n")
    : "No reported git changes.";
}

function formatPostForPrompt(state: WorkbenchCollaborationState, postId: string, depth = 0): string[] {
  const post = state.posts[postId];
  if (!post) {
    return [];
  }

  const indent = "  ".repeat(depth);
  const lines = [
    `${indent}- id: ${post.id}`,
    `${indent}  author: ${post.author}`,
    `${indent}  editable agent leaf: ${isEditableAgentLeafPost(state, post.id) ? "yes" : "no"}`,
    `${indent}  eligible user leaf parent: ${post.author === "user" && isCollaborationLeafPost(state, post.id) ? "yes" : "no"}`,
    `${indent}  tags: ${post.tags.length ? post.tags.join(", ") : "none"}`,
    ...(post.promptThreadId ? [`${indent}  materialized prompt thread id: ${post.promptThreadId}`] : []),
    ...(post.prompt ? [`${indent}  prompt: ${post.prompt}`] : []),
    `${indent}  body: ${post.body.replace(/\n/g, "\n" + indent + "    ")}`,
  ];
  for (const childId of post.childIds) {
    lines.push(...formatPostForPrompt(state, childId, depth + 1));
  }

  return lines;
}

function formatTreeForPrompt(state: WorkbenchCollaborationState) {
  if (!state.rootPostIds.length) {
    return "No visible posts yet.";
  }

  return state.rootPostIds.flatMap((postId) => formatPostForPrompt(state, postId)).join("\n");
}

function formatTagsForPrompt(state: WorkbenchCollaborationState) {
  return state.tags.length
    ? state.tags.map((tag) => `- ${tag}`).join("\n")
    : "No tags have been created yet.";
}

function buildCollaborationInstructionInjections({
  diffMap,
  previousMemory,
  projectId,
  state,
}: {
  diffMap: string;
  previousMemory: string;
  projectId: string;
  state: WorkbenchCollaborationState;
}) {
  const collaborationPostEndpoint = typeof window === "undefined"
    ? "/api/collaboration/posts"
    : `${window.location.origin}/api/collaboration/posts`;
  const collaborationMemoryEndpoint = typeof window === "undefined"
    ? "/api/collaboration/memory"
    : `${window.location.origin}/api/collaboration/memory`;

  return {
    "collaboration.diff-map": diffMap,
    "collaboration.memory-endpoint": collaborationMemoryEndpoint,
    "collaboration.post-endpoint": collaborationPostEndpoint,
    "collaboration.previous-memory": previousMemory || "None.",
    "collaboration.project-id": projectId,
    "collaboration.tags": formatTagsForPrompt(state),
    "collaboration.tree": formatTreeForPrompt(state),
  };
}

function applyCollaboratorDraftSettings(draftThread: ThreadPayload, settingsThread: ThreadPayload) {
  return {
    ...draftThread,
    agentPath: settingsThread.agentPath,
    model: settingsThread.model,
    reasoningEffort: settingsThread.reasoningEffort,
    serviceTier: settingsThread.harness === "codex" ? settingsThread.serviceTier : null,
  };
}

function updateDraftThread(
  threadId: string,
  setCollaboratorDraftThread: (update: (current: ThreadPayload | null) => ThreadPayload | null) => void,
  update: (thread: ThreadPayload) => ThreadPayload,
) {
  setCollaboratorDraftThread((current) => {
    if (!current || current.id !== threadId) {
      return current;
    }

    return update(current);
  });
}

export default function CollaborationRunController({
  collaborationState,
  collaborationThreadSummaries,
  controls,
  getCurrentCollaborationState,
  harness,
  isProjectLoading,
  livePendingUserInputRequestsByThreadId,
  onClaimAutoWake,
  onPauseThread,
  onReadThread,
  onResumeThread,
  onSendMessage,
  onStopThread,
  projectChanges,
  projectId,
  publishStateIfChanged,
  scratchpadWritableRoot,
  threadDocuments,
}: CollaborationRunControllerOptions): CollaborationRunControllerState {
  const [selectedRunThreadId, setSelectedRunThreadId] = useState(collaborationState.runThreadIds[0] ?? "");
  const [continuedRunThreadId, setContinuedRunThreadId] = useState("");
  const [collaboratorThread, setCollaboratorThread] = useState<ThreadPayload | null>(null);
  const [collaboratorDraftThread, setCollaboratorDraftThread] = useState<ThreadPayload | null>(null);
  const [collaboratorDraftComposerDraft, setCollaboratorDraftComposerDraftState] = useState<WorkbenchThreadComposerDraft | null>(null);
  const [collaboratorError, setCollaboratorError] = useState("");
  const [collaboratorWarnings, setCollaboratorWarnings] = useState<string[]>([]);
  const [collaboratorPhase, setCollaboratorPhase] = useState<CollaboratorRunStatus>("idle");
  const [isLoadingRunThread, setIsLoadingRunThread] = useState(false);
  const [pendingAutoWakeActivityAt, setPendingAutoWakeActivityAt] = useState<number | null>(null);
  const [autoWakeNow, setAutoWakeNow] = useState(() => Date.now());
  const [isAutoWakeLeader, setIsAutoWakeLeader] = useState(false);
  const collaboratorDraftProjectIdRef = useRef(projectId);
  const hydrationGenerationRef = useRef(0);
  const isSendingControlPromptRef = useRef(false);
  const ownerIdRef = useRef(`collaboration:${projectId}:${Math.random().toString(36).slice(2)}`);

  const summariesById = useMemo(() => new Map(collaborationThreadSummaries.map((summary) => [summary.id, summary])), [collaborationThreadSummaries]);
  const runThreadIds = collaborationState.runThreadIds;
  const runThreadIdSignature = runThreadIds.join("\0");
  const projectDiffMap = useMemo(() => formatProjectDiffMapForPrompt(projectChanges), [projectChanges]);
  const snapshotRunThread = selectedRunThreadId ? getThreadDocumentFromSnapshot(threadDocuments, selectedRunThreadId) : null;
  const effectiveRunThread = snapshotRunThread ?? collaboratorThread;
  const currentRunSummary = selectedRunThreadId ? summariesById.get(selectedRunThreadId) ?? null : null;
  const currentRunPendingUserInputRequest = selectedRunThreadId
    ? livePendingUserInputRequestsByThreadId[selectedRunThreadId] ?? null
    : null;
  const selectedRunIsReallyActive = Boolean(
    effectiveRunThread
    && effectiveRunThread.id === selectedRunThreadId
    && (
      isThreadStatusActive(effectiveRunThread.status)
      || Boolean(currentRunSummary && isThreadStatusActive(currentRunSummary.status))
      || Boolean(currentRunPendingUserInputRequest)
    ),
  );
  const selectedRunIsContinued = Boolean(
    continuedRunThreadId
    && continuedRunThreadId === selectedRunThreadId
    && effectiveRunThread
    && effectiveRunThread.id === selectedRunThreadId,
  );
  const selectedRunIsActive = selectedRunIsReallyActive || selectedRunIsContinued;
  const canContinueSelectedRunThread = Boolean(
    effectiveRunThread
    && effectiveRunThread.id === selectedRunThreadId
    && !selectedRunIsActive,
  );
  const shouldRenderCurrentRunThread = selectedRunIsActive;
  const shouldShowRunThreadLoading = Boolean(
    isLoadingRunThread
    && selectedRunThreadId
    && !shouldRenderCurrentRunThread
    && (
      currentRunPendingUserInputRequest
      || (currentRunSummary && isThreadStatusActive(currentRunSummary.status))
    ),
  );
  const collaboratorDraftHasContent = Boolean(collaboratorDraftComposerDraft?.text.trim() || collaboratorDraftComposerDraft?.attachments.length);
  const autoWakeCountdownMs = pendingAutoWakeActivityAt === null
    ? null
    : Math.max(0, pendingAutoWakeActivityAt + WORKBENCH_COLLABORATION_AUTO_WAKE_DELAY_MS - autoWakeNow);
  const autoWakeProgressPercent = autoWakeCountdownMs === null
    ? 0
    : ((WORKBENCH_COLLABORATION_AUTO_WAKE_DELAY_MS - autoWakeCountdownMs) / WORKBENCH_COLLABORATION_AUTO_WAKE_DELAY_MS) * 100;
  const isAutoWakePaused = collaborationState.autoWakeEnabled && collaboratorDraftHasContent;
  const isAutoWakeToggleDisabled = !controls || (!collaborationState.autoWakeEnabled && collaboratorDraftHasContent);
  const collaboratorStatus: CollaboratorRunStatus = collaboratorPhase === "idle" && selectedRunIsActive
    ? "running"
    : collaboratorPhase;
  const collaboratorStatusLabel = isAutoWakePaused
    ? "Auto-run is paused while the collaborator note has unsent text."
    : collaboratorStatus === "starting"
      ? "Starting collaborator run..."
      : collaboratorStatus === "running"
        ? "Collaborator run is active."
        : collaboratorStatus === "hydrating"
          ? "Loading collaborator thread..."
          : collaboratorStatus === "failed"
            ? "Collaborator needs attention."
            : runThreadIds.length
              ? "Ready to continue maintaining the discussion tree."
              : "Start the collaborator when you want it to read the discussion and project state.";

  useEffect(() => {
    setSelectedRunThreadId((current) => current && runThreadIds.includes(current)
      ? current
      : runThreadIds[0] || "");
  }, [runThreadIdSignature]);

  useEffect(() => {
    if (continuedRunThreadId && continuedRunThreadId !== selectedRunThreadId) {
      setContinuedRunThreadId("");
    }
  }, [continuedRunThreadId, selectedRunThreadId]);

  useEffect(() => {
    if (selectedRunIsReallyActive && continuedRunThreadId === selectedRunThreadId) {
      setContinuedRunThreadId("");
    }
  }, [continuedRunThreadId, selectedRunIsReallyActive, selectedRunThreadId]);

  useEffect(() => {
    if (!collaborationState.autoWakeEnabled || pendingAutoWakeActivityAt === null) {
      return;
    }

    const interval = window.setInterval(() => {
      setAutoWakeNow(Date.now());
    }, 1000);
    return () => {
      window.clearInterval(interval);
    };
  }, [collaborationState.autoWakeEnabled, pendingAutoWakeActivityAt]);

  useEffect(() => {
    if (!selectedRunThreadId || !isThreadStatusActive(effectiveRunThread?.status ?? "")) {
      return;
    }

    const interval = window.setInterval(() => {
      void onReadThread(selectedRunThreadId, undefined, { hydration: COLLABORATOR_THREAD_HYDRATION });
    }, COLLABORATOR_THREAD_ACTIVE_REFRESH_INTERVAL_MS);
    return () => {
      window.clearInterval(interval);
    };
  }, [effectiveRunThread?.status, onReadThread, selectedRunThreadId]);

  useEffect(() => {
    if (!selectedRunThreadId || isThreadStatusActive(effectiveRunThread?.status ?? "")) {
      return;
    }

    const interval = window.setInterval(() => {
      void onReadThread(selectedRunThreadId, undefined, { hydration: COLLABORATOR_THREAD_HYDRATION });
    }, COLLABORATOR_THREAD_IDLE_REFRESH_INTERVAL_MS);
    return () => {
      window.clearInterval(interval);
    };
  }, [effectiveRunThread?.status, onReadThread, selectedRunThreadId]);

  const rememberCollaboratorThread = useCallback((thread: ThreadPayload, options: { replaceThreadId?: string } = {}) => {
    const currentState = getCurrentCollaborationState();
    const runThreadIds = [
      thread.id,
      ...currentState.runThreadIds.filter((threadId) => threadId !== thread.id && threadId !== options.replaceThreadId),
    ];
    publishStateIfChanged({
      ...currentState,
      runThreadIds,
    });
    setSelectedRunThreadId(thread.id);
  }, [getCurrentCollaborationState, publishStateIfChanged]);

  const hydrateCollaboratorThread = useCallback(async (threadId: string, options: { showLoading?: boolean; showMissingError?: boolean } = {}) => {
    if (!threadId || threadId.startsWith("draft:")) {
      return null;
    }

    const generation = ++hydrationGenerationRef.current;
    if (options.showLoading !== false) {
      setIsLoadingRunThread(true);
    }
    setCollaboratorError("");

    const payload = await onReadThread(threadId, undefined, {
      hydration: COLLABORATOR_THREAD_HYDRATION,
    }).catch((error) => {
      if (options.showMissingError !== false && hydrationGenerationRef.current === generation) {
        setCollaboratorError(error instanceof Error ? error.message : "Unable to read this collaborator thread.");
      }
      return null;
    });

    if (hydrationGenerationRef.current !== generation) {
      return null;
    }

    setIsLoadingRunThread(false);
    if (payload) {
      setCollaboratorThread(payload);
      setCollaboratorPhase("idle");
      return payload;
    }

    if (options.showMissingError !== false) {
      setCollaboratorPhase("failed");
      setCollaboratorError("The collaborator thread started, but its saved history is still unavailable.");
    }
    return null;
  }, [onReadThread]);

  useEffect(() => {
    if (!selectedRunThreadId) {
      setCollaboratorThread(null);
      return;
    }

    if (selectedRunThreadId.startsWith("draft:")) {
      return;
    }

    if (effectiveRunThread?.id === selectedRunThreadId) {
      return;
    }

    void hydrateCollaboratorThread(selectedRunThreadId);

    return () => {
      hydrationGenerationRef.current += 1;
    };
  }, [effectiveRunThread?.id, hydrateCollaboratorThread, selectedRunThreadId]);

  const createCollaboratorDraftThread = useCallback((settingsThread?: ThreadPayload | null) => {
    if (!controls) {
      return null;
    }

    const draft = controls.createThreadDraft(settingsThread?.harness ?? harness, {
      select: false,
      threadId: createDraftCollaboratorThreadId(projectId),
    });
    collaboratorDraftProjectIdRef.current = projectId;
    return settingsThread ? applyCollaboratorDraftSettings(draft, settingsThread) : draft;
  }, [controls, harness, projectId]);

  useEffect(() => {
    if (!controls) {
      setCollaboratorDraftThread(null);
      setCollaboratorDraftComposerDraftState(null);
      return;
    }

    if (collaboratorDraftProjectIdRef.current !== projectId) {
      setCollaboratorDraftComposerDraftState(null);
    }
    setCollaboratorDraftThread((current) => current && collaboratorDraftProjectIdRef.current === projectId
      ? current
      : createCollaboratorDraftThread());
  }, [controls, createCollaboratorDraftThread, projectId]);

  const sendCollaboratorRun = useCallback(async (
    thread: ThreadPayload,
    options: {
      additionalInput?: UserInput[];
      replaceThreadId?: string;
      throwOnError?: boolean;
    } = {},
  ) => {
    if (isSendingControlPromptRef.current) {
      return thread;
    }

    isSendingControlPromptRef.current = true;
    let stateForPrompt = getCurrentCollaborationState();
    try {
      stateForPrompt = await writeWorkbenchCollaborationState(projectId, stateForPrompt);
      publishStateIfChanged(stateForPrompt);
    } catch (error) {
      setCollaboratorWarnings([error instanceof Error
        ? `Unable to sync Collaboration state before the run: ${error.message}`
        : "Unable to sync Collaboration state before the run."]);
    }

    const instructionInjections = buildCollaborationInstructionInjections({
      diffMap: projectDiffMap,
      previousMemory: stateForPrompt.lastRunMemory,
      projectId,
      state: stateForPrompt,
    });
    const input = options.additionalInput?.length
      ? options.additionalInput
      : [createTextInput("Run the collaborator workflow with the injected Collaboration context.")];
    const sendOptions: WorkbenchSendThreadMessageOptions = {
      additionalWritableRoots: scratchpadWritableRoot ? [scratchpadWritableRoot] : [],
      instructionInjections,
      onThreadMaterialized: (materializedThread) => {
        rememberCollaboratorThread(materializedThread, { replaceThreadId: options.replaceThreadId });
        setCollaboratorPhase("hydrating");
        void hydrateCollaboratorThread(materializedThread.id, {
          showLoading: false,
          showMissingError: false,
        });
      },
      selectThread: false,
      workflowIds: [...COLLABORATOR_WORKFLOW_IDS],
    };

    setCollaboratorPhase("running");
    setCollaboratorError("");
    try {
      const sentThread = await onSendMessage(thread, input, sendOptions);
      if (sentThread) {
        rememberCollaboratorThread(sentThread, { replaceThreadId: options.replaceThreadId });
        setCollaboratorPhase("idle");
        return sentThread;
      }
      if (!thread.isDraft) {
        void hydrateCollaboratorThread(thread.id, {
          showLoading: false,
          showMissingError: false,
        });
      }
      setCollaboratorPhase("idle");
      return thread;
    } catch (error) {
      setCollaboratorPhase("failed");
      const message = error instanceof Error ? error.message : "Unable to start the collaborator run.";
      setCollaboratorError(message);
      if (options.throwOnError) {
        throw error;
      }
      return thread;
    } finally {
      isSendingControlPromptRef.current = false;
    }
  }, [getCurrentCollaborationState, hydrateCollaboratorThread, onSendMessage, projectDiffMap, projectId, publishStateIfChanged, rememberCollaboratorThread, scratchpadWritableRoot]);

  const startCollaboratorRun = useCallback(async () => {
    if (!controls) {
      setCollaboratorError("Workbench controls are not ready.");
      return;
    }

    const settingsThread = collaboratorDraftThread ?? createCollaboratorDraftThread();
    if (!settingsThread) {
      setCollaboratorError("Collaborator draft is not ready.");
      return;
    }

    const draftThread = createCollaboratorDraftThread(settingsThread);
    if (!draftThread) {
      setCollaboratorError("Collaborator draft is not ready.");
      return;
    }

    setCollaboratorPhase("starting");
    rememberCollaboratorThread(draftThread);
    const result = await sendCollaboratorRun(draftThread, { replaceThreadId: draftThread.id });
    if (result.id !== draftThread.id || !result.isDraft) {
      setCollaboratorDraftThread(createCollaboratorDraftThread(settingsThread));
      setCollaboratorDraftComposerDraftState(null);
    }
  }, [collaboratorDraftThread, controls, createCollaboratorDraftThread, rememberCollaboratorThread, sendCollaboratorRun]);

  useEffect(() => {
    const leader = new ActiveTabRefreshLeader({
      onLeadershipChange: setIsAutoWakeLeader,
      storageKey: "workbench-collaboration-auto-wake",
    });
    return () => {
      leader.dispose();
    };
  }, []);

  useEffect(() => {
    if (!collaborationState.autoWakeEnabled || !isAutoWakeLeader || pendingAutoWakeActivityAt === null || collaboratorDraftHasContent) {
      return;
    }

    const delay = pendingAutoWakeActivityAt + WORKBENCH_COLLABORATION_AUTO_WAKE_DELAY_MS - Date.now();
    if (delay > 0) {
      const timeout = window.setTimeout(() => {
        setAutoWakeNow(Date.now());
      }, delay);
      return () => {
        window.clearTimeout(timeout);
      };
    }

    let cancelled = false;
    void onClaimAutoWake(projectId, ownerIdRef.current)
      .then(async (result) => {
        if (cancelled) {
          return;
        }
        publishStateIfChanged(result.state);
        if (result.acquired) {
          setPendingAutoWakeActivityAt(null);
          await startCollaboratorRun();
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setCollaboratorError(error instanceof Error ? error.message : "Unable to claim Collaboration auto-run.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [collaborationState.autoWakeEnabled, collaboratorDraftHasContent, isAutoWakeLeader, onClaimAutoWake, pendingAutoWakeActivityAt, projectId, publishStateIfChanged, startCollaboratorRun]);

  const selectRunThread = useCallback((threadId: string) => {
    if (threadId !== selectedRunThreadId) {
      setContinuedRunThreadId("");
    }
    setSelectedRunThreadId(threadId);
    if (!threadId.startsWith("draft:")) {
      setCollaboratorPhase("hydrating");
      void hydrateCollaboratorThread(threadId);
    }
  }, [hydrateCollaboratorThread, selectedRunThreadId]);

  const continueSelectedRunThread = useCallback(() => {
    if (!canContinueSelectedRunThread || !selectedRunThreadId) {
      return;
    }

    setContinuedRunThreadId(selectedRunThreadId);
    setCollaboratorPhase("idle");
  }, [canContinueSelectedRunThread, selectedRunThreadId]);

  const toggleAutoRun = useCallback(() => {
    const currentState = getCurrentCollaborationState();
    publishStateIfChanged({
      ...currentState,
      autoWakeEnabled: !currentState.autoWakeEnabled,
    });
    setPendingAutoWakeActivityAt(Date.now());
  }, [getCurrentCollaborationState, publishStateIfChanged]);

  const recordCollaborationActivity = useCallback(() => {
    setPendingAutoWakeActivityAt(Date.now());
  }, []);

  const cycleCollaboratorDraftHarness = useCallback(() => {
    if (!controls) {
      return;
    }

    setCollaboratorDraftThread((current) => {
      const currentHarness = current?.harness ?? harness;
      const currentIndex = THREAD_HARNESSES.indexOf(currentHarness);
      const nextHarness = THREAD_HARNESSES[(currentIndex + 1) % THREAD_HARNESSES.length] ?? "codex";
      collaboratorDraftProjectIdRef.current = projectId;
      return controls.createThreadDraft(nextHarness, {
        select: false,
        threadId: createDraftCollaboratorThreadId(projectId),
      });
    });
  }, [controls, harness, projectId]);

  const sendComposerMessage = useCallback(async (threadId: string, input: UserInput[]) => {
    if (!collaboratorDraftThread || threadId !== collaboratorDraftThread.id) {
      throw new Error("Collaborator draft is not ready.");
    }

    const draftThread = createCollaboratorDraftThread(collaboratorDraftThread);
    if (!draftThread) {
      throw new Error("Collaborator draft is not ready.");
    }

    rememberCollaboratorThread(draftThread);
    await sendCollaboratorRun(draftThread, {
      additionalInput: input,
      replaceThreadId: draftThread.id,
      throwOnError: true,
    });
    setCollaboratorDraftThread(createCollaboratorDraftThread(collaboratorDraftThread));
    setCollaboratorDraftComposerDraftState(null);
  }, [collaboratorDraftThread, createCollaboratorDraftThread, rememberCollaboratorThread, sendCollaboratorRun]);

  const sendRunMessage = useCallback(async (
    thread: ThreadPayload,
    input: UserInput[],
    options?: WorkbenchSendThreadMessageOptions,
  ) => {
    const payload = await onSendMessage(thread, input, {
      ...options,
      selectThread: false,
    });
    if (payload) {
      rememberCollaboratorThread(payload);
      setCollaboratorPhase("idle");
    }
    return payload;
  }, [onSendMessage, rememberCollaboratorThread]);

  const stopRunThread = useCallback(async (thread: ThreadPayload) => {
    const payload = await onStopThread(thread);
    if (payload) {
      rememberCollaboratorThread(payload);
      setCollaboratorPhase("idle");
    }
    return payload;
  }, [onStopThread, rememberCollaboratorThread]);

  const pauseRunThread = useCallback(async (thread: ThreadPayload) => {
    const payload = await onPauseThread(thread);
    if (payload) {
      rememberCollaboratorThread(payload);
      setCollaboratorPhase("idle");
    }
    return payload;
  }, [onPauseThread, rememberCollaboratorThread]);

  const resumeRunThread = useCallback(async (thread: ThreadPayload) => {
    const payload = await onResumeThread(thread);
    if (payload) {
      rememberCollaboratorThread(payload);
      setCollaboratorPhase("idle");
    }
    return payload;
  }, [onResumeThread, rememberCollaboratorThread]);

  return {
    autoWakeCountdownMs,
    autoWakeProgressPercent,
    canContinueSelectedRunThread,
    collaboratorDraftComposerDraft,
    collaboratorDraftThread,
    collaboratorError,
    collaboratorStatus,
    collaboratorStatusLabel,
    collaboratorWarnings,
    currentRunSummary,
    effectiveRunThread,
    isAutoWakePaused,
    isAutoWakeToggleDisabled,
    isRunDisabled: !controls || isProjectLoading,
    recentRunIds: runThreadIds,
    selectedRunThreadId,
    shouldRenderCurrentRunThread,
    shouldShowRunThreadLoading,
    summariesById,
    clearCollaboratorDraft: (threadId) => {
      if (threadId !== collaboratorDraftThread?.id) {
        return;
      }
      setCollaboratorDraftComposerDraftState(null);
    },
    cycleCollaboratorDraftHarness,
    continueSelectedRunThread,
    pauseRunThread,
    recordCollaborationActivity,
    resumeRunThread,
    selectRunThread,
    sendComposerMessage,
    sendRunMessage,
    setCollaboratorDraftAgent: (threadId, agentPath) => {
      updateDraftThread(threadId, setCollaboratorDraftThread, (thread) => ({ ...thread, agentPath }));
    },
    setCollaboratorDraftComposerDraft: (threadId, draft) => {
      if (threadId !== collaboratorDraftThread?.id) {
        return;
      }
      setCollaboratorDraftComposerDraftState(draft);
    },
    setCollaboratorDraftModel: (threadId, model) => {
      updateDraftThread(threadId, setCollaboratorDraftThread, (thread) => ({ ...thread, model }));
    },
    setCollaboratorDraftReasoningEffort: (threadId, reasoningEffort) => {
      updateDraftThread(threadId, setCollaboratorDraftThread, (thread) => ({ ...thread, reasoningEffort }));
    },
    setCollaboratorDraftServiceTier: (threadId, serviceTier) => {
      updateDraftThread(threadId, setCollaboratorDraftThread, (thread) => ({ ...thread, serviceTier }));
    },
    startCollaboratorRun,
    stopRunThread,
    toggleAutoRun,
  };
}
