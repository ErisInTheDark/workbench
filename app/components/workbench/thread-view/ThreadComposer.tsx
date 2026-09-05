/*
 * Exports:
 * - default ThreadComposer: render thread composer controls, message input, attachments, and questionnaire handoff. Keywords: composer, thread, questionnaire, model, agent.
 * - Local helpers: attachment reading, sticky composer preview rendering, saved draft shelf rendering, and compact composer icons. Keywords: attachments, saved drafts, user input, controls, sticky composer.
 */
"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent, type FormEvent, type KeyboardEvent, type ReactNode } from "react";

import type { RateLimitSnapshot } from "workbench-shared/codex/generated/app-server/v2/RateLimitSnapshot";
import type { UserInput } from "workbench-shared/codex/generated/app-server/v2/UserInput";
import { getCurrentInProgressTurn, hasStaleApprovalState, isCurrentTurnWaitingOnApproval } from "workbench-shared/codex/thread-state";
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
  WorkbenchComposerInputDraft,
  WorkbenchUserInputResponse,
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
import type { WorkbenchThreadLifecycle } from "workbench-shared/workbench/thread/thread-state";
import PrimaryButton from "../PrimaryButton";
import StickyCollapsibleSurface from "../StickyCollapsibleSurface";
import { PlayIcon, StopIcon } from "../workbench-icons";
import PlaintextEditable from "./PlaintextEditable";
import { isMobileTextInputEnvironment, useMobileTextInputEnvironment } from "./mobile-text-input-environment";
import ThreadAgentPicker from "./ThreadAgentPicker";
import ThreadComposerRibbon from "./ThreadComposerRibbon";
import ThreadComposerDraftSyncController from "./ThreadComposerDraftSyncController";
import ThreadLightboxImage from "./ThreadLightboxImage";
import ThreadModelPicker from "./ThreadModelPicker";
import ThreadProfilePicker from "./ThreadProfilePicker";
import { getComposerProfileDisplayLabel } from "./composer-profile-label";
import ThreadUserInputRequest from "./ThreadUserInputRequest";
import { getThreadComposerStopControlState } from "./thread-composer-controls";
import { getThreadUserInputRequestPreviewText } from "./thread-user-input-request-preview";
import { buildPendingUserInputRequestSubmissionOptions } from "./thread-user-input-request-submission";
import { useThreadScrollViewportContext } from "./thread-scroll-viewport-context";
import { useWorkbenchComposerProfiles } from "../WorkbenchComposerProfileContext";

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

interface ComposerImageAttachment {
  id: string;
  url: string;
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

export default function ThreadComposer ({
  children,
  canToggleHarness = false,
  composerSpellCheck,
  controlsMode = "thread",
  header,
  layout = "thread",
  onListModels,
  onHarnessToggle,
  onSendMessage,
  onStopThread,
  onThreadComposerDraftChange,
  onThreadComposerDraftClear,
  onThreadQuestionnaireDraftChange,
  onThreadQuestionnaireDraftClear,
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
  sendLabel = "Send",
  surface = "card",
  stickyMode = false,
  leadingActions,
  trailingActions,
  threadQuestionnaireDraft,
  threadComposerDraft,
  threadLifecycle,
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
  onSendMessage: (
    threadId: string,
    input: UserInput[],
    options?: { activatedSkillPaths?: string[] },
  ) => Promise<void>;
  onStopThread: (threadId: string) => Promise<void> | void;
  onThreadComposerDraftChange: (threadId: string, draft: WorkbenchComposerInputDraft, reason?: "autosave" | "submission") => Promise<void> | void;
  onThreadComposerDraftClear: (threadId: string) => Promise<void> | void;
  onThreadQuestionnaireDraftChange: (threadId: string, requestKey: string, draft: WorkbenchQuestionnaireDraft) => void;
  onThreadQuestionnaireDraftClear: (threadId: string, requestKey: string) => void;
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
  sendLabel?: string;
  surface?: "bare" | "card";
  stickyMode?: boolean;
  leadingActions?: ReactNode;
  trailingActions?: ReactNode;
  threadQuestionnaireDraft: WorkbenchQuestionnaireDraft | null;
  threadComposerDraft: WorkbenchComposerInputDraft | null;
  knownSkills: WorkbenchSkillSummary[];
  highlightSources: InlineMentionHighlightSources;
  thread: ThreadPayload;
  threadLifecycle: WorkbenchThreadLifecycle | null;
}) {
  const daemon = useWorkbenchDaemonClient();
  const { controller: composerProfileController, snapshot: composerProfileSnapshot } = useWorkbenchComposerProfiles();
  const {
    isWithinBottomDistance,
    reportComposerArmed,
  } = useThreadScrollViewportContext();
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
  const [profilePickerTargetId, setProfilePickerTargetId] = useState<string | null>(null);
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
  const [isSending, setIsSending] = useState(false);
  const [isRecoveringInterruptedTurn, setIsRecoveringInterruptedTurn] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [isStickyComposerCollapsed, setIsStickyComposerCollapsed] = useState(false);
  const draftSyncControllerRef = useRef<ThreadComposerDraftSyncController | null>(null);
  draftSyncControllerRef.current ??= new ThreadComposerDraftSyncController(
    thread.id,
    `${thread.id}:${threadComposerDraft?.updatedAt ?? 0}`,
  );
  const hasDurableComposerDraftRef = useRef(Boolean(threadComposerDraft));
  hasDurableComposerDraftRef.current = Boolean(threadComposerDraft);
  const agentLoadGenerationRef = useRef(0);
  const modelLoadGenerationRef = useRef(0);
  const agentRefreshCooldownTimeoutRef = useRef<number | null>(null);
  const modelRefreshCooldownTimeoutRef = useRef<number | null>(null);
  const isComposerMountedRef = useRef(true);
  const onThreadComposerDraftChangeRef = useRef(onThreadComposerDraftChange);
  const onThreadComposerDraftClearRef = useRef(onThreadComposerDraftClear);

  onThreadComposerDraftChangeRef.current = onThreadComposerDraftChange;
  onThreadComposerDraftClearRef.current = onThreadComposerDraftClear;
  const isCommentMode = controlsMode === "comment";
  const trimmedValue = value.trim();
  const isAttaching = pendingAttachmentReads > 0;
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
  const stopControlState = getThreadComposerStopControlState({ hasPendingUserInputRequest, isActiveThread, isCommentMode, isStopping });
  const isStopDisabled = stopControlState.disabled;
  const isMobileTextInput = useMobileTextInputEnvironment();
  const helperText = !hasEffectiveProfile
      ? composerProfileSnapshot.error || "Loading daemon profile settings..."
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
  const modelButtonLabel = !hasEffectiveProfile ? "Profile unavailable" : selectedModelOption?.displayName
    ?? selectedModel
    ?? "Default model";
  const supportedReasoningEfforts = modelOptionForControls?.supportedReasoningEfforts ?? [];
  const currentReasoningEffort = thread.reasoningEffort;
  const showsThreadControls = !isCommentMode;
  const showsReasoningEffortControl = showsThreadControls && Boolean(modelOptionForControls?.supportsReasoningEffort);
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
  const showStopButton = stopControlState.visible;
  const selectedAgent = availableAgents.find((agent) => areWorkbenchAgentPathsEqual(agent.path, thread.agentPath)) ?? null;
  const agentButtonLabel = !hasEffectiveProfile ? "Profile unavailable" : selectedAgent?.name
    ?? getWorkbenchAgentPathLabel(thread.agentPath)
    ?? "Default agent";
  const profileSelection = profileSlot
    ? composerProfileController.getSelection(profileSlot)
    : { kind: "custom" } as const;
  const selectedProfile = profileSelection.kind === "profile"
    ? composerProfileController.getProfile(profileSelection.profileId)
    : null;
  const profilePickerTarget = profilePickerTargetId
    ? composerProfileController.getProfile(profilePickerTargetId)
    : null;
  const pickerHarness = profilePickerTarget?.harness ?? thread.harness;
  const pickerSelectedModelId = profilePickerTarget?.model ?? selectedModel;
  const pickerSelectedAgentPath = profilePickerTarget?.agentPath ?? thread.agentPath;
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
  const deprioritizedModelIds = deprioritizedModelIdsByHarness[pickerHarness] ?? [];

  useEffect(() => {
    if (!profilePickerTargetId || profilePickerTarget) {
      return;
    }
    setProfilePickerTargetId(null);
    setActivePicker(null);
  }, [profilePickerTarget, profilePickerTargetId]);

  const finishConfigurationPicker = () => {
    const shouldReturnToProfiles = profilePickerTarget !== null;
    setProfilePickerTargetId(null);
    setActivePicker(shouldReturnToProfiles ? "profile" : null);
  };
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

    return daemon.request("agents/list", { projectId }).then((payload) => {
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
  }, [daemon, isCommentMode, projectId]);
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
      harness: pickerHarness,
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
  }, [isLoadingModels, isModelRefreshCoolingDown, isModelRefreshPending, loadAvailableModels, pickerHarness]);
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
    if (isSending || !draftSyncControllerRef.current?.acceptHydration(thread.id, draftKey)) return;
    const nextText = threadComposerDraft?.text ?? "";
    const nextAttachments = cloneComposerImageAttachments(threadComposerDraft?.attachments ?? []);
    setValue(nextText);
    setAttachments(nextAttachments);
  }, [isSending, thread.id, threadComposerDraft]);

  useEffect(() => {
    if (hasPendingUserInputRequest || isSending) {
      return;
    }

    const save = draftSyncControllerRef.current?.beginSave();
    if (!save) return;
    const timeoutId = window.setTimeout(() => {
      void (async () => {
        try {
          if (!value.trim() && attachments.length === 0) {
            if (hasDurableComposerDraftRef.current && !thread.isDraft) {
              await onThreadComposerDraftClearRef.current(thread.id);
            } else if (hasDurableComposerDraftRef.current) {
              await onThreadComposerDraftChangeRef.current(thread.id, {
                attachments: [],
                text: "",
                updatedAt: Date.now(),
              });
            }
            draftSyncControllerRef.current?.completeSave(save);
            return;
          }

          await onThreadComposerDraftChangeRef.current(thread.id, {
            attachments,
            text: value,
            updatedAt: Date.now(),
          });
          draftSyncControllerRef.current?.completeSave(save);
        } catch (draftError) {
          console.error("Workbench composer draft persistence failed.", draftError);
        }
      })();
    }, 260);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [attachments, hasPendingUserInputRequest, isSending, thread.id, thread.isDraft, value]);

  useEffect(() => {
    setActivePicker(null);
    setAgentsError("");
    setModelsError("");
    setIsQuestionnaireVisible(Boolean(visiblePendingUserInputRequest));
  }, [thread.id, visiblePendingUserInputRequest?.request.id]);

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
    const activatedSkillPaths = getActivatedWorkbenchSkillPaths(composerHighlights);
    setIsSending(true);
    setError("");
    setValue("");
    setAttachments([]);
    try {
      const sent = await runThreadComposerSubmission({
        clearDurableDraft: () => onThreadComposerDraftClearRef.current(thread.id),
        preserveDurableDraft: () => onThreadComposerDraftChangeRef.current(thread.id, {
          attachments: submittedAttachments,
          text: submittedValue,
          updatedAt: Date.now(),
        }, "submission"),
        restoreLocalInput: () => {
          setValue(submittedValue);
          setAttachments(submittedAttachments);
        },
        send: () => onSendMessage(thread.id, input, {
          ...(activatedSkillPaths.length ? { activatedSkillPaths } : {}),
        }),
        showError: setError,
      });
      if (sent) draftSyncControllerRef.current?.completeSubmission(thread.id);
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

  const recoverInterruptedTurn = async () => {
    if (!canRecoverInterruptedTurn || isRecoveringInterruptedTurn || isPickerOpen || !hasEffectiveProfile) {
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
    setPendingAttachmentReads((count) => count + 1);
    void (async () => {
      try {
        const nextAttachments = (await readClipboardImageDataUrls(event.clipboardData.items)).map((image) => ({
          id: createAttachmentId(),
          url: image.url,
        }));
        if (nextAttachments.length) draftSyncControllerRef.current?.noteEdit();
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
    if (profileSlot && onThreadSettingsChange) {
      onThreadSettingsChange(thread.id, nextSettings);
      composerProfileController.selectCustom(profileSlot, nextSettings);
      return;
    }

    applyCustomChange();
  };

  const cycleReasoningEffort = (direction: 1 | -1) => {
    if (!supportedReasoningEfforts.length) {
      return;
    }

    const currentIndex = currentReasoningEffort ? supportedReasoningEfforts.indexOf(currentReasoningEffort) : -1;
    const baseIndex = currentIndex >= 0 ? currentIndex : direction === 1 ? -1 : 0;
    const nextIndex = (baseIndex + direction + supportedReasoningEfforts.length) % supportedReasoningEfforts.length;
    const nextEffort = supportedReasoningEfforts[nextIndex] ?? null;
    applyDirectSettingsChange(
      { ...currentComposerSettings, reasoningEffort: nextEffort },
      () => onThreadReasoningEffortChange(thread.id, nextEffort),
    );
  };

  const stopButton = showStopButton ? (
    <PrimaryButton
      type="button"
      aria-label={isStopping ? "Stopping current turn" : isActiveThread ? "Stop current turn" : "Dismiss questionnaire"}
      title={isStopping ? "Stopping current turn" : isActiveThread ? "Stop current turn" : "Dismiss questionnaire"}
      disabled={isStopDisabled}
      shape="circle"
      onClick={() => {
        void stop();
      }}
    >
      <StopIcon className="h-4.5 w-4.5" />
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
      <PlayIcon className="h-4.5 w-4.5" />
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
                  onSubmit={async (response, supplementalInput, activatedSkillPaths) => {
                    if (visiblePendingUserInputRequest.responseMode === "newTurn" && !hasEffectiveProfile) {
                      throw new Error("The daemon composer profile is unavailable.");
                    }
                    await onSubmitUserInputRequest(
                      thread.id,
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
                  draftSyncControllerRef.current?.noteEdit();
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
                              draftSyncControllerRef.current?.noteEdit();
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
                    {showsThreadControls ? (
                    <ThreadComposerRibbon
                      agentLabel={agentButtonLabel}
                      currentReasoningEffort={currentReasoningEffort ?? "default"}
                      isFastModeEnabled={isFastModeEnabled}
                      isProfilePanelOpen={isProfilePickerOpen}
                      modelLabel={modelButtonLabel}
                      profileLabel={profileButtonLabel}
                      selectedProfileLabel={selectedProfile ? profileButtonLabel : null}
                      showsFastModeControl={showsFastModeControl}
                      showsReasoningEffortControl={showsReasoningEffortControl}
                      onAgentOpen={() => {
                        setProfilePickerTargetId(null);
                        setActivePicker("agent");
                      }}
                      onFastModeToggle={() => {
                        const serviceTier = isFastModeEnabled ? null : "fast";
                        applyDirectSettingsChange(
                          { ...currentComposerSettings, serviceTier },
                          () => onThreadServiceTierChange(thread.id, serviceTier),
                        );
                      }}
                      onModelOpen={() => {
                        setProfilePickerTargetId(null);
                        setActivePicker("model");
                      }}
                      onProfileOpen={() => {
                        setProfilePickerTargetId(null);
                        setActivePicker((current) => current === "profile" ? null : "profile");
                      }}
                      onReasoningEffortCycle={cycleReasoningEffort}
                    />
                    ) : null}
                    {leadingActions}
                    <PrimaryButton
                      type="submit"
                      disabled={(!trimmedValue && !attachments.length) || isSendDisabled}
                      className="text-[0.84em]"
                      pendingHalo={isSending || isAttaching}
                    >
                      {isSending ? "Sending..." : isAttaching ? "Attaching..." : isThreadStateBroken ? "Unavailable" : sendLabel}
                    </PrimaryButton>
                    {trailingActions}
                    {resumeButton}
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
                  {isModelPickerPanelActive ? (
                    <ThreadModelPicker
                      appliesOnNextTurnOnly={!profilePickerTarget && thread.harness === "codex" && isActiveThread}
                      deprioritizedModelIds={deprioritizedModelIds}
                      error={modelsError}
                      harness={pickerHarness}
                      isLoading={isLoadingModels}
                      isRefreshDisabled={isLoadingModels || isModelRefreshPending || isModelRefreshCoolingDown}
                      isRefreshing={isModelRefreshPending}
                      models={availableModels}
                      selectedModelId={pickerSelectedModelId}
                      onClose={finishConfigurationPicker}
                      onRefresh={refreshAvailableModels}
                      onSelectModel={(model) => {
                        if (profilePickerTarget) {
                          void composerProfileController.updateProfile(profilePickerTarget.id, {
                            model: model.id,
                            reasoningEffort: model.supportsReasoningEffort
                              ? model.defaultReasoningEffort ?? model.supportedReasoningEfforts[0] ?? null
                              : null,
                            serviceTier: model.supportsFastMode ? profilePickerTarget.serviceTier : null,
                          });
                          setModelsError("");
                          finishConfigurationPicker();
                          return;
                        }
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
                        finishConfigurationPicker();
                      }}
                      onToggleModelPriority={(modelId) => {
                        setDeprioritizedModelIdsByHarness((current) => {
                          const currentIds = current[pickerHarness] ?? [];
                          const nextIds = currentIds.includes(modelId)
                            ? currentIds.filter((id) => id !== modelId)
                            : [...currentIds, modelId];

                          return {
                            ...current,
                            [pickerHarness]: nextIds,
                          };
                        });
                      }}
                    />
                  ) : null}
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
                    selectedAgentPath={pickerSelectedAgentPath}
                    onClose={finishConfigurationPicker}
                    onRefresh={refreshAvailableAgents}
                    onSelectAgent={(agentPath) => {
                      const agent = availableAgents.find((candidate) => areWorkbenchAgentPathsEqual(candidate.path, agentPath)) ?? null;
                      if (profilePickerTarget) {
                        void composerProfileController.updateProfile(profilePickerTarget.id, {
                          agentPath,
                          agentSource: agent?.source ?? null,
                        });
                        finishConfigurationPicker();
                        return;
                      }
                      applyDirectSettingsChange(
                        { ...currentComposerSettings, agentPath, agentSource: agent?.source ?? null },
                        () => onThreadAgentChange(thread.id, agentPath),
                      );
                      finishConfigurationPicker();
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
                      canToggleHarness={canToggleHarness}
                      currentSettings={currentComposerSettings}
                      models={availableModels}
                      projectId={projectId}
                      slot={profileSlot}
                      onAgentOpen={(profileId) => {
                        setProfilePickerTargetId(profileId);
                        setActivePicker("agent");
                      }}
                      onClose={() => {
                        setProfilePickerTargetId(null);
                        setActivePicker(null);
                      }}
                      onHarnessToggle={onHarnessToggle}
                      onModelOpen={(profileId, harness) => {
                        setProfilePickerTargetId(profileId);
                        setActivePicker("model");
                        void loadAvailableModels({ clearBeforeLoad: true, harness, showErrors: true, showLoading: true });
                      }}
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
      {typeof children === "function" ? children({ isProfilePickerOpen }) : children}
    </>
  );
}
