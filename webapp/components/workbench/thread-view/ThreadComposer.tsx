/*
 * Exports:
 * - default ThreadComposer: render thread composer controls, message input, attachments, and questionnaire handoff. Keywords: composer, thread, questionnaire, model, agent.
 * - Local helpers: attachment reading, sticky composer preview rendering, saved draft shelf rendering, pending questionnaire submission options, and compact composer icons. Keywords: attachments, saved drafts, user input, controls, sticky composer.
 */
"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent, type CSSProperties, type FormEvent, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

import type { RateLimitSnapshot } from "../../../lib/codex/generated/app-server/v2/RateLimitSnapshot";
import type { UserInput } from "../../../lib/codex/generated/app-server/v2/UserInput";
import { getCurrentInProgressTurn, hasStaleApprovalState, isCurrentTurnWaitingOnApproval } from "../../../lib/codex/thread-state";
import type {
  ThreadPayload,
  WorkbenchAgentOption,
  WorkbenchComposerProfileSlot,
  WorkbenchComposerSettings,
  WorkbenchListModelsOptions,
  WorkbenchModelOption,
  WorkbenchPendingUserInputRequest,
  WorkbenchQuestionnaireDraft,
  WorkbenchSkillSummary,
  WorkbenchSubmitUserInputRequestOptions,
  WorkbenchThreadComposerDraft,
  WorkbenchThreadSavedComposerDraft,
  WorkbenchUserInputResponse,
} from "../../../lib/types";
import {
  areWorkbenchAgentPathsEqual,
  getWorkbenchAgentPathLabel,
} from "../../../lib/workbench/agent-paths";
import { readClipboardImageDataUrls } from "../../../lib/workbench/dom/clipboard";
import type { WorkspaceFileLinkRoot } from "../../../lib/workbench/markdown/markdown-links";
import {
  buildInlineMentionHighlights,
  type InlineMentionHighlightSources,
} from "../../../lib/workbench/thread/inline-mention-highlights";
import {
  WORKBENCH_PAUSE_CONTROL_KIND,
  WORKBENCH_PAUSE_PENDING_HALO_MS,
} from "../../../lib/workbench/thread/thread-pause-control";
import { isSyntheticQuestionnaireHistoryItem } from "../../../lib/workbench/thread/thread-questionnaire-history";
import { isWorkbenchSyntheticSteerUserMessage } from "../../../lib/workbench/thread/thread-steer-history";
import PrimaryButton from "../PrimaryButton";
import ChevronIcon from "../ChevronIcon";
import { PauseIcon, PlayIcon, StopIcon } from "../workbench-icons";
import PlaintextEditable, { isMobileTextInputEnvironment, useMobileTextInputEnvironment } from "./PlaintextEditable";
import ThreadAgentPicker from "./ThreadAgentPicker";
import ThreadComposerRibbon from "./ThreadComposerRibbon";
import ThreadLightboxImage from "./ThreadLightboxImage";
import ThreadModelPicker from "./ThreadModelPicker";
import ThreadProfilePicker from "./ThreadProfilePicker";
import { getComposerProfileDisplayLabel } from "./composer-profile-label";
import ThreadUserInputRequest, { getThreadUserInputRequestPreviewText } from "./ThreadUserInputRequest";
import { useWorkbenchComposerProfiles } from "../WorkbenchComposerProfileProvider";

const PICKER_REFRESH_COOLDOWN_MS = 1500;
const PICKER_REFRESH_MIN_SPIN_MS = 500;

function joinClasses (...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

async function waitForMinimumDuration (work: Promise<void>, durationMs: number): Promise<void> {
  let thrownError: unknown = null;
  await Promise.all([
    work.catch((error: unknown) => {
      thrownError = error;
    }),
    new Promise<void>((resolve) => {
      window.setTimeout(resolve, durationMs);
    }),
  ]);

  if (thrownError) {
    throw thrownError;
  }
}

function isCollapsedPreviewInteractiveTarget (
  currentTarget: HTMLElement,
  target: EventTarget | null,
) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  const interactiveTarget = target.closest("button,a,input,textarea,select,[contenteditable='true']");
  return Boolean(interactiveTarget && interactiveTarget !== currentTarget);
}

function ArchiveTrayIcon () {
  return (
    <svg viewBox="0 0 20 20" className="h-4.5 w-4.5" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.7">
      <path d="M4.25 3.75h11.5l1 4.25H3.25l1-4.25z" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M3.75 8v7.25c0 .55.45 1 1 1h10.5c.55 0 1-.45 1-1V8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M7.25 11.25h5.5" strokeLinecap="round" />
    </svg>
  );
}

function ArrowUpIcon () {
  return (
    <svg viewBox="0 0 20 20" className="h-4.5 w-4.5" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M10 15.75V4.25" strokeLinecap="round" />
      <path d="M5.75 8.5L10 4.25l4.25 4.25" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function TrashIcon () {
  return (
    <svg viewBox="0 0 20 20" className="h-4.5 w-4.5" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.7">
      <path d="M4.25 6.5h11.5" strokeLinecap="round" />
      <path d="M8.25 3.75h3.5c.28 0 .5.22.5.5V6.5h-4.5V4.25c0-.28.22-.5.5-.5z" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M6.25 6.5l.75 9c.05.52.49.9 1 .9h4c.51 0 .95-.38 1-.9l.75-9" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M8.75 9.5v4.25M11.25 9.5v4.25" strokeLinecap="round" />
    </svg>
  );
}

interface ComposerImageAttachment {
  id: string;
  url: string;
}

interface HydratedComposerDraftSnapshot {
  attachments: ComposerImageAttachment[];
  draftKey: string;
  text: string;
}

function createAttachmentId () {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `attachment:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

function cloneComposerImageAttachments(attachments: readonly ComposerImageAttachment[]) {
  return attachments.map((attachment) => ({
    id: attachment.id,
    url: attachment.url,
  }));
}

function areComposerImageAttachmentsEqual(
  left: readonly ComposerImageAttachment[],
  right: readonly ComposerImageAttachment[],
) {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((attachment, index) => {
    const candidate = right[index];
    return Boolean(candidate && attachment.id === candidate.id && attachment.url === candidate.url);
  });
}

function createSavedDraftId () {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `saved-draft:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

function isQuestionnaireFallbackAnchorItem (item: ThreadPayload["turns"][number]["items"][number]) {
  if (isWorkbenchSyntheticSteerUserMessage(item)) {
    return false;
  }

  switch (item.type) {
    case "agentMessage":
      return Boolean(item.text.trim());
    case "hookPrompt":
    case "plan":
    case "reasoning":
    case "userMessage":
      return true;
    default:
      return false;
  }
}

function getQuestionnaireFallbackAnchorIndex (items: ThreadPayload["turns"][number]["items"]) {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (isQuestionnaireFallbackAnchorItem(items[index]!)) {
      return index;
    }
  }

  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index]?.type !== "contextCompaction") {
      return index;
    }
  }

  return -1;
}

function isDurableQuestionnairePlacementItem (item: ThreadPayload["turns"][number]["items"][number]) {
  return !isSyntheticQuestionnaireHistoryItem(item)
    && !isWorkbenchSyntheticSteerUserMessage(item);
}

function buildPendingUserInputRequestSubmissionOptions (
  thread: ThreadPayload,
  pendingUserInputRequest: WorkbenchPendingUserInputRequest,
): WorkbenchSubmitUserInputRequestOptions {
  const turn = pendingUserInputRequest.turnId
    ? thread.turns.find((candidateTurn) => candidateTurn.id === pendingUserInputRequest.turnId) ?? null
    : getCurrentInProgressTurn(thread) ?? thread.turns.at(-1) ?? null;
  const insertAfterItemId = pendingUserInputRequest.itemId?.trim() ?? null;
  if (!turn) {
    return {
      insertAfterItemId,
      insertAfterItemIndex: null,
      turnId: pendingUserInputRequest.turnId ?? null,
    };
  }

  const visibleItems = turn.items.filter(isDurableQuestionnairePlacementItem);
  const requestedAnchorIndex = insertAfterItemId
    ? visibleItems.findIndex((item) => item.id === insertAfterItemId)
    : -1;
  const fallbackAnchorIndex = getQuestionnaireFallbackAnchorIndex(visibleItems);
  const resolvedAnchorIndex = requestedAnchorIndex >= 0 ? requestedAnchorIndex : fallbackAnchorIndex;
  const resolvedAnchorItem = resolvedAnchorIndex >= 0 ? visibleItems[resolvedAnchorIndex] : null;

  return {
    insertAfterItemId: resolvedAnchorItem?.id ?? insertAfterItemId,
    insertAfterItemIndex: resolvedAnchorIndex >= 0 ? resolvedAnchorIndex : null,
    turnId: pendingUserInputRequest.turnId ?? turn.id,
  };
}

function formatSavedDraftTimestamp (timestamp: number) {
  return new Date(timestamp).toLocaleString(undefined, {
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    month: "short",
  });
}

function ThreadSavedDraftShelf ({
  drafts,
  isExpanded,
  isRestoreDisabled,
  onDelete,
  onExpandChange,
  onRestore,
  shelfRef,
}: {
  drafts: WorkbenchThreadSavedComposerDraft[];
  isExpanded: boolean;
  isRestoreDisabled: boolean;
  onDelete: (draftId: string) => void;
  onExpandChange: (isExpanded: boolean) => void;
  onRestore: (draft: WorkbenchThreadSavedComposerDraft) => void;
  shelfRef: RefObject<HTMLDivElement | null>;
}) {
  if (!drafts.length) {
    return null;
  }

  return (
    <section
      ref={shelfRef}
      aria-label="Saved message drafts"
      className={joinClasses(
        "group mt-4 transition-all duration-500 ease-out motion-reduce:transition-none",
        isExpanded ? "pb-4" : "pb-1",
      )}
      onFocus={() => {
        onExpandChange(true);
      }}
      onMouseEnter={() => {
        onExpandChange(true);
      }}
    >
      <div className="flex items-center gap-2 px-1 text-[0.78em] font-medium leading-none text-muted">
        <ArchiveTrayIcon />
        <span>Saved drafts</span>
        <span className="rounded-full bg-[color-mix(in_srgb,var(--text)_8%,transparent)] px-2 py-1 text-[0.88em]">{drafts.length}</span>
      </div>
      <div className={joinClasses(
        "mt-3 grid gap-3 transition-all duration-500 ease-out motion-reduce:transition-none",
        isExpanded
          ? "translate-y-0 opacity-100"
          : "max-h-32 -translate-y-2 overflow-hidden opacity-72 [mask-image:linear-gradient(to_bottom,#000_0%,#000_48%,transparent_100%)]",
      )}>
        {(isExpanded ? drafts : drafts.slice(0, 3)).map((draft, index) => (
          <article
            key={draft.id}
            className={joinClasses(
              "rounded-[1rem] bg-[color-mix(in_srgb,var(--text)_4%,transparent)] p-3 transition-all duration-500 ease-out motion-reduce:transition-none",
              isExpanded
                ? "translate-y-0 scale-100 opacity-100"
                : "-mt-1 scale-[0.98] opacity-80",
            )}
            style={!isExpanded && index <= 2 ? { transform: `translateY(${-index * 0.42}rem) scale(${1 - index * 0.018})` } : undefined}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <p className="m-0 text-[0.74em] leading-none text-muted">
                  {formatSavedDraftTimestamp(draft.updatedAt)}
                </p>
                <p className="mt-2 mb-0 line-clamp-4 whitespace-pre-wrap break-words text-[0.9em] leading-[1.55] text-text">
                  {draft.text.trim() || (draft.attachments.length ? "Image draft" : "Empty draft")}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  aria-label="Delete saved draft"
                  title="Delete saved draft"
                  className="inline-flex size-10 items-center justify-center rounded-full border border-[color-mix(in_srgb,var(--text)_12%,transparent)] bg-[color-mix(in_srgb,var(--bg)_96%,transparent)] text-muted transition hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
                  onClick={() => {
                    onDelete(draft.id);
                  }}
                >
                  <TrashIcon />
                </button>
                <PrimaryButton
                  type="button"
                  aria-label="Restore saved draft to composer"
                  title="Restore saved draft to composer"
                  disabled={isRestoreDisabled}
                  shape="circle"
                  onClick={() => {
                    onRestore(draft);
                  }}
                >
                  <ArrowUpIcon />
                </PrimaryButton>
              </div>
            </div>
            {draft.attachments.length ? (
              <div className="mt-3 flex flex-wrap gap-2">
                {draft.attachments.map((attachment, attachmentIndex) => (
                  <ThreadLightboxImage
                    key={attachment.id}
                    alt={`Saved draft image ${attachmentIndex + 1}`}
                    buttonClassName="h-16 w-16 rounded-[0.8rem]"
                    imageClassName="h-full w-full object-cover"
                    src={attachment.url}
                  />
                ))}
              </div>
            ) : null}
          </article>
        ))}
      </div>
    </section>
  );
}

export default function ThreadComposer ({
  children,
  canToggleHarness = false,
  composerSpellCheck,
  controlsMode = "thread",
  header,
  layout = "thread",
  onListModels,
  onHarnessToggle,
  onPauseThread,
  onResumeThread,
  onSendMessage,
  onStopThread,
  onThreadComposerDraftChange,
  onThreadComposerDraftClear,
  onThreadQuestionnaireDraftChange,
  onThreadQuestionnaireDraftClear,
  onThreadSavedComposerDraftDelete,
  onThreadSavedComposerDraftSave,
  onSubmitUserInputRequest,
  onThreadAgentChange,
  onThreadReasoningEffortChange,
  onThreadServiceTierChange,
  onThreadSettingsChange,
  onThreadModelChange,
  pendingUserInputRequest,
  projectId,
  projectRootPath,
  profileSlot,
  workspaceRoots,
  rateLimits,
  autoExpandSavedDraftShelf = true,
  savedDraftShelfPortalHost,
  sendLabel = "Send",
  showSavedDraftControls = true,
  surface = "card",
  stickyMode = false,
  leadingActions,
  trailingActions,
  threadQuestionnaireDraft,
  threadComposerDraft,
  threadSavedComposerDrafts,
  useSavedDraftShelfPortal = false,
  knownSkills,
  highlightSources,
  thread,
}: {
  children?: ReactNode | ((state: { isProfilePickerOpen: boolean }) => ReactNode);
  canToggleHarness?: boolean;
  composerSpellCheck: boolean;
  controlsMode?: "comment" | "thread";
  header?: ReactNode;
  layout?: "thread" | "inline";
  onListModels: (harness: ThreadPayload["harness"], options?: WorkbenchListModelsOptions) => Promise<WorkbenchModelOption[]>;
  onHarnessToggle?: () => void;
  onPauseThread: (threadId: string) => Promise<void> | void;
  onResumeThread: (threadId: string) => Promise<void> | void;
  onSendMessage: (threadId: string, input: UserInput[]) => Promise<void>;
  onStopThread: (threadId: string) => Promise<void> | void;
  onThreadComposerDraftChange: (threadId: string, draft: WorkbenchThreadComposerDraft) => void;
  onThreadComposerDraftClear: (threadId: string) => void;
  onThreadQuestionnaireDraftChange: (threadId: string, requestKey: string, draft: WorkbenchQuestionnaireDraft) => void;
  onThreadQuestionnaireDraftClear: (threadId: string, requestKey: string) => void;
  onThreadSavedComposerDraftDelete: (draftId: string) => void;
  onThreadSavedComposerDraftSave: (draft: WorkbenchThreadSavedComposerDraft) => void;
  onSubmitUserInputRequest: (
    threadId: string,
    response: WorkbenchUserInputResponse,
    options?: WorkbenchSubmitUserInputRequestOptions,
  ) => Promise<void>;
  onThreadAgentChange: (threadId: string, agentPath: string | null) => void;
  onThreadReasoningEffortChange: (threadId: string, effort: string | null) => void;
  onThreadServiceTierChange: (threadId: string, serviceTier: string | null) => void;
  onThreadSettingsChange?: (threadId: string, settings: WorkbenchComposerSettings) => void;
  onThreadModelChange: (threadId: string, model: string) => void;
  pendingUserInputRequest: WorkbenchPendingUserInputRequest | null;
  projectId: string;
  projectRootPath: string;
  profileSlot?: WorkbenchComposerProfileSlot;
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
  rateLimits: RateLimitSnapshot | null;
  autoExpandSavedDraftShelf?: boolean;
  savedDraftShelfPortalHost?: HTMLElement | null;
  sendLabel?: string;
  showSavedDraftControls?: boolean;
  surface?: "bare" | "card";
  stickyMode?: boolean;
  leadingActions?: ReactNode;
  trailingActions?: ReactNode;
  threadQuestionnaireDraft: WorkbenchQuestionnaireDraft | null;
  threadComposerDraft: WorkbenchThreadComposerDraft | null;
  threadSavedComposerDrafts: WorkbenchThreadSavedComposerDraft[];
  useSavedDraftShelfPortal?: boolean;
  knownSkills: WorkbenchSkillSummary[];
  highlightSources: InlineMentionHighlightSources;
  thread: ThreadPayload;
}) {
  const { controller: composerProfileController, snapshot: composerProfileSnapshot } = useWorkbenchComposerProfiles();
  const [value, setValue] = useState(threadComposerDraft?.text ?? "");
  const [attachments, setAttachments] = useState<ComposerImageAttachment[]>(threadComposerDraft?.attachments ?? []);
  const [availableModels, setAvailableModels] = useState<WorkbenchModelOption[]>([]);
  const [availableAgents, setAvailableAgents] = useState<WorkbenchAgentOption[]>([]);
  const [deprioritizedModelIdsByHarness, setDeprioritizedModelIdsByHarness] = useState<Record<ThreadPayload["harness"], string[]>>({
    codex: [],
    copilot: [],
    opencode: [],
  });
  const [activePicker, setActivePicker] = useState<"agent" | "model" | "profile" | null>(null);
  const [error, setError] = useState("");
  const [isComposing, setIsComposing] = useState(false);
  const [isLoadingAgents, setIsLoadingAgents] = useState(false);
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const [isAgentRefreshPending, setIsAgentRefreshPending] = useState(false);
  const [isAgentRefreshCoolingDown, setIsAgentRefreshCoolingDown] = useState(false);
  const [isModelRefreshPending, setIsModelRefreshPending] = useState(false);
  const [isModelRefreshCoolingDown, setIsModelRefreshCoolingDown] = useState(false);
  const [agentsError, setAgentsError] = useState("");
  const [modelsError, setModelsError] = useState("");
  const [isQuestionnaireVisible, setIsQuestionnaireVisible] = useState(Boolean(pendingUserInputRequest));
  const [pendingAttachmentReads, setPendingAttachmentReads] = useState(0);
  const [pauseRequestedAt, setPauseRequestedAt] = useState<number | null>(null);
  const [isSending, setIsSending] = useState(false);
  const [isPausing, setIsPausing] = useState(false);
  const [isResuming, setIsResuming] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [isSavedDraftShelfExpanded, setIsSavedDraftShelfExpanded] = useState(false);
  const [isStickyComposerArmed, setIsStickyComposerArmed] = useState(false);
  const [stickyComposerMotionState, setStickyComposerMotionState] = useState<"idle" | "entering" | "leaving">("idle");
  const [isStickyComposerCollapsed, setIsStickyComposerCollapsed] = useState(false);
  const [stickyExpandedHeightPx, setStickyExpandedHeightPx] = useState(0);
  const acknowledgedDraftKeyRef = useRef(`${thread.id}:${threadComposerDraft?.updatedAt ?? 0}`);
  const hydratedDraftSnapshotRef = useRef<HydratedComposerDraftSnapshot | null>(threadComposerDraft
    ? {
      attachments: cloneComposerImageAttachments(threadComposerDraft.attachments),
      draftKey: `${thread.id}:${threadComposerDraft.updatedAt}`,
      text: threadComposerDraft.text,
    }
    : null);
  const previousStickyComposerArmedRef = useRef(false);
  const agentLoadGenerationRef = useRef(0);
  const modelLoadGenerationRef = useRef(0);
  const agentRefreshCooldownTimeoutRef = useRef<number | null>(null);
  const modelRefreshCooldownTimeoutRef = useRef<number | null>(null);
  const isComposerMountedRef = useRef(true);
  const stickyTopSentinelRef = useRef<HTMLDivElement>(null);
  const stickySurfaceRef = useRef<HTMLDivElement>(null);
  const stickyExpandedRef = useRef<HTMLDivElement>(null);
  const savedDraftShelfRef = useRef<HTMLDivElement>(null);
  const onThreadComposerDraftChangeRef = useRef(onThreadComposerDraftChange);
  const onThreadComposerDraftClearRef = useRef(onThreadComposerDraftClear);

  onThreadComposerDraftChangeRef.current = onThreadComposerDraftChange;
  onThreadComposerDraftClearRef.current = onThreadComposerDraftClear;
  const isCommentMode = controlsMode === "comment";
  const trimmedValue = value.trim();
  const isAttaching = pendingAttachmentReads > 0;
  const hasPendingUserInputRequest = pendingUserInputRequest !== null;
  const hiddenPauseRequest = pendingUserInputRequest?.hidden && pendingUserInputRequest.controlKind === WORKBENCH_PAUSE_CONTROL_KIND
    ? pendingUserInputRequest
    : null;
  const visiblePendingUserInputRequest = pendingUserInputRequest && !pendingUserInputRequest.hidden
    ? pendingUserInputRequest
    : null;
  const hasVisiblePendingUserInputRequest = visiblePendingUserInputRequest !== null;
  const questionnaireRequestKey = pendingUserInputRequest?.requestKey ?? "";
  const showQuestionnairePanel = hasVisiblePendingUserInputRequest && isQuestionnaireVisible;
  const isCopilotAuthRequired = thread.harness === "copilot" && rateLimits?.limitId === "copilot:auth";
  const isThreadStateBroken = hasStaleApprovalState(thread);
  const isApprovalBlocked = isCurrentTurnWaitingOnApproval(thread);
  const isActiveThread = getCurrentInProgressTurn(thread) !== null;
  const isInputDisabled = isSending || isAttaching || isThreadStateBroken || isCopilotAuthRequired;
  const isSendDisabled = isInputDisabled;
  const isSaveDraftDisabled = hasPendingUserInputRequest || isInputDisabled || (!trimmedValue && !attachments.length);
  const isStopDisabled = !isActiveThread || isStopping;
  const isPauseRequestPending = pauseRequestedAt !== null && !hiddenPauseRequest;
  const isPauseDisabled = !isActiveThread || isPausing || isResuming || isPauseRequestPending;
  const isResumeDisabled = !hiddenPauseRequest || isResuming;
  const isMobileTextInput = useMobileTextInputEnvironment();
  const helperText = hiddenPauseRequest
    ? "Paused. Send a steer or resume the agent."
    : hasVisiblePendingUserInputRequest
      ? "\xa0"
      : isAttaching
        ? "Attaching pasted image..."
        : isCopilotAuthRequired
          ? "Open a terminal, run copilot, then use /login to authenticate Copilot CLI."
          : isThreadStateBroken
            ? "Thread state is out of sync. Sending is disabled here."
            : isApprovalBlocked
              ? ""
              : isActiveThread
                ? isMobileTextInput
                  ? ""
                  : ""
                : thread.isDraft
                  ? ""
                  : isMobileTextInput
                    ? ""
                    : "";
  const selectedModel = thread.model;
  const selectedModelOption = availableModels.find((model) => model.id === selectedModel) ?? null;
  const defaultModelOption = availableModels.find((model) => model.isDefault) ?? null;
  const modelOptionForControls = selectedModelOption ?? defaultModelOption;
  const modelButtonLabel = selectedModelOption?.displayName
    ?? selectedModel
    ?? defaultModelOption?.displayName
    ?? "Default model";
  const supportedReasoningEfforts = modelOptionForControls?.supportedReasoningEfforts ?? [];
  const currentReasoningEffort = thread.reasoningEffort
    ?? modelOptionForControls?.defaultReasoningEffort
    ?? supportedReasoningEfforts[0]
    ?? null;
  const showsThreadControls = !isCommentMode;
  const showsReasoningEffortControl = showsThreadControls && Boolean(modelOptionForControls?.supportsReasoningEffort && currentReasoningEffort);
  const showsFastModeControl = showsThreadControls && thread.harness === "codex" && Boolean(modelOptionForControls?.supportsFastMode);
  const isFastModeEnabled = thread.serviceTier === "fast";
  const isAgentPickerOpen = showsThreadControls && activePicker === "agent";
  const isModelPickerOpen = showsThreadControls && activePicker === "model";
  const isProfilePickerOpen = showsThreadControls && activePicker === "profile";
  const isPickerOpen = activePicker !== null;
  const composerPlaceholder = isCommentMode
    ? "Write a comment..."
    : isThreadStateBroken
    ? "New messages are disabled for this thread."
    : isCopilotAuthRequired
      ? "Sign in to Copilot CLI to send messages."
      : isActiveThread
        ? "Message the current turn..."
        : thread.isDraft
          ? "Start a new thread..."
          : "Continue this thread...";
  const showStopButton = !isCommentMode && (isActiveThread || isStopping);
  const selectedAgent = availableAgents.find((agent) => areWorkbenchAgentPathsEqual(agent.path, thread.agentPath)) ?? null;
  const agentButtonLabel = selectedAgent?.name
    ?? getWorkbenchAgentPathLabel(thread.agentPath)
    ?? "Default agent";
  const profileSelection = profileSlot
    ? composerProfileController.getSelection(profileSlot)
    : { kind: "custom" } as const;
  const selectedProfile = profileSelection.kind === "profile"
    ? composerProfileController.getProfile(profileSelection.profileId)
    : null;
  const profileButtonLabel = selectedProfile ? getComposerProfileDisplayLabel(selectedProfile, agentButtonLabel, modelButtonLabel) : "Custom";
  const currentComposerSettings: WorkbenchComposerSettings = {
    agentPath: thread.agentPath,
    agentSource: selectedAgent?.source ?? null,
    harness: thread.harness,
    model: selectedModel ?? modelOptionForControls?.id ?? "",
    reasoningEffort: currentReasoningEffort,
    serviceTier: isFastModeEnabled ? "fast" : null,
  };
  void composerProfileSnapshot;
  const deprioritizedModelIds = deprioritizedModelIdsByHarness[thread.harness] ?? [];
  const loadAvailableAgents = useCallback((options: { clearBeforeLoad?: boolean } = {}): Promise<void> => {
    const generation = agentLoadGenerationRef.current + 1;
    agentLoadGenerationRef.current = generation;

    if (isCommentMode) {
      setAvailableAgents([]);
      setAgentsError("");
      setIsLoadingAgents(false);
      return Promise.resolve();
    }

    if (options.clearBeforeLoad) {
      setAvailableAgents([]);
    }
    setAgentsError("");
    setIsLoadingAgents(true);

    return fetch(`/api/agents?projectId=${encodeURIComponent(projectId)}`, { cache: "no-store" }).then(async (response) => {
      if (!response.ok) {
        throw new Error("Unable to load agents.");
      }

      const payload = await response.json() as { data?: WorkbenchAgentOption[] };
      if (agentLoadGenerationRef.current !== generation) {
        return;
      }

      setAvailableAgents(payload.data ?? []);
      setAgentsError("");
    }).catch((agentsLoadError) => {
      if (agentLoadGenerationRef.current !== generation) {
        return;
      }

      setAgentsError(agentsLoadError instanceof Error ? agentsLoadError.message : "Unable to load agents.");
    }).finally(() => {
      if (agentLoadGenerationRef.current === generation) {
        setIsLoadingAgents(false);
      }
    });
  }, [isCommentMode, projectId]);
  const loadAvailableModels = useCallback((options: { clearBeforeLoad?: boolean; forceRefresh?: boolean; harness?: ThreadPayload["harness"]; showErrors?: boolean; showLoading?: boolean } = {}): Promise<void> => {
    const {
      clearBeforeLoad = false,
      forceRefresh = false,
      harness = thread.harness,
      showErrors = true,
      showLoading = true,
    } = options;
    const generation = modelLoadGenerationRef.current + 1;
    modelLoadGenerationRef.current = generation;

    if (isCommentMode) {
      setAvailableModels([]);
      setModelsError("");
      setIsLoadingModels(false);
      return Promise.resolve();
    }

    if (clearBeforeLoad) {
      setAvailableModels([]);
    }
    if (showErrors) {
      setModelsError("");
    }
    if (showLoading) {
      setIsLoadingModels(true);
    }

    return onListModels(harness, { forceRefresh }).then((models) => {
      if (modelLoadGenerationRef.current !== generation) {
        return;
      }

      setAvailableModels(models);
      if (showErrors) {
        setModelsError("");
      }
    }).catch((modelsLoadError) => {
      if (modelLoadGenerationRef.current !== generation) {
        return;
      }

      if (showErrors) {
        setModelsError(modelsLoadError instanceof Error ? modelsLoadError.message : "Unable to load models.");
      }
    }).finally(() => {
      if (modelLoadGenerationRef.current === generation && showLoading) {
        setIsLoadingModels(false);
      }
    });
  }, [isCommentMode, onListModels, thread.harness]);
  const refreshAvailableAgents = useCallback(() => {
    if (isLoadingAgents || isAgentRefreshPending || isAgentRefreshCoolingDown) {
      return;
    }

    if (agentRefreshCooldownTimeoutRef.current !== null) {
      window.clearTimeout(agentRefreshCooldownTimeoutRef.current);
      agentRefreshCooldownTimeoutRef.current = null;
    }

    setIsAgentRefreshPending(true);
    setIsAgentRefreshCoolingDown(true);
    void waitForMinimumDuration(loadAvailableAgents(), PICKER_REFRESH_MIN_SPIN_MS).finally(() => {
      if (!isComposerMountedRef.current) {
        return;
      }

      setIsAgentRefreshPending(false);
      agentRefreshCooldownTimeoutRef.current = window.setTimeout(() => {
        agentRefreshCooldownTimeoutRef.current = null;
        setIsAgentRefreshCoolingDown(false);
      }, PICKER_REFRESH_COOLDOWN_MS);
    });
  }, [isAgentRefreshCoolingDown, isAgentRefreshPending, isLoadingAgents, loadAvailableAgents]);
  const refreshAvailableModels = useCallback(() => {
    if (isLoadingModels || isModelRefreshPending || isModelRefreshCoolingDown) {
      return;
    }

    if (modelRefreshCooldownTimeoutRef.current !== null) {
      window.clearTimeout(modelRefreshCooldownTimeoutRef.current);
      modelRefreshCooldownTimeoutRef.current = null;
    }

    setIsModelRefreshPending(true);
    setIsModelRefreshCoolingDown(true);
    void waitForMinimumDuration(loadAvailableModels({
      forceRefresh: true,
      showErrors: true,
      showLoading: true,
    }), PICKER_REFRESH_MIN_SPIN_MS).finally(() => {
      if (!isComposerMountedRef.current) {
        return;
      }

      setIsModelRefreshPending(false);
      modelRefreshCooldownTimeoutRef.current = window.setTimeout(() => {
        modelRefreshCooldownTimeoutRef.current = null;
        setIsModelRefreshCoolingDown(false);
      }, PICKER_REFRESH_COOLDOWN_MS);
    });
  }, [isLoadingModels, isModelRefreshCoolingDown, isModelRefreshPending, loadAvailableModels]);
  const handleQuestionnaireDraftChange = useCallback((draft: WorkbenchQuestionnaireDraft) => {
    onThreadQuestionnaireDraftChange(thread.id, questionnaireRequestKey, draft);
  }, [onThreadQuestionnaireDraftChange, questionnaireRequestKey, thread.id]);
  const handleQuestionnaireDraftClear = useCallback(() => {
    onThreadQuestionnaireDraftClear(thread.id, questionnaireRequestKey);
  }, [onThreadQuestionnaireDraftClear, questionnaireRequestKey, thread.id]);
  const composerHighlights = useMemo(() => (
    buildInlineMentionHighlights(value, highlightSources)
  ), [highlightSources, value]);

  useEffect(() => {
    isComposerMountedRef.current = true;

    return () => {
      isComposerMountedRef.current = false;
      if (agentRefreshCooldownTimeoutRef.current !== null) {
        window.clearTimeout(agentRefreshCooldownTimeoutRef.current);
      }
      if (modelRefreshCooldownTimeoutRef.current !== null) {
        window.clearTimeout(modelRefreshCooldownTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const draftKey = `${thread.id}:${threadComposerDraft?.updatedAt ?? 0}`;
    if (acknowledgedDraftKeyRef.current === draftKey) {
      return;
    }

    const hydratedDraftSnapshot = hydratedDraftSnapshotRef.current;

    const isStillAtHydratedDraft = Boolean(
      hydratedDraftSnapshot
      && value === hydratedDraftSnapshot.text
      && areComposerImageAttachmentsEqual(attachments, hydratedDraftSnapshot.attachments),
    );
    if ((value.trim() || attachments.length) && threadComposerDraft && !isStillAtHydratedDraft) {
      acknowledgedDraftKeyRef.current = draftKey;
      return;
    }

    const nextText = threadComposerDraft?.text ?? "";
    const nextAttachments = cloneComposerImageAttachments(threadComposerDraft?.attachments ?? []);
    acknowledgedDraftKeyRef.current = draftKey;
    hydratedDraftSnapshotRef.current = {
      attachments: nextAttachments,
      draftKey,
      text: nextText,
    };
    setValue(nextText);
    setAttachments(nextAttachments);
  }, [attachments, thread.id, threadComposerDraft, value]);

  useEffect(() => {
    if (hasPendingUserInputRequest) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      if (!value.trim() && attachments.length === 0) {
        onThreadComposerDraftClearRef.current(thread.id);
        return;
      }

      onThreadComposerDraftChangeRef.current(thread.id, {
        attachments,
        text: value,
        updatedAt: Date.now(),
      });
    }, 260);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [attachments, hasPendingUserInputRequest, thread.id, value]);

  useEffect(() => {
    setActivePicker(null);
    setAgentsError("");
    setModelsError("");
    setIsQuestionnaireVisible(Boolean(visiblePendingUserInputRequest));
  }, [thread.id, visiblePendingUserInputRequest?.request.id]);

  useEffect(() => {
    if (hiddenPauseRequest) {
      setPauseRequestedAt(null);
      setIsPausing(false);
      return;
    }

    if (pauseRequestedAt === null) {
      return;
    }

    const remainingMs = Math.max(0, WORKBENCH_PAUSE_PENDING_HALO_MS - (Date.now() - pauseRequestedAt));
    const timeoutId = window.setTimeout(() => {
      setPauseRequestedAt(null);
      setIsPausing(false);
    }, remainingMs);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [hiddenPauseRequest, pauseRequestedAt]);

  useEffect(() => {
    if (!autoExpandSavedDraftShelf) {
      return;
    }

    const element = savedDraftShelfRef.current;
    if (!element || typeof IntersectionObserver === "undefined") {
      return;
    }

    const observer = new IntersectionObserver(([entry]) => {
      setIsSavedDraftShelfExpanded(Boolean(entry?.isIntersecting));
    }, {
      rootMargin: "0px 0px -18% 0px",
      threshold: 0.22,
    });
    observer.observe(element);

    return () => {
      observer.disconnect();
    };
  }, [autoExpandSavedDraftShelf, threadSavedComposerDrafts.length]);

  useEffect(() => {
    void loadAvailableAgents({ clearBeforeLoad: true });

    return () => {
      agentLoadGenerationRef.current += 1;
    };
  }, [loadAvailableAgents]);

  useEffect(() => {
    void loadAvailableModels({
      clearBeforeLoad: true,
      showErrors: false,
      showLoading: false,
    });

    return () => {
      modelLoadGenerationRef.current += 1;
    };
  }, [loadAvailableModels]);

  useEffect(() => {
    if (!stickyMode) {
      setIsStickyComposerArmed(false);
      return;
    }

    const sentinelElement = stickyTopSentinelRef.current;
    if (!sentinelElement) {
      setIsStickyComposerArmed(true);
      return;
    }

    let frameId: number | null = null;
    const updateArmedState = () => {
      frameId = null;
      setIsStickyComposerArmed(sentinelElement.getBoundingClientRect().top > window.innerHeight);
    };

    const requestUpdateArmedState = () => {
      if (frameId !== null) {
        return;
      }

      frameId = window.requestAnimationFrame(updateArmedState);
    };

    updateArmedState();

    window.addEventListener("scroll", requestUpdateArmedState, { passive: true });
    window.addEventListener("resize", requestUpdateArmedState);
    return () => {
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }

      window.removeEventListener("scroll", requestUpdateArmedState);
      window.removeEventListener("resize", requestUpdateArmedState);
    };
  }, [stickyMode, thread.id]);

  useEffect(() => {
    if (!stickyMode) {
      return;
    }

    const sentinelElement = stickyTopSentinelRef.current;
    if (!sentinelElement) {
      return;
    }

    setIsStickyComposerArmed(sentinelElement.getBoundingClientRect().top > window.innerHeight);
  }, [stickyMode, thread]);

  useEffect(() => {
    if (!stickyMode) {
      previousStickyComposerArmedRef.current = false;
      setStickyComposerMotionState("idle");
      return;
    }

    const previousIsArmed = previousStickyComposerArmedRef.current;
    if (previousIsArmed === isStickyComposerArmed) {
      return;
    }

    previousStickyComposerArmedRef.current = isStickyComposerArmed;
    setStickyComposerMotionState(isStickyComposerArmed ? "entering" : "leaving");
    const timeoutId = window.setTimeout(() => {
      setStickyComposerMotionState("idle");
    }, 240);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [isStickyComposerArmed, stickyMode]);

  useEffect(() => {
    if (!stickyMode || typeof ResizeObserver === "undefined") {
      return;
    }

    const expandedElement = stickyExpandedRef.current;
    const surfaceElement = stickySurfaceRef.current;
    if (!expandedElement || !surfaceElement) {
      return;
    }

    const updateHeight = () => {
      const surfaceStyle = window.getComputedStyle(surfaceElement);
      const verticalPadding = (
        (Number.parseFloat(surfaceStyle.paddingTop) || 0) +
        (Number.parseFloat(surfaceStyle.paddingBottom) || 0)
      );
      const nextHeight = expandedElement.getBoundingClientRect().height + verticalPadding;
      setStickyExpandedHeightPx((currentHeight) => (
        Math.abs(currentHeight - nextHeight) < 0.5 ? currentHeight : nextHeight
      ));
    };
    updateHeight();
    const frameId = window.requestAnimationFrame(updateHeight);

    const observer = new ResizeObserver(updateHeight);
    observer.observe(expandedElement);
    observer.observe(surfaceElement);
    return () => {
      window.cancelAnimationFrame(frameId);
      observer.disconnect();
    };
  }, [stickyMode, isStickyComposerArmed, isStickyComposerCollapsed, showQuestionnairePanel, isPickerOpen, attachments.length, helperText, value, visiblePendingUserInputRequest?.request.id]);

  useEffect(() => {
    if (isCommentMode || !isModelPickerOpen) {
      return;
    }

    void loadAvailableModels({
      showErrors: true,
      showLoading: true,
    });

    return () => {
      modelLoadGenerationRef.current += 1;
    };
  }, [isCommentMode, isModelPickerOpen, loadAvailableModels]);

  const buildSavedDraftFromComposer = useCallback((): WorkbenchThreadSavedComposerDraft | null => {
    if (!value.trim() && attachments.length === 0) {
      return null;
    }

    const timestamp = Date.now();
    return {
      attachments,
      createdAt: timestamp,
      id: createSavedDraftId(),
      text: value,
      updatedAt: timestamp,
    };
  }, [attachments, value]);

  const saveCurrentComposerForLater = useCallback(() => {
    const draft = buildSavedDraftFromComposer();
    if (!draft || isSaveDraftDisabled) {
      return;
    }

    onThreadSavedComposerDraftSave(draft);
    setValue("");
    setAttachments([]);
    setError("");
    onThreadComposerDraftClearRef.current(thread.id);
    setIsSavedDraftShelfExpanded(true);
  }, [buildSavedDraftFromComposer, isSaveDraftDisabled, onThreadSavedComposerDraftSave, thread.id]);

  const restoreSavedDraft = useCallback((draft: WorkbenchThreadSavedComposerDraft) => {
    if (hasPendingUserInputRequest || isInputDisabled) {
      return;
    }

    const currentDraft = buildSavedDraftFromComposer();
    if (currentDraft) {
      onThreadSavedComposerDraftSave(currentDraft);
    }
    onThreadSavedComposerDraftDelete(draft.id);
    setValue(draft.text);
    setAttachments(draft.attachments);
    setError("");
    onThreadComposerDraftChangeRef.current(thread.id, {
      attachments: draft.attachments,
      text: draft.text,
      updatedAt: Date.now(),
    });
    setIsSavedDraftShelfExpanded(false);
  }, [buildSavedDraftFromComposer, hasPendingUserInputRequest, isInputDisabled, onThreadSavedComposerDraftDelete, onThreadSavedComposerDraftSave, thread.id]);

  const submit = async () => {
    if ((!trimmedValue && !attachments.length) || isSendDisabled || isPickerOpen) {
      return;
    }

    const input: UserInput[] = [];
    if (trimmedValue) {
      input.push({
        type: "text",
        text: trimmedValue,
        text_elements: [],
      });
    }
    for (const attachment of attachments) {
      input.push({
        type: "image",
        url: attachment.url,
      });
    }

    const submittedValue = value;
    const submittedAttachments = attachments;
    setIsSending(true);
    setError("");
    setValue("");
    setAttachments([]);
    onThreadComposerDraftClearRef.current(thread.id);
    try {
      await onSendMessage(thread.id, input);
      onThreadComposerDraftClearRef.current(thread.id);
    } catch (submissionError) {
      setValue(submittedValue);
      setAttachments(submittedAttachments);
      setError(submissionError instanceof Error ? submissionError.message : "Unable to send that message.");
    } finally {
      setIsSending(false);
    }
  };

  const stop = async () => {
    if (isStopDisabled || isPickerOpen) {
      return;
    }

    setIsStopping(true);
    setError("");
    try {
      await onStopThread(thread.id);
    } catch (stopError) {
      setError(stopError instanceof Error ? stopError.message : "Unable to stop that turn.");
    } finally {
      setIsStopping(false);
    }
  };

  const pause = async () => {
    if (isPauseDisabled || isPickerOpen) {
      return;
    }

    setIsPausing(true);
    setPauseRequestedAt(Date.now());
    setError("");
    try {
      await onPauseThread(thread.id);
    } catch (pauseError) {
      setPauseRequestedAt(null);
      setError(pauseError instanceof Error ? pauseError.message : "Unable to pause that turn.");
    } finally {
      setIsPausing(false);
    }
  };

  const resume = async () => {
    if (isResumeDisabled || isPickerOpen) {
      return;
    }

    setIsResuming(true);
    setError("");
    try {
      await onResumeThread(thread.id);
      setPauseRequestedAt(null);
    } catch (resumeError) {
      setError(resumeError instanceof Error ? resumeError.message : "Unable to resume that turn.");
    } finally {
      setIsResuming(false);
    }
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void submit();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" || event.shiftKey || isComposing) {
      return;
    }

    if (isMobileTextInputEnvironment()) {
      return;
    }

    event.preventDefault();
    void submit();
  };

  const handlePaste = (event: ClipboardEvent<HTMLDivElement>) => {
    const hasImage = Array.from(event.clipboardData.items).some((item) => item.type.startsWith("image/"));
    if (!hasImage) {
      return;
    }

    event.preventDefault();
    setError("");
    setPendingAttachmentReads((count) => count + 1);
    void (async () => {
      try {
        const nextAttachments = (await readClipboardImageDataUrls(event.clipboardData.items)).map((image) => ({
          id: createAttachmentId(),
          url: image.url,
        }));
        setAttachments((current) => [...current, ...nextAttachments]);
      } catch (pasteError) {
        setError(pasteError instanceof Error ? pasteError.message : "Unable to attach the pasted image.");
      } finally {
        setPendingAttachmentReads((count) => Math.max(0, count - 1));
      }
    })();
  };

  const applyDirectSettingsChange = (
    nextSettings: WorkbenchComposerSettings,
    applyCustomChange: () => void,
  ) => {
    if (profileSelection.kind === "profile" && profileSlot && onThreadSettingsChange) {
      onThreadSettingsChange(thread.id, nextSettings);
      composerProfileController.selectCustom(profileSlot);
      return;
    }

    applyCustomChange();
  };

  const cycleReasoningEffort = (direction: 1 | -1) => {
    if (!supportedReasoningEfforts.length || !currentReasoningEffort) {
      return;
    }

    const currentIndex = supportedReasoningEfforts.indexOf(currentReasoningEffort);
    const baseIndex = currentIndex >= 0 ? currentIndex : 0;
    const nextIndex = (baseIndex + direction + supportedReasoningEfforts.length) % supportedReasoningEfforts.length;
    const nextEffort = supportedReasoningEfforts[nextIndex] ?? null;
    applyDirectSettingsChange(
      { ...currentComposerSettings, reasoningEffort: nextEffort },
      () => onThreadReasoningEffortChange(thread.id, nextEffort),
    );
  };

  const pauseButton = showStopButton || hiddenPauseRequest || isPauseRequestPending ? (
    <PrimaryButton
      type="button"
      aria-label={hiddenPauseRequest ? (isResuming ? "Resuming paused agent" : "Resume paused agent") : isPauseRequestPending ? "Pause request pending" : "Pause current turn"}
      title={hiddenPauseRequest ? (isResuming ? "Resuming paused agent" : "Resume paused agent") : isPauseRequestPending ? "Pause request pending" : "Pause current turn"}
      disabled={hiddenPauseRequest ? isResumeDisabled : isPauseDisabled}
      pendingHalo={isPauseRequestPending}
      shape="circle"
      onClick={() => {
        void (hiddenPauseRequest ? resume() : pause());
      }}
    >
      {hiddenPauseRequest ? <PlayIcon className="h-4.5 w-4.5" /> : <PauseIcon className="h-4.5 w-4.5" />}
    </PrimaryButton>
  ) : null;

  const stopButton = showStopButton ? (
    <PrimaryButton
      type="button"
      aria-label={isStopping ? "Stopping current turn" : "Stop current turn"}
      title={isStopping ? "Stopping current turn" : "Stop current turn"}
      disabled={isStopDisabled}
      shape="circle"
      onClick={() => {
        void stop();
      }}
    >
      <StopIcon className="h-4.5 w-4.5" />
    </PrimaryButton>
  ) : null;
  const questionnaireToggleButton = hasVisiblePendingUserInputRequest ? (
    <button
      type="button"
      aria-label={showQuestionnairePanel ? "Show composer" : "Show questionnaire"}
      title={showQuestionnairePanel ? "Show composer" : "Show questionnaire"}
      className={joinClasses(
        "inline-flex size-10 items-center justify-center rounded-full border transition",
        showQuestionnairePanel
          ? "border-[color-mix(in_srgb,var(--text)_18%,transparent)] bg-[color-mix(in_srgb,var(--text)_8%,transparent)] text-text"
          : "border-[color-mix(in_srgb,var(--text)_12%,transparent)] bg-[color-mix(in_srgb,var(--bg)_96%,transparent)] text-muted hover:text-text",
      )}
      onClick={() => {
        setIsQuestionnaireVisible((current) => !current);
      }}
    >
      <svg viewBox="0 0 20 20" className="h-5 w-5" aria-hidden="true">
        <path d="M5.25 5.5h9.5M5.25 10h9.5M5.25 14.5h5.2" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.7" />
        <path d="M3.2 5.5h.1M3.2 10h.1M3.2 14.5h.1" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="2.4" />
      </svg>
    </button>
  ) : null;

  const savedDraftShelf = (
    <ThreadSavedDraftShelf
      drafts={threadSavedComposerDrafts}
      isExpanded={isSavedDraftShelfExpanded}
      isRestoreDisabled={hasPendingUserInputRequest || isInputDisabled}
      onDelete={onThreadSavedComposerDraftDelete}
      onExpandChange={setIsSavedDraftShelfExpanded}
      onRestore={restoreSavedDraft}
      shelfRef={savedDraftShelfRef}
    />
  );

  const questionnairePreviewText = visiblePendingUserInputRequest
    ? getThreadUserInputRequestPreviewText(visiblePendingUserInputRequest.request)
    : "";
  const stickyPreviewKind = questionnairePreviewText
    ? "questionnaire"
    : trimmedValue
      ? "draft"
      : "placeholder";
  const stickyPreviewText = (
    questionnairePreviewText || trimmedValue || composerPlaceholder
  ).replace(/\s+/g, " ").trim();
  const collapsedAttachmentPreviews = attachments.slice(0, 3);
  const hiddenAttachmentCount = Math.max(0, attachments.length - collapsedAttachmentPreviews.length);
  const stickyCollapseLabel = isStickyComposerCollapsed ? "Expand composer" : "Collapse composer";
  const stickyCollapseButton = (
    <button
      type="button"
      aria-expanded={!isStickyComposerCollapsed}
      aria-label={stickyCollapseLabel}
      title={stickyCollapseLabel}
      className="inline-flex size-9 items-center justify-center rounded-full text-muted transition hover:bg-[color-mix(in_srgb,var(--text)_5%,transparent)] hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
      onClick={() => {
        setIsStickyComposerCollapsed((current) => !current);
      }}
    >
      <ChevronIcon
        className={joinClasses(
          "size-4 transition-transform",
          isStickyComposerCollapsed ? "-rotate-90" : "rotate-90",
        )}
      />
    </button>
  );
  const handleCollapsedPreviewClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (isCollapsedPreviewInteractiveTarget(event.currentTarget, event.target)) {
      return;
    }

    setIsStickyComposerCollapsed(false);
  };
  const handleCollapsedPreviewKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }

    if (isCollapsedPreviewInteractiveTarget(event.currentTarget, event.target)) {
      return;
    }

    event.preventDefault();
    setIsStickyComposerCollapsed(false);
  };
  const effectiveSurface = stickyMode ? "bare" : surface;
  const stickyHostStyle = stickyExpandedHeightPx > 0
    ? { "--thread-composer-expanded-height": `${stickyExpandedHeightPx}px` } as CSSProperties
    : undefined;
  const showComposerControlRow = !showQuestionnairePanel && !isModelPickerOpen && !isAgentPickerOpen && !isProfilePickerOpen;
  const hasNormalComposerSupplementalContent = attachments.length > 0 || Boolean(helperText);
  const activeComposerMode = showQuestionnairePanel
    ? "questionnaire"
    : isModelPickerOpen
      ? "model"
      : isAgentPickerOpen
        ? "agent"
        : isProfilePickerOpen
          ? "profile"
        : "composer";
  const isComposerPanelActive = activeComposerMode === "composer";
  const isQuestionnairePanelActive = activeComposerMode === "questionnaire";
  const isModelPickerPanelActive = activeComposerMode === "model";
  const isAgentPickerPanelActive = activeComposerMode === "agent";
  const isProfilePickerPanelActive = activeComposerMode === "profile";
  const composerForm = (
      <form
        className={joinClasses(
          layout === "thread" && !stickyMode
            ? "mt-6 border-t border-[color-mix(in_srgb,var(--text)_10%,transparent)] pt-4"
            : "m-0",
        )}
        onSubmit={handleSubmit}
      >
        <div className={effectiveSurface === "card" ? "rounded-[1.15rem] bg-[color-mix(in_srgb,var(--text)_4%,transparent)] p-3" : "p-0"}>
          {header ? (
            <div className="mb-3 px-1">
              {header}
            </div>
          ) : null}
          <div className="thread-composer-mode-stack" data-active-mode={activeComposerMode}>
            {visiblePendingUserInputRequest ? (
              <div
                aria-hidden={!isQuestionnairePanelActive}
                className="thread-composer-mode-panel thread-composer-sticky-questionnaire-frame"
                data-active={isQuestionnairePanelActive ? "true" : "false"}
                inert={!isQuestionnairePanelActive}
              >
                <ThreadUserInputRequest
                  actions={stopButton}
                  draft={threadQuestionnaireDraft}
                  highlightSources={highlightSources}
                  knownSkills={knownSkills}
                  leadingActions={questionnaireToggleButton}
                  spellCheck={composerSpellCheck}
                  onDraftChange={handleQuestionnaireDraftChange}
                  onDraftClear={handleQuestionnaireDraftClear}
                  projectRootPath={projectRootPath}
                  request={visiblePendingUserInputRequest.request}
                  workspaceRoots={workspaceRoots}
                  mode="live"
                  onSubmit={async (response, supplementalInput) => {
                    await onSubmitUserInputRequest(
                      thread.id,
                      response,
                      {
                        ...buildPendingUserInputRequestSubmissionOptions(thread, visiblePendingUserInputRequest),
                        ...(supplementalInput?.length ? { supplementalInput } : {}),
                      },
                    );
                  }}
                />
              </div>
            ) : null}
            <div
              aria-hidden={!isComposerPanelActive}
              className="thread-composer-mode-panel thread-composer-sticky-form-content"
              data-active={isComposerPanelActive ? "true" : "false"}
              inert={!isComposerPanelActive}
            >
              <span className="sr-only">{isCommentMode ? "Write comment" : "Message thread"}</span>
              <PlaintextEditable
                id={`thread-composer:${thread.id}`}
                ariaLabel={isCommentMode ? "Write comment" : "Message thread"}
                className="thread-plaintext-editable min-h-[5.75rem] w-full border-0 bg-transparent px-1 py-1 text-[0.96em] leading-[1.65] text-text outline-none"
                disabled={isInputDisabled}
                placeholder={composerPlaceholder}
                highlights={composerHighlights}
                mentionSources={highlightSources}
                mentionSuggestionsPlacement="above"
                spellCheck={composerSpellCheck}
                value={value}
                onChange={(nextValue) => {
                  setValue(nextValue);
                  if (error) {
                    setError("");
                  }
                }}
                onCompositionStart={() => {
                  setIsComposing(true);
                }}
                onCompositionEnd={() => {
                  setIsComposing(false);
                }}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
              />
              {hasNormalComposerSupplementalContent ? (
                <div className="mt-3 space-y-3">
                  {attachments.length ? (
                    <div className="flex flex-wrap gap-3 px-1">
                      {attachments.map((attachment, index) => (
                        <div key={attachment.id} className="relative h-24 w-24">
                          <ThreadLightboxImage
                            alt={`Attached image ${index + 1}`}
                            buttonClassName="h-full w-full rounded-[0.95rem]"
                            imageClassName="h-full w-full object-cover"
                            src={attachment.url}
                          />
                          <button
                            type="button"
                            aria-label={`Remove attached image ${index + 1}`}
                            title="Remove attached image"
                            className="absolute top-1.5 right-1.5 z-10 inline-flex h-7 w-7 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--bg)_82%,transparent)] text-text shadow-sm transition hover:bg-[color-mix(in_srgb,var(--bg)_92%,transparent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
                            onClick={() => {
                              setAttachments((current) => current.filter((currentAttachment) => currentAttachment.id !== attachment.id));
                            }}
                          >
                            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" aria-hidden="true">
                              <path
                                d="M4 4l8 8M12 4l-8 8"
                                fill="none"
                                stroke="currentColor"
                                strokeLinecap="round"
                                strokeWidth="1.8"
                              />
                            </svg>
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : null}
                    {helperText ? (
                      <p className={joinClasses(
                        attachments.length ? "mt-2 mb-0 px-1 text-[0.78em] leading-[1.6]" : "m-0 px-1 text-[0.78em] leading-[1.6]",
                        isThreadStateBroken ? "text-danger" : "text-muted",
                      )}>
                        {helperText}
                      </p>
                    ) : null}
                </div>
              ) : null}
              {showComposerControlRow ? (
                <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    {questionnaireToggleButton}
                  </div>
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    {showSavedDraftControls ? (
                      <button
                        type="button"
                        aria-label="Save message draft for later"
                        title="Save message draft for later"
                        disabled={isSaveDraftDisabled}
                        className={joinClasses(
                          "inline-flex size-10 items-center justify-center rounded-full border transition",
                          "border-[color-mix(in_srgb,var(--text)_12%,transparent)] bg-[color-mix(in_srgb,var(--bg)_96%,transparent)] text-muted hover:text-text",
                          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft",
                          isSaveDraftDisabled && "cursor-not-allowed opacity-45",
                        )}
                        onClick={saveCurrentComposerForLater}
                      >
                        <ArchiveTrayIcon />
                      </button>
                    ) : null}
                    {showsThreadControls ? (
                    <ThreadComposerRibbon
                      agentLabel={agentButtonLabel}
                      currentReasoningEffort={currentReasoningEffort}
                      isFastModeEnabled={isFastModeEnabled}
                      isProfilePanelOpen={isProfilePickerOpen}
                      modelLabel={modelButtonLabel}
                      profileLabel={profileButtonLabel}
                      selectedProfileLabel={selectedProfile ? profileButtonLabel : null}
                      showsFastModeControl={showsFastModeControl}
                      showsReasoningEffortControl={showsReasoningEffortControl}
                      onAgentOpen={() => setActivePicker("agent")}
                      onFastModeToggle={() => {
                        const serviceTier = isFastModeEnabled ? null : "fast";
                        applyDirectSettingsChange(
                          { ...currentComposerSettings, serviceTier },
                          () => onThreadServiceTierChange(thread.id, serviceTier),
                        );
                      }}
                      onModelOpen={() => setActivePicker("model")}
                      onProfileOpen={() => setActivePicker((current) => current === "profile" ? null : "profile")}
                      onReasoningEffortCycle={cycleReasoningEffort}
                    />
                    ) : null}
                    {leadingActions}
                    <PrimaryButton
                      type="submit"
                      disabled={(!trimmedValue && !attachments.length) || isSendDisabled}
                      className="text-[0.84em]"
                    >
                      {isSending ? "Sending..." : isAttaching ? "Attaching..." : isThreadStateBroken ? "Unavailable" : sendLabel}
                    </PrimaryButton>
                    {trailingActions}
                    {pauseButton}
                    {stopButton}
                  </div>
                </div>
              ) : null}
            </div>
            {showsThreadControls ? (
              <>
                <div
                  aria-hidden={!isModelPickerPanelActive}
                  className="thread-composer-mode-panel"
                  data-active={isModelPickerPanelActive ? "true" : "false"}
                  inert={!isModelPickerPanelActive}
                >
                  <ThreadModelPicker
                    appliesOnNextTurnOnly={thread.harness === "codex" && isActiveThread}
                    deprioritizedModelIds={deprioritizedModelIds}
                    error={modelsError}
                    harness={thread.harness}
                    isLoading={isLoadingModels}
                    isRefreshDisabled={isLoadingModels || isModelRefreshPending || isModelRefreshCoolingDown}
                    isRefreshing={isModelRefreshPending}
                    models={availableModels}
                    selectedModelId={selectedModel}
                    onClose={() => {
                      setActivePicker(null);
                    }}
                    onRefresh={refreshAvailableModels}
                    onSelectModel={(model) => {
                      const nextSettings: WorkbenchComposerSettings = {
                        ...currentComposerSettings,
                        model: model.id,
                        reasoningEffort: model.supportsReasoningEffort
                          ? model.defaultReasoningEffort ?? model.supportedReasoningEfforts[0] ?? null
                          : null,
                        serviceTier: model.supportsFastMode ? currentComposerSettings.serviceTier : null,
                      };
                      applyDirectSettingsChange(nextSettings, () => {
                        onThreadModelChange(thread.id, model.id);
                        if (!model.supportsFastMode && isFastModeEnabled) {
                          onThreadServiceTierChange(thread.id, null);
                        }
                      });
                      setModelsError("");
                      setActivePicker(null);
                    }}
                    onToggleModelPriority={(modelId) => {
                      setDeprioritizedModelIdsByHarness((current) => {
                        const currentIds = current[thread.harness] ?? [];
                        const nextIds = currentIds.includes(modelId)
                          ? currentIds.filter((id) => id !== modelId)
                          : [...currentIds, modelId];

                        return {
                          ...current,
                          [thread.harness]: nextIds,
                        };
                      });
                    }}
                  />
                </div>
                <div
                  aria-hidden={!isAgentPickerPanelActive}
                  className="thread-composer-mode-panel"
                  data-active={isAgentPickerPanelActive ? "true" : "false"}
                  inert={!isAgentPickerPanelActive}
                >
                  <ThreadAgentPicker
                    agents={availableAgents}
                    error={agentsError}
                    isLoading={isLoadingAgents}
                    isRefreshDisabled={isLoadingAgents || isAgentRefreshPending || isAgentRefreshCoolingDown}
                    isRefreshing={isAgentRefreshPending}
                    selectedAgentPath={thread.agentPath}
                    onClose={() => {
                      setActivePicker(null);
                    }}
                    onRefresh={refreshAvailableAgents}
                    onSelectAgent={(agentPath) => {
                      const agent = availableAgents.find((candidate) => areWorkbenchAgentPathsEqual(candidate.path, agentPath)) ?? null;
                      applyDirectSettingsChange(
                        { ...currentComposerSettings, agentPath, agentSource: agent?.source ?? null },
                        () => onThreadAgentChange(thread.id, agentPath),
                      );
                      setActivePicker(null);
                    }}
                  />
                </div>
                <div
                  aria-hidden={!isProfilePickerPanelActive}
                  className="thread-composer-mode-panel"
                  data-active={isProfilePickerPanelActive ? "true" : "false"}
                  inert={!isProfilePickerPanelActive}
                >
                  {profileSlot ? (
                    <ThreadProfilePicker
                      agents={availableAgents}
                      agentsError={agentsError}
                      canToggleHarness={canToggleHarness}
                      currentSettings={currentComposerSettings}
                      deprioritizedModelIds={deprioritizedModelIds}
                      isAgentRefreshDisabled={isLoadingAgents || isAgentRefreshPending || isAgentRefreshCoolingDown}
                      isAgentRefreshing={isAgentRefreshPending}
                      isLoadingAgents={isLoadingAgents}
                      isLoadingModels={isLoadingModels}
                      isModelRefreshDisabled={isLoadingModels || isModelRefreshPending || isModelRefreshCoolingDown}
                      isModelRefreshing={isModelRefreshPending}
                      models={availableModels}
                      modelsError={modelsError}
                      projectId={projectId}
                      slot={profileSlot}
                      onClose={() => setActivePicker(null)}
                      onHarnessToggle={onHarnessToggle}
                      onLoadModels={(harness, forceRefresh = false) => loadAvailableModels({ clearBeforeLoad: true, forceRefresh, harness, showErrors: true, showLoading: true })}
                      onRefreshAgents={refreshAvailableAgents}
                    />
                  ) : null}
                </div>
              </>
            ) : null}
          </div>
        </div>
        {error ? (
          <p className="mt-2 mb-0 text-[0.84em] leading-[1.6] text-danger">{error}</p>
        ) : null}
      </form>
  );
  const composerContent = stickyMode ? (
    <>
      <div ref={stickyTopSentinelRef} className="thread-composer-sticky-top-sentinel" aria-hidden="true" />
      <div
        className="thread-composer-sticky-host"
        data-collapsed={isStickyComposerCollapsed ? "true" : "false"}
        data-sticky-armed={isStickyComposerArmed ? "true" : "false"}
        data-sticky-motion={stickyComposerMotionState}
        style={stickyHostStyle}
      >
      <div className="thread-composer-sticky-spacer" aria-hidden="true" />
      <div className="thread-composer-sticky-shell">
        <div
          ref={stickySurfaceRef}
          className="thread-composer-sticky-surface"
          data-collapsed={isStickyComposerCollapsed ? "true" : "false"}
        >
          <div ref={stickyExpandedRef} className="thread-composer-sticky-expanded">
            <div className="thread-composer-sticky-collapse-button-slot">
              {stickyCollapseButton}
            </div>
            <div className="min-w-0">
              {composerForm}
            </div>
          </div>
          <div
            role="button"
            tabIndex={0}
            aria-label="Expand composer"
            className="thread-composer-sticky-collapsed"
            onClick={handleCollapsedPreviewClick}
            onKeyDown={handleCollapsedPreviewKeyDown}
          >
            <span className="thread-composer-sticky-collapsed-chevron" aria-hidden="true">
              <ChevronIcon className="size-4 -rotate-90" />
            </span>
            <span className="thread-composer-sticky-collapsed-text" data-preview-kind={stickyPreviewKind}>
              {stickyPreviewText}
            </span>
            {collapsedAttachmentPreviews.length ? (
              <span className="thread-composer-sticky-collapsed-attachments">
                {collapsedAttachmentPreviews.map((attachment, index) => (
                  <span
                    key={attachment.id}
                    onClick={(event) => {
                      event.stopPropagation();
                    }}
                  >
                    <ThreadLightboxImage
                      alt={`Attached image ${index + 1}`}
                      buttonClassName="size-10 rounded-[0.75rem]"
                      imageClassName="h-full w-full object-cover"
                      src={attachment.url}
                    />
                  </span>
                ))}
                {hiddenAttachmentCount ? (
                  <span className="inline-flex size-10 items-center justify-center rounded-[0.75rem] bg-[color-mix(in_srgb,var(--text)_6%,transparent)] text-[0.76em] font-medium text-muted">
                    +{hiddenAttachmentCount}
                  </span>
                ) : null}
              </span>
            ) : null}
          </div>
        </div>
      </div>
      </div>
    </>
  ) : composerForm;

  return (
    <>
      {composerContent}
      {typeof children === "function" ? children({ isProfilePickerOpen }) : children}
      {showSavedDraftControls
        ? useSavedDraftShelfPortal
          ? (savedDraftShelfPortalHost ? createPortal(savedDraftShelf, savedDraftShelfPortalHost) : null)
          : savedDraftShelf
        : null}
    </>
  );
}
