/*
 * Exports:
 * - default ThreadComposer: render thread composer controls, message input, attachments, and questionnaire handoff.
 */
"use client";

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type ClipboardEvent, type FormEvent, type KeyboardEvent, type ReactNode } from "react";

import type { RateLimitSnapshot } from "workbench-shared/codex/generated/app-server/v2/RateLimitSnapshot";
import type { UserInput } from "workbench-shared/codex/generated/app-server/v2/UserInput";
import { getCurrentInProgressTurn, hasStaleApprovalState, isCurrentTurnWaitingOnApproval } from "workbench-shared/codex/thread-state";
import type {
  ThreadPayload,
  WorkbenchComposerProfileSlot,
  WorkbenchComposerSettings,
  WorkbenchListModelsOptions,
  WorkbenchModelOption,
  WorkbenchSkillSummary,
  WorkbenchComposerInputDraft,
} from "workbench-shared/types";
import { useWorkbenchDaemonClient } from "../WorkbenchDaemonClientContext";
import {
  areWorkbenchAgentPathsEqual,
  getWorkbenchAgentPathLabel,
} from "workbench-shared/workbench/agent-paths";
import { readClipboardImageDataUrls } from "../../../workbench/dom/clipboard";
import type { WorkspaceFileLinkRoot } from "../../../workbench/markdown/markdown-links";
import {
  buildInlineMentionHighlights,
  getActivatedWorkbenchSkillPaths,
  type InlineMentionHighlightSources,
} from "../../../workbench/thread/inline-mention-highlights";
import { runThreadComposerSubmission } from "../../../workbench/thread/thread-message-submission";
import {
  createWorkbenchThreadRecoveryInput,
  isWorkbenchThreadRecoveryEligible,
} from "workbench-shared/workbench/thread/thread-recovery-message";
import type { WorkbenchThreadRouteTarget as WorkbenchThreadTarget } from "workbench-shared/workbench/thread/thread-state";
import PrimaryButton from "../PrimaryButton";
import StickyCollapsibleSurface from "../StickyCollapsibleSurface";
import { PlayIcon, QuestionnaireListIcon, SendHorizontalIcon, SnoozedThreadIcon, SquareIcon, XIcon } from "../workbench-icons";
import useWorkbenchQuestionnaire from "../use-workbench-questionnaire";
import PlaintextEditable from "./PlaintextEditable";
import { isMobileTextInputEnvironment, useMobileTextInputEnvironment } from "./mobile-text-input-environment";
import ThreadComposerRibbon from "./ThreadComposerRibbon";
import ThreadProfileQuickPicker from "./ThreadProfileQuickPicker";
import type { DraftUpdate } from "./DraftSessionController";
import { useDraftSession } from "./use-draft-session";
import ThreadLightboxImage from "./ThreadLightboxImage";
import ThreadProfileEditor from "./ThreadProfileEditor";
import ThreadProfileEditorController, { type ProfileEditorSection } from "./ThreadProfileEditorController";
import { getComposerProfileDisplayLabel } from "./composer-profile-label";
import ThreadUserInputRequest from "./ThreadUserInputRequest";
import { getThreadComposerStopControlState } from "./thread-composer-controls";
import { getThreadUserInputRequestPreviewText } from "./thread-user-input-request-preview";
import { buildPendingUserInputRequestSubmissionOptions } from "./thread-user-input-request-submission";
import { useThreadScrollViewportContext } from "./thread-scroll-viewport-context";
import { useWorkbenchComposerProfiles } from "../WorkbenchComposerProfileContext";

function joinClasses (...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
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
  onHarnessSelect,
  onSendMessage,
  onStopThread,
  onThreadComposerDraftChange,
  onThreadComposerDraftClear,
  onQuestionnaireError,
  onThreadAgentChange,
  onThreadReasoningEffortChange,
  onThreadServiceTierChange,
  onThreadSettingsChange,
  onThreadModelChange,
  projectId,
  projectRootPath,
  profileSlot,
  workspaceRoots,
  rateLimits,
  sendLabel = "Send",
  surface = "card",
  stickyMode = false,
  leadingActions,
  trailingActions,
  threadComposerDraft,
  knownSkills,
  highlightSources,
  thread,
  threadTarget,
}: {
  children?: ReactNode | ((state: { isProfilePickerOpen: boolean }) => ReactNode);
  canToggleHarness?: boolean;
  composerSpellCheck: boolean;
  controlsMode?: "comment" | "thread";
  header?: ReactNode;
  layout?: "thread" | "inline";
  onListModels: (harness: ThreadPayload["harness"], options?: WorkbenchListModelsOptions) => Promise<WorkbenchModelOption[]>;
  onHarnessToggle?: () => void;
  onHarnessSelect?: (harness: ThreadPayload["harness"]) => void;
  onSendMessage: (
    threadId: string,
    input: UserInput[],
    options?: { activatedSkillPaths?: string[] },
  ) => Promise<void>;
  onStopThread: (threadId: string) => Promise<void> | void;
  onThreadComposerDraftChange: (projectId: string, threadId: string, update: DraftUpdate<WorkbenchComposerInputDraft>, reason?: "autosave" | "submission", target?: WorkbenchThreadTarget, detached?: boolean) => Promise<WorkbenchComposerInputDraft | null>;
  onThreadComposerDraftClear: (projectId: string, threadId: string, target?: WorkbenchThreadTarget) => Promise<void> | void;
  onQuestionnaireError?: (message: string) => void;
  onThreadAgentChange: (threadId: string, agentPath: string | null) => void;
  onThreadReasoningEffortChange: (threadId: string, effort: string | null) => void;
  onThreadServiceTierChange: (threadId: string, serviceTier: string | null) => void;
  onThreadSettingsChange?: (threadId: string, settings: WorkbenchComposerSettings) => void;
  onThreadModelChange: (threadId: string, model: string) => void;
  projectId: string;
  projectRootPath: string;
  profileSlot?: WorkbenchComposerProfileSlot;
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
  rateLimits: RateLimitSnapshot | null;
  sendLabel?: string;
  surface?: "bare" | "card";
  stickyMode?: boolean;
  leadingActions?: ReactNode;
  trailingActions?: ReactNode;
  threadComposerDraft: WorkbenchComposerInputDraft | null;
  knownSkills: WorkbenchSkillSummary[];
  highlightSources: InlineMentionHighlightSources;
  thread: ThreadPayload;
  threadTarget?: WorkbenchThreadTarget | null;
}) {
  const daemon = useWorkbenchDaemonClient();
  const questionnaire = useWorkbenchQuestionnaire(projectId, thread.isDraft ? null
    : threadTarget?.kind === "subagent" && threadTarget.threadId === thread.id ? threadTarget
    : { kind: "provider", harness: thread.harness, threadId: thread.id }, onQuestionnaireError);
  const threadController = questionnaire.thread;
  const sidebarEntry = threadController.state.entry;
  const threadLifecycle = sidebarEntry?.lifecycle ?? null;
  const pendingUserInputRequest = questionnaire.request;
  const threadQuestionnaireDraft = questionnaire.draft;
  const { controller: composerProfileController, snapshot: composerProfileSnapshot } = useWorkbenchComposerProfiles();
  const {
    isWithinBottomDistance,
    reportComposerArmed,
  } = useThreadScrollViewportContext();
  const composerTarget = useMemo<WorkbenchThreadTarget>(() => thread.isDraft
    ? threadTarget ?? { kind: "draft", draftId: thread.id }
    : { kind: "provider", harness: thread.harness, threadId: thread.id },
  [thread.harness, thread.id, thread.isDraft, threadTarget]);
  const emptyDraft = useMemo<WorkbenchComposerInputDraft>(() => ({ attachments: [], text: "", updatedAt: 0 }), []);
  const editing = useDraftSession(threadComposerDraft ?? emptyDraft, {
    empty: () => emptyDraft,
    save: (update, options) => onThreadComposerDraftChange(projectId, thread.id, update, options.reason, composerTarget, options.detached),
  });
  const [profileEditor] = useState(() => new ThreadProfileEditorController());
  const editorState = useSyncExternalStore(profileEditor.subscribe, profileEditor.getSnapshot, profileEditor.getSnapshot);
  const [editorAnchor, setEditorAnchor] = useState<{ trigger: HTMLElement; ribbon: HTMLElement } | null>(null);
  const availableModels = editorState.models;
  const availableAgents = editorState.agents;
  const [localError, setError] = useState("");
  const error = localError || editing.error || composerProfileSnapshot.error;
  const [isComposing, setIsComposing] = useState(false);
  const [isQuestionnaireVisible, setIsQuestionnaireVisible] = useState(Boolean(pendingUserInputRequest));
  const isSending = editing.isSubmitting;
  const value = isSending ? "" : editing.draft.text;
  const attachments = isSending ? [] : editing.draft.attachments;
  const [isRecoveringInterruptedTurn, setIsRecoveringInterruptedTurn] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [isStickyComposerCollapsed, setIsStickyComposerCollapsed] = useState(false);
  const isCommentMode = controlsMode === "comment";
  const trimmedValue = value.trim();
  const isAttaching = editing.isAttaching;
  const hasPendingUserInputRequest = pendingUserInputRequest !== null;
  const visiblePendingUserInputRequest = pendingUserInputRequest;
  const hasVisiblePendingUserInputRequest = visiblePendingUserInputRequest !== null;
  const questionnaireRequestKey = pendingUserInputRequest?.requestKey ?? "";
  const showQuestionnairePanel = hasVisiblePendingUserInputRequest && isQuestionnaireVisible;
  const isCopilotAuthRequired = thread.harness === "copilot" && rateLimits?.limitId === "copilot:auth";
  const isThreadStateBroken = hasStaleApprovalState(thread);
  const isApprovalBlocked = isCurrentTurnWaitingOnApproval(thread);
  const isActiveThread = getCurrentInProgressTurn(thread) !== null;
  const hasEffectiveProfile = !profileSlot || Boolean(composerProfileController.resolveSettings(profileSlot)?.model);
  const canRecoverInterruptedTurn = isWorkbenchThreadRecoveryEligible(thread, threadLifecycle, hasPendingUserInputRequest, controlsMode);
  const isInputDisabled = isSending || isRecoveringInterruptedTurn || isAttaching || isThreadStateBroken || isCopilotAuthRequired;
  const isSendDisabled = isInputDisabled || (!isActiveThread && !hasEffectiveProfile);
  const stopControlState = getThreadComposerStopControlState({
    hasPendingUserInputRequest, isActiveThread, isCommentMode, isStopping,
    canSnoozeQuestionnaire: sidebarEntry?.entryKind === "thread" && !sidebarEntry.metadata.archived && !isApprovalBlocked,
    snoozed: sidebarEntry?.entryKind === "thread" && sidebarEntry.metadata.snoozed,
  });
  const isStopDisabled = stopControlState.disabled;
  const isMobileTextInput = useMobileTextInputEnvironment();
  const helperText = !hasEffectiveProfile
      ? composerProfileSnapshot.error
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
  const modelOptionForControls = selectedModel ? selectedModelOption : defaultModelOption;
  const modelButtonLabel = selectedModelOption?.displayName
    ?? selectedModel
    ?? "Default model";
  const supportedReasoningEfforts = modelOptionForControls?.supportedReasoningEfforts ?? [];
  const currentReasoningEffort = thread.reasoningEffort;
  const showsThreadControls = !isCommentMode;
  const showsReasoningEffortControl = showsThreadControls && Boolean(modelOptionForControls?.supportsReasoningEffort);
  const showsFastModeControl = showsThreadControls && thread.harness === "codex" && Boolean(modelOptionForControls?.supportsFastMode);
  const isFastModeEnabled = thread.serviceTier === "fast";
  const isProfilePickerOpen = showsThreadControls && editorState.open;
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
  const showStopButton = stopControlState.visible;
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
  const profileButtonLabel = selectedProfile
    ? getComposerProfileDisplayLabel(selectedProfile, agentButtonLabel, modelButtonLabel)
    : "Custom";
  const currentComposerSettings: WorkbenchComposerSettings = (profileSlot ? composerProfileController.resolveSettings(profileSlot) : null) ?? {
    agentPath: thread.agentPath,
    agentSource: selectedAgent?.source ?? null,
    harness: thread.harness,
    model: selectedModel ?? modelOptionForControls?.id ?? "",
    reasoningEffort: currentReasoningEffort,
    serviceTier: isFastModeEnabled ? "fast" : null,
    contextWindowTokens: thread.contextWindowTokens,
  };
  void composerProfileSnapshot;
  const openProfileEditor = (section: ProfileEditorSection, trigger: HTMLElement, ribbon: HTMLElement) => {
    setEditorAnchor({ trigger, ribbon });
    profileEditor.toggle(section);
    void composerProfileController.refreshProfiles();
  };
  const loadAvailableAgents = useCallback(() => profileEditor.loadAgents(async () => {
    const payload = await daemon.request("agents/list", { projectId });
    return payload.data ?? [];
  }), [daemon, profileEditor, projectId]);
  const loadAvailableModels = useCallback((forceRefresh = false) => profileEditor.loadModels(
    () => onListModels(thread.harness, { forceRefresh }),
  ), [onListModels, profileEditor, thread.harness]);
  const composerHighlights = useMemo(() => (
    buildInlineMentionHighlights(value, highlightSources)
  ), [highlightSources, value]);

  useEffect(() => {
    setIsQuestionnaireVisible(Boolean(visiblePendingUserInputRequest));
  }, [thread.id, visiblePendingUserInputRequest?.request.id]);

  useEffect(() => {
    profileEditor.close();
    setEditorAnchor(null);
  }, [thread.id, projectId, profileEditor]);
  useEffect(() => {
    profileEditor.resetAgents();
    if (!isCommentMode) void loadAvailableAgents();
    return () => profileEditor.resetAgents();
  }, [isCommentMode, profileEditor, loadAvailableAgents]);
  useEffect(() => {
    profileEditor.resetModels();
    if (!isCommentMode) void loadAvailableModels();
    return () => profileEditor.resetModels();
  }, [isCommentMode, profileEditor, loadAvailableModels]);

  const submit = async () => {
    if ((!trimmedValue && !attachments.length) || isSendDisabled) {
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

    const activatedSkillPaths = getActivatedWorkbenchSkillPaths(composerHighlights);
    setError("");
    await editing.session.submit(async (submitted, options) => {
      return await runThreadComposerSubmission({
        clearDurableDraft: () => onThreadComposerDraftClear(projectId, thread.id, composerTarget),
        preserveDurableDraft: async () => {
          await onThreadComposerDraftChange(projectId, thread.id, () => submitted, "submission", composerTarget, options.detached);
        },
        send: () => onSendMessage(thread.id, input, {
          ...(activatedSkillPaths.length ? { activatedSkillPaths } : {}),
        }),
        showError: setError,
      });
    });
  };

  const stop = async () => {
    if (isStopDisabled) {
      return;
    }

    setIsStopping(true);
    setError("");
    try {
      if (stopControlState.action === "snooze") {
        await threadController.actions.snoozeQuestionnaire(questionnaireRequestKey);
      } else {
        await onStopThread(thread.id);
      }
    } catch (stopError) {
      setError(stopError instanceof Error ? stopError.message : "Unable to update that turn.");
    } finally {
      setIsStopping(false);
    }
  };

  const recoverInterruptedTurn = async () => {
    if (!canRecoverInterruptedTurn || isRecoveringInterruptedTurn || !hasEffectiveProfile) {
      return;
    }

    setIsRecoveringInterruptedTurn(true);
    setError("");
    try {
      await onSendMessage(thread.id, createWorkbenchThreadRecoveryInput());
    } catch (resumeError) {
      setError(resumeError instanceof Error ? resumeError.message : "Unable to resume that interrupted turn.");
    } finally {
      setIsRecoveringInterruptedTurn(false);
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
    void editing.session.attachImages(() => readClipboardImageDataUrls(event.clipboardData.items));
  };

  const applyDirectSettingsChange = (
    nextSettings: WorkbenchComposerSettings,
    applyCustomChange: () => void,
  ) => {
    if (profileSlot && onThreadSettingsChange) {
      onThreadSettingsChange(thread.id, nextSettings);
      composerProfileController.selectCustom(profileSlot, nextSettings);
      return;
    }

    applyCustomChange();
  };

  const changeReasoningEffort = (nextEffort: string) => {
    applyDirectSettingsChange(
      { ...currentComposerSettings, reasoningEffort: nextEffort },
      () => onThreadReasoningEffortChange(thread.id, nextEffort),
    );
  };

  const stopLabel = stopControlState.action === "snooze" ? "Snooze questionnaire" : isActiveThread ? "Stop current turn" : "Dismiss questionnaire";
  const stoppingLabel = stopControlState.action === "snooze" ? "Snoozing questionnaire" : "Stopping current turn";
  const stopButton = showStopButton ? (
    <PrimaryButton
      type="button"
      aria-label={isStopping ? stoppingLabel : stopLabel}
      title={stopLabel}
      disabled={isStopDisabled}
      shape="circle"
      onClick={() => {
        void stop();
      }}
    >
      {stopControlState.action === "snooze" ? <SnoozedThreadIcon size={18} /> : <SquareIcon size={18} />}
    </PrimaryButton>
  ) : null;
  const resumeButton = canRecoverInterruptedTurn ? (
    <PrimaryButton
      type="button"
      aria-label={isRecoveringInterruptedTurn ? "Resuming thread" : "Resume thread"}
      title={isRecoveringInterruptedTurn ? "Resuming thread" : "Resume thread"}
      disabled={isRecoveringInterruptedTurn || !hasEffectiveProfile}
      shape="circle"
      onClick={() => {
        void recoverInterruptedTurn();
      }}
    >
      <PlayIcon size={18} />
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
      <QuestionnaireListIcon size={20} />
    </button>
  ) : null;

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
  const effectiveSurface = stickyMode ? "bare" : surface;
  const showComposerControlRow = !showQuestionnairePanel;
  const hasNormalComposerSupplementalContent = attachments.length > 0 || Boolean(helperText);
  const activeComposerMode = showQuestionnairePanel ? "questionnaire" : "composer";
  const isComposerPanelActive = activeComposerMode === "composer";
  const isQuestionnairePanelActive = activeComposerMode === "questionnaire";
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
                  key={`${projectId}:${thread.id}:${questionnaireRequestKey}`}
                  actions={stopButton}
                  draft={threadQuestionnaireDraft}
                  highlightSources={highlightSources}
                  knownSkills={knownSkills}
                  leadingActions={questionnaireToggleButton}
                  spellCheck={composerSpellCheck}
                  onDraftChange={questionnaire.save}
                  onDraftClear={questionnaire.clear}
                  projectRootPath={projectRootPath}
                  request={visiblePendingUserInputRequest.request}
                  workspaceRoots={workspaceRoots}
                  mode="live"
                  onSubmit={async (response, supplementalInput, activatedSkillPaths) => {
                    if (visiblePendingUserInputRequest.responseMode === "newTurn" && !hasEffectiveProfile) {
                      throw new Error("The daemon composer profile is unavailable.");
                    }
                    await questionnaire.submit(
                      response,
                      {
                        ...buildPendingUserInputRequestSubmissionOptions(thread, visiblePendingUserInputRequest),
                        ...(activatedSkillPaths?.length ? { activatedSkillPaths } : {}),
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
                  editing.session.edit((draft) => ({ ...draft, text: nextValue }));
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
                              editing.session.edit((draft) => ({
                                ...draft,
                                attachments: draft.attachments.filter((currentAttachment) => currentAttachment.id !== attachment.id),
                              }));
                            }}
                          >
                            <XIcon size={14} />
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
                <div className="mt-3 flex min-w-0 items-center justify-between gap-3">
                  <div className="flex shrink-0 items-center gap-2">
                    {questionnaireToggleButton}
                  </div>
                  <div className="flex min-w-0 flex-1 items-center justify-end gap-2">
                    {showsThreadControls ? (
                    !hasEffectiveProfile && profileSlot && !composerProfileController.hasSelection(profileSlot) && !composerProfileSnapshot.error ? (
                      <div
                        role="status"
                        aria-label="Loading composer profile"
                        className="workbench-skeleton h-9 w-48 max-w-full rounded-full"
                      />
                    ) :
                    <ThreadComposerRibbon
                      key={`${projectId}:${thread.id}`}
                      modelId={thread.model}
                      agentLabel={agentButtonLabel}
                      currentReasoningEffort={currentReasoningEffort ?? "default"}
                      isFastModeEnabled={isFastModeEnabled}
                      modelLabel={modelButtonLabel}
                      profileControl={profileSlot ? <ThreadProfileQuickPicker
                        slot={profileSlot}
                        fallbackSettings={currentComposerSettings}
                        agents={availableAgents}
                        models={availableModels}
                        label={profileButtonLabel}
                        selectedLabel={selectedProfile ? profileButtonLabel : null}
                        onOpen={profileEditor.close}
                        onEdit={(trigger, ribbon) => {
                          setEditorAnchor({ trigger, ribbon });
                          profileEditor.open("profile");
                          void composerProfileController.refreshProfiles();
                        }}
                      /> : null}
                      selectedProfileLabel={selectedProfile ? profileButtonLabel : null}
                      showsFastModeControl={showsFastModeControl}
                      showsReasoningEffortControl={showsReasoningEffortControl}
                      onAgentOpen={(trigger, ribbon) => openProfileEditor("agent", trigger, ribbon)}
                      onFastModeToggle={() => {
                        const serviceTier = isFastModeEnabled ? null : "fast";
                        applyDirectSettingsChange(
                          { ...currentComposerSettings, serviceTier },
                          () => onThreadServiceTierChange(thread.id, serviceTier),
                        );
                      }}
                      onModelOpen={(trigger, ribbon) => openProfileEditor("model", trigger, ribbon)}
                      onReasoningEffortChange={changeReasoningEffort}
                      supportedReasoningEfforts={supportedReasoningEfforts}
                      context={thread.harness === "codex" && modelOptionForControls?.contextWindow ? {
                        ...modelOptionForControls.contextWindow,
                        value: currentComposerSettings.contextWindowTokens ?? modelOptionForControls.contextWindow.defaultTokens,
                      } : null}
                      onContextChange={(contextWindowTokens) => applyDirectSettingsChange({ ...currentComposerSettings, contextWindowTokens }, () => {})}
                    />
                    ) : null}
                    <div className="flex shrink-0 items-center gap-2">
                    {leadingActions}
                    <PrimaryButton
                      type="submit"
                      disabled={(!trimmedValue && !attachments.length) || isSendDisabled}
                      shape="circle"
                      aria-label={isSending ? "Sending..." : isAttaching ? "Attaching..." : isThreadStateBroken ? "Unavailable" : sendLabel}
                      title={isSending ? "Sending..." : isAttaching ? "Attaching..." : isThreadStateBroken ? "Unavailable" : sendLabel}
                      pendingHalo={isSending || isAttaching}
                    >
                      <SendHorizontalIcon size={20} />
                    </PrimaryButton>
                    {trailingActions}
                    {resumeButton}
                    {stopButton}
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </div>
        {error ? (
          <p className="mt-2 mb-0 text-[0.84em] leading-[1.6] text-danger">{error}</p>
        ) : null}
      </form>
  );
  const composerContent = stickyMode ? (
    <StickyCollapsibleSurface
      collapseLabel="Collapse composer"
      collapsed={isStickyComposerCollapsed}
      collapsedAccessory={collapsedAttachmentPreviews.length ? (
        <>
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
        </>
      ) : undefined}
      collapsedContent={stickyPreviewText}
      collapsedLabel="Expand composer"
      collapsedPreviewKind={stickyPreviewKind}
      isWithinScrollBottomDistance={isWithinBottomDistance}
      onArmedChange={reportComposerArmed}
      onCollapsedChange={setIsStickyComposerCollapsed}
      scrollTargetSelector='[data-thread-scroll-target="true"]'
    >
      {composerForm}
    </StickyCollapsibleSurface>
  ) : composerForm;

  return (
    <>
      {composerContent}
      {showsThreadControls && editorState.open && editorAnchor && profileSlot ? <ThreadProfileEditor
        key={`${projectId}:${thread.id}`}
        anchor={editorAnchor.ribbon}
        trigger={editorAnchor.trigger}
        controller={profileEditor}
        slot={profileSlot}
        fallbackSettings={currentComposerSettings}
        onCustomChange={(settings) => applyDirectSettingsChange(settings, () => {
          onThreadModelChange(thread.id, settings.model);
          onThreadReasoningEffortChange(thread.id, settings.reasoningEffort);
          onThreadServiceTierChange(thread.id, settings.serviceTier);
          onThreadAgentChange(thread.id, settings.agentPath);
        })}
        onRefreshModels={() => { void loadAvailableModels(true); }}
        onRefreshAgents={() => { void loadAvailableAgents(); }}
        canToggleHarness={canToggleHarness}
        onHarnessToggle={onHarnessToggle}
        onHarnessSelect={onHarnessSelect}
      /> : null}
      {typeof children === "function" ? children({ isProfilePickerOpen }) : children}
    </>
  );
}
