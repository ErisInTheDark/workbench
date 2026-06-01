/*
 * Exports:
 * - default ThreadComposer: render thread composer controls, message input, attachments, and questionnaire handoff. Keywords: composer, thread, questionnaire, model, agent.
 * - Local helpers: attachment reading, saved draft shelf rendering, pending questionnaire submission options, and compact composer icons. Keywords: attachments, saved drafts, user input, controls.
 */
"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent, type FormEvent, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

import type { RateLimitSnapshot } from "../../../lib/codex/generated/app-server/v2/RateLimitSnapshot";
import type { UserInput } from "../../../lib/codex/generated/app-server/v2/UserInput";
import { getCurrentInProgressTurn, hasStaleApprovalState, isCurrentTurnWaitingOnApproval } from "../../../lib/codex/thread-state";
import type {
  ThreadPayload,
  WorkbenchAgentOption,
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
  buildInlineMentionHighlights,
  type InlineMentionHighlightSources,
} from "../../../lib/workbench/thread/inline-mention-highlights";
import { isSyntheticQuestionnaireHistoryItem } from "../../../lib/workbench/thread/thread-questionnaire-history";
import PlaintextEditable, { isMobileTextInputEnvironment, useMobileTextInputEnvironment } from "./PlaintextEditable";
import ThreadAgentPicker from "./ThreadAgentPicker";
import ThreadLightboxImage from "./ThreadLightboxImage";
import ThreadModelPicker from "./ThreadModelPicker";
import ThreadUserInputRequest from "./ThreadUserInputRequest";

function joinClasses (...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

function LightningBoltIcon () {
  return (
    <svg viewBox="0 0 20 20" className="h-4.5 w-4.5" aria-hidden="true">
      <path
        d="M11.25 1.9L4.75 10.7h4.55l-.75 7.4 6.7-9h-4.65l.65-7.2z"
        fill="currentColor"
      />
    </svg>
  );
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

function createAttachmentId () {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `attachment:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

function createSavedDraftId () {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `saved-draft:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

function readFileAsDataUrl (file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => {
      reject(new Error("Unable to read the pasted image."));
    };
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }

      reject(new Error("Unable to read the pasted image."));
    };
    reader.readAsDataURL(file);
  });
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

  const visibleItems = turn.items.filter((item) => !isSyntheticQuestionnaireHistoryItem(item));
  const requestedAnchorIndex = insertAfterItemId
    ? visibleItems.findIndex((item) => item.id === insertAfterItemId)
    : -1;
  const fallbackAnchorIndex = visibleItems.length - 1;
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
                <button
                  type="button"
                  aria-label="Restore saved draft to composer"
                  title="Restore saved draft to composer"
                  disabled={isRestoreDisabled}
                  className={joinClasses(
                    "inline-flex size-10 items-center justify-center rounded-full transition",
                    "bg-[color:color-mix(in_srgb,var(--text)_92%,var(--bg)_8%)] text-[var(--bg)]",
                    "hover:opacity-92 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:color-mix(in_srgb,var(--text)_22%,transparent)]",
                    isRestoreDisabled && "cursor-not-allowed opacity-45",
                  )}
                  onClick={() => {
                    onRestore(draft);
                  }}
                >
                  <ArrowUpIcon />
                </button>
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
  onListModels,
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
  onThreadModelChange,
  pendingUserInputRequest,
  projectId,
  projectRootPath,
  rateLimits,
  autoExpandSavedDraftShelf = true,
  savedDraftShelfPortalHost,
  threadQuestionnaireDraft,
  threadComposerDraft,
  threadSavedComposerDrafts,
  useSavedDraftShelfPortal = false,
  knownSkills,
  highlightSources,
  thread,
}: {
  children?: ReactNode;
  onListModels: (harness: ThreadPayload["harness"]) => Promise<WorkbenchModelOption[]>;
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
  onThreadModelChange: (threadId: string, model: string) => void;
  pendingUserInputRequest: WorkbenchPendingUserInputRequest | null;
  projectId: string;
  projectRootPath: string;
  rateLimits: RateLimitSnapshot | null;
  autoExpandSavedDraftShelf?: boolean;
  savedDraftShelfPortalHost?: HTMLElement | null;
  threadQuestionnaireDraft: WorkbenchQuestionnaireDraft | null;
  threadComposerDraft: WorkbenchThreadComposerDraft | null;
  threadSavedComposerDrafts: WorkbenchThreadSavedComposerDraft[];
  useSavedDraftShelfPortal?: boolean;
  knownSkills: WorkbenchSkillSummary[];
  highlightSources: InlineMentionHighlightSources;
  thread: ThreadPayload;
}) {
  const [value, setValue] = useState(threadComposerDraft?.text ?? "");
  const [attachments, setAttachments] = useState<ComposerImageAttachment[]>(threadComposerDraft?.attachments ?? []);
  const [availableModels, setAvailableModels] = useState<WorkbenchModelOption[]>([]);
  const [availableAgents, setAvailableAgents] = useState<WorkbenchAgentOption[]>([]);
  const [deprioritizedModelIdsByHarness, setDeprioritizedModelIdsByHarness] = useState<Record<ThreadPayload["harness"], string[]>>({
    codex: [],
    copilot: [],
  });
  const [activePicker, setActivePicker] = useState<"agent" | "model" | null>(null);
  const [error, setError] = useState("");
  const [isComposing, setIsComposing] = useState(false);
  const [isLoadingAgents, setIsLoadingAgents] = useState(false);
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const [agentsError, setAgentsError] = useState("");
  const [modelsError, setModelsError] = useState("");
  const [isQuestionnaireVisible, setIsQuestionnaireVisible] = useState(Boolean(pendingUserInputRequest));
  const [pendingAttachmentReads, setPendingAttachmentReads] = useState(0);
  const [isSending, setIsSending] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [isSavedDraftShelfExpanded, setIsSavedDraftShelfExpanded] = useState(false);
  const hydratedDraftKeyRef = useRef("");
  const savedDraftShelfRef = useRef<HTMLDivElement>(null);
  const onThreadComposerDraftChangeRef = useRef(onThreadComposerDraftChange);
  const onThreadComposerDraftClearRef = useRef(onThreadComposerDraftClear);

  onThreadComposerDraftChangeRef.current = onThreadComposerDraftChange;
  onThreadComposerDraftClearRef.current = onThreadComposerDraftClear;
  const trimmedValue = value.trim();
  const isAttaching = pendingAttachmentReads > 0;
  const hasPendingUserInputRequest = pendingUserInputRequest !== null;
  const questionnaireRequestKey = pendingUserInputRequest?.requestKey ?? "";
  const showQuestionnairePanel = hasPendingUserInputRequest && isQuestionnaireVisible;
  const isCopilotAuthRequired = thread.harness === "copilot" && rateLimits?.limitId === "copilot:auth";
  const isThreadStateBroken = hasStaleApprovalState(thread);
  const isApprovalBlocked = isCurrentTurnWaitingOnApproval(thread);
  const isActiveThread = getCurrentInProgressTurn(thread) !== null;
  const isInputDisabled = isSending || isAttaching || isThreadStateBroken || isCopilotAuthRequired;
  const isSendDisabled = hasPendingUserInputRequest || isInputDisabled;
  const isSaveDraftDisabled = hasPendingUserInputRequest || isInputDisabled || (!trimmedValue && !attachments.length);
  const isStopDisabled = !isActiveThread || isStopping;
  const isMobileTextInput = useMobileTextInputEnvironment();
  const helperText = hasPendingUserInputRequest
    ? "Answer the question card before sending."
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
  const showsReasoningEffortControl = Boolean(modelOptionForControls?.supportsReasoningEffort && currentReasoningEffort);
  const showsFastModeControl = thread.harness === "codex" && Boolean(modelOptionForControls?.supportsFastMode);
  const isFastModeEnabled = thread.serviceTier === "fast";
  const isAgentPickerOpen = activePicker === "agent";
  const isModelPickerOpen = activePicker === "model";
  const isPickerOpen = activePicker !== null;
  const showStopButton = isActiveThread || isStopping;
  const selectedAgent = availableAgents.find((agent) => agent.path === thread.agentPath) ?? null;
  const agentButtonLabel = selectedAgent?.name
    ?? thread.agentPath?.split("/").at(-1)?.replace(/\.agent\.md$/i, "")
    ?? "Default agent";
  const deprioritizedModelIds = deprioritizedModelIdsByHarness[thread.harness] ?? [];
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
    const draftKey = `${thread.id}:${threadComposerDraft?.updatedAt ?? 0}`;
    if (hydratedDraftKeyRef.current === draftKey) {
      return;
    }

    hydratedDraftKeyRef.current = draftKey;
    if ((value.trim() || attachments.length) && threadComposerDraft) {
      return;
    }

    setValue(threadComposerDraft?.text ?? "");
    setAttachments(threadComposerDraft?.attachments ?? []);
  }, [attachments.length, thread.id, threadComposerDraft, value]);

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
    setIsQuestionnaireVisible(Boolean(pendingUserInputRequest));
  }, [pendingUserInputRequest?.request.id, thread.id]);

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
    let cancelled = false;
    setIsLoadingAgents(true);
    void fetch(`/api/agents?projectId=${encodeURIComponent(projectId)}`, { cache: "no-store" }).then(async (response) => {
      if (!response.ok) {
        throw new Error("Unable to load agents.");
      }

      const payload = await response.json() as { data?: WorkbenchAgentOption[] };
      if (cancelled) {
        return;
      }

      setAvailableAgents(payload.data ?? []);
      setAgentsError("");
    }).catch((agentsLoadError) => {
      if (cancelled) {
        return;
      }

      setAgentsError(agentsLoadError instanceof Error ? agentsLoadError.message : "Unable to load agents.");
    }).finally(() => {
      if (!cancelled) {
        setIsLoadingAgents(false);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [projectId]);

  useEffect(() => {
    let cancelled = false;
    setAvailableModels([]);
    void onListModels(thread.harness).then((models) => {
      if (cancelled) {
        return;
      }

      setAvailableModels(models);
    }).catch(() => {
      // Ignore background refresh failures; the picker load path shows a user-facing error.
    });

    return () => {
      cancelled = true;
    };
  }, [onListModels, thread.harness]);

  useEffect(() => {
    if (!isModelPickerOpen) {
      return;
    }

    let cancelled = false;
    setIsLoadingModels(true);
    setModelsError("");
    void onListModels(thread.harness).then((models) => {
      if (cancelled) {
        return;
      }

      setAvailableModels(models);
    }).catch((modelsLoadError) => {
      if (cancelled) {
        return;
      }

      setModelsError(modelsLoadError instanceof Error ? modelsLoadError.message : "Unable to load models.");
    }).finally(() => {
      if (!cancelled) {
        setIsLoadingModels(false);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [isModelPickerOpen, onListModels, thread.harness]);

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
    const imageFiles = Array.from(event.clipboardData.items)
      .filter((item) => item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);

    if (!imageFiles.length) {
      return;
    }

    event.preventDefault();
    setError("");
    setPendingAttachmentReads((count) => count + 1);
    void (async () => {
      try {
        const nextAttachments = await Promise.all(imageFiles.map(async (file) => ({
          id: createAttachmentId(),
          url: await readFileAsDataUrl(file),
        })));
        setAttachments((current) => [...current, ...nextAttachments]);
      } catch (pasteError) {
        setError(pasteError instanceof Error ? pasteError.message : "Unable to attach the pasted image.");
      } finally {
        setPendingAttachmentReads((count) => Math.max(0, count - 1));
      }
    })();
  };

  const cycleReasoningEffort = (direction: 1 | -1) => {
    if (!supportedReasoningEfforts.length || !currentReasoningEffort) {
      return;
    }

    const currentIndex = supportedReasoningEfforts.indexOf(currentReasoningEffort);
    const baseIndex = currentIndex >= 0 ? currentIndex : 0;
    const nextIndex = (baseIndex + direction + supportedReasoningEfforts.length) % supportedReasoningEfforts.length;
    onThreadReasoningEffortChange(thread.id, supportedReasoningEfforts[nextIndex] ?? null);
  };

  const stopButton = showStopButton ? (
    <button
      type="button"
      aria-label={isStopping ? "Stopping current turn" : "Stop current turn"}
      title={isStopping ? "Stopping current turn" : "Stop current turn"}
      disabled={isStopDisabled}
      className={joinClasses(
        "inline-flex size-10 items-center justify-center rounded-full transition",
        "bg-[color:color-mix(in_srgb,var(--text)_92%,var(--bg)_8%)] text-[var(--bg)]",
        "hover:opacity-92 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:color-mix(in_srgb,var(--text)_22%,transparent)]",
        isStopDisabled && "cursor-not-allowed opacity-45",
      )}
      onClick={() => {
        void stop();
      }}
    >
      <svg viewBox="0 0 16 16" className="h-4.5 w-4.5" aria-hidden="true">
        <rect x="2.5" y="2.5" width="11" height="11" rx="1.9" fill="currentColor" />
      </svg>
    </button>
  ) : null;
  const questionnaireToggleButton = hasPendingUserInputRequest ? (
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

  return (
    <>
      <form className="mt-6 border-t border-[color-mix(in_srgb,var(--text)_10%,transparent)] pt-4" onSubmit={handleSubmit}>
        <div className="rounded-[1.15rem] bg-[color-mix(in_srgb,var(--text)_4%,transparent)] p-3">
          {showQuestionnairePanel && pendingUserInputRequest ? (
            <ThreadUserInputRequest
              actions={stopButton}
              draft={threadQuestionnaireDraft}
              highlightSources={highlightSources}
              knownSkills={knownSkills}
              leadingActions={questionnaireToggleButton}
              onDraftChange={handleQuestionnaireDraftChange}
              onDraftClear={handleQuestionnaireDraftClear}
              projectRootPath={projectRootPath}
              request={pendingUserInputRequest.request}
              mode="live"
              onSubmit={async (response) => {
                await onSubmitUserInputRequest(
                  thread.id,
                  response,
                  buildPendingUserInputRequestSubmissionOptions(thread, pendingUserInputRequest),
                );
              }}
            />
          ) : null}
          {!showQuestionnairePanel && attachments.length ? (
            <div className="mb-3 flex flex-wrap gap-3 px-1">
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
          <div className="block" hidden={showQuestionnairePanel}>
            <span className="sr-only">Message thread</span>
            <div hidden={isPickerOpen}>
              <PlaintextEditable
                id={`thread-composer:${thread.id}`}
                ariaLabel="Message thread"
                className="thread-plaintext-editable min-h-[5.75rem] w-full border-0 bg-transparent px-1 py-1 text-[0.96em] leading-[1.65] text-text outline-none"
                disabled={isInputDisabled}
                placeholder={isThreadStateBroken
                  ? "New messages are disabled for this thread."
                  : isCopilotAuthRequired
                    ? "Sign in to Copilot CLI to send messages."
                    : isActiveThread
                      ? "Message the current turn..."
                      : thread.isDraft
                        ? "Start a new thread..."
                        : "Continue this thread..."}
                highlights={composerHighlights}
                mentionSources={highlightSources}
                mentionSuggestionsPlacement="above"
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
            </div>
          </div>
          {!showQuestionnairePanel && isModelPickerOpen ? (
            <ThreadModelPicker
              appliesOnNextTurnOnly={thread.harness === "codex" && isActiveThread}
              deprioritizedModelIds={deprioritizedModelIds}
              error={modelsError}
              harness={thread.harness}
              isLoading={isLoadingModels}
              models={availableModels}
              selectedModelId={selectedModel}
              onClose={() => {
                setActivePicker(null);
              }}
              onSelectModel={(model) => {
                onThreadModelChange(thread.id, model.id);
                if (!model.supportsFastMode && isFastModeEnabled) {
                  onThreadServiceTierChange(thread.id, null);
                }
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
          ) : !showQuestionnairePanel && isAgentPickerOpen ? (
            <ThreadAgentPicker
              agents={availableAgents}
              error={agentsError}
              isLoading={isLoadingAgents}
              selectedAgentPath={thread.agentPath}
              onClose={() => {
                setActivePicker(null);
              }}
              onSelectAgent={(agentPath) => {
                onThreadAgentChange(thread.id, agentPath);
                setActivePicker(null);
              }}
            />
          ) : !showQuestionnairePanel ? (
            <div className={joinClasses(
              "mt-3 flex flex-wrap items-center gap-3",
              helperText ? "justify-between" : "justify-end",
            )}>
              <div className="flex items-center gap-2">
                {questionnaireToggleButton}
                {helperText ? (
                  <p className={joinClasses(
                    "m-0 text-[0.78em] leading-[1.6]",
                    isThreadStateBroken ? "text-danger" : "text-muted",
                  )}>
                    {helperText}
                  </p>
                ) : null}
              </div>
              <div className="flex flex-wrap items-center gap-2">
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
                <div className="inline-flex items-stretch overflow-hidden rounded-full border border-[color-mix(in_srgb,var(--text)_10%,transparent)] bg-[color-mix(in_srgb,var(--bg)_96%,transparent)] text-[0.78em] font-medium text-text">
                  <button
                    type="button"
                    className="px-3 py-2 transition hover:bg-[color-mix(in_srgb,var(--text)_4%,transparent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-soft"
                    onClick={() => {
                      setActivePicker("model");
                    }}
                  >
                    {modelButtonLabel}
                  </button>
                  {showsReasoningEffortControl ? (
                    <>
                      <span className="w-px bg-[color-mix(in_srgb,var(--text)_10%,transparent)]" aria-hidden="true" />
                      <button
                        type="button"
                        className="px-2.5 py-2 capitalize transition hover:bg-[color-mix(in_srgb,var(--text)_4%,transparent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-soft"
                        title="Left click to increase effort. Right click to decrease effort."
                        onClick={() => {
                          cycleReasoningEffort(1);
                        }}
                        onContextMenu={(event) => {
                          event.preventDefault();
                          cycleReasoningEffort(-1);
                        }}
                      >
                        {currentReasoningEffort}
                      </button>
                    </>
                  ) : null}
                  {showsFastModeControl ? (
                    <>
                      <span className="w-px bg-[color-mix(in_srgb,var(--text)_10%,transparent)]" aria-hidden="true" />
                      <button
                        type="button"
                        aria-label={isFastModeEnabled ? "Turn fast mode off" : "Turn fast mode on"}
                        aria-pressed={isFastModeEnabled}
                        className={joinClasses(
                          "inline-flex items-center justify-center px-2.5 py-2 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-soft",
                          isFastModeEnabled
                            ? "text-text hover:bg-[color-mix(in_srgb,var(--text)_4%,transparent)]"
                            : "text-muted opacity-40 hover:bg-[color-mix(in_srgb,var(--text)_4%,transparent)] hover:opacity-65",
                        )}
                        title={isFastModeEnabled ? "Fast mode is on" : "Fast mode is off"}
                        onClick={() => {
                          onThreadServiceTierChange(thread.id, isFastModeEnabled ? null : "fast");
                        }}
                      >
                        <LightningBoltIcon />
                      </button>
                    </>
                  ) : null}
                  <span className="w-px bg-[color-mix(in_srgb,var(--text)_10%,transparent)]" aria-hidden="true" />
                  <button
                    type="button"
                    className="px-3 py-2 transition hover:bg-[color-mix(in_srgb,var(--text)_4%,transparent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-soft"
                    onClick={() => {
                      setActivePicker("agent");
                    }}
                  >
                    {agentButtonLabel}
                  </button>
                </div>
                <button
                  type="submit"
                  disabled={(!trimmedValue && !attachments.length) || isSendDisabled}
                  className={joinClasses(
                    "rounded-full px-4 py-2 text-[0.84em] font-medium transition",
                    "bg-[color:color-mix(in_srgb,var(--text)_92%,var(--bg)_8%)] text-[var(--bg)]",
                    "hover:opacity-92 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:color-mix(in_srgb,var(--text)_22%,transparent)]",
                    ((!trimmedValue && !attachments.length) || isSendDisabled) && "cursor-not-allowed opacity-45",
                  )}
                >
                  {isSending ? "Sending..." : isAttaching ? "Attaching..." : isThreadStateBroken ? "Unavailable" : "Send"}
                </button>
                {stopButton}
              </div>
            </div>
          ) : null}
        </div>
        {error ? (
          <p className="mt-2 mb-0 text-[0.84em] leading-[1.6] text-danger">{error}</p>
        ) : null}
      </form>
      {children}
      {useSavedDraftShelfPortal
        ? (savedDraftShelfPortalHost ? createPortal(savedDraftShelf, savedDraftShelfPortalHost) : null)
        : savedDraftShelf}
    </>
  );
}
