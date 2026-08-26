/*
 * Exports:
 * - default ThreadUserInputRequest: render full or compact live, preview, and historical questionnaire requests. Keywords: questionnaire, custom input, thread, compact.
 * - Local helpers: question display normalization, answered value derivation, pasted image attachments, and submit handling. Keywords: options, answers, drafts, images, presentation.
 */
"use client";

import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent, type ReactNode } from "react";

import type { UserInput } from "../../../lib/codex/generated/app-server/v2/UserInput";
import type {
  WorkbenchQuestionnaireDraft,
  WorkbenchSkillSummary,
  WorkbenchThreadComposerAttachmentDraft,
  WorkbenchUserInputQuestion,
  WorkbenchUserInputRequest,
  WorkbenchUserInputResponse,
} from "../../../lib/types";
import { readClipboardImageDataUrls } from "../../../lib/workbench/dom/clipboard";
import type { WorkspaceFileLinkRoot } from "../../../lib/workbench/markdown/markdown-links";
import {
  buildInlineMentionHighlights,
  type InlineMentionHighlightSources,
} from "../../../lib/workbench/thread/inline-mention-highlights";
import { getThreadCommandDisplay } from "../../../lib/workbench/thread/thread-command-matchers";
import {
  hasWorkbenchApprovalDecisionSelection,
  isWorkbenchApprovalDecisionQuestion,
  isWorkbenchApprovalRequest,
} from "../../../lib/workbench/thread/thread-user-input-requests";
import PrimaryButton from "../PrimaryButton";
import { WorkbenchOptionCard } from "../WorkbenchOptionCards";
import PlaintextEditable from "./PlaintextEditable";
import ThreadLightboxImage from "./ThreadLightboxImage";
import { isMobileTextInputEnvironment } from "./mobile-text-input-environment";
import { formatQuestionDisplay, shouldUseCompactSingleQuestionDisplay } from "./thread-user-input-request-preview";
import { ThreadCommandSummary } from "./thread-view-primitives";

function joinClasses (...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

const EMPTY_HISTORY_CUSTOM_TEXT_SPACER_CLASS = "w-full min-h-[2.45rem] rounded-lg px-3 py-2";
const APPROVAL_OPTION_REQUIRED_MESSAGE = "Choose one of the approval options before submitting.";

function createAttachmentId () {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `questionnaire-attachment:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

function deriveAnsweredValues (
  question: WorkbenchUserInputQuestion,
  response: WorkbenchUserInputResponse | null,
) {
  const answers = response?.answers[question.id]?.answers ?? [];
  const optionLabels = new Set(question.options.map((option) => option.label));
  const matchedOptions = answers.filter((answer) => optionLabels.has(answer));
  const unmatchedAnswers = answers.filter((answer) => !optionLabels.has(answer));

  return {
    customValue: unmatchedAnswers.join("\n\n"),
    selectedValues: matchedOptions,
  };
}

function hasSelectedDraftValues (values: Record<string, string[]>) {
  return Object.values(values).some((questionValues) => questionValues.some((value) => value.trim()));
}

function isSingleChoiceQuestion (
  request: WorkbenchUserInputRequest,
  question: WorkbenchUserInputQuestion,
) {
  if (request.approval) {
    return true;
  }

  return isWorkbenchApprovalDecisionQuestion(question);
}

type InteractiveThreadUserInputRequestProps = {
  actions?: ReactNode;
  draft: WorkbenchQuestionnaireDraft | null;
  highlightSources?: InlineMentionHighlightSources;
  knownSkills?: WorkbenchSkillSummary[];
  leadingActions?: ReactNode;
  mode: "live";
  onDraftChange: (draft: WorkbenchQuestionnaireDraft) => void;
  onDraftClear: () => void;
  onSubmit: (response: WorkbenchUserInputResponse, supplementalInput?: UserInput[]) => Promise<void>;
  presentation?: "compact" | "full";
  projectRootPath?: string;
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
  request: WorkbenchUserInputRequest;
  spellCheck: boolean;
};

type HistoryThreadUserInputRequestProps = {
  highlightSources?: InlineMentionHighlightSources;
  knownSkills?: WorkbenchSkillSummary[];
  mode: "history";
  presentation?: "compact" | "full";
  projectRootPath?: string;
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
  request: WorkbenchUserInputRequest;
  response: WorkbenchUserInputResponse | null;
  statusLabel?: string;
};

type PreviewThreadUserInputRequestProps = {
  draft: WorkbenchQuestionnaireDraft | null;
  highlightSources?: InlineMentionHighlightSources;
  knownSkills?: WorkbenchSkillSummary[];
  mode: "preview";
  presentation?: "compact" | "full";
  projectRootPath?: string;
  request: WorkbenchUserInputRequest;
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
};

type ThreadUserInputRequestProps =
  | HistoryThreadUserInputRequestProps
  | InteractiveThreadUserInputRequestProps
  | PreviewThreadUserInputRequestProps;

function ThreadApprovalCommandSummary ({
  knownSkills,
  projectRootPath,
  request,
  workspaceRoots,
}: {
  knownSkills?: WorkbenchSkillSummary[];
  projectRootPath?: string;
  request: WorkbenchUserInputRequest;
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
}) {
  const commandContext = request.approval?.command ?? null;
  const display = useMemo(() => (
    commandContext
      ? getThreadCommandDisplay({
        command: commandContext.command,
        commandActions: commandContext.commandActions,
        cwd: commandContext.cwd,
        knownSkills,
        projectRootPath,
        workspaceRoots,
      })
      : null
  ), [commandContext, knownSkills, projectRootPath, workspaceRoots]);

  if (!display || display.omitFromDisplay || display.summaryKind !== "matched") {
    return null;
  }

  return (
    <div className="rounded-lg bg-[color-mix(in_srgb,var(--text)_4%,transparent)] px-3 py-2.5">
      <p className="m-0 text-[0.72em] font-semibold tracking-[0.08em] text-muted uppercase">
        Matched action
      </p>
      <p className="mt-1 mb-0 min-w-0 text-[0.92em] leading-[1.65] text-text">
        <ThreadCommandSummary display={display} />
      </p>
    </div>
  );
}

export default function ThreadUserInputRequest (props: ThreadUserInputRequestProps) {
  const { mode, request } = props;
  const isHistoryMode = mode === "history";
  const isPreviewMode = mode === "preview";
  const isInteractiveMode = mode === "live";
  const isReadOnlyMode = isHistoryMode || isPreviewMode;
  const compact = props.presentation === "compact";
  const useCompactSingleQuestionDisplay = shouldUseCompactSingleQuestionDisplay(request);
  const compactQuestion = useCompactSingleQuestionDisplay ? request.questions[0] : null;
  const requestTitle = compactQuestion?.question.trim() || request.title;
  const requestSummary = useCompactSingleQuestionDisplay ? "" : request.summary.trim();
  const historyProps = mode === "history" ? props : null;
  const previewProps = mode === "preview" ? props : null;
  const interactiveProps = isInteractiveMode ? props : null;
  const highlightSources = props.highlightSources;
  const interactiveDraft = interactiveProps?.draft ?? null;
  const onInteractiveDraftChange = interactiveProps?.onDraftChange;
  const onInteractiveDraftClear = interactiveProps?.onDraftClear;
  const [selectedValues, setSelectedValues] = useState<Record<string, string[]>>(interactiveDraft?.selectedValues ?? {});
  const [customValues, setCustomValues] = useState<Record<string, string>>(interactiveDraft?.customValues ?? {});
  const [attachments, setAttachments] = useState<WorkbenchThreadComposerAttachmentDraft[]>(interactiveDraft?.attachments ?? []);
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [pendingAttachmentReads, setPendingAttachmentReads] = useState(0);
  const hydratedDraftKeyRef = useRef("");
  const hydratedRequestIdRef = useRef("");
  const onInteractiveDraftChangeRef = useRef(onInteractiveDraftChange);
  const onInteractiveDraftClearRef = useRef(onInteractiveDraftClear);
  const latestDraftRef = useRef<WorkbenchQuestionnaireDraft>({
    attachments,
    customValues,
    selectedValues,
    updatedAt: Date.now(),
  });
  const submissionSucceededRef = useRef(false);

  onInteractiveDraftChangeRef.current = onInteractiveDraftChange;
  onInteractiveDraftClearRef.current = onInteractiveDraftClear;
  latestDraftRef.current = {
    attachments,
    customValues,
    selectedValues,
    updatedAt: Date.now(),
  };
  const isAttaching = pendingAttachmentReads > 0;

  useEffect(() => {
    if (!interactiveProps) {
      return;
    }

    const requestChanged = hydratedRequestIdRef.current !== request.id;
    const draftKey = `${request.id}:${interactiveDraft?.updatedAt ?? 0}`;
    if (requestChanged) {
      submissionSucceededRef.current = false;
      hydratedRequestIdRef.current = request.id;
      hydratedDraftKeyRef.current = draftKey;
      setSelectedValues(interactiveDraft?.selectedValues ?? {});
      setCustomValues(interactiveDraft?.customValues ?? {});
      setAttachments(interactiveDraft?.attachments ?? []);
    } else if (hydratedDraftKeyRef.current !== draftKey) {
      hydratedDraftKeyRef.current = draftKey;
      const hasLocalDraft = hasSelectedDraftValues(selectedValues)
        || Object.values(customValues).some((value) => value.trim())
        || attachments.length > 0;
      if (!hasLocalDraft) {
        setSelectedValues(interactiveDraft?.selectedValues ?? {});
        setCustomValues(interactiveDraft?.customValues ?? {});
        setAttachments(interactiveDraft?.attachments ?? []);
      }
    }
    setError("");
    setIsSubmitting(false);
  }, [attachments.length, customValues, interactiveDraft, isInteractiveMode, request.id, selectedValues]);

  useEffect(() => {
    if (!interactiveProps) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      const hasSelectedValues = hasSelectedDraftValues(selectedValues);
      const hasCustomValues = Object.values(customValues).some((value) => value.trim());
      if (!hasSelectedValues && !hasCustomValues && attachments.length === 0) {
        onInteractiveDraftClearRef.current?.();
        return;
      }

      onInteractiveDraftChangeRef.current?.({
        attachments,
        customValues,
        selectedValues,
        updatedAt: Date.now(),
      });
    }, 260);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [attachments, customValues, isInteractiveMode, selectedValues]);

  useEffect(() => {
    if (!interactiveProps) return;
    submissionSucceededRef.current = false;
    return () => {
      if (submissionSucceededRef.current) return;
      const draft = latestDraftRef.current;
      const hasSelectedValues = hasSelectedDraftValues(draft.selectedValues);
      const hasCustomValues = Object.values(draft.customValues).some((value) => value.trim());
      if (!hasSelectedValues && !hasCustomValues && draft.attachments.length === 0) {
        onInteractiveDraftClearRef.current?.();
        return;
      }
      onInteractiveDraftChangeRef.current?.({
        ...draft,
        updatedAt: Date.now(),
      });
    };
  }, [isInteractiveMode, request.id]);

  const resetAnswers = () => {
    setSelectedValues({});
    setCustomValues({});
    setAttachments([]);
    setError("");
    setIsSubmitting(false);
    onInteractiveDraftClearRef.current?.();
  };

  const handleSubmit = async () => {
    if (!interactiveProps || isSubmitting || isAttaching) {
      return;
    }

    const answers: WorkbenchUserInputResponse["answers"] = {};
    for (const question of request.questions) {
      const selectedQuestionValues = selectedValues[question.id] ?? [];
      const customValue = customValues[question.id]?.trim();

      answers[question.id] = {
        answers: [
          ...selectedQuestionValues,
          ...(customValue ? [customValue] : []),
        ],
      };
    }

    const response = { answers };
    if (isWorkbenchApprovalRequest(request) && !hasWorkbenchApprovalDecisionSelection(request, response)) {
      setError(APPROVAL_OPTION_REQUIRED_MESSAGE);
      return;
    }

    const supplementalInput: UserInput[] = attachments.map((attachment) => ({
      type: "image",
      url: attachment.url,
    }));
    setIsSubmitting(true);
    setError("");
    try {
      await interactiveProps.onSubmit(response, supplementalInput.length ? supplementalInput : undefined);
      submissionSucceededRef.current = true;
      onInteractiveDraftClearRef.current?.();
    } catch (submissionError) {
      setError(submissionError instanceof Error ? submissionError.message : "Unable to submit that response.");
      setIsSubmitting(false);
    }
  };

  const handlePaste = (event: ClipboardEvent<HTMLDivElement>) => {
    if (!interactiveProps) {
      return;
    }

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

  const handleLastQuestionKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!interactiveProps || isSubmitting || isAttaching || event.key !== "Enter" || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing) {
      return;
    }

    if (isMobileTextInputEnvironment()) {
      return;
    }

    event.preventDefault();
    void handleSubmit();
  };
  const renderSubmitButton = () => (
    <PrimaryButton
      type="button"
      data-thread-questionnaire-submit="true"
      onClick={() => {
        void handleSubmit();
      }}
      disabled={isSubmitting || isAttaching}
      className={joinClasses("justify-self-end text-[0.84em]", compact && "!px-3 !py-1")}
      pendingHalo={isSubmitting || isAttaching}
    >
      {isSubmitting ? "Submitting..." : isAttaching ? "Attaching..." : "Submit"}
    </PrimaryButton>
  );

  return (
    <div
      className={joinClasses("thread-user-input-request px-1 py-1", compact ? "space-y-2" : "space-y-4")}
      data-thread-user-input-presentation={compact ? "compact" : "full"}
    >
      <div className={joinClasses("thread-user-input-request-content", compact ? "space-y-2.5" : "space-y-4")}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-2">
            <div className="space-y-1">
              <h3 className="m-0 text-[1.02em] font-semibold leading-[1.35] text-text">
                {requestTitle}
              </h3>
              {requestSummary ? (
                <p className="m-0 max-w-3xl text-[0.88em] leading-[1.7] text-muted">
                  {requestSummary}
                </p>
              ) : null}
            </div>
          </div>
          {isHistoryMode ? (
            historyProps?.statusLabel ? (
              <p className="m-0 text-[0.76em] font-medium leading-[1.6] text-muted">{historyProps.statusLabel}</p>
            ) : null
          ) : (
            <>{/*
          <button
            type="button"
            onClick={() => {
              resetAnswers();
            }}
            className="rounded-full border border-[color-mix(in_srgb,var(--text)_10%,transparent)] px-3 py-2 text-[0.76em] font-medium text-text transition hover:bg-[color-mix(in_srgb,var(--text)_4%,transparent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
          >
            Clear answers
              </button>
              */}</>
          )}
        </div>

        <ThreadApprovalCommandSummary
          knownSkills={props.knownSkills}
          projectRootPath={props.projectRootPath}
          request={request}
          workspaceRoots={props.workspaceRoots}
        />

        <div className="space-y-3">
          {request.questions.map((question, index) => {
            const isLastQuestion = index === request.questions.length - 1;
            const { headerText, questionText } = formatQuestionDisplay(question, index);
            const answerValues = isHistoryMode
              ? deriveAnsweredValues(question, historyProps?.response ?? null)
              : isPreviewMode ? {
                customValue: previewProps?.draft?.customValues[question.id] ?? "",
                selectedValues: previewProps?.draft?.selectedValues[question.id] ?? [],
              } : {
                customValue: customValues[question.id] ?? "",
                selectedValues: selectedValues[question.id] ?? [],
              };
            const selectedQuestionValues = answerValues.selectedValues;
            const customValue = answerValues.customValue;
            const isSingleChoice = isSingleChoiceQuestion(request, question);
            const customValueHighlights = highlightSources
              ? buildInlineMentionHighlights(customValue, highlightSources)
              : [];

            return (
              <section
                key={question.id}
                className="mb-0"
              >
                {!useCompactSingleQuestionDisplay ? (
                  <div className="space-y-1">
                    <p className="m-0 text-[0.72em] font-semibold tracking-[0.08em] text-muted uppercase">
                      {headerText}
                    </p>
                    {questionText ? (
                      <p className="m-0 whitespace-pre-wrap break-words text-[0.92em] leading-[1.65] text-text">
                        {questionText}
                      </p>
                    ) : null}
                  </div>
                ) : null}
                <div className={compact ? "mt-2 space-y-0.5" : "mt-3 space-y-2"}>
                  {question.options.map((option, index) => {
                    const optionId = `${request.id}:${question.id}:option:${index}`;
                    const isChecked = selectedQuestionValues.includes(option.label);

                    if (isReadOnlyMode) {
                      return (
                        <WorkbenchOptionCard
                          key={optionId}
                          description={option.description}
                          isChecked={isChecked}
                          isHistoryMode
                          isSingleChoice={isSingleChoice}
                          label={option.label}
                          markerId={optionId}
                          presentation={compact ? "compact-inline" : "card"}
                        />
                      );
                    }

                    return (
                      <WorkbenchOptionCard
                        key={optionId}
                        description={option.description}
                        isChecked={isChecked}
                        isSingleChoice={isSingleChoice}
                        label={option.label}
                        markerId={optionId}
                        presentation={compact ? "compact-inline" : "card"}
                        onClick={() => {
                          setSelectedValues((current) => {
                            const next = { ...current };
                            const currentQuestionValues = next[question.id] ?? [];
                            if (isSingleChoice) {
                              if (currentQuestionValues.includes(option.label)) {
                                delete next[question.id];
                              } else {
                                next[question.id] = [option.label];
                              }
                              return next;
                            }

                            if (currentQuestionValues.includes(option.label)) {
                              const nextQuestionValues = currentQuestionValues.filter((value) => value !== option.label);
                              if (nextQuestionValues.length) {
                                next[question.id] = nextQuestionValues;
                              } else {
                                delete next[question.id];
                              }
                            } else {
                              next[question.id] = [...currentQuestionValues, option.label];
                            }
                            if (!next[question.id]?.length) {
                              delete next[question.id];
                            }
                            return next;
                          });
                          if (error) {
                            setError("");
                          }
                        }}
                      />
                    );
                  })}
                  {isReadOnlyMode ? (
                    customValue ? (
                      <PlaintextEditable
                        id={`${request.id}:${question.id}:custom`}
                        ariaLabel={`${headerText} answer`}
                        className="thread-plaintext-editable min-h-[2.45rem] w-full rounded-lg bg-[color-mix(in_srgb,var(--text)_4%,transparent)] px-3 py-3 text-[0.84em] leading-[1.5] text-text outline-none"
                        readOnly
                        spellCheck={false}
                        highlights={customValueHighlights}
                        value={customValue}
                      />
                    ) : (
                      !isLastQuestion ? (
                        <div
                          aria-hidden="true"
                          className={EMPTY_HISTORY_CUSTOM_TEXT_SPACER_CLASS}
                        />
                      ) : null
                    )
                  ) : compact && isLastQuestion ? (
                    <div
                      className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-2 [&:has([data-empty=false])]:grid-cols-1"
                      data-thread-questionnaire-custom-layout="compact-flow"
                    >
                      <PlaintextEditable
                        id={`${request.id}:${question.id}:custom`}
                        ariaLabel={`${headerText} answer`}
                        className="thread-plaintext-editable min-h-8 w-full rounded-lg bg-[color-mix(in_srgb,var(--text)_4%,transparent)] px-2.5 py-1.5 text-[0.82em] leading-[1.45] text-text outline-none"
                        spellCheck={!question.isSecret && (interactiveProps?.spellCheck ?? false)}
                        highlights={customValueHighlights}
                        mentionSources={highlightSources}
                        mentionSuggestionsPlacement="below"
                        value={customValue}
                        onChange={(nextValue) => {
                          setCustomValues((current) => ({
                            ...current,
                            [question.id]: nextValue,
                          }));
                          if (error) {
                            setError("");
                          }
                        }}
                        onKeyDown={handleLastQuestionKeyDown}
                        onPaste={handlePaste}
                      />
                      {renderSubmitButton()}
                    </div>
                  ) : (
                    <PlaintextEditable
                      id={`${request.id}:${question.id}:custom`}
                      ariaLabel={`${headerText} answer`}
                      className={joinClasses(
                        "thread-plaintext-editable min-h-[2.45rem] w-full rounded-lg px-3 py-2 text-[0.84em] leading-[1.5] text-text outline-none transition",
                        customValue
                          ? "bg-[color-mix(in_srgb,var(--text)_4%,transparent)] py-3 mt-1 mb-3"
                          : `
                          hover:bg-[color-mix(in_srgb,var(--text)_4%,transparent)] hover:py-3 hover:mb-3
                          focus-visible:bg-[color-mix(in_srgb,var(--text)_4%,transparent)] focus-visible:py-3 focus-visible:mt-1 focus-visible:mb-3
                        `,
                      )}
                      spellCheck={!question.isSecret && (interactiveProps?.spellCheck ?? false)}
                      highlights={customValueHighlights}
                      mentionSources={highlightSources}
                      mentionSuggestionsPlacement="below"
                      value={customValue}
                      onChange={(nextValue) => {
                        setCustomValues((current) => ({
                          ...current,
                          [question.id]: nextValue,
                        }));
                        if (error) {
                          setError("");
                        }
                      }}
                      onKeyDown={isLastQuestion ? handleLastQuestionKeyDown : undefined}
                      onPaste={handlePaste}
                    />
                  )}
                </div>
              </section>
            );
          })}
        </div>
        {!isHistoryMode && ((isPreviewMode ? previewProps?.draft?.attachments.length : attachments.length) || isAttaching) ? (
          <div className="space-y-2">
            {(isPreviewMode ? previewProps?.draft?.attachments ?? [] : attachments).length ? (
              <div className="flex flex-wrap gap-3">
                {(isPreviewMode ? previewProps?.draft?.attachments ?? [] : attachments).map((attachment, index) => (
                  <div key={attachment.id} className={joinClasses("relative", compact ? "h-16 w-16" : "h-24 w-24")}>
                    <ThreadLightboxImage
                      alt={`Questionnaire attached image ${index + 1}`}
                      buttonClassName="h-full w-full rounded-[0.95rem]"
                      imageClassName="h-full w-full object-cover"
                      src={attachment.url}
                    />
                    {!isPreviewMode ? <button
                      type="button"
                      aria-label={`Remove questionnaire attached image ${index + 1}`}
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
                    </button> : null}
                  </div>
                ))}
              </div>
            ) : null}
            {isAttaching && !isPreviewMode ? (
              <p className="m-0 text-[0.78em] leading-[1.6] text-muted">Attaching pasted image...</p>
            ) : null}
          </div>
        ) : null}
      </div>

      {interactiveProps && (!compact || interactiveProps.leadingActions || interactiveProps.actions) ? (
        <div className="thread-user-input-request-actions flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            {interactiveProps?.leadingActions}
          </div>
          <div className="flex flex-wrap items-center justify-end gap-3">
            {!compact ? renderSubmitButton() : null}
            {interactiveProps?.actions}
          </div>
        </div>
      ) : null}

      {interactiveProps && error ? (
        <p className="m-0 text-[0.84em] leading-[1.6] text-danger">{error}</p>
      ) : null}
    </div>
  );
}
