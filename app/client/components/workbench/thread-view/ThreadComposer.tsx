/*
 * Exports:
 * - default ThreadComposer: render thread composer controls, message input, attachments, composer reference pills, and questionnaire handoff.
 */
"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ClipboardEvent, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { installedProviderKeys } from "workbench-shared/workbench/provider/provider-registrations";
import { matchesWorkbenchModelOption } from "workbench-shared/workbench/provider/provider-model";

import type { WorkbenchRateLimitSnapshot as RateLimitSnapshot } from "workbench-shared/workbench/provider/provider-account";
import type { WorkbenchUserInput as UserInput } from "workbench-shared/workbench/provider/provider-input";
import { hasStaleApprovalState, isCurrentTurnWaitingOnApproval, isThreadStatusActive } from "workbench-shared/workbench/thread/thread-runtime-state";
import type { Turn } from "workbench-shared/workbench/thread/workbench-thread-turn";
import type { ThreadHead } from "../../../workbench/thread/ThreadStore";
import type {
  ThreadPayload,
  WorkbenchComposerProfileSlot,
  WorkbenchComposerSettings,
  WorkbenchListModelsOptions,
  WorkbenchModelOption,
  WorkbenchHarness,
  WorkbenchSkillSummary,
  WorkbenchComposerInputDraft,
  WorkbenchSendThreadMessageOptions,
} from "workbench-shared/types";
import { useWorkbenchDaemonClient } from "../WorkbenchWorkspaceContext";
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
import { toInlineMentionOverlayHighlights } from "../../../workbench/thread/inline-mention-styles";
import {
  createThreadComposerMessageInput,
  runThreadComposerSubmission,
} from "../../../workbench/thread/thread-message-submission";
import {
  createWorkbenchThreadRecoveryInput,
  isWorkbenchThreadRecoveryEligible,
} from "workbench-shared/workbench/thread/thread-recovery-message";
import { isWorkbenchThreadSnoozeAvailable, type WorkbenchThreadRouteTarget as WorkbenchThreadTarget } from "workbench-shared/workbench/thread/thread-state";
import PrimaryButton from "../../ui/PrimaryButton";
import { ListEndIcon, PlayIcon, QuestionnaireListIcon, SendHorizontalIcon, SnoozedThreadIcon, SquareIcon } from "../workbench-icons";
import AutoCompactSendBadge, { autoCompactSendLabel } from "./AutoCompactSendBadge";
import SendActionBadge from "./SendActionBadge";
import useWorkbenchQuestionnaire from "../use-workbench-questionnaire";
import PlaintextEditable, { threadPlaintextEditableClassName, type PlaintextEditableHandle } from "./PlaintextEditable";
import { isMobileTextInputEnvironment, useMobileTextInputEnvironment } from "./mobile-text-input-environment";
import ThreadAgentQuickPicker from "./ThreadAgentQuickPicker";
import ThreadComposerRibbon from "./ThreadComposerRibbon";
import StickyComposerSurface from "./StickyComposerSurface";
import ThreadProfileQuickPicker from "./ThreadProfileQuickPicker";
import WorkbenchModelQuickPicker from "../WorkbenchModelQuickPicker";
import type DraftSessionController from "./DraftSessionController";
import { draftSessionOwner, type DraftUpdate } from "./DraftSessionController";
import { useDraftSession } from "./use-draft-session";
import useHeightTransition from "./use-height-transition";
import { takeNewThreadReferences } from "../../../workbench/thread/new-thread-reference-seeds";
import {
  composerReferenceKey, type ComposerReference,
} from "workbench-shared/workbench/thread/composer-reference";
import { workbenchThreadTodoReference, type WorkbenchThreadTodo } from "workbench-shared/workbench/thread/thread-todo";
import ComposerReferencePills from "./ComposerReferencePills";
import ThreadLightboxImage from "./ThreadLightboxImage";
import ComposerAttachments from "./ComposerAttachments";
import { applyAttachmentTextEdits, renumberAttachmentReferences } from "workbench-shared/workbench/thread/attachment-references";
import ThreadProfileEditor from "./ThreadProfileEditor";
import ThreadProfileEditorController, { type ProfileEditorSection } from "./ThreadProfileEditorController";
import { getComposerProfileDisplayLabel } from "./composer-profile-label";
import { formatHarnessLabel } from "./harness-label";
import ThreadUserInputRequest from "./ThreadUserInputRequest";
import { getThreadComposerEnterAction, getThreadComposerStopControlState } from "./thread-composer-controls";
import { getThreadUserInputRequestPreviewText } from "./thread-user-input-request-preview";
import { buildPendingUserInputRequestSubmissionOptions } from "./thread-user-input-request-submission";
import { useWorkbenchComposerProfiles } from "../WorkbenchComposerProfileContext";
import { useNonTextInputShiftKey } from "../use-non-text-input-shift-key";

function joinClasses (...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

// Leaving content fades on the short exit timing so a resizing container never clips still-bright text.
const modePanelClassName = `
  hidden absolute inset-0 col-start-1 row-start-1 min-w-0 overflow-clip opacity-0
  transform-[translateY(0.45rem) scale(0.985)]
  [transition:
    opacity var(--sticky-composer-exit-duration) var(--sticky-composer-motion-ease),
    transform var(--sticky-composer-exit-duration) var(--sticky-composer-motion-ease),
    display var(--sticky-composer-exit-duration) allow-discrete
  ]
  [transition-behavior: allow-discrete]
  data-[active=true]:(block relative inset-auto opacity-100 transform-[translateY(0) scale(1)])
  data-[active=true]:[transition:
    opacity var(--sticky-composer-motion-duration) var(--sticky-composer-motion-ease),
    transform var(--sticky-composer-motion-duration) var(--sticky-composer-motion-ease),
    display var(--sticky-composer-motion-duration) allow-discrete
  ]
  starting:data-[active=true]:(opacity-0 transform-[translateY(0.45rem) scale(0.985)])
  motion-reduce:(animate-none transition-none)
`;

const modePanelsClassName = `
  relative grid
  [transition: height var(--sticky-composer-motion-duration) var(--sticky-composer-motion-ease)]
`;

const actionClusterClassName = `
  col-start-1 row-start-1 min-w-0 invisible opacity-0
  [transition:
    opacity var(--sticky-composer-exit-duration) var(--sticky-composer-motion-ease),
    visibility 0s linear var(--sticky-composer-exit-duration)
  ]
  data-[active=true]:(visible opacity-100 [transition: opacity var(--sticky-composer-motion-duration) var(--sticky-composer-motion-ease)])
  motion-reduce:transition-none
`;

const stickyComposerContentClassName = `
  [scrollbar-color: rgb(from var(--fg) r g b / 0) transparent]
  [transition: scrollbar-color var(--sticky-composer-motion-duration) var(--sticky-composer-motion-ease)]
  stuck:(
    [max-height: min(52dvh, calc(100dvh - env(safe-area-inset-bottom, 0px) - 11rem))]
    overflow-y-auto overscroll-contain
    [padding-bottom: min(0.75rem, var(--workbench-safe-area-bottom, 0px))]
    pr-[0.15rem] [scrollbar-gutter: stable] [scrollbar-color: inherit]
  )
  motion-reduce:transition-none
`;

export default function ThreadComposer ({
  autoFocusOnEntry = false,
  children,
  composerSpellCheck,
  controlsMode = "thread",
  header,
  layout = "thread",
  onListModels,
  subscribeModelUpdates,
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
  bottomUi,
  leadingActions,
  trailingActions,
  threadComposerDraft,
  knownSkills,
  highlightSources,
  thread,
  turns,
  threadTarget,
  targetControl,
  controlNotice,
  onDraftSessionChange,
  selectedTodos,
  onTodoDeselect,
  onTodosSent,
}: {
  autoFocusOnEntry?: boolean;
  children?: ReactNode | ((state: { isProfilePickerOpen: boolean }) => ReactNode);
  composerSpellCheck: boolean;
  controlsMode?: "comment" | "thread";
  header?: ReactNode;
  layout?: "thread" | "inline";
  onListModels: (harness: ThreadPayload["harness"], options?: WorkbenchListModelsOptions) => Promise<WorkbenchModelOption[]>;
  subscribeModelUpdates?: (listener: (harness: ThreadPayload["harness"]) => void) => () => void;
  onSendMessage: (
    threadId: string,
    input: UserInput[],
    options?: Pick<WorkbenchSendThreadMessageOptions, "activatedSkillPaths" | "skipAutoCompact" | "onThreadLaunched" | "stayInCreate">,
  ) => Promise<void>;
  onStopThread: (threadId: string) => Promise<void> | void;
  onThreadComposerDraftChange: (projectId: string, threadId: string, update: DraftUpdate<WorkbenchComposerInputDraft>, reason?: "autosave" | "submission" | "retarget", target?: WorkbenchThreadTarget, detached?: boolean) => Promise<WorkbenchComposerInputDraft | null>;
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
  bottomUi?: StickyComposerSurface.BottomUi;
  leadingActions?: ReactNode;
  trailingActions?: ReactNode;
  threadComposerDraft: WorkbenchComposerInputDraft | null;
  knownSkills: WorkbenchSkillSummary[];
  highlightSources: InlineMentionHighlightSources;
  thread: ThreadHead;
  /** Loaded turns without side-history items, newest last. */
  turns: readonly Turn[];
  threadTarget?: WorkbenchThreadTarget | null;
  targetControl?: ReactNode;
  /** Short alert shown at the left of the control row, such as a mode that cannot work yet. */
  controlNotice?: ReactNode;
  onDraftSessionChange?: (session: DraftSessionController<WorkbenchComposerInputDraft> | null) => void;
  /** Todos the user picked to hand the agent with the next message. */
  selectedTodos?: readonly WorkbenchThreadTodo[];
  onTodoDeselect?: (id: number) => void;
  /** The message carrying these todos was accepted. */
  onTodosSent?: (ids: readonly number[]) => void;
}) {
  const daemon = useWorkbenchDaemonClient();
  const questionnaire = useWorkbenchQuestionnaire(projectId, thread.isDraft ? { kind: "draft", draftId: thread.id }
    : threadTarget?.kind === "subagent" && threadTarget.threadId === thread.id ? threadTarget
    : { kind: "provider", harness: thread.harness, threadId: thread.id }, onQuestionnaireError);
  const threadController = questionnaire.thread;
  const sidebarEntry = threadController.entry;
  const threadState = useMemo(() => ({ status: thread.status, turns: [...turns] }), [thread.status, turns]);
  const threadLifecycle = sidebarEntry?.lifecycle ?? null;
  const pendingUserInputRequest = questionnaire.request;
  const threadQuestionnaireDraft = questionnaire.draft;
  const { controller: composerProfileController, snapshot: composerProfileSnapshot } = useWorkbenchComposerProfiles();
  const composerTarget = useMemo<WorkbenchThreadTarget>(() => thread.isDraft
    ? threadTarget ?? { kind: "draft", draftId: thread.id }
    : { kind: "provider", harness: thread.harness, threadId: thread.id },
  [thread.harness, thread.id, thread.isDraft, threadTarget]);
  const emptyDraft = useMemo<WorkbenchComposerInputDraft>(() => ({ attachments: [], text: "", updatedAt: 0 }), []);
  const editing = useDraftSession(threadComposerDraft ?? emptyDraft, {
    owner: draftSessionOwner(projectId, thread.id),
    empty: () => emptyDraft,
    save: (update, options) => onThreadComposerDraftChange(projectId, thread.id, update, options.reason, composerTarget, options.detached),
  });
  const [profileEditor] = useState(() => new ThreadProfileEditorController());
  const editorState = useSyncExternalStore(profileEditor.subscribe, profileEditor.getSnapshot, profileEditor.getSnapshot);
  const [editorAnchor, setEditorAnchor] = useState<{ trigger: HTMLElement; ribbon: HTMLElement } | null>(null);
  const resolvedComposerSettings = profileSlot ? composerProfileController.resolveSettings(profileSlot) : null;
  const activeHarness = resolvedComposerSettings?.harness ?? thread.harness;
  const allowedHarnesses = useMemo<readonly WorkbenchHarness[]>(() => profileSlot?.kind === "thread"
    ? [activeHarness] : installedProviderKeys, [profileSlot?.kind, activeHarness]);
  const availableModels = editorState.modelsByHarness[activeHarness] ?? [];
  const availableAgents = editorState.agents;
  const [localError, setError] = useState("");
  const error = localError || editing.error || composerProfileSnapshot.error;
  const [isComposing, setIsComposing] = useState(false);
  const [isQuestionnaireVisible, setIsQuestionnaireVisible] = useState(Boolean(pendingUserInputRequest));
  const [questionnaireSubmitTarget, setQuestionnaireSubmitTarget] = useState<HTMLDivElement | null>(null);
  const isLaunchingDraft = thread.isDraft && turns.length > 0;
  const isSending = editing.isSubmitting;
  const value = isSending || isLaunchingDraft ? "" : editing.draft.text;
  const attachments = isSending || isLaunchingDraft ? [] : editing.draft.attachments;
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
  const composerInputRef = useRef<PlaintextEditableHandle>(null);
  const removeAttachment = (id: string) => {
    const current = editing.session.getSnapshot().draft;
    const next = current.attachments.filter(attachment => attachment.id !== id);
    const edits = renumberAttachmentReferences(current.text, current.attachments, next);
    if (!composerInputRef.current?.canEdit()) return;
    if (!composerInputRef.current.applyEdits(current.text, edits)) return;
    editing.session.edit(draft => {
      const attachments = draft.attachments.filter(attachment => attachment.id !== id);
      return { ...draft, attachments, text: applyAttachmentTextEdits(draft.text,
        renumberAttachmentReferences(draft.text, draft.attachments, attachments)) };
    });
  };
  const focusAfterSendRef = useRef(false);
  const modePanelsRef = useRef<HTMLDivElement>(null);
  const isProviderUnavailable = !isCommentMode && !installedProviderKeys.some(key => key === thread.harness);
  const isThreadStateBroken = hasStaleApprovalState(threadState);
  const isApprovalBlocked = isCurrentTurnWaitingOnApproval(threadState);
  // The thread's own status (from its lifecycle) says whether it is working; turn statuses are provider detail.
  const isActiveThread = isThreadStatusActive(thread.status);
  const hasEffectiveProfile = !profileSlot || Boolean(resolvedComposerSettings?.model);
  const canRecoverInterruptedTurn = isWorkbenchThreadRecoveryEligible(threadState, threadLifecycle, hasPendingUserInputRequest, controlsMode);
  const isInputDisabled = isSending || isLaunchingDraft || isRecoveringInterruptedTurn || isAttaching || isThreadStateBroken;
  useLayoutEffect(() => {
    if (autoFocusOnEntry && !isInputDisabled && !showQuestionnairePanel
      && !isStickyComposerCollapsed && !isMobileTextInputEnvironment()) {
      composerInputRef.current?.focus();
    }
  }, []);
  useLayoutEffect(() => {
    if (!focusAfterSendRef.current || isInputDisabled) return;
    focusAfterSendRef.current = false;
    if (!isMobileTextInputEnvironment()) composerInputRef.current?.focus();
  }, [isInputDisabled]);
  // A one-shot seed, such as feedback being addressed, joins the new-thread composer's references through the normal draft path.
  useLayoutEffect(() => {
    if (composerTarget.kind !== "new") return;
    const seed = takeNewThreadReferences(projectId);
    if (!seed?.length) return;
    editing.session.edit((draft) => {
      const current = draft.references ?? [];
      const known = new Set(current.map(composerReferenceKey));
      return { ...draft, references: [...current, ...seed.filter(reference => !known.has(composerReferenceKey(reference)))] };
    });
    composerInputRef.current?.focus();
  }, [composerTarget.kind, projectId]);
  const draftReferences = isSending || isLaunchingDraft ? [] : editing.draft.references ?? [];
  // Selected todos join only thread messages; drafts keep their own durable references.
  const todoReferences = useMemo(() => thread.isDraft ? [] : (selectedTodos ?? []).map(workbenchThreadTodoReference),
    [selectedTodos, thread.isDraft]);
  const references: readonly ComposerReference[] = [...todoReferences, ...draftReferences];
  const isSendDisabled = isInputDisabled || isProviderUnavailable
    || (!isActiveThread && !hasEffectiveProfile);
  const isShiftPressed = useNonTextInputShiftKey({
    allowWhileTextInputFocused: true,
  });
  const hasSendableInput = Boolean(trimmedValue || attachments.length || references.length);
  const willStayInCreate = thread.isDraft && isShiftPressed && hasSendableInput && !isSendDisabled;
  const willAutoCompactOnSend = Boolean(thread.willAutoCompact)
    && hasSendableInput
    && !isSendDisabled
    && !isShiftPressed;
  const sendButtonLabel = isSending
    ? "Sending..."
    : isAttaching
      ? "Attaching..."
      : isThreadStateBroken
        ? "Unavailable"
        : willStayInCreate ? `${sendLabel} (stay in create new thread)`
        : autoCompactSendLabel(sendLabel, willAutoCompactOnSend);
  useEffect(() => {
    onDraftSessionChange?.(editing.session);
    return () => onDraftSessionChange?.(null);
  }, [editing.session, onDraftSessionChange]);
  const stopControlState = getThreadComposerStopControlState({
    hasPendingUserInputRequest, isActiveThread, isCommentMode, isStopping,
    canSnooze: sidebarEntry?.entryKind === "thread" && isWorkbenchThreadSnoozeAvailable(sidebarEntry),
    isApprovalBlocked,
    preferStop: isShiftPressed,
    snoozed: sidebarEntry?.entryKind === "thread" && sidebarEntry.metadata.snoozed,
  });
  const isStopDisabled = isLaunchingDraft || stopControlState.disabled;
  const isMobileTextInput = useMobileTextInputEnvironment();
  const helperText = isProviderUnavailable
      ? `Provider ${thread.harness} is not installed. Saved input is retained.`
      : !hasEffectiveProfile
      ? composerProfileSnapshot.error
      : hasVisiblePendingUserInputRequest
      ? "\xa0"
      : isAttaching
        ? "Attaching pasted image..."
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
  const selectedModelOption = selectedModel
    ? availableModels.find((model) => matchesWorkbenchModelOption(model, selectedModel)) ?? null : null;
  const defaultModelOption = availableModels.find((model) => model.isDefault) ?? null;
  const modelOptionForControls = selectedModel ? selectedModelOption : defaultModelOption;
  const modelButtonLabel = activeHarness === "opencode" && !availableModels.length
    ? editorState.modelsErrorByHarness[activeHarness] ? "Model unavailable" : "Loading..."
    : selectedModelOption?.displayName ?? selectedModel ?? "Default model";
  const supportedReasoningEfforts = modelOptionForControls?.supportedReasoningEfforts ?? [];
  const currentReasoningEffort = thread.reasoningEffort;
  const showsThreadControls = !isCommentMode;
  const showsReasoningEffortControl = showsThreadControls && Boolean(modelOptionForControls?.supportsReasoningEffort);
  const showsFastModeControl = showsThreadControls && Boolean(modelOptionForControls?.supportsFastMode);
  const isFastModeEnabled = thread.serviceTier === "fast";
  const isProfilePickerOpen = showsThreadControls && editorState.open;
  const composerPlaceholder = isCommentMode
    ? "Write a comment..."
    : isThreadStateBroken
    ? "New messages are disabled for this thread."
    : isProviderUnavailable
      ? "This provider is not installed."
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
  const selectedProfile = profileSlot ? composerProfileController.getSelectedProfile(profileSlot) : null;
  const profileButtonLabel = selectedProfile
    ? getComposerProfileDisplayLabel(selectedProfile, agentButtonLabel, modelButtonLabel)
    : "Custom";
  const currentComposerSettings: WorkbenchComposerSettings = resolvedComposerSettings ?? {
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
    if (section === "model") void Promise.all(allowedHarnesses.map(harness => loadAvailableModels(harness, true)));
  };
  const loadAvailableAgents = useCallback(() => profileEditor.loadAgents(async () => {
    const payload = await daemon.agents.list({ projectId });
    return payload.data ?? [];
  }), [daemon, profileEditor, projectId]);
  const loadAvailableModels = useCallback(async (harness: WorkbenchComposerSettings["harness"], forceRefresh = false) => {
    const models = await profileEditor.loadModels(harness, () => onListModels(harness, { forceRefresh }));
    if (models && profileSlot && harness === "opencode"
      && await composerProfileController.fillMissingModel(profileSlot, harness, models)) {
      const settings = composerProfileController.resolveSettings(profileSlot);
      if (settings) onThreadSettingsChange?.(thread.id, settings);
    }
    return models;
  }, [composerProfileController, onListModels, onThreadSettingsChange, profileEditor, profileSlot, thread.id]);
  const composerHighlights = useMemo(() => (
    buildInlineMentionHighlights(value, highlightSources)
  ), [highlightSources, value]);
  const composerOverlayHighlights = useMemo(() => toInlineMentionOverlayHighlights(composerHighlights), [composerHighlights]);

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
    if (!isCommentMode) void Promise.all(allowedHarnesses.map(harness => loadAvailableModels(harness)));
    return () => profileEditor.resetModels();
  }, [allowedHarnesses, isCommentMode, profileEditor, loadAvailableModels]);
  useEffect(() => subscribeModelUpdates?.((harness) => {
    if (!isCommentMode && allowedHarnesses.includes(harness)) void loadAvailableModels(harness);
  }), [subscribeModelUpdates, isCommentMode, allowedHarnesses, loadAvailableModels]);
  const wasEditorOpenRef = useRef(false);
  useEffect(() => {
    if (wasEditorOpenRef.current && !editorState.open) void loadAvailableModels(activeHarness);
    wasEditorOpenRef.current = editorState.open;
  }, [activeHarness, editorState.open, loadAvailableModels]);

  const submit = async (shiftKey = isShiftPressed) => {
    if (!hasSendableInput || isSendDisabled) {
      return;
    }
    focusAfterSendRef.current = thread.isDraft && shiftKey;

    // Drafts launch from saved references; existing threads carry every attached reference in their next message.
    const sentTodoIds = todoReferences.map(({ id }) => id);
    const input = createThreadComposerMessageInput(
      trimmedValue,
      attachments,
      thread.isDraft ? [] : references,
    );

    const activatedSkillPaths = getActivatedWorkbenchSkillPaths(composerHighlights);
    setError("");
    const send = (onThreadLaunched?: WorkbenchSendThreadMessageOptions["onThreadLaunched"]) => onSendMessage(thread.id, input, {
      ...(activatedSkillPaths.length ? { activatedSkillPaths } : {}),
      ...(!thread.isDraft && shiftKey ? { skipAutoCompact: true } : {}),
      ...(thread.isDraft && shiftKey ? { stayInCreate: true } : {}),
      onThreadLaunched,
    });
    if (!thread.isDraft) {
      await editing.session.submitAccepted(async () => {
        await send();
        if (sentTodoIds.length) onTodosSent?.(sentTodoIds);
      }, () => onThreadComposerDraftClear(projectId, thread.id, composerTarget), "message");
      return;
    }
    await threadController.actions.submitDraft(
      createThreadComposerMessageInput(trimmedValue, attachments, references),
      accept => editing.session.submit(async (submitted, options) => {
        return await runThreadComposerSubmission({
          clearDurableDraft: () => onThreadComposerDraftClear(projectId, thread.id, composerTarget),
          preserveDurableDraft: async () => {
            await onThreadComposerDraftChange(projectId, thread.id, () => submitted, "submission", composerTarget, options.detached);
          },
          send: () => send(accept),
          showError: setError,
        });
      }),
      { stayInCreate: shiftKey },
    );
  };

  const stop = async () => {
    if (isStopDisabled) {
      return;
    }

    setIsStopping(true);
    setError("");
    try {
      if (stopControlState.action === "snooze") {
        await threadController.actions.snooze(questionnaireRequestKey || undefined);
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
    const action = getThreadComposerEnterAction({
      key: event.key, shiftKey: event.shiftKey, ctrlKey: event.ctrlKey,
      isComposing: isComposing || event.nativeEvent.isComposing,
      isMobile: isMobileTextInputEnvironment(), isDraft: thread.isDraft,
    });
    if (!action) return;
    event.preventDefault();
    void submit(action === "stay");
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
  const selectQuickModel = (harness: WorkbenchComposerSettings["harness"], model: WorkbenchModelOption) => {
    const nextSettings: WorkbenchComposerSettings = {
      ...currentComposerSettings,
      harness,
      model: model.id,
      reasoningEffort: model.supportsReasoningEffort
        ? model.defaultReasoningEffort ?? model.supportedReasoningEfforts[0] ?? null : null,
      serviceTier: harness === currentComposerSettings.harness && model.supportsFastMode
        ? currentComposerSettings.serviceTier : null,
      contextWindowTokens: model.contextWindow?.defaultTokens ?? null,
    };
    applyDirectSettingsChange(nextSettings, () => {
      onThreadModelChange(thread.id, model.id);
      onThreadReasoningEffortChange(thread.id, nextSettings.reasoningEffort);
      onThreadServiceTierChange(thread.id, nextSettings.serviceTier);
    });
  };

  const changeReasoningEffort = (nextEffort: string) => {
    applyDirectSettingsChange(
      { ...currentComposerSettings, reasoningEffort: nextEffort },
      () => onThreadReasoningEffortChange(thread.id, nextEffort),
    );
  };

  const stopLabel = stopControlState.action === "snooze" ? "Snooze thread" : isActiveThread ? "Stop current turn" : "Dismiss questionnaire";
  const stoppingLabel = stopControlState.action === "snooze" ? "Snoozing thread" : "Stopping current turn";
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
          ? "border-[color-mix(in srgb, var(--text) 18%, transparent)] bg-fg/8 text-text"
          : "border-[color-mix(in srgb, var(--text) 12%, transparent)] bg-[color-mix(in srgb, var(--bg) 96%, transparent)] [--fg-bg: color-mix(in srgb, var(--bg) 96%, var(--app-bg-solid))] text-fg/muted hover:text-text",
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
  const hasNormalComposerSupplementalContent = attachments.length > 0 || Boolean(helperText);
  const activeComposerMode = showQuestionnairePanel ? "questionnaire" : "composer";
  const isComposerPanelActive = activeComposerMode === "composer";
  const isQuestionnairePanelActive = activeComposerMode === "questionnaire";
  useHeightTransition(modePanelsRef, activeComposerMode);
  const composerForm = (
      <form
        className={joinClasses(
          layout === "thread" && !stickyMode
            ? "mt-6 border-t border-[color-mix(in srgb, var(--text) 10%, transparent)] pt-4"
            : "m-0",
        )}
        onSubmit={handleSubmit}
      >
        <div className={effectiveSurface === "card"
          ? "rounded-[1.15rem] bg-fg/4 p-3"
          : "p-0"}>
          {header ? (
            <div className="mb-3 px-1">
              {header}
            </div>
          ) : null}
          <div ref={modePanelsRef} className={modePanelsClassName} data-active-mode={activeComposerMode}>
            {visiblePendingUserInputRequest ? (
              <div
                aria-hidden={!isQuestionnairePanelActive}
                className={modePanelClassName}
                data-active={isQuestionnairePanelActive ? "true" : "false"}
                inert={!isQuestionnairePanelActive}
              >
                <ThreadUserInputRequest
                  key={`${projectId}:${thread.id}:${questionnaireRequestKey}`}
                  contentClassName={stickyMode ? stickyComposerContentClassName : undefined}
                  draft={threadQuestionnaireDraft}
                  highlightSources={highlightSources}
                  knownSkills={knownSkills}
                  spellCheck={composerSpellCheck}
                  submitTarget={questionnaireSubmitTarget}
                  onDraftChange={questionnaire.save}
                  onDraftClear={questionnaire.clear}
                  projectRootPath={projectRootPath}
                  request={visiblePendingUserInputRequest.request}
                  workspaceRoots={workspaceRoots}
                  mode="live"
                  willAutoCompact={Boolean(thread.willAutoCompact)}
                  onSubmit={async (response, options) => {
                    await questionnaire.submit(response, {
                      ...buildPendingUserInputRequestSubmissionOptions(turns, visiblePendingUserInputRequest),
                      ...options,
                    });
                  }}
                />
              </div>
            ) : null}
            <div
              aria-hidden={!isComposerPanelActive}
              className={modePanelClassName}
              data-active={isComposerPanelActive ? "true" : "false"}
              inert={!isComposerPanelActive}
            >
              <div className={stickyMode ? stickyComposerContentClassName : undefined}>
                <span className="sr-only">{isCommentMode ? "Write comment" : "Message thread"}</span>
                <ComposerReferencePills
                  className="mb-2 px-1"
                  onRemove={(reference) => {
                    if (reference.kind === "todo") {
                      onTodoDeselect?.(reference.id);
                      return;
                    }
                    const key = composerReferenceKey(reference);
                    editing.session.edit((draft) => ({
                      ...draft, references: (draft.references ?? []).filter(item => composerReferenceKey(item) !== key),
                    }));
                  }}
                  references={references}
                />
                <PlaintextEditable
                  ref={composerInputRef}
                  attachmentCount={attachments.length}
                  onEditError={error => editing.session.reportError(error, "Unable to edit attachment references.")}
                  id={`thread-composer:${thread.id}`}
                  ariaLabel={isCommentMode ? "Write comment" : "Message thread"}
                  className={`${threadPlaintextEditableClassName} min-h-[5.75rem] w-full border-0 bg-transparent px-1 py-1 text-[0.96em] leading-[1.65] text-text outline-none`}
                  disabled={isInputDisabled}
                  placeholder={composerPlaceholder}
                  highlights={composerOverlayHighlights}
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
                    {attachments.length ? <ComposerAttachments attachments={attachments} disabled={isInputDisabled || isComposing}
                      onRemove={removeAttachment}
                      onReference={number => composerInputRef.current?.insertText(`#[attach:${number}]`)} /> : null}
                    {helperText ? (
                      <p className={joinClasses(
                        attachments.length ? "mt-2 mb-0 px-1 text-[0.78em] leading-[1.6]" : "m-0 px-1 text-[0.78em] leading-[1.6]",
                        isThreadStateBroken ? "text-danger" : "text-fg/muted",
                      )}>
                        {helperText}
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>
          </div>
          <div className="mt-3 flex min-w-0 items-center justify-between gap-3">
            <div className="flex min-w-0 shrink items-center gap-2">
              {questionnaireToggleButton}
              {isComposerPanelActive ? controlNotice : null}
            </div>
            <div className="flex min-w-0 flex-1 items-center justify-end gap-2">
              <div className="grid min-w-0 flex-1 grid-cols-[minmax(0, 1fr)]">
                <div
                  aria-hidden={!isComposerPanelActive}
                  className={`${actionClusterClassName} flex min-w-0 items-center justify-end gap-2`}
                  data-active={isComposerPanelActive ? "true" : "false"}
                  inert={!isComposerPanelActive}
                >
                  {!showsThreadControls ? null
                    : !hasEffectiveProfile && profileSlot && !composerProfileController.hasSelection(profileSlot) && !composerProfileSnapshot.error ? (
                      <div
                        role="status"
                        aria-label="Loading composer profile"
                        className="workbench-skeleton h-9 w-48 max-w-full rounded-full"
                      />
                    ) : (
                      <ThreadComposerRibbon
                        targetControl={targetControl}
                        modelId={thread.model}
                        agentControl={<ThreadAgentQuickPicker
                          agents={availableAgents}
                          label={agentButtonLabel}
                          selectedAgentPath={currentComposerSettings.agentPath}
                          onOpen={() => {
                            profileEditor.close();
                            void loadAvailableAgents();
                          }}
                          onEdit={(trigger, ribbon) => openProfileEditor("agent", trigger, ribbon)}
                          onSelect={(agentPath, agentSource) => applyDirectSettingsChange(
                            { ...currentComposerSettings, agentPath, agentSource },
                            () => onThreadAgentChange(thread.id, agentPath),
                          )}
                        />}
                        currentReasoningEffort={currentReasoningEffort ?? "default"}
                        isFastModeEnabled={isFastModeEnabled}
                        modelControl={<WorkbenchModelQuickPicker
                          allowedHarnesses={allowedHarnesses}
                          harness={currentComposerSettings.harness}
                          modelName={modelButtonLabel}
                          providerLabel={formatHarnessLabel(currentComposerSettings.harness)}
                          modelId={currentComposerSettings.model}
                          threadId={thread.id}
                          onOpen={() => {
                            profileEditor.close();
                            void Promise.all(allowedHarnesses.map(harness => loadAvailableModels(harness, true)));
                          }}
                          onSelect={({ harness, model }) => selectQuickModel(harness, model)}
                        />}
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
                        onFastModeToggle={() => {
                          const serviceTier = isFastModeEnabled ? null : "fast";
                          applyDirectSettingsChange(
                            { ...currentComposerSettings, serviceTier },
                            () => onThreadServiceTierChange(thread.id, serviceTier),
                          );
                        }}
                        onReasoningEffortChange={changeReasoningEffort}
                        supportedReasoningEfforts={supportedReasoningEfforts}
                        context={modelOptionForControls?.contextWindow ? {
                          ...modelOptionForControls.contextWindow,
                          value: currentComposerSettings.contextWindowTokens ?? modelOptionForControls.contextWindow.defaultTokens,
                        } : null}
                        onContextChange={(contextWindowTokens) => applyDirectSettingsChange({ ...currentComposerSettings, contextWindowTokens }, () => {})}
                      />
                    )}
                  <div className="flex shrink-0 items-center gap-2">
                    {leadingActions}
                    <PrimaryButton
                      type="submit"
                      onClick={event => {
                        event.preventDefault();
                        void submit(event.shiftKey);
                      }}
                      disabled={!hasSendableInput || isSendDisabled}
                      shape="circle"
                      aria-label={sendButtonLabel}
                      title={sendButtonLabel}
                      pendingHalo={isSending && !isLaunchingDraft || isAttaching}
                    >
                      <SendHorizontalIcon size={20} />
                      {willAutoCompactOnSend ? <AutoCompactSendBadge /> : null}
                      {willStayInCreate ? <SendActionBadge><ListEndIcon size={12} /></SendActionBadge> : null}
                    </PrimaryButton>
                    {trailingActions}
                    {resumeButton}
                  </div>
                </div>
                {visiblePendingUserInputRequest ? (
                  <div
                    ref={setQuestionnaireSubmitTarget}
                    aria-hidden={!isQuestionnairePanelActive}
                    className={`${actionClusterClassName} flex items-center justify-end gap-2`}
                    data-active={isQuestionnairePanelActive ? "true" : "false"}
                    inert={!isQuestionnairePanelActive}
                  />
                ) : null}
              </div>
              {stopButton}
            </div>
          </div>
        </div>
        {error ? (
          <p className="mt-2 mb-0 text-[0.84em] leading-[1.6] text-danger">{error}</p>
        ) : null}
      </form>
  );
  const composerContent = stickyMode ? (
    <StickyComposerSurface
      bottomUi={bottomUi}
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
            <span className="inline-flex size-10 items-center justify-center rounded-[0.75rem] bg-fg/6 text-[0.76em] font-medium text-fg/muted">
              +{hiddenAttachmentCount}
            </span>
          ) : null}
        </>
      ) : undefined}
      collapsedContent={stickyPreviewText}
      collapsedLabel="Expand composer"
      collapsedPreviewKind={stickyPreviewKind}
      onCollapsedChange={setIsStickyComposerCollapsed}
    >
      {composerForm}
    </StickyComposerSurface>
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
        onRefreshModels={(harness) => { void loadAvailableModels(harness, true); }}
        onRefreshAgents={() => { void loadAvailableAgents(); }}
      /> : null}
      {typeof children === "function" ? children({ isProfilePickerOpen }) : children}
    </>
  );
}
