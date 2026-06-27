/*
 * Exports:
 * - default WorkbenchCollaborationView: render resizable Collaboration scratchpad and collaborator panels. Keywords: collaboration, scratchpad, collaborator, split layout.
 * - Local helpers: build collaborator control prompts, select/persist Collaboration threads, and own mobile pane switching. Keywords: collaboration, registry, prompt, mobile, suggestions.
 */
"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps } from "react";

import type { UserInput } from "../../../lib/codex/generated/app-server/v2/UserInput";
import { createTextInput } from "../../../lib/codex/protocol";
import type {
  ChangeSummary,
  ThreadPayload,
  ThreadSummary,
  WorkbenchCollaborationStartedSuggestionThread,
  WorkbenchCollaborationSuggestion,
  WorkbenchCollaborationThreadRegistry,
  WorkbenchControls,
  WorkbenchHarness,
  WorkbenchSendThreadMessageOptions,
} from "../../../lib/types";
import {
  readStoredWorkbenchCollaborationLayout,
  writeStoredWorkbenchCollaborationLayout,
} from "../../../lib/workbench/collaboration/collaboration-layout";
import { WORKBENCH_COLLABORATION_AUTO_WAKE_DELAY_MS } from "../../../lib/workbench/collaboration/collaboration-registry";
import {
  applyWorkbenchCollaborationSuggestionPatch,
  findWorkbenchCollaborationSuggestionPatch,
  type WorkbenchCollaborationSuggestionPatch,
} from "../../../lib/workbench/collaboration/collaboration-suggestions";
import { areDeeplyEqual } from "../../../lib/workbench/deep-equality";
import WorkbenchMainLayout from "../../../lib/workbench/layout/workbench-layout";
import ActiveTabRefreshLeader from "../../../lib/workbench/state/ActiveTabRefreshLeader";
import {
  buildInlineMentionCandidates,
} from "../../../lib/workbench/thread/inline-mention-highlights";
import { WORKBENCH_FILE_LINK_INSTRUCTIONS } from "../../../lib/workbench/thread/workbench-file-link-instructions";
import type { WorkbenchFilePanelClientOptions } from "../../../lib/workbench/WorkbenchFilePanelClient";
import WorkbenchFilePanel from "../layout/WorkbenchFilePanel";
import WorkbenchMainLayoutView from "../layout/WorkbenchMainLayoutView";
import PrimaryButton from "../PrimaryButton";
import { ThreadThreadContent } from "../thread-view/thread-view-items";
import ThreadComposer from "../thread-view/ThreadComposer";
import ThreadDisclosure from "../thread-view/ThreadDisclosure";
import ThreadRateLimits from "../thread-view/ThreadRateLimits";
import ThreadView from "../thread-view/ThreadView";
import WorkbenchProgressWheel from "../WorkbenchProgressWheel";
import CollaborationSuggestionCard from "./CollaborationSuggestionCard";

type ThreadViewProps = ComponentProps<typeof ThreadView>;
type CollaborationComposerDraft = Parameters<ThreadViewProps["onThreadComposerDraftChange"]>[1];

const SCRATCHPAD_AUTOSAVE_DELAY_MS = 180;
const SCRATCHPAD_AUTO_REFRESH_DELAY_MS = 650;
const COLLABORATOR_THREAD_ACTIVE_REFRESH_INTERVAL_MS = 1500;
const COLLABORATOR_THREAD_IDLE_REFRESH_INTERVAL_MS = 10000;
const COLLABORATOR_THREAD_HYDRATION_RETRY_ATTEMPTS = 4;
const COLLABORATOR_THREAD_HYDRATION_RETRY_DELAY_MS = 600;
const COLLABORATOR_THREAD_HYDRATION = { mode: "legacyFull" as const };
const THREAD_HARNESSES: readonly WorkbenchHarness[] = ["codex", "copilot", "opencode"];

type CollaboratorRunStatus = "idle" | "starting" | "hydrating" | "running" | "failed";
type WorkbenchCollaborationSuggestionStartResult =
  | {
    readonly error: string;
    readonly status: "failed";
  }
  | {
    readonly status: "started";
    readonly threadId: string;
  };
type StartedCollaborationSuggestion = WorkbenchCollaborationSuggestion & {
  readonly startedAt: number;
  readonly startedThreadId: string;
};

interface WorkbenchCollaborationViewProps extends Omit<ThreadViewProps, "contained" | "fontSizeRem" | "hideFinalAgentMessage" | "hideWorkbenchControlAgentMessages" | "hideWorkbenchControlUserMessages" | "projectId" | "thread"> {
  collaborationThreadRegistry: WorkbenchCollaborationThreadRegistry;
  collaborationStartedSuggestionThreadSummaries: ThreadSummary[];
  collaborationThreadSummaries: ThreadSummary[];
  collaboratorPrompt: string;
  controls: WorkbenchControls | null;
  editorFontClassName: string;
  fontSizeRem: number;
  harness: WorkbenchHarness;
  isMobile: boolean;
  isProjectLoading: boolean;
  onCollaborationThreadRegistryChange: (registry: WorkbenchCollaborationThreadRegistry) => void;
  onClaimAutoWake: (projectId: string, ownerId: string) => Promise<{ acquired: boolean; registry: WorkbenchCollaborationThreadRegistry }>;
  onOpenThreadFromSuggestion: (threadId: string) => void;
  onStartThreadFromPrompt: (input: UserInput[], thread: ThreadPayload) => Promise<WorkbenchCollaborationSuggestionStartResult>;
  projectChanges: Record<string, ChangeSummary>;
  projectId: string;
  scratchpadPath: string;
  scratchpadWritableRoot: string;
}

function joinClasses (...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

function createDraftCollaboratorThreadId (projectId: string) {
  const safeProjectId = projectId.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "project";
  return `draft:collaboration:${safeProjectId}:${Date.now()}`;
}

function isThreadStatusActive (status: string) {
  return status === "active" || status.startsWith("active:");
}

function waitForCollaboratorHydrationDelay () {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, COLLABORATOR_THREAD_HYDRATION_RETRY_DELAY_MS);
  });
}

function getThreadLabel (threadId: string, summariesById: Map<string, ThreadSummary>) {
  const summary = summariesById.get(threadId);
  return summary?.name || summary?.preview || threadId.replace(/^draft:collaboration:/, "Draft ");
}

function formatCollaboratorRunRelativeTime (summary: ThreadSummary | null, now: number) {
  if (!summary) {
    return "saved run";
  }

  const elapsedSeconds = Math.max(0, Math.floor((now - summary.updatedAt * 1000) / 1000));
  if (elapsedSeconds < 45) {
    return "just now";
  }

  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) {
    return `${elapsedMinutes}m ago`;
  }

  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) {
    return `${elapsedHours}h ago`;
  }

  const elapsedDays = Math.floor(elapsedHours / 24);
  return `${elapsedDays}d ago`;
}

function createSuggestionDraftThreadId (projectId: string, suggestionId: string) {
  const safeProjectId = projectId.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "project";
  const safeSuggestionId = suggestionId.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "suggestion";
  return `draft:collaboration-suggestion:${safeProjectId}:${safeSuggestionId}`;
}

function applyCollaboratorDraftSettings (draftThread: ThreadPayload, settingsThread: ThreadPayload) {
  return {
    ...draftThread,
    agentPath: settingsThread.agentPath,
    model: settingsThread.model,
    reasoningEffort: settingsThread.reasoningEffort,
    serviceTier: settingsThread.harness === "codex" ? settingsThread.serviceTier : null,
  };
}

function formatSuggestionsForPrompt (suggestions: readonly WorkbenchCollaborationSuggestion[]) {
  if (!suggestions.length) {
    return "None.";
  }

  return suggestions.map((suggestion) => [
    `- id: ${suggestion.id}`,
    `  title: ${suggestion.title}`,
    ...(suggestion.rationale ? [`  rationale: ${suggestion.rationale}`] : []),
    `  prompt: ${suggestion.prompt}`,
  ].join("\n")).join("\n");
}

function formatStartedSuggestionThreadsForPrompt (
  startedThreads: readonly WorkbenchCollaborationStartedSuggestionThread[],
  summariesByThreadId: Map<string, ThreadSummary>,
) {
  if (!startedThreads.length) {
    return "None.";
  }

  return [...startedThreads]
    .sort((left, right) => right.startedAt - left.startedAt || left.title.localeCompare(right.title))
    .map((startedThread) => {
      const summary = summariesByThreadId.get(startedThread.threadId);
      return [
        `- suggestion id: ${startedThread.suggestionId}`,
        `  title: ${startedThread.title}`,
        `  thread id: ${startedThread.threadId}`,
        `  thread status: ${summary?.status ?? "unknown"}`,
        `  thread label: ${summary?.name || summary?.preview || "unknown"}`,
        `  thread updated at: ${summary ? new Date(summary.updatedAt).toISOString() : "unknown"}`,
        ...(startedThread.rationale ? [`  original rationale: ${startedThread.rationale}`] : []),
        `  original prompt: ${startedThread.prompt}`,
      ].join("\n");
    })
    .join("\n");
}

function formatProjectDiffMapForPrompt (changes: Record<string, ChangeSummary>) {
  const entries = Object.entries(changes).sort(([leftPath], [rightPath]) => leftPath.localeCompare(rightPath));
  if (!entries.length) {
    return "No reported git changes.";
  }

  return entries.map(([path, change]) => `- ${path}: +${change.additions} -${change.deletions}`).join("\n");
}

function formatFileLinkingInfoForPrompt (
  workspaceRoots: readonly { id: string; openPathMode?: string; rootPath: string }[],
) {
  const rootLines = workspaceRoots.length
    ? workspaceRoots.map((root) => `- ${root.id}: ${root.rootPath}${root.openPathMode ? ` (${root.openPathMode})` : ""}`).join("\n")
    : "- single-root project: use project-relative paths";

  return [
    WORKBENCH_FILE_LINK_INSTRUCTIONS,
    "Available file-link roots:",
    rootLines,
  ].join("\n");
}

function buildCollaboratorControlPrompt ({
  additionalUserMessage,
  collaboratorPrompt,
  diffMap,
  fileLinkingInfo,
  mode,
  previousSummary,
  scratchpadPath,
  startedSuggestionThreads,
  suggestions,
}: {
  additionalUserMessage?: string;
  collaboratorPrompt: string;
  diffMap: string;
  fileLinkingInfo: string;
  mode: "bootstrap" | "wake";
  previousSummary: string;
  scratchpadPath: string;
  startedSuggestionThreads: string;
  suggestions: readonly WorkbenchCollaborationSuggestion[];
}) {
  return `<!-- workbench-collaboration-control -->
${collaboratorPrompt}
${additionalUserMessage ? `
Additional user message:
${additionalUserMessage}
` : ""}

Mode: ${mode}.
Scratchpad path: ${scratchpadPath}

Previous private Workbench summary:
${previousSummary || "None."}

Current git diff map:
${diffMap}

Workbench file-linking information:
${fileLinkingInfo}

Current Workbench-owned suggestions:
${formatSuggestionsForPrompt(suggestions)}

Previous suggestion-created threads:
${startedSuggestionThreads}

Use the scratchpad as plain Workbench-owned project notes. Read it every run.

Scratchpad rules:

* Read the scratchpad every run.
* Do not write suggested agent threads into the scratchpad. Workbench owns suggestions as structured state in your final JSON.
* You may edit the scratchpad only when the user explicitly asks for project-note updates, when the current collaborator-thread conversation is specifically about changing the scratchpad, or when previous suggestion-created thread state plus the current diff strongly indicates a scratchpad item has been dealt with.
* If scratchpad cleanup is warranted, do not delete text outright. Wrap stale or dealt-with scratchpad text in <del></del> markers so the user can review and accept the deletion.
* Scratchpad edits happen in the scratchpad file before the final JSON. Do not describe scratchpad edits in the JSON unless they affect the summary.
* If there is nothing useful to add or mark, leave the scratchpad unchanged.

Suggestion judgment rules:

* Suggest work that is coherent as a separate dedicated thread.
* Actively maintain existing suggestions based on the current scratchpad, diff map, and suggestion-created thread state.
* Meaningfully improve existing suggestions when the current scratchpad, diff map, or suggestion-created thread state gives you better context for the title, rationale, or prompt.
* When relevant files matter, use Workbench-clickable file links from the file-linking information above.
* Avoid suggestions that are vague, duplicate existing work, already completed, or mostly generic process reminders.

Suggestion prompt quality rules:

* Suggestion prompts must be self-contained for a fresh agent thread.
* Include the concrete desired outcome, relevant TODO/project context, adjacent work that affects judgment, task-specific constraints not already supplied by the project, and only the most useful Workbench-clickable file links when anchors materially help.
* Do not repeat generic agent instructions.
* Do not tell the executing agent to read AGENTS files, inspect before planning, wait for approval, use skills, follow project style rules, avoid deep selectors, or obey baseline project instructions.
* Do not use exhaustive file lists as a substitute for task context.

Bad suggestion prompt example:
\"Inspect and plan this follow-up; do not implement until approval. Read AGENTS.md and focus on file A, file B, file C, file D.\"

Good suggestion prompt example:
\"Make static component content align toward its placement edges. The scratchpad is tracking MenuBar top-left and Stats bottom-right behavior; preserve the existing orientation model unless inspection shows it is the wrong owner. Useful anchors: #[src/ui/screen/screens/game/static/StaticComponent.ts], #[style/newui/screens/game/MenuBar.scss].\"

Workbench hides the final response in the Collaboration view; the scratchpad is the user-facing source of truth.

The TypeScript block below is explanatory only. Return valid JSON matching this TypeScript-described shape. Do not include markdown fences, comments, explanations, or trailing commas in the response.

\`\`\`ts
type SuggestionsPatch = Record<string, Suggestion | null>;

interface Suggestion {
  /** Short user-facing title for the suggested dedicated thread. */
  title: string;

  /**
   * Self-contained editable prompt the user could hand to a fresh Workbench thread.
   *
   * Include:
   * - the concrete desired outcome
   * - relevant scratchpad/TODO/project context
   * - adjacent work that affects judgment
   * - task-specific constraints not already supplied by project instructions
   * - only the most useful Workbench-clickable file links when anchors help
   *
   * Do not repeat generic agent/project instructions or exhaustive file lists.
   */
  prompt: string;

  /** Why this suggestion is coherent now. Include when it helps the user decide. */
  rationale?: string;
}

interface WorkbenchCollaborationResponse {
  /** Concise private state for the next collaborator run, including the diff map and important interpretation from this run. */
  summary: string;

  /**
   * Patch for Workbench-owned suggestions.
   *
   * Use stable slug-like IDs.
   * Omit still-good suggestions.
   * Replace stale, weak, incomplete, or lower-quality suggestions with an improved object.
   * Set obsolete suggestions to null.
   */
  suggestions: SuggestionsPatch;
}
\`\`\`

Example JSON shape:
{
  "summary": "short private summary for Workbench",
  "suggestions": {
    "stable-suggestion-id": {
      "title": "short suggestion title",
      "rationale": "why this is coherent now",
      "prompt": "dedicated thread prompt"
    },
    "obsolete-suggestion-id": null
  }
}
`;
}

function applySuggestionPatchToRegistry (
  registry: WorkbenchCollaborationThreadRegistry,
  thread: ThreadPayload,
): WorkbenchCollaborationThreadRegistry {
  const result = findWorkbenchCollaborationSuggestionPatch(thread);
  if (!result) {
    return registry;
  }
  if (result.signature && result.signature === registry.lastAppliedSuggestionPatchSignature) {
    return registry;
  }

  const dismissedSuggestionIds = new Set(registry.dismissedSuggestionIds);
  const filteredPatch: WorkbenchCollaborationSuggestionPatch = {};
  for (const [suggestionId, entry] of Object.entries(result.suggestions)) {
    if (entry && dismissedSuggestionIds.has(suggestionId)) {
      continue;
    }
    if (entry === null) {
      dismissedSuggestionIds.add(suggestionId);
    }

    filteredPatch[suggestionId] = entry;
  }

  const suggestions = applyWorkbenchCollaborationSuggestionPatch(
    registry.suggestions,
    filteredPatch,
    Date.now(),
  );
  if (
    suggestions === registry.suggestions
    && result.summary === registry.lastRunSummary
    && result.signature === registry.lastAppliedSuggestionPatchSignature
  ) {
    return registry;
  }

  return {
    ...registry,
    dismissedSuggestionIds: Array.from(dismissedSuggestionIds),
    lastAppliedSuggestionPatchSignature: result.signature,
    lastRunSummary: result.summary,
    suggestions,
  };
}

export default function WorkbenchCollaborationView ({
  collaborationThreadRegistry,
  collaborationStartedSuggestionThreadSummaries,
  collaborationThreadSummaries,
  collaboratorPrompt,
  composerSpellCheck,
  controls,
  editorFontClassName,
  fontSizeRem,
  harness,
  isMobile,
  isProjectLoading,
  livePendingUserInputRequestsByThreadId,
  onCollaborationThreadRegistryChange,
  onCompactThread,
  onClaimAutoWake,
  onDraftHarnessChange,
  onListModels,
  onPauseThread,
  onReadThread,
  onResumeThread,
  onSendMessage,
  onStopThread,
  onSubmitUserInputRequest,
  onThreadAgentChange,
  onThreadCodeBlockWrapChange,
  onThreadComposerDraftChange,
  onThreadComposerDraftClear,
  onThreadModelChange,
  onThreadQuestionnaireDraftChange,
  onThreadQuestionnaireDraftClear,
  onThreadReasoningEffortChange,
  onThreadSavedComposerDraftDelete,
  onThreadSavedComposerDraftSave,
  onThreadSeen,
  onThreadServiceTierChange,
  onOpenThreadFromSuggestion,
  onStartThreadFromPrompt,
  projectFileCandidates,
  projectFileIndexId,
  projectFileLinkRoots,
  projectFilePaths,
  projectChanges,
  projectId,
  projectRootPath,
  projectRoots,
  rateLimits,
  scratchpadPath,
  scratchpadWritableRoot,
  threadCodeBlockWrap,
  threadComposerDraftsByThreadId,
  threadQuestionnaireDraftsByKey,
  threadSavedComposerDrafts,
}: WorkbenchCollaborationViewProps) {
  const [selectedThreadId, setSelectedThreadId] = useState(collaborationThreadRegistry.currentThreadId || collaborationThreadRegistry.threadIds[0] || "");
  const [collaboratorThread, setCollaboratorThread] = useState<ThreadPayload | null>(null);
  const [collaboratorDraftThread, setCollaboratorDraftThread] = useState<ThreadPayload | null>(null);
  const [collaboratorDraftComposerDraft, setCollaboratorDraftComposerDraft] = useState<CollaborationComposerDraft | null>(null);
  const [collaboratorError, setCollaboratorError] = useState("");
  const [collaboratorRunStatus, setCollaboratorRunStatus] = useState<CollaboratorRunStatus>("idle");
  const [isAutoWakeLeader, setIsAutoWakeLeader] = useState(false);
  const [isLoadingThread, setIsLoadingThread] = useState(false);
  const [isSendingControlPrompt, setIsSendingControlPrompt] = useState(false);
  const [mobilePane, setMobilePane] = useState<"scratchpad" | "collaborator">("scratchpad");
  const [collaborationLayout, setCollaborationLayout] = useState(() => readStoredWorkbenchCollaborationLayout(projectId));
  const [pendingAutoWakeActivityAt, setPendingAutoWakeActivityAt] = useState<number | null>(null);
  const [autoWakeNow, setAutoWakeNow] = useState(() => Date.now());
  const [openSuggestionIds, setOpenSuggestionIds] = useState<Record<string, boolean | undefined>>({});
  const [suggestionDraftThreadsById, setSuggestionDraftThreadsById] = useState<Record<string, ThreadPayload | undefined>>({});
  const [startedSuggestionsById, setStartedSuggestionsById] = useState<Record<string, StartedCollaborationSuggestion | undefined>>({});
  const [suggestionStartErrorsById, setSuggestionStartErrorsById] = useState<Record<string, string | undefined>>({});
  const collaboratorThreadRef = useRef<ThreadPayload | null>(null);
  const collaborationThreadRegistryRef = useRef(collaborationThreadRegistry);
  const collaboratorDraftProjectIdRef = useRef(projectId);
  const hydrationGenerationRef = useRef(0);
  const isSendingControlPromptRef = useRef(false);
  const autoWakeOwnerIdRef = useRef(typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const observedProjectDiffMapRef = useRef({ projectDiffMap: "", projectId: "" });
  const projectDiffMapObserverReadyRef = useRef(false);
  const summariesById = useMemo(() => new Map(collaborationThreadSummaries.map((thread) => [thread.id, thread])), [collaborationThreadSummaries]);
  const hasActiveCollaboratorRun = useMemo(
    () => collaborationThreadSummaries.some((thread) => isThreadStatusActive(thread.status)),
    [collaborationThreadSummaries],
  );
  const startedSuggestionSummariesByThreadId = useMemo(
    () => new Map(collaborationStartedSuggestionThreadSummaries.map((thread) => [thread.id, thread])),
    [collaborationStartedSuggestionThreadSummaries],
  );
  const collaborationSuggestions = useMemo(() => (
    Object.values(collaborationThreadRegistry.suggestions)
      .sort((left, right) => right.updatedAt - left.updatedAt || left.title.localeCompare(right.title))
  ), [collaborationThreadRegistry.suggestions]);
  const visibleSuggestions = useMemo(() => (
    [
      ...collaborationSuggestions,
      ...Object.values(startedSuggestionsById).filter((suggestion): suggestion is StartedCollaborationSuggestion => (
        Boolean(suggestion) && !(suggestion.id in collaborationThreadRegistry.suggestions)
      )),
    ].sort((left, right) => right.updatedAt - left.updatedAt || left.title.localeCompare(right.title))
  ), [collaborationSuggestions, collaborationThreadRegistry.suggestions, startedSuggestionsById]);
  const projectDiffMap = useMemo(() => formatProjectDiffMapForPrompt(projectChanges), [projectChanges]);
  const startedSuggestionThreadsForPrompt = useMemo(() => (
    formatStartedSuggestionThreadsForPrompt(
      Object.values(collaborationThreadRegistry.startedSuggestionThreads),
      startedSuggestionSummariesByThreadId,
    )
  ), [collaborationThreadRegistry.startedSuggestionThreads, startedSuggestionSummariesByThreadId]);
  const suggestionComposerWorkspaceRoots = useMemo(() => (
    projectFileLinkRoots ?? (projectRoots.length > 1
      ? projectRoots.map((root) => ({ id: root.id, rootPath: root.rootPath }))
      : [])
  ), [projectFileLinkRoots, projectRoots]);
  const fileLinkingInfo = useMemo(() => formatFileLinkingInfoForPrompt(suggestionComposerWorkspaceRoots), [suggestionComposerWorkspaceRoots]);
  const suggestionComposerHighlightSources = useMemo(() => buildInlineMentionCandidates({
    files: projectFileCandidates,
    filesIdentity: projectFileIndexId,
    projectRootPath,
    skills: [],
    threadCwdPath: projectRootPath,
    workspaceRoots: suggestionComposerWorkspaceRoots,
  }), [projectFileCandidates, projectFileIndexId, projectRootPath, suggestionComposerWorkspaceRoots]);
  const collaboratorDraftHasContent = Boolean(collaboratorDraftComposerDraft?.text.trim() || collaboratorDraftComposerDraft?.attachments.length);
  const resetPendingAutoWakeActivity = useCallback(() => {
    const now = Date.now();
    setAutoWakeNow(now);
    setPendingAutoWakeActivityAt(now);
  }, []);
  const clearPendingAutoWakeActivity = useCallback(() => {
    setPendingAutoWakeActivityAt(null);
  }, []);

  useEffect(() => {
    if (collaboratorDraftHasContent) {
      clearPendingAutoWakeActivity();
    }
  }, [clearPendingAutoWakeActivity, collaboratorDraftHasContent]);

  useEffect(() => {
    const observed = observedProjectDiffMapRef.current;
    if (isProjectLoading || observed.projectId !== projectId) {
      observedProjectDiffMapRef.current = { projectDiffMap, projectId };
      projectDiffMapObserverReadyRef.current = !isProjectLoading;
      return;
    }

    if (!projectDiffMapObserverReadyRef.current) {
      observedProjectDiffMapRef.current = { projectDiffMap, projectId };
      projectDiffMapObserverReadyRef.current = true;
      return;
    }

    if (observed.projectDiffMap !== projectDiffMap) {
      observedProjectDiffMapRef.current = { projectDiffMap, projectId };
      resetPendingAutoWakeActivity();
    }
  }, [isProjectLoading, projectDiffMap, projectId, resetPendingAutoWakeActivity]);

  useEffect(() => {
    if (pendingAutoWakeActivityAt === null) {
      return;
    }

    const intervalId = window.setInterval(() => {
      setAutoWakeNow(Date.now());
    }, 1000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [pendingAutoWakeActivityAt]);

  useEffect(() => {
    setCollaborationLayout(readStoredWorkbenchCollaborationLayout(projectId));
  }, [projectId]);

  const setAndStoreCollaborationLayout = useCallback((nextLayout: typeof collaborationLayout) => {
    setCollaborationLayout(nextLayout);
    writeStoredWorkbenchCollaborationLayout(projectId, nextLayout);
  }, [projectId]);

  const focusCollaborationPanel = useCallback((panelId: string) => {
    setCollaborationLayout((current) => {
      const nextLayout = WorkbenchMainLayout.focusPanel(current, panelId);
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
  const scratchpadClientOptions = useMemo<Partial<Omit<WorkbenchFilePanelClientOptions, "clearThreadSelection" | "draftStore" | "emitExplorerStateChange" | "expandProjectPath" | "getProjectChangeSummary" | "getProjectId" | "refreshProject" | "surfaces">>>(() => ({
    autoRefreshCleanFile: false,
    autoRefreshCleanFileDelayMs: SCRATCHPAD_AUTO_REFRESH_DELAY_MS,
    autoSave: true,
    autoSaveDelayMs: SCRATCHPAD_AUTOSAVE_DELAY_MS,
    documentProfile: "collaborationScratchpad",
    fileApiPath: "/api/collaboration/scratchpad",
    keepEverythingOnSave: true,
    onContentChange: resetPendingAutoWakeActivity,
    refreshProjectOnSave: false,
  }), [resetPendingAutoWakeActivity]);

  const createCollaboratorDraftThread = useCallback((settingsThread?: ThreadPayload | null) => {
    if (!controls) {
      return null;
    }

    const draftThread = controls.createThreadDraft(settingsThread?.harness ?? harness, {
      select: false,
      threadId: createDraftCollaboratorThreadId(projectId),
    });
    collaboratorDraftProjectIdRef.current = projectId;
    return settingsThread ? applyCollaboratorDraftSettings(draftThread, settingsThread) : draftThread;
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
    setCollaboratorDraftThread((current) => {
      if (current && collaboratorDraftProjectIdRef.current === projectId) {
        return current;
      }

      return createCollaboratorDraftThread();
    });
  }, [controls, createCollaboratorDraftThread, projectId]);

  useEffect(() => {
    if (!controls) {
      setSuggestionDraftThreadsById({});
      return;
    }

    setSuggestionDraftThreadsById((current) => {
      const next: Record<string, ThreadPayload | undefined> = {};
      let changed = false;
      for (const suggestion of collaborationSuggestions) {
        const existing = current[suggestion.id];
        next[suggestion.id] = existing?.harness === harness
          ? existing
          : controls.createThreadDraft(harness, {
            select: false,
            threadId: createSuggestionDraftThreadId(projectId, suggestion.id),
          });
        if (next[suggestion.id] !== existing) {
          changed = true;
        }
      }

      if (Object.keys(current).length !== Object.keys(next).length) {
        changed = true;
      }

      return changed ? next : current;
    });
  }, [collaborationSuggestions, controls, harness, projectId]);

  useEffect(() => {
    collaboratorThreadRef.current = collaboratorThread;
  }, [collaboratorThread]);

  useEffect(() => {
    collaborationThreadRegistryRef.current = collaborationThreadRegistry;
  }, [collaborationThreadRegistry]);

  useEffect(() => {
    const nextSelectedThreadId = collaborationThreadRegistry.currentThreadId || collaborationThreadRegistry.threadIds[0] || "";
    setSelectedThreadId(nextSelectedThreadId);
  }, [collaborationThreadRegistry.currentThreadId, collaborationThreadRegistry.threadIds]);

  useEffect(() => {
    const leader = new ActiveTabRefreshLeader({
      onLeadershipChange: setIsAutoWakeLeader,
      storageKey: `workbench:collaboration:${projectId}:leader`,
    });
    return () => {
      leader.dispose();
    };
  }, [projectId]);

  const publishRegistryIfChanged = useCallback((nextRegistry: WorkbenchCollaborationThreadRegistry) => {
    if (areDeeplyEqual(collaborationThreadRegistryRef.current, nextRegistry)) {
      return;
    }

    collaborationThreadRegistryRef.current = nextRegistry;
    onCollaborationThreadRegistryChange(nextRegistry);
  }, [onCollaborationThreadRegistryChange]);

  const rememberCollaboratorThread = useCallback((thread: ThreadPayload, options: { replaceThreadId?: string; select?: boolean } = {}) => {
    const nextThreadIds = [
      thread.id,
      ...collaborationThreadRegistry.threadIds.filter((threadId) => threadId !== thread.id && threadId !== options.replaceThreadId),
    ];
    const nextCurrentThreadId = options.select === false
      ? collaborationThreadRegistry.currentThreadId || nextThreadIds[0] || ""
      : thread.id;
    const nextRegistry = applySuggestionPatchToRegistry({
      ...collaborationThreadRegistry,
      currentThreadId: nextCurrentThreadId,
      threadIds: nextThreadIds,
    }, thread);
    setCollaboratorThread(thread);
    setSelectedThreadId(nextCurrentThreadId);
    publishRegistryIfChanged(nextRegistry);
  }, [collaborationThreadRegistry, publishRegistryIfChanged]);

  const publishSuggestionPatchFromThread = useCallback((thread: ThreadPayload) => {
    const existingThreadIds = collaborationThreadRegistry.threadIds.filter((threadId) => !threadId.startsWith("draft:collaboration:"));
    const baseThreadIds = existingThreadIds.includes(thread.id)
      ? existingThreadIds
      : [thread.id, ...existingThreadIds];
    const baseRegistry = {
      ...collaborationThreadRegistry,
      currentThreadId: collaborationThreadRegistry.currentThreadId.startsWith("draft:collaboration:")
        ? thread.id
        : collaborationThreadRegistry.currentThreadId || thread.id,
      threadIds: baseThreadIds,
    };
    const nextRegistry = applySuggestionPatchToRegistry(baseRegistry, thread);
    publishRegistryIfChanged(nextRegistry);
  }, [collaborationThreadRegistry, publishRegistryIfChanged]);

  const hydrateCollaboratorThread = useCallback(async (threadId: string, options: { attempts?: number; showLoading?: boolean; showMissingError?: boolean } = {}) => {
    if (!threadId || threadId.startsWith("draft:")) {
      return null;
    }

    const generation = ++hydrationGenerationRef.current;
    const attempts = Math.max(1, options.attempts ?? 1);
    if (options.showLoading !== false) {
      setIsLoadingThread(true);
    }
    setCollaboratorError("");

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const payload = await onReadThread(threadId, harness, {
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

      if (payload) {
        setCollaboratorThread(payload);
        publishSuggestionPatchFromThread(payload);
        setCollaboratorRunStatus(isThreadStatusActive(payload.status) ? "running" : "idle");
        setIsLoadingThread(false);
        return payload;
      }

      if (attempt < attempts) {
        setCollaboratorRunStatus("hydrating");
        await waitForCollaboratorHydrationDelay();
      }
    }

    if (options.showMissingError !== false && hydrationGenerationRef.current === generation) {
      setIsLoadingThread(false);
      setCollaboratorRunStatus("failed");
      setCollaboratorError("The collaborator thread started, but its saved history is still unavailable. Try Run now again in a moment.");
    } else if (hydrationGenerationRef.current === generation) {
      setIsLoadingThread(false);
    }
    return null;
  }, [harness, onReadThread, publishSuggestionPatchFromThread]);

  useEffect(() => {
    if (!selectedThreadId) {
      setCollaboratorThread(null);
      return;
    }

    if (selectedThreadId.startsWith("draft:")) {
      return;
    }

    if (collaboratorThread?.id === selectedThreadId) {
      return;
    }

    void hydrateCollaboratorThread(selectedThreadId);

    return () => {
      hydrationGenerationRef.current += 1;
    };
  }, [collaboratorThread?.id, hydrateCollaboratorThread, selectedThreadId]);

  const sendControlPrompt = useCallback(async (thread: ThreadPayload, mode: "bootstrap" | "wake", options: { additionalInput?: UserInput[]; replaceThreadId?: string; throwOnError?: boolean } = {}) => {
    if (isSendingControlPromptRef.current) {
      return thread;
    }

    isSendingControlPromptRef.current = true;
    setIsSendingControlPrompt(true);
    clearPendingAutoWakeActivity();
    setCollaboratorRunStatus(mode === "bootstrap" ? "starting" : "running");
    setCollaboratorError("");
    try {
      const additionalText = options.additionalInput?.find((input): input is Extract<UserInput, { type: "text" }> => input.type === "text")?.text.trim() ?? "";
      const additionalNonTextInput = options.additionalInput?.filter((input) => input.type !== "text") ?? [];
      const payload = await onSendMessage(thread, [
        createTextInput(buildCollaboratorControlPrompt({
          additionalUserMessage: additionalText,
          collaboratorPrompt,
          diffMap: projectDiffMap,
          fileLinkingInfo,
          mode,
          previousSummary: collaborationThreadRegistry.lastRunSummary,
          scratchpadPath,
          startedSuggestionThreads: startedSuggestionThreadsForPrompt,
          suggestions: collaborationSuggestions,
        })),
        ...additionalNonTextInput,
      ], {
        additionalWritableRoots: scratchpadWritableRoot ? [scratchpadWritableRoot] : undefined,
        onThreadMaterialized: (materializedThread) => {
          rememberCollaboratorThread(materializedThread, {
            replaceThreadId: options.replaceThreadId,
          });
          setCollaboratorRunStatus("hydrating");
          void hydrateCollaboratorThread(materializedThread.id, {
            attempts: COLLABORATOR_THREAD_HYDRATION_RETRY_ATTEMPTS,
            showLoading: false,
          });
        },
        selectThread: false,
        workflowIds: ["collaborator"],
      });
      if (payload) {
        rememberCollaboratorThread(payload, {
          replaceThreadId: options.replaceThreadId,
        });
        setCollaboratorRunStatus(isThreadStatusActive(payload.status) ? "running" : "idle");
      } else if (!thread.isDraft) {
        void hydrateCollaboratorThread(thread.id, {
          attempts: COLLABORATOR_THREAD_HYDRATION_RETRY_ATTEMPTS,
          showLoading: false,
        });
      }
      return payload ?? thread;
    } catch (error) {
      setCollaboratorRunStatus("failed");
      setCollaboratorError(error instanceof Error ? error.message : "Unable to wake the collaborator.");
      if (options.throwOnError) {
        throw error;
      }
      return thread;
    } finally {
      isSendingControlPromptRef.current = false;
      setIsSendingControlPrompt(false);
    }
  }, [clearPendingAutoWakeActivity, collaborationSuggestions, collaborationThreadRegistry.lastRunSummary, collaboratorPrompt, fileLinkingInfo, hydrateCollaboratorThread, onSendMessage, projectDiffMap, rememberCollaboratorThread, scratchpadPath, scratchpadWritableRoot, startedSuggestionThreadsForPrompt]);

  const startCollaboratorRun = useCallback(async (mode: "bootstrap" | "wake" = collaborationThreadRegistry.threadIds.length ? "wake" : "bootstrap") => {
    if (!controls) {
      return;
    }

    const settingsThread = collaboratorDraftThread ?? createCollaboratorDraftThread();
    if (!settingsThread) {
      return;
    }

    const draftThread = createCollaboratorDraftThread(settingsThread);
    if (!draftThread) {
      return;
    }

    rememberCollaboratorThread(draftThread);
    const result = await sendControlPrompt(draftThread, mode, {
      replaceThreadId: draftThread.id,
    });
    if (result.id !== draftThread.id || !result.isDraft) {
      setCollaboratorDraftThread(createCollaboratorDraftThread(settingsThread));
    }
  }, [collaborationThreadRegistry.threadIds.length, collaboratorDraftThread, controls, createCollaboratorDraftThread, rememberCollaboratorThread, sendControlPrompt]);

  const runCollaboratorNow = useCallback(async () => {
    await startCollaboratorRun();
  }, [startCollaboratorRun]);

  useEffect(() => {
    if (!collaborationThreadRegistry.autoWakeEnabled || !isAutoWakeLeader || pendingAutoWakeActivityAt === null || collaboratorDraftHasContent) {
      return;
    }

    const delayMs = Math.max(0, WORKBENCH_COLLABORATION_AUTO_WAKE_DELAY_MS - (Date.now() - pendingAutoWakeActivityAt));
    const timeoutId = window.setTimeout(async () => {
      if (hasActiveCollaboratorRun || isSendingControlPromptRef.current || collaboratorDraftHasContent) {
        resetPendingAutoWakeActivity();
        return;
      }

      const claim = await onClaimAutoWake(projectId, autoWakeOwnerIdRef.current).catch(() => null);
      if (!claim) {
        resetPendingAutoWakeActivity();
        return;
      }

      publishRegistryIfChanged(claim.registry);
      if (!claim.acquired) {
        clearPendingAutoWakeActivity();
        return;
      }

      await startCollaboratorRun(claim.registry.threadIds.length ? "wake" : "bootstrap");
    }, delayMs);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [
    clearPendingAutoWakeActivity,
    collaborationThreadRegistry.autoWakeEnabled,
    collaboratorDraftHasContent,
    hasActiveCollaboratorRun,
    isAutoWakeLeader,
    onClaimAutoWake,
    pendingAutoWakeActivityAt,
    projectId,
    publishRegistryIfChanged,
    resetPendingAutoWakeActivity,
    startCollaboratorRun,
  ]);

  useEffect(() => {
    const thread = collaboratorThread;
    if (!thread || thread.isDraft) {
      return;
    }

    const intervalId = window.setInterval(() => {
      void hydrateCollaboratorThread(thread.id, {
        showMissingError: false,
        showLoading: false,
      });
    }, isThreadStatusActive(thread.status) ? COLLABORATOR_THREAD_ACTIVE_REFRESH_INTERVAL_MS : COLLABORATOR_THREAD_IDLE_REFRESH_INTERVAL_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [collaboratorThread, hydrateCollaboratorThread]);

  const selectCollaboratorThread = useCallback((threadId: string) => {
    setSelectedThreadId(threadId);
    publishRegistryIfChanged({
      ...collaborationThreadRegistry,
      currentThreadId: threadId,
    });
  }, [collaborationThreadRegistry, publishRegistryIfChanged]);

  const toggleAutoWake = useCallback(() => {
    const nextAutoWakeEnabled = !collaborationThreadRegistry.autoWakeEnabled;
    if (!nextAutoWakeEnabled) {
      clearPendingAutoWakeActivity();
    }

    publishRegistryIfChanged({
      ...collaborationThreadRegistry,
      autoWakeEnabled: nextAutoWakeEnabled,
    });
  }, [clearPendingAutoWakeActivity, collaborationThreadRegistry, publishRegistryIfChanged]);

  const dismissSuggestion = useCallback((suggestionId: string) => {
    setOpenSuggestionIds((current) => {
      if (!(suggestionId in current)) {
        return current;
      }

      const next = { ...current };
      delete next[suggestionId];
      return next;
    });
    const { [suggestionId]: _removedSuggestion, ...nextSuggestions } = collaborationThreadRegistry.suggestions;
    void _removedSuggestion;
    const dismissedSuggestionIds = collaborationThreadRegistry.dismissedSuggestionIds.includes(suggestionId)
      ? collaborationThreadRegistry.dismissedSuggestionIds
      : [...collaborationThreadRegistry.dismissedSuggestionIds, suggestionId];
    publishRegistryIfChanged({
      ...collaborationThreadRegistry,
      dismissedSuggestionIds,
      suggestions: nextSuggestions,
    });
  }, [collaborationThreadRegistry, publishRegistryIfChanged]);

  const openSuggestion = useCallback((suggestionId: string) => {
    setOpenSuggestionIds((current) => current[suggestionId] ? current : {
      ...current,
      [suggestionId]: true,
    });
  }, []);

  const collapseSuggestion = useCallback((suggestionId: string) => {
    setOpenSuggestionIds((current) => {
      if (!current[suggestionId]) {
        return current;
      }

      return {
        ...current,
        [suggestionId]: false,
      };
    });
  }, []);

  const hideStartedSuggestion = useCallback((suggestionId: string) => {
    setStartedSuggestionsById((current) => {
      if (!current[suggestionId]) {
        return current;
      }

      const next = { ...current };
      delete next[suggestionId];
      return next;
    });
    setOpenSuggestionIds((current) => {
      if (!(suggestionId in current)) {
        return current;
      }

      const next = { ...current };
      delete next[suggestionId];
      return next;
    });
  }, []);

  const updateSuggestionPrompt = useCallback((suggestionId: string, prompt: string) => {
    const suggestion = collaborationThreadRegistry.suggestions[suggestionId];
    if (!suggestion || suggestion.prompt === prompt) {
      return;
    }

    publishRegistryIfChanged({
      ...collaborationThreadRegistry,
      suggestions: {
        ...collaborationThreadRegistry.suggestions,
        [suggestionId]: {
          ...suggestion,
          prompt,
          updatedAt: Date.now(),
        },
      },
    });
  }, [collaborationThreadRegistry, publishRegistryIfChanged]);

  const markSuggestionStarted = useCallback((suggestion: WorkbenchCollaborationSuggestion, threadId: string) => {
    const startedSuggestionThread: WorkbenchCollaborationStartedSuggestionThread = {
      prompt: suggestion.prompt,
      startedAt: Date.now(),
      suggestionId: suggestion.id,
      threadId,
      title: suggestion.title,
      ...(suggestion.rationale ? { rationale: suggestion.rationale } : {}),
    };
    setStartedSuggestionsById((current) => ({
      ...current,
      [suggestion.id]: {
        ...suggestion,
        startedAt: startedSuggestionThread.startedAt,
        startedThreadId: threadId,
      },
    }));
    setOpenSuggestionIds((current) => {
      if (!(suggestion.id in current)) {
        return current;
      }

      const next = { ...current };
      delete next[suggestion.id];
      return next;
    });
    setSuggestionStartErrorsById((current) => {
      if (!current[suggestion.id]) {
        return current;
      }

      const next = { ...current };
      delete next[suggestion.id];
      return next;
    });
    const { [suggestion.id]: _removedSuggestion, ...nextSuggestions } = collaborationThreadRegistry.suggestions;
    void _removedSuggestion;
    const dismissedSuggestionIds = collaborationThreadRegistry.dismissedSuggestionIds.includes(suggestion.id)
      ? collaborationThreadRegistry.dismissedSuggestionIds
      : [...collaborationThreadRegistry.dismissedSuggestionIds, suggestion.id];
    publishRegistryIfChanged({
      ...collaborationThreadRegistry,
      dismissedSuggestionIds,
      startedSuggestionThreads: {
        ...collaborationThreadRegistry.startedSuggestionThreads,
        [suggestion.id]: startedSuggestionThread,
      },
      suggestions: nextSuggestions,
    });
  }, [collaborationThreadRegistry, publishRegistryIfChanged]);

  const markSuggestionStartFailed = useCallback((suggestionId: string, error: string) => {
    setSuggestionStartErrorsById((current) => ({
      ...current,
      [suggestionId]: error,
    }));
  }, []);

  const readSuggestionIdFromComposerThreadId = useCallback((threadId: string) => (
    threadId.startsWith("draft:collaboration-suggestion:")
      ? threadId.split(":").at(-1) ?? ""
      : ""
  ), []);

  const updateSuggestionDraftThread = useCallback((threadId: string, update: (thread: ThreadPayload) => ThreadPayload) => {
    const suggestionId = readSuggestionIdFromComposerThreadId(threadId);
    if (!suggestionId) {
      return;
    }

    setSuggestionDraftThreadsById((current) => {
      const existing = current[suggestionId];
      if (!existing) {
        return current;
      }

      const nextThread = update(existing);
      return nextThread === existing
        ? current
        : {
          ...current,
          [suggestionId]: nextThread,
        };
    });
  }, [readSuggestionIdFromComposerThreadId]);

  const handleSuggestionComposerDraftChange = useCallback((threadId: string, draft: Parameters<ThreadViewProps["onThreadComposerDraftChange"]>[1]) => {
    const suggestionId = readSuggestionIdFromComposerThreadId(threadId);
    if (!suggestionId) {
      return;
    }

    updateSuggestionPrompt(suggestionId, draft.text);
  }, [readSuggestionIdFromComposerThreadId, updateSuggestionPrompt]);

  const handleSuggestionComposerDraftClear = useCallback(() => { }, []);

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
      setCollaboratorRunStatus(isThreadStatusActive(payload.status) ? "running" : "idle");
    }
    return payload;
  }, [onSendMessage, rememberCollaboratorThread]);

  const handleCollaboratorStopThread = useCallback(async (thread: ThreadPayload) => {
    const payload = await onStopThread(thread);
    if (payload) {
      rememberCollaboratorThread(payload);
      setCollaboratorRunStatus(isThreadStatusActive(payload.status) ? "running" : "idle");
    }
    return payload;
  }, [onStopThread, rememberCollaboratorThread]);

  const handleCollaboratorPauseThread = useCallback(async (thread: ThreadPayload) => {
    const payload = await onPauseThread(thread);
    if (payload) {
      rememberCollaboratorThread(payload);
      setCollaboratorRunStatus(isThreadStatusActive(payload.status) ? "running" : "idle");
    }
    return payload;
  }, [onPauseThread, rememberCollaboratorThread]);

  const handleCollaboratorResumeThread = useCallback(async (thread: ThreadPayload) => {
    const payload = await onResumeThread(thread);
    if (payload) {
      rememberCollaboratorThread(payload);
      setCollaboratorRunStatus(isThreadStatusActive(payload.status) ? "running" : "idle");
    }
    return payload;
  }, [onResumeThread, rememberCollaboratorThread]);

  const updateCollaboratorDraftThread = useCallback((update: (thread: ThreadPayload) => ThreadPayload) => {
    setCollaboratorDraftThread((current) => {
      if (!current) {
        return current;
      }

      const nextThread = update(current);
      return nextThread === current ? current : nextThread;
    });
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

  const handleCollaboratorDraftComposerChange = useCallback((threadId: string, draft: CollaborationComposerDraft) => {
    if (threadId !== collaboratorDraftThread?.id) {
      return;
    }

    setCollaboratorDraftComposerDraft(draft);
  }, [collaboratorDraftThread?.id]);

  const handleCollaboratorDraftComposerClear = useCallback((threadId: string) => {
    if (threadId !== collaboratorDraftThread?.id) {
      return;
    }

    setCollaboratorDraftComposerDraft(null);
  }, [collaboratorDraftThread?.id]);

  const handleCollaboratorDraftSendMessage = useCallback(async (threadId: string, input: UserInput[]) => {
    if (!collaboratorDraftThread || threadId !== collaboratorDraftThread.id) {
      throw new Error("Collaborator draft is not ready.");
    }

    const draftThread = createCollaboratorDraftThread(collaboratorDraftThread);
    if (!draftThread) {
      throw new Error("Collaborator draft is not ready.");
    }

    const mode = collaborationThreadRegistry.threadIds.length ? "wake" : "bootstrap";
    rememberCollaboratorThread(draftThread);
    await sendControlPrompt(draftThread, mode, {
      additionalInput: input,
      replaceThreadId: draftThread.id,
      throwOnError: true,
    });
    setCollaboratorDraftThread(createCollaboratorDraftThread(collaboratorDraftThread));
    setCollaboratorDraftComposerDraft(null);
  }, [collaborationThreadRegistry.threadIds.length, collaboratorDraftThread, createCollaboratorDraftThread, rememberCollaboratorThread, sendControlPrompt]);

  const collaboratorHistory = collaborationThreadRegistry.threadIds;
  const currentCollaboratorThreadId = selectedThreadId || collaboratorHistory[0] || "";
  const currentCollaboratorSummary = currentCollaboratorThreadId ? summariesById.get(currentCollaboratorThreadId) ?? null : null;
  const currentCollaboratorPendingUserInputRequest = currentCollaboratorThreadId
    ? livePendingUserInputRequestsByThreadId[currentCollaboratorThreadId] ?? null
    : null;
  const shouldRenderCurrentCollaboratorThread = Boolean(
    collaboratorThread
    && collaboratorThread.id === currentCollaboratorThreadId
    && (
      isThreadStatusActive(collaboratorThread.status)
      || Boolean(currentCollaboratorSummary && isThreadStatusActive(currentCollaboratorSummary.status))
      || Boolean(currentCollaboratorPendingUserInputRequest)
    ),
  );
  const shouldShowCollaboratorThreadLoading = Boolean(
    isLoadingThread
    && currentCollaboratorThreadId
    && !shouldRenderCurrentCollaboratorThread
    && (
      currentCollaboratorPendingUserInputRequest
      || (currentCollaboratorSummary && isThreadStatusActive(currentCollaboratorSummary.status))
    ),
  );
  const recentCollaboratorThreadIds = [...collaboratorHistory.slice(0, 3)].reverse();
  const collaboratorStatusLabel = collaboratorRunStatus === "starting"
    ? "Starting collaborator..."
    : collaboratorRunStatus === "hydrating"
      ? "Waiting for collaborator thread..."
      : collaboratorRunStatus === "running"
        ? "Collaborator running..."
        : collaboratorRunStatus === "failed"
          ? "Collaborator needs attention"
          : "Ready";
  const autoWakeCountdownMs = pendingAutoWakeActivityAt === null
    ? null
    : Math.max(0, WORKBENCH_COLLABORATION_AUTO_WAKE_DELAY_MS - (autoWakeNow - pendingAutoWakeActivityAt));
  const autoWakeProgressPercent = autoWakeCountdownMs === null
    ? 0
    : ((WORKBENCH_COLLABORATION_AUTO_WAKE_DELAY_MS - autoWakeCountdownMs) / WORKBENCH_COLLABORATION_AUTO_WAKE_DELAY_MS) * 100;
  const isAutoWakeToggleDisabled = !controls || (!collaborationThreadRegistry.autoWakeEnabled && collaboratorDraftHasContent);

  function renderScratchpadPanel (isFocused: boolean, onFocus: () => void) {
    return (
      <WorkbenchFilePanel
        clientOptions={scratchpadClientOptions}
        contained
        controls={controls}
        editorFontClassName={editorFontClassName}
        fontSizeRem={fontSizeRem}
        isFocused={isFocused}
        onFocus={onFocus}
        path={scratchpadPath}
        showManualFileActions={false}
        spellCheck
        titleLabel="Scratchpad"
      />
    );
  }

  function renderCollaboratorPanel () {
    return (
      <div className="min-h-full min-w-0 px-5 py-5 md:px-6">
        <div className="mb-6 border-b border-[color-mix(in_srgb,var(--text)_10%,transparent)] pb-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <p className="m-0 text-[0.78rem] font-medium uppercase tracking-[0.08em] text-muted">Collaborator</p>
              <p className="mt-1 mb-0 text-[0.84rem] leading-5 text-muted">{collaboratorStatusLabel}</p>
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2 sm:justify-end">
              <button
                type="button"
                aria-pressed={collaborationThreadRegistry.autoWakeEnabled}
                title={collaboratorDraftHasContent ? "Auto-run is paused while the collaborator composer has unsent text." : "Toggle collaborator auto-run"}
                className="inline-flex h-9 items-center gap-2 rounded-full px-2.5 text-[0.82rem] font-medium text-muted transition hover:bg-[color-mix(in_srgb,var(--text)_5%,transparent)] hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft disabled:cursor-not-allowed disabled:opacity-45"
                disabled={isAutoWakeToggleDisabled}
                onClick={toggleAutoWake}
              >
                <span
                  aria-hidden="true"
                  className={joinClasses(
                    "inline-flex size-4 shrink-0 rounded-[0.28rem] border transition",
                    collaborationThreadRegistry.autoWakeEnabled
                      ? "border-[color-mix(in_srgb,var(--text)_40%,transparent)] bg-[color-mix(in_srgb,var(--text)_86%,var(--bg)_14%)]"
                      : "border-[color-mix(in_srgb,var(--text)_22%,transparent)] bg-transparent",
                  )}
                />
                <span>{collaboratorDraftHasContent ? "Auto-run paused" : "Auto-run"}</span>
                {collaborationThreadRegistry.autoWakeEnabled && autoWakeCountdownMs !== null ? (
                  <span className="inline-flex shrink-0 items-center text-muted">
                    <WorkbenchProgressWheel percent={autoWakeProgressPercent} />
                  </span>
                ) : null}
              </button>
              <PrimaryButton
                type="button"
                disabled={!controls || isSendingControlPrompt}
                onClick={() => {
                  void runCollaboratorNow();
                }}
              >
                {isSendingControlPrompt ? "Running..." : collaboratorHistory.length ? "Run now" : "Start collaborator"}
              </PrimaryButton>
            </div>
          </div>
          <div className="mt-4 flex flex-col gap-3">
            {visibleSuggestions.length ? visibleSuggestions.map((suggestion) => {
              const startedSuggestion = startedSuggestionsById[suggestion.id];
              const isSuggestionOpen = Boolean(openSuggestionIds[suggestion.id]);
              if (startedSuggestion && !(suggestion.id in collaborationThreadRegistry.suggestions)) {
                return (
                  <CollaborationSuggestionCard
                    key={suggestion.id}
                    isDimmed
                    isOpen={isSuggestionOpen}
                    onCollapse={() => {
                      collapseSuggestion(suggestion.id);
                    }}
                    onDismiss={() => {
                      hideStartedSuggestion(suggestion.id);
                      dismissSuggestion(suggestion.id);
                    }}
                    onOpen={() => {
                      openSuggestion(suggestion.id);
                    }}
                    rationale={startedSuggestion.rationale}
                    title={startedSuggestion.title}
                  >
                    <p className="mb-0 whitespace-pre-wrap px-1 pr-18 text-[0.9rem] leading-6 text-muted">{startedSuggestion.prompt}</p>
                    <div className="mt-3 flex justify-end px-1">
                      <PrimaryButton
                        type="button"
                        onClick={() => {
                          onOpenThreadFromSuggestion(startedSuggestion.startedThreadId);
                        }}
                      >
                        Go to thread
                      </PrimaryButton>
                    </div>
                  </CollaborationSuggestionCard>
                );
              }

              const suggestionComposerThread = suggestionDraftThreadsById[suggestion.id];
              const suggestionStartError = suggestionStartErrorsById[suggestion.id];
              return suggestionComposerThread ? (
                <CollaborationSuggestionCard
                  key={suggestion.id}
                  isOpen={isSuggestionOpen}
                  onCollapse={() => {
                    collapseSuggestion(suggestion.id);
                  }}
                  onDismiss={() => {
                    dismissSuggestion(suggestion.id);
                  }}
                  onOpen={() => {
                    openSuggestion(suggestion.id);
                  }}
                  rationale={suggestion.rationale}
                  title={suggestion.title}
                >
                  <ThreadComposer
                    autoExpandSavedDraftShelf={false}
                    composerSpellCheck={composerSpellCheck}
                    header={(
                      <div className="pr-18">
                        <h3 className="m-0 text-[0.98rem] font-semibold leading-5 text-text">{suggestion.title}</h3>
                        {suggestion.rationale ? (
                          <p className="mt-1 mb-0 text-[0.84rem] leading-5 text-muted">{suggestion.rationale}</p>
                        ) : null}
                      </div>
                    )}
                    highlightSources={suggestionComposerHighlightSources}
                    knownSkills={[]}
                    layout="inline"
                    onListModels={onListModels}
                    onPauseThread={() => { }}
                    onResumeThread={() => { }}
                    onSendMessage={async (_threadId, input) => {
                      const result = await onStartThreadFromPrompt(input, suggestionComposerThread);
                      if (result.status === "started") {
                        markSuggestionStarted(suggestion, result.threadId);
                        return;
                      }

                      markSuggestionStartFailed(suggestion.id, result.error);
                    }}
                    onStopThread={() => { }}
                    onSubmitUserInputRequest={onSubmitUserInputRequest}
                    onThreadAgentChange={(threadId, agentPath) => {
                      updateSuggestionDraftThread(threadId, (thread) => ({ ...thread, agentPath }));
                    }}
                    onThreadComposerDraftChange={handleSuggestionComposerDraftChange}
                    onThreadComposerDraftClear={handleSuggestionComposerDraftClear}
                    onThreadModelChange={(threadId, model) => {
                      updateSuggestionDraftThread(threadId, (thread) => ({ ...thread, model }));
                    }}
                    onThreadQuestionnaireDraftChange={onThreadQuestionnaireDraftChange}
                    onThreadQuestionnaireDraftClear={onThreadQuestionnaireDraftClear}
                    onThreadReasoningEffortChange={(threadId, reasoningEffort) => {
                      updateSuggestionDraftThread(threadId, (thread) => ({ ...thread, reasoningEffort }));
                    }}
                    onThreadSavedComposerDraftDelete={onThreadSavedComposerDraftDelete}
                    onThreadSavedComposerDraftSave={onThreadSavedComposerDraftSave}
                    onThreadServiceTierChange={(threadId, serviceTier) => {
                      updateSuggestionDraftThread(threadId, (thread) => ({ ...thread, serviceTier }));
                    }}
                    pendingUserInputRequest={null}
                    projectId={projectId}
                    projectRootPath={projectRootPath}
                    rateLimits={rateLimits}
                    sendLabel="Start"
                    showSavedDraftControls={false}
                    thread={suggestionComposerThread}
                    threadComposerDraft={{
                      attachments: [],
                      text: suggestion.prompt,
                      updatedAt: suggestion.updatedAt,
                    }}
                    threadQuestionnaireDraft={null}
                    threadSavedComposerDrafts={[]}
                    workspaceRoots={suggestionComposerWorkspaceRoots}
                  />
                  {suggestionStartError ? (
                    <p className="mt-2 mb-0 px-1 text-[0.84rem] leading-5 text-danger">{suggestionStartError}</p>
                  ) : null}
                </CollaborationSuggestionCard>
              ) : (
                <CollaborationSuggestionCard
                  key={suggestion.id}
                  isOpen={isSuggestionOpen}
                  onCollapse={() => {
                    collapseSuggestion(suggestion.id);
                  }}
                  onDismiss={() => {
                    dismissSuggestion(suggestion.id);
                  }}
                  onOpen={() => {
                    openSuggestion(suggestion.id);
                  }}
                  rationale={suggestion.rationale}
                  title={suggestion.title}
                >
                  <p className="m-0 px-1 py-4 text-[0.86rem] leading-6 text-muted">Preparing suggestion composer...</p>
                </CollaborationSuggestionCard>
              );
            }) : (
              <div className="border-t border-[color-mix(in_srgb,var(--text)_10%,transparent)] pt-4">
                <p className="m-0 text-[0.95rem] font-semibold text-text">No suggestions yet</p>
                <p className="mt-1 mb-0 text-[0.86rem] leading-6 text-muted">Run the collaborator when you want it to read the scratchpad and project state.</p>
              </div>
            )}
          </div>
        </div>

        {recentCollaboratorThreadIds.length ? (
          <section className="mb-5 space-y-3">
            <p className="m-0 text-[0.78rem] font-medium uppercase tracking-[0.08em] text-muted">Recent collaborator runs</p>
            <div className="space-y-3">
              {recentCollaboratorThreadIds.map((threadId) => {
                const summary = summariesById.get(threadId) ?? null;
                const isOpen = currentCollaboratorThreadId === threadId;
                return (
                  <ThreadDisclosure
                    key={threadId}
                    className="py-0.5"
                    contentClassName="-mt-2 pl-[1.6rem] md:pl-[1.85rem]"
                    open={isOpen}
                    onToggle={(event) => {
                      if (event.currentTarget.open) {
                        selectCollaboratorThread(threadId);
                      }
                    }}
                    summary={(
                      <span className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
                        <span className="max-w-full truncate font-semibold text-text">{getThreadLabel(threadId, summariesById)}</span>
                        <span className="text-[0.84rem] font-normal text-muted">{formatCollaboratorRunRelativeTime(summary, Date.now())}</span>
                      </span>
                    )}
                    summaryClassName="text-[0.92rem] leading-6"
                  >
                    {isOpen && shouldShowCollaboratorThreadLoading ? (
                      <p className="m-0 text-[0.86rem] leading-6 text-muted">Loading collaborator thread...</p>
                    ) : isOpen && collaboratorThread?.id === threadId ? (
                      shouldRenderCurrentCollaboratorThread ? (
                        <ThreadView
                          composerSpellCheck={composerSpellCheck}
                          contained
                          fontSizeRem={fontSizeRem}
                          hideWorkbenchControlAgentMessages
                          hideFinalAgentMessage
                          hideWorkbenchControlUserMessages
                          livePendingUserInputRequestsByThreadId={livePendingUserInputRequestsByThreadId}
                          onCompactThread={onCompactThread}
                          onDraftHarnessChange={onDraftHarnessChange}
                          onListModels={onListModels}
                          onReadThread={onReadThread}
                          onPauseThread={handleCollaboratorPauseThread}
                          onResumeThread={handleCollaboratorResumeThread}
                          onSendMessage={handleCollaboratorSendMessage}
                          onStopThread={handleCollaboratorStopThread}
                          onSubmitUserInputRequest={onSubmitUserInputRequest}
                          onThreadAgentChange={onThreadAgentChange}
                          onThreadCodeBlockWrapChange={onThreadCodeBlockWrapChange}
                          onThreadComposerDraftChange={onThreadComposerDraftChange}
                          onThreadComposerDraftClear={onThreadComposerDraftClear}
                          onThreadModelChange={onThreadModelChange}
                          onThreadQuestionnaireDraftChange={onThreadQuestionnaireDraftChange}
                          onThreadQuestionnaireDraftClear={onThreadQuestionnaireDraftClear}
                          onThreadReasoningEffortChange={onThreadReasoningEffortChange}
                          onThreadSavedComposerDraftDelete={onThreadSavedComposerDraftDelete}
                          onThreadSavedComposerDraftSave={onThreadSavedComposerDraftSave}
                          onThreadSeen={onThreadSeen}
                          onThreadServiceTierChange={onThreadServiceTierChange}
                          projectFileCandidates={projectFileCandidates}
                          projectFileIndexId={projectFileIndexId}
                          projectFileLinkRoots={projectFileLinkRoots}
                          projectFilePaths={projectFilePaths}
                          projectId={projectId}
                          projectRootPath={projectRootPath}
                          projectRoots={projectRoots}
                          rateLimits={rateLimits}
                          thread={collaboratorThread}
                          threadCodeBlockWrap={threadCodeBlockWrap}
                          threadComposerDraftsByThreadId={threadComposerDraftsByThreadId}
                          threadQuestionnaireDraftsByKey={threadQuestionnaireDraftsByKey}
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
                          inlineMentionSources={suggestionComposerHighlightSources}
                          knownSkills={[]}
                          projectFilePaths={projectFilePaths}
                          projectId={projectId}
                          projectRoots={projectRoots}
                          projectRootPath={projectRootPath}
                          thread={collaboratorThread}
                          threadCwdPath={collaboratorThread.cwd}
                        />
                      )
                    ) : (
                      <p className="m-0 text-[0.86rem] leading-6 text-muted">Select this run to load its transcript.</p>
                    )}
                  </ThreadDisclosure>
                );
              })}
            </div>
          </section>
        ) : null}

        <details className="mb-4" open={!visibleSuggestions.length}>
          <summary className="cursor-pointer list-none text-[0.78rem] font-medium uppercase tracking-[0.08em] text-muted marker:hidden">
            Collaborator run details
          </summary>
          <div className="mt-3 space-y-3">
            {currentCollaboratorThreadId ? (
              <p className="m-0 text-[0.84rem] leading-6 text-muted">
                Current run: {getThreadLabel(currentCollaboratorThreadId, summariesById)}
              </p>
            ) : null}
            {collaborationThreadRegistry.lastRunSummary ? (
              <details className="pt-1">
                <summary className="cursor-pointer list-none text-[0.78rem] font-medium text-muted marker:hidden">
                  Last private run summary
                </summary>
                <p className="mt-2 mb-0 whitespace-pre-wrap text-[0.84rem] leading-6 text-muted">{collaborationThreadRegistry.lastRunSummary}</p>
              </details>
            ) : null}
          </div>
        </details>
        {collaboratorError ? (
          <p className="mb-3 border-b border-[color-mix(in_srgb,var(--danger)_28%,transparent)] pb-3 text-[0.84rem] leading-5 text-danger">
            {collaboratorError}
          </p>
        ) : null}
        {!shouldRenderCurrentCollaboratorThread && collaboratorDraftThread ? (
          <ThreadComposer
            key={collaboratorDraftThread.id}
            composerSpellCheck={composerSpellCheck}
            highlightSources={suggestionComposerHighlightSources}
            knownSkills={[]}
            onListModels={onListModels}
            onPauseThread={() => { }}
            onResumeThread={() => { }}
            onSendMessage={handleCollaboratorDraftSendMessage}
            onStopThread={() => { }}
            onSubmitUserInputRequest={onSubmitUserInputRequest}
            onThreadAgentChange={(threadId, agentPath) => {
              if (threadId === collaboratorDraftThread.id) {
                updateCollaboratorDraftThread((thread) => ({ ...thread, agentPath }));
              }
            }}
            onThreadComposerDraftChange={handleCollaboratorDraftComposerChange}
            onThreadComposerDraftClear={handleCollaboratorDraftComposerClear}
            onThreadModelChange={(threadId, model) => {
              if (threadId === collaboratorDraftThread.id) {
                updateCollaboratorDraftThread((thread) => ({ ...thread, model }));
              }
            }}
            onThreadQuestionnaireDraftChange={onThreadQuestionnaireDraftChange}
            onThreadQuestionnaireDraftClear={onThreadQuestionnaireDraftClear}
            onThreadReasoningEffortChange={(threadId, reasoningEffort) => {
              if (threadId === collaboratorDraftThread.id) {
                updateCollaboratorDraftThread((thread) => ({ ...thread, reasoningEffort }));
              }
            }}
            onThreadSavedComposerDraftDelete={onThreadSavedComposerDraftDelete}
            onThreadSavedComposerDraftSave={onThreadSavedComposerDraftSave}
            onThreadServiceTierChange={(threadId, serviceTier) => {
              if (threadId === collaboratorDraftThread.id) {
                updateCollaboratorDraftThread((thread) => ({ ...thread, serviceTier }));
              }
            }}
            pendingUserInputRequest={null}
            projectId={projectId}
            projectRootPath={projectRootPath}
            rateLimits={rateLimits}
            sendLabel="Run with note"
            thread={collaboratorDraftThread}
            threadComposerDraft={collaboratorDraftComposerDraft}
            threadQuestionnaireDraft={null}
            threadSavedComposerDrafts={threadSavedComposerDrafts}
            workspaceRoots={suggestionComposerWorkspaceRoots}
          >
            <ThreadRateLimits
              canToggleHarness={collaboratorDraftThread.isDraft}
              harness={collaboratorDraftThread.harness}
              onHarnessToggle={cycleCollaboratorDraftHarness}
              rateLimits={rateLimits}
            />
          </ThreadComposer>
        ) : !shouldRenderCurrentCollaboratorThread ? (
          <div className="py-8">
            <p className="m-0 text-[0.95rem] font-semibold text-text">Collaborator is not ready</p>
            <p className="mt-1 mb-0 text-[0.86rem] leading-6 text-muted">Run the collaborator when the Workbench controls are ready.</p>
          </div>
        ) : null}
      </div>
    );
  }

  if (isMobile) {
    return (
      <div className="h-full min-h-0">
        <div className="flex gap-2 px-4 pt-4" role="tablist" aria-label="Collaboration panes">
          {(["scratchpad", "collaborator"] as const).map((pane) => (
            <button
              key={pane}
              type="button"
              aria-selected={mobilePane === pane}
              className={joinClasses(
                "rounded-lg px-3 py-2 text-[0.84rem] font-semibold capitalize transition",
                mobilePane === pane ? "bg-accent-soft text-accent" : "text-muted hover:bg-[color-mix(in_srgb,var(--text)_4%,transparent)] hover:text-text",
              )}
              onClick={() => {
                setMobilePane(pane);
              }}
            >
              {pane}
            </button>
          ))}
        </div>
        {mobilePane === "scratchpad" ? (
          <section className="min-h-0 min-w-0 overflow-hidden px-4 py-4">
            {renderScratchpadPanel(true, () => { })}
          </section>
        ) : (
          <section className="explorer-scrollbar min-h-0 min-w-0 overflow-y-auto">
            {renderCollaboratorPanel()}
          </section>
        )}
      </div>
    );
  }

  return (
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
            return renderScratchpadPanel(isFocused, () => {
              focusCollaborationPanel(panelId);
            });
          }
          if (target.kind === "collaborationCollaborator") {
            return renderCollaboratorPanel();
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
}
