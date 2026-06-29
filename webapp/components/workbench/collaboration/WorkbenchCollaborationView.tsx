/*
 * Exports:
 * - default WorkbenchCollaborationView: own threaded Collaboration state, collaborator runs, prompt materialization, and tree UI wiring. Keywords: collaboration, threaded, posts, runs.
 * - Local helpers: format tree context, create collaborator drafts, and coordinate run patch application. Keywords: collaboration, prompt, patches, auto-wake.
 */
"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps, type PointerEvent as ReactPointerEvent } from "react";

import type { UserInput } from "../../../lib/codex/generated/app-server/v2/UserInput";
import { createTextInput } from "../../../lib/codex/protocol";
import type {
  ChangeSummary,
  ThreadPayload,
  ThreadSummary,
  WorkbenchCollaborationPost,
  WorkbenchCollaborationState,
  WorkbenchControls,
  WorkbenchHarness,
  WorkbenchSendThreadMessageOptions,
  WorkbenchThreadComposerDraft,
} from "../../../lib/types";
import {
  COLLABORATION_IMPORTED_SCRATCHPAD_POST_ID,
  ensureImportedScratchpadPost,
  normalizeWorkbenchCollaborationState,
} from "../../../lib/workbench/collaboration/collaboration-state";
import {
  readStoredWorkbenchCollaborationLayout,
  writeStoredWorkbenchCollaborationLayout,
} from "../../../lib/workbench/collaboration/collaboration-layout";
import { WORKBENCH_COLLABORATION_AUTO_WAKE_DELAY_MS } from "../../../lib/workbench/collaboration/collaboration-registry";
import {
  applyWorkbenchCollaborationPostPatch,
  findWorkbenchCollaborationPostPatch,
} from "../../../lib/workbench/collaboration/collaboration-post-patches";
import {
  createCollaborationPost,
  deleteCollaborationSubtree,
  isCollaborationLeafPost,
  isEditableAgentLeafPost,
  moveCollaborationPost,
  restoreCollaborationPostRevision,
  updateCollaborationPost,
  type CollaborationPostDropIntent,
  type WorkbenchCollaborationPostDraft,
} from "../../../lib/workbench/collaboration/collaboration-tree-mutations";
import { areDeeplyEqual } from "../../../lib/workbench/deep-equality";
import type { WorkbenchDragPayload } from "../../../lib/workbench/layout/workbench-drag";
import ActiveTabRefreshLeader from "../../../lib/workbench/state/ActiveTabRefreshLeader";
import {
  buildInlineMentionCandidates,
} from "../../../lib/workbench/thread/inline-mention-highlights";
import { getThreadDocumentFromSnapshot } from "../../../lib/workbench/thread/thread-document-keys";
import { WORKBENCH_FILE_LINK_INSTRUCTIONS } from "../../../lib/workbench/thread/workbench-file-link-instructions";
import WorkbenchMainLayout from "../../../lib/workbench/layout/workbench-layout";
import WorkbenchMainLayoutView from "../layout/WorkbenchMainLayoutView";
import { ThreadThreadContent } from "../thread-view/thread-view-items";
import ThreadComposer from "../thread-view/ThreadComposer";
import ThreadRateLimits from "../thread-view/ThreadRateLimits";
import ThreadView from "../thread-view/ThreadView";
import CollaborationRevisionHistoryDialog from "./CollaborationRevisionHistoryDialog";
import CollaborationRunPanel from "./CollaborationRunPanel";
import CollaborationThreadedView from "./CollaborationThreadedView";

type ThreadViewProps = ComponentProps<typeof ThreadView>;

const COLLABORATOR_THREAD_HYDRATION = { mode: "legacyFull" as const };
const COLLABORATOR_THREAD_ACTIVE_REFRESH_INTERVAL_MS = 1500;
const COLLABORATOR_THREAD_IDLE_REFRESH_INTERVAL_MS = 10000;
const THREAD_HARNESSES: readonly WorkbenchHarness[] = ["codex", "copilot", "opencode"];

type CollaboratorRunStatus = "failed" | "hydrating" | "idle" | "running" | "starting";

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
  onCollaborationStateChange: (state: WorkbenchCollaborationState) => void;
  onOpenThreadFromPromptPost: (threadId: string) => void;
  onPointerDrop: () => void;
  onPostPointerDragStart: (event: ReactPointerEvent<HTMLElement>, post: WorkbenchCollaborationPost) => void;
  onStartThreadFromPrompt: (input: UserInput[], thread: ThreadPayload) => Promise<WorkbenchCollaborationPromptStartResult>;
  projectChanges: Record<string, ChangeSummary>;
  projectId: string;
  scratchpadPath: string;
  scratchpadWritableRoot: string;
}

function createDraftCollaboratorThreadId(projectId: string) {
  const safeProjectId = projectId.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "project";
  return `draft:collaboration:${safeProjectId}:${Date.now()}`;
}

function createPromptDraftThreadId(projectId: string, postId: string) {
  const safeProjectId = projectId.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "project";
  const safePostId = postId.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "post";
  return `draft:collaboration-prompt:${safeProjectId}:${safePostId}`;
}

function isThreadStatusActive(status: string) {
  return status === "active" || status.startsWith("active:");
}

function getPromptTextFromInput(input: readonly UserInput[]) {
  return input
    .flatMap((entry) => entry.type === "text" ? [entry.text] : [])
    .join("\n")
    .trim();
}

function formatProjectDiffMapForPrompt(changes: Record<string, ChangeSummary>) {
  const entries = Object.entries(changes).sort(([leftPath], [rightPath]) => leftPath.localeCompare(rightPath));
  return entries.length
    ? entries.map(([path, change]) => `- ${path}: +${change.additions} -${change.deletions}`).join("\n")
    : "No reported git changes.";
}

function formatFileLinkingInfoForPrompt(workspaceRoots: readonly { id: string; openPathMode?: string; rootPath: string }[]) {
  const rootLines = workspaceRoots.length
    ? workspaceRoots.map((root) => `- ${root.id}: ${root.rootPath}${root.openPathMode ? ` (${root.openPathMode})` : ""}`).join("\n")
    : "- single-root project: use project-relative paths";

  return [
    WORKBENCH_FILE_LINK_INSTRUCTIONS,
    "Available file-link roots:",
    rootLines,
  ].join("\n");
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

function buildCollaboratorControlPrompt({
  additionalUserMessage,
  diffMap,
  fileLinkingInfo,
  mode,
  previousSummary,
  scratchpadPath,
  state,
}: {
  additionalUserMessage?: string;
  diffMap: string;
  fileLinkingInfo: string;
  mode: "bootstrap" | "wake";
  previousSummary: string;
  scratchpadPath: string;
  state: WorkbenchCollaborationState;
}) {
  return `<!-- workbench-collaboration-control -->
${additionalUserMessage ? `
Additional user message:
${additionalUserMessage}
` : ""}

Mode: ${mode}.
Former scratchpad path, if this project still references old notes: ${scratchpadPath}

Previous private Workbench summary:
${previousSummary || "None."}

Current git diff map:
${diffMap}

Workbench file-linking information:
${fileLinkingInfo}

Current Workbench-owned threaded discussion tree:
${formatTreeForPrompt(state)}

Threaded Collaboration rules:

* Workbench owns the visible discussion tree. Real agent transcripts are run records, not the editable source of truth for posts.
* You receive the latest visible post version only. Do not assume revision history.
* You may create new agent posts only under user-authored leaf posts marked as eligible user leaf parents.
* You may edit or null-delete only agent-authored leaf posts marked as editable agent leaves.
* Once a user replies under an agent post, that agent post is no longer editable by you.
* Prompt-bearing posts are local thread suggestions. Use \`prompt\` only when starting a normal Workbench thread would be useful.
* Keep useful context in the post body. Use \`prompt\` for the dedicated thread prompt only.
* If nothing useful should change, return an empty \`posts\` object and a summary.

Return valid JSON only. Do not include markdown fences, comments, explanations, or trailing commas.

\`\`\`ts
interface WorkbenchCollaborationResponse {
  summary: string;
  posts: Record<string, WorkbenchCollaborationPostPatch | null>;
}

interface WorkbenchCollaborationPostPatch {
  parentId?: string;
  body: string;
  prompt?: string;
}
\`\`\`

Examples:

{"summary":"Created one reply.","posts":{"agent-follow-up":{"parentId":"some-user-leaf","body":"This is the collaborator reply."}}}
{"summary":"Updated one current leaf.","posts":{"agent-existing-leaf":{"body":"Updated latest text."}}}
{"summary":"Removed an obsolete leaf.","posts":{"agent-obsolete-leaf":null}}
`;
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
  const [selectedRunThreadId, setSelectedRunThreadId] = useState(collaborationState.runThreadIds[0] ?? "");
  const [collaboratorThread, setCollaboratorThread] = useState<ThreadPayload | null>(null);
  const [collaboratorDraftThread, setCollaboratorDraftThread] = useState<ThreadPayload | null>(null);
  const [collaboratorDraftComposerDraft, setCollaboratorDraftComposerDraft] = useState<WorkbenchThreadComposerDraft | null>(null);
  const [promptDraftThreadsByPostId, setPromptDraftThreadsByPostId] = useState<Record<string, ThreadPayload | undefined>>({});
  const [promptComposerDraftsByPostId, setPromptComposerDraftsByPostId] = useState<Record<string, WorkbenchThreadComposerDraft | undefined>>({});
  const [promptStartErrorsByPostId, setPromptStartErrorsByPostId] = useState<Record<string, string | undefined>>({});
  const [collaboratorError, setCollaboratorError] = useState("");
  const [collaboratorWarnings, setCollaboratorWarnings] = useState<string[]>([]);
  const [collaboratorStatus, setCollaboratorStatus] = useState<CollaboratorRunStatus>("idle");
  const [isLoadingRunThread, setIsLoadingRunThread] = useState(false);
  const [mobilePane, setMobilePane] = useState<"scratchpad" | "collaborator">("scratchpad");
  const [collaborationLayout, setCollaborationLayout] = useState(() => readStoredWorkbenchCollaborationLayout(projectId));
  const [pendingAutoWakeActivityAt, setPendingAutoWakeActivityAt] = useState<number | null>(null);
  const [autoWakeNow, setAutoWakeNow] = useState(() => Date.now());
  const [isAutoWakeLeader, setIsAutoWakeLeader] = useState(false);
  const [revisionPostId, setRevisionPostId] = useState<string | null>(null);
  const stateRef = useRef(normalizeWorkbenchCollaborationState(collaborationState));
  const attemptedScratchpadImportKeyRef = useRef("");
  const collaboratorDraftProjectIdRef = useRef(projectId);
  const hydrationGenerationRef = useRef(0);
  const isSendingControlPromptRef = useRef(false);
  const ownerIdRef = useRef(`collaboration:${projectId}:${Math.random().toString(36).slice(2)}`);

  useEffect(() => {
    stateRef.current = normalizeWorkbenchCollaborationState(collaborationState);
  }, [collaborationState]);

  useEffect(() => {
    setCollaborationLayout(readStoredWorkbenchCollaborationLayout(projectId));
    setPromptDraftThreadsByPostId({});
    setPromptComposerDraftsByPostId({});
    setPromptStartErrorsByPostId({});
  }, [projectId]);

  useEffect(() => {
    setSelectedRunThreadId((current) => current && collaborationState.runThreadIds.includes(current)
      ? current
      : collaborationState.runThreadIds[0] || "");
  }, [collaborationState.runThreadIds]);

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

  const summariesById = useMemo(() => new Map(collaborationThreadSummaries.map((summary) => [summary.id, summary])), [collaborationThreadSummaries]);
  const activeDragPayload = activeDrag?.payload ?? null;
  const composerWorkspaceRoots = projectFileLinkRoots ?? [];
  const highlightSources = useMemo(() => buildInlineMentionCandidates({
    files: projectFileCandidates,
    filesIdentity: projectFileIndexId,
    projectRootPath,
    skills: [],
    workspaceRoots: composerWorkspaceRoots,
  }), [composerWorkspaceRoots, projectFileCandidates, projectFileIndexId, projectRootPath]);
  const projectDiffMap = useMemo(() => formatProjectDiffMapForPrompt(projectChanges), [projectChanges]);
  const fileLinkingInfo = useMemo(() => formatFileLinkingInfoForPrompt(projectFileLinkRoots ?? []), [projectFileLinkRoots]);
  const snapshotRunThread = selectedRunThreadId ? getThreadDocumentFromSnapshot(threadDocuments, selectedRunThreadId) : null;
  const effectiveRunThread = snapshotRunThread ?? collaboratorThread;
  const currentRunSummary = selectedRunThreadId ? summariesById.get(selectedRunThreadId) ?? null : null;
  const currentRunPendingUserInputRequest = selectedRunThreadId
    ? threadViewProps.livePendingUserInputRequestsByThreadId[selectedRunThreadId] ?? null
    : null;
  const shouldRenderCurrentRunThread = Boolean(
    effectiveRunThread
    && effectiveRunThread.id === selectedRunThreadId
    && (
      isThreadStatusActive(effectiveRunThread.status)
      || Boolean(currentRunSummary && isThreadStatusActive(currentRunSummary.status))
      || Boolean(currentRunPendingUserInputRequest)
    ),
  );
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
            : collaborationState.runThreadIds.length
              ? "Ready to continue maintaining the discussion tree."
              : "Start the collaborator when you want it to read the discussion and project state.";
  const revisionPost = revisionPostId ? collaborationState.posts[revisionPostId] ?? null : null;

  const publishStateIfChanged = useCallback((nextState: WorkbenchCollaborationState) => {
    const normalizedState = normalizeWorkbenchCollaborationState(nextState);
    if (areDeeplyEqual(stateRef.current, normalizedState)) {
      return;
    }

    stateRef.current = normalizedState;
    onCollaborationStateChange(normalizedState);
  }, [onCollaborationStateChange]);

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
    for (const runThreadId of collaborationState.runThreadIds) {
      const thread = getThreadDocumentFromSnapshot(threadDocuments, runThreadId);
      const patch = thread ? findWorkbenchCollaborationPostPatch(thread) : null;
      if (!patch || patch.signature === collaborationState.lastAppliedPostPatchSignature) {
        continue;
      }

      const result = applyWorkbenchCollaborationPostPatch(collaborationState, patch);
      setCollaboratorWarnings(result.warnings);
      publishStateIfChanged(result.state);
      break;
    }
  }, [collaborationState, publishStateIfChanged, threadDocuments]);

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
    const runThreadIds = [
      thread.id,
      ...stateRef.current.runThreadIds.filter((threadId) => threadId !== thread.id && threadId !== options.replaceThreadId),
    ];
    publishStateIfChanged({
      ...stateRef.current,
      runThreadIds,
    });
    setSelectedRunThreadId(thread.id);
  }, [publishStateIfChanged]);

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
      setCollaboratorStatus(isThreadStatusActive(payload.status) ? "running" : "idle");
      return payload;
    }

    if (options.showMissingError !== false) {
      setCollaboratorStatus("failed");
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
      setCollaboratorDraftComposerDraft(null);
      return;
    }

    if (collaboratorDraftProjectIdRef.current !== projectId) {
      setCollaboratorDraftComposerDraft(null);
    }
    setCollaboratorDraftThread((current) => current && collaboratorDraftProjectIdRef.current === projectId
      ? current
      : createCollaboratorDraftThread());
  }, [controls, createCollaboratorDraftThread, projectId]);

  const sendControlPrompt = useCallback(async (
    thread: ThreadPayload,
    mode: "bootstrap" | "wake",
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
    const additionalUserMessage = options.additionalInput
      ?.flatMap((input) => input.type === "text" ? [input.text] : [])
      .join("\n")
      .trim();
    const prompt = buildCollaboratorControlPrompt({
      additionalUserMessage,
      diffMap: projectDiffMap,
      fileLinkingInfo,
      mode,
      previousSummary: stateRef.current.lastRunSummary,
      scratchpadPath,
      state: stateRef.current,
    });
    const input = [
      createTextInput(prompt),
      ...(options.additionalInput ?? []).filter((entry) => entry.type !== "text"),
    ];
    const sendOptions: WorkbenchSendThreadMessageOptions = {
      additionalWritableRoots: scratchpadWritableRoot ? [scratchpadWritableRoot] : [],
      onThreadMaterialized: (materializedThread) => {
        rememberCollaboratorThread(materializedThread, { replaceThreadId: options.replaceThreadId });
        setCollaboratorStatus("hydrating");
        void hydrateCollaboratorThread(materializedThread.id, {
          showLoading: false,
          showMissingError: false,
        });
      },
      selectThread: false,
    };

    setCollaboratorStatus("running");
    setCollaboratorError("");
    try {
      const sentThread = await onSendMessage(thread, input, sendOptions);
      if (sentThread) {
        rememberCollaboratorThread(sentThread, { replaceThreadId: options.replaceThreadId });
        setCollaboratorStatus(isThreadStatusActive(sentThread.status) ? "running" : "idle");
        return sentThread;
      }
      if (!thread.isDraft) {
        void hydrateCollaboratorThread(thread.id, {
          showLoading: false,
          showMissingError: false,
        });
      }
      setCollaboratorStatus("idle");
      return thread;
    } catch (error) {
      setCollaboratorStatus("failed");
      const message = error instanceof Error ? error.message : "Unable to start the collaborator run.";
      setCollaboratorError(message);
      if (options.throwOnError) {
        throw error;
      }
      return thread;
    } finally {
      isSendingControlPromptRef.current = false;
    }
  }, [fileLinkingInfo, hydrateCollaboratorThread, onSendMessage, projectDiffMap, rememberCollaboratorThread, scratchpadPath, scratchpadWritableRoot]);

  const startCollaboratorRun = useCallback(async (mode: "bootstrap" | "wake" = stateRef.current.runThreadIds.length ? "wake" : "bootstrap") => {
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

    setCollaboratorStatus("starting");
    rememberCollaboratorThread(draftThread);
    const result = await sendControlPrompt(draftThread, mode, { replaceThreadId: draftThread.id });
    if (result.id !== draftThread.id || !result.isDraft) {
      setCollaboratorDraftThread(createCollaboratorDraftThread(settingsThread));
      setCollaboratorDraftComposerDraft(null);
    }
  }, [collaboratorDraftThread, controls, createCollaboratorDraftThread, rememberCollaboratorThread, sendControlPrompt]);

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
          await startCollaboratorRun("wake");
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

  const mutateState = useCallback((mutator: (state: WorkbenchCollaborationState) => WorkbenchCollaborationState) => {
    const nextState = mutator(stateRef.current);
    publishStateIfChanged(nextState);
    setPendingAutoWakeActivityAt(Date.now());
  }, [publishStateIfChanged]);

  const ensurePromptDraftThread = useCallback((post: WorkbenchCollaborationPost) => {
    if (!controls) {
      setCollaboratorError("Workbench controls are not ready.");
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

  const handlePromptDraftChange = useCallback((postId: string, draft: WorkbenchThreadComposerDraft) => {
    setPromptComposerDraftsByPostId((current) => ({
      ...current,
      [postId]: draft,
    }));
    setPromptStartErrorsByPostId((current) => {
      if (!current[postId]) {
        return current;
      }

      const next = { ...current };
      delete next[postId];
      return next;
    });
  }, []);

  const handlePromptDraftClear = useCallback((postId: string) => {
    setPromptComposerDraftsByPostId((current) => {
      if (!current[postId]) {
        return current;
      }

      const next = { ...current };
      delete next[postId];
      return next;
    });
  }, []);

  const handleCreatePost = useCallback((parentId: string | null, draft: WorkbenchCollaborationPostDraft) => {
    mutateState((state) => createCollaborationPost(state, parentId, draft));
  }, [mutateState]);

  const handleEditPost = useCallback((postId: string, draft: WorkbenchCollaborationPostDraft) => {
    mutateState((state) => updateCollaborationPost(state, postId, draft));
  }, [mutateState]);

  const handleDeletePost = useCallback((postId: string) => {
    mutateState((state) => deleteCollaborationSubtree(state, postId));
  }, [mutateState]);

  const handleRestoreRevision = useCallback((postId: string, revisionId: string) => {
    mutateState((state) => restoreCollaborationPostRevision(state, postId, revisionId));
    setRevisionPostId(null);
  }, [mutateState]);

  const handleMovePost = useCallback((postId: string, intent: CollaborationPostDropIntent) => {
    mutateState((state) => moveCollaborationPost(state, postId, intent));
    onPointerDrop();
  }, [mutateState, onPointerDrop]);

  const handleStartPromptThread = useCallback(async (postId: string, input: UserInput[], draftThread: ThreadPayload) => {
    const submittedPrompt = getPromptTextFromInput(input);
    const result = await onStartThreadFromPrompt(input, draftThread);
    if (result.status === "failed") {
      setPromptStartErrorsByPostId((current) => ({
        ...current,
        [postId]: result.error,
      }));
      return;
    }

    mutateState((state) => {
      const post = state.posts[postId];
      if (!post) {
        return state;
      }

      return normalizeWorkbenchCollaborationState({
        ...state,
        posts: {
          ...state.posts,
          [postId]: {
            ...post,
            prompt: submittedPrompt || post.prompt,
            promptThreadId: result.threadId,
            updatedAt: Date.now(),
          },
        },
      });
    });
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
  }, [mutateState, onStartThreadFromPrompt]);

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

  const collaboratorComposerThread = collaboratorDraftThread;
  const collaboratorComposer = collaboratorComposerThread ? (
    <ThreadComposer
      key={collaboratorComposerThread.id}
      composerSpellCheck={composerSpellCheck}
      highlightSources={highlightSources}
      knownSkills={[]}
      onListModels={threadViewProps.onListModels}
      onPauseThread={() => { }}
      onResumeThread={() => { }}
      onSendMessage={async (threadId, input) => {
        if (threadId !== collaboratorComposerThread.id) {
          throw new Error("Collaborator draft is not ready.");
        }

        const draftThread = createCollaboratorDraftThread(collaboratorComposerThread);
        if (!draftThread) {
          throw new Error("Collaborator draft is not ready.");
        }

        rememberCollaboratorThread(draftThread);
        await sendControlPrompt(draftThread, stateRef.current.runThreadIds.length ? "wake" : "bootstrap", {
          additionalInput: input,
          replaceThreadId: draftThread.id,
          throwOnError: true,
        });
        setCollaboratorDraftThread(createCollaboratorDraftThread(collaboratorComposerThread));
        setCollaboratorDraftComposerDraft(null);
      }}
      onStopThread={() => { }}
      onSubmitUserInputRequest={threadViewProps.onSubmitUserInputRequest}
      onThreadAgentChange={(threadId, agentPath) => {
        if (threadId !== collaboratorComposerThread.id) {
          return;
        }
        setCollaboratorDraftThread((current) => current ? { ...current, agentPath } : current);
      }}
      onThreadComposerDraftChange={(threadId, draft) => {
        if (threadId !== collaboratorComposerThread.id) {
          return;
        }
        setCollaboratorDraftComposerDraft(draft);
      }}
      onThreadComposerDraftClear={(threadId) => {
        if (threadId !== collaboratorComposerThread.id) {
          return;
        }
        setCollaboratorDraftComposerDraft(null);
      }}
      onThreadModelChange={(threadId, model) => {
        if (threadId !== collaboratorComposerThread.id) {
          return;
        }
        setCollaboratorDraftThread((current) => current ? { ...current, model } : current);
      }}
      onThreadQuestionnaireDraftChange={threadViewProps.onThreadQuestionnaireDraftChange}
      onThreadQuestionnaireDraftClear={threadViewProps.onThreadQuestionnaireDraftClear}
      onThreadReasoningEffortChange={(threadId, reasoningEffort) => {
        if (threadId !== collaboratorComposerThread.id) {
          return;
        }
        setCollaboratorDraftThread((current) => current ? { ...current, reasoningEffort } : current);
      }}
      onThreadSavedComposerDraftDelete={threadViewProps.onThreadSavedComposerDraftDelete}
      onThreadSavedComposerDraftSave={threadViewProps.onThreadSavedComposerDraftSave}
      onThreadServiceTierChange={(threadId, serviceTier) => {
        if (threadId !== collaboratorComposerThread.id) {
          return;
        }
        setCollaboratorDraftThread((current) => current ? { ...current, serviceTier } : current);
      }}
      pendingUserInputRequest={null}
      projectId={projectId}
      projectRootPath={projectRootPath}
      rateLimits={rateLimits}
      sendLabel="Run with note"
      thread={collaboratorComposerThread}
      threadComposerDraft={collaboratorDraftComposerDraft}
      threadQuestionnaireDraft={null}
      threadSavedComposerDrafts={threadSavedComposerDrafts}
      workspaceRoots={composerWorkspaceRoots}
    >
      <ThreadRateLimits
        canToggleHarness={collaboratorComposerThread.isDraft}
        harness={collaboratorComposerThread.harness}
        onHarnessToggle={cycleCollaboratorDraftHarness}
        rateLimits={rateLimits}
      />
    </ThreadComposer>
  ) : (
    <p className="m-0 text-[0.86rem] leading-6 text-muted">Collaborator is not ready.</p>
  );

  const handleCollaboratorSendMessage = useCallback(async (
    thread: ThreadPayload,
    input: Parameters<ThreadViewProps["onSendMessage"]>[1],
    options?: WorkbenchSendThreadMessageOptions,
  ) => {
    const payload = await onSendMessage(thread, input, {
      ...options,
      selectThread: false,
    });
    if (payload) {
      rememberCollaboratorThread(payload);
      setCollaboratorStatus(isThreadStatusActive(payload.status) ? "running" : "idle");
    }
    return payload;
  }, [onSendMessage, rememberCollaboratorThread]);

  const handleCollaboratorStopThread = useCallback(async (thread: ThreadPayload) => {
    const payload = await threadViewProps.onStopThread(thread);
    if (payload) {
      rememberCollaboratorThread(payload);
      setCollaboratorStatus(isThreadStatusActive(payload.status) ? "running" : "idle");
    }
    return payload;
  }, [rememberCollaboratorThread, threadViewProps]);

  const handleCollaboratorPauseThread = useCallback(async (thread: ThreadPayload) => {
    const payload = await threadViewProps.onPauseThread(thread);
    if (payload) {
      rememberCollaboratorThread(payload);
      setCollaboratorStatus(isThreadStatusActive(payload.status) ? "running" : "idle");
    }
    return payload;
  }, [rememberCollaboratorThread, threadViewProps]);

  const handleCollaboratorResumeThread = useCallback(async (thread: ThreadPayload) => {
    const payload = await threadViewProps.onResumeThread(thread);
    if (payload) {
      rememberCollaboratorThread(payload);
      setCollaboratorStatus(isThreadStatusActive(payload.status) ? "running" : "idle");
    }
    return payload;
  }, [rememberCollaboratorThread, threadViewProps]);

  const activeRunContent = effectiveRunThread ? (
    shouldRenderCurrentRunThread ? (
      <ThreadView
        {...threadViewProps}
        composerSpellCheck={composerSpellCheck}
        contained
        fontSizeRem={fontSizeRem}
        hideFinalAgentMessage
        hideWorkbenchControlAgentMessages
        hideWorkbenchControlUserMessages
        onPauseThread={handleCollaboratorPauseThread}
        onReadThread={onReadThread}
        onResumeThread={handleCollaboratorResumeThread}
        onSendMessage={handleCollaboratorSendMessage}
        onStopThread={handleCollaboratorStopThread}
        projectId={projectId}
        projectFileCandidates={projectFileCandidates}
        projectFileIndexId={projectFileIndexId}
        projectFileLinkRoots={projectFileLinkRoots}
        projectRootPath={projectRootPath}
        rateLimits={rateLimits}
        thread={effectiveRunThread}
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
        thread={effectiveRunThread}
        threadCwdPath={effectiveRunThread.cwd}
      />
    )
  ) : (
    <p className="m-0 text-[0.84rem] leading-6 text-muted">{shouldShowRunThreadLoading || collaboratorStatus === "hydrating" ? "Loading collaborator thread..." : "Select this run to load its transcript."}</p>
  );

  const runPanel = (
    <CollaborationRunPanel
      activeRunContent={activeRunContent}
      autoWakeCountdownMs={autoWakeCountdownMs}
      autoWakeEnabled={collaborationState.autoWakeEnabled}
      autoWakeProgressPercent={autoWakeProgressPercent}
      collaboratorComposer={shouldRenderCurrentRunThread ? null : collaboratorComposer}
      collaboratorStatus={collaboratorStatus}
      collaboratorStatusLabel={collaboratorStatusLabel}
      error={[collaboratorError, ...collaboratorWarnings].filter(Boolean).join("\n")}
      isAutoWakePaused={isAutoWakePaused}
      isAutoWakeToggleDisabled={isAutoWakeToggleDisabled}
      isRunDisabled={!controls || isProjectLoading}
      lastRunSummary={collaborationState.lastRunSummary}
      recentRunIds={[...collaborationState.runThreadIds].reverse()}
      selectedRunThreadId={selectedRunThreadId}
      summariesById={summariesById}
      onRunNow={() => {
        void startCollaboratorRun();
      }}
      onSelectRunThread={(threadId) => {
        setSelectedRunThreadId(threadId);
        setCollaboratorStatus("hydrating");
        void hydrateCollaboratorThread(threadId);
      }}
      onToggleAutoRun={() => {
        publishStateIfChanged({
          ...stateRef.current,
          autoWakeEnabled: !stateRef.current.autoWakeEnabled,
        });
        setPendingAutoWakeActivityAt(Date.now());
      }}
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
      onDeletePost={handleDeletePost}
      onEditPost={handleEditPost}
      onEnsurePromptDraftThread={ensurePromptDraftThread}
      onMovePost={handleMovePost}
      onOpenPromptThread={onOpenThreadFromPromptPost}
      onOpenRevisionHistory={setRevisionPostId}
      onPostPointerDragStart={onPostPointerDragStart}
      onPromptDraftChange={handlePromptDraftChange}
      onPromptDraftClear={handlePromptDraftClear}
      onStartPromptThread={handleStartPromptThread}
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
