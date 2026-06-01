/*
 * Exports:
 * - default ThreadUserInputRequest: render live and historical questionnaire requests. Keywords: questionnaire, custom input, thread.
 * - Local helpers: question display normalization, answered value derivation, and submit handling. Keywords: options, answers, drafts.
 */
"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import type {
  WorkbenchUserInputQuestion,
  WorkbenchQuestionnaireDraft,
  WorkbenchSkillSummary,
  WorkbenchUserInputRequest,
  WorkbenchUserInputResponse,
} from "../../../lib/types";
import {
  buildInlineMentionHighlights,
  type InlineMentionHighlightSources,
} from "../../../lib/workbench/thread/inline-mention-highlights";
import { getThreadCommandDisplay } from "../../../lib/workbench/thread/thread-command-matchers";
import PlaintextEditable, { isMobileTextInputEnvironment } from "./PlaintextEditable";
import { ThreadCommandSummary } from "./thread-view-primitives";

function joinClasses (...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

const MAX_HEADER_LENGTH = 36;
const MAX_HEADER_WORDS = 5;
const EMPTY_HISTORY_CUSTOM_TEXT_SPACER_CLASS = "w-full min-h-[2.45rem] rounded-lg px-3 py-2";
const GENERIC_CODEX_QUESTIONNAIRE_TITLE = "Follow-up questions";
const GENERIC_CODEX_QUESTIONNAIRE_SUMMARY = "Codex needs your input before it can continue.";
const APPROVAL_DECISION_QUESTION_ID = "decision";
const APPROVAL_OPTION_LABELS = new Set(["Allow once", "Allow for session", "Decline"]);

function normalizeHeaderText (value: string | undefined) {
  return value?.replace(/\s+/g, " ").trim() ?? "";
}

function formatQuestionDisplay (
  question: WorkbenchUserInputQuestion,
  index: number,
) {
  const fallbackHeader = `Question ${index + 1}`;
  const rawHeader = question.header.trim();
  const normalizedHeader = normalizeHeaderText(question.header);
  const questionText = question.question.trim();
  const headerLooksLikeQuestion = !normalizedHeader
    || normalizedHeader.length > MAX_HEADER_LENGTH
    || normalizedHeader.split(/\s+/).filter(Boolean).length > MAX_HEADER_WORDS
    || /[?.!]$/u.test(rawHeader);

  if (headerLooksLikeQuestion) {
    return {
      headerText: fallbackHeader,
      questionText: questionText || normalizedHeader || "No question text provided.",
    };
  }

  return {
    headerText: normalizedHeader,
    questionText,
  };
}

function isGenericCodexQuestionnaireRequest (request: WorkbenchUserInputRequest) {
  return request.title.trim() === GENERIC_CODEX_QUESTIONNAIRE_TITLE
    && request.summary.trim() === GENERIC_CODEX_QUESTIONNAIRE_SUMMARY;
}

function shouldUseCompactSingleQuestionDisplay (request: WorkbenchUserInputRequest) {
  if (request.questions.length !== 1) {
    return false;
  }

  const questionText = request.questions[0]?.question.trim() ?? "";
  if (!questionText) {
    return false;
  }

  return isGenericCodexQuestionnaireRequest(request)
    || (!request.summary.trim() && request.title.trim() === questionText);
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

  return question.id === APPROVAL_DECISION_QUESTION_ID
    && question.options.some((option) => APPROVAL_OPTION_LABELS.has(option.label));
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
  onSubmit: (response: WorkbenchUserInputResponse) => Promise<void>;
  projectRootPath?: string;
  request: WorkbenchUserInputRequest;
};

type HistoryThreadUserInputRequestProps = {
  highlightSources?: InlineMentionHighlightSources;
  knownSkills?: WorkbenchSkillSummary[];
  mode: "history";
  projectRootPath?: string;
  request: WorkbenchUserInputRequest;
  response: WorkbenchUserInputResponse | null;
  statusLabel?: string;
};

function ThreadApprovalCommandSummary ({
  knownSkills,
  projectRootPath,
  request,
}: {
  knownSkills?: WorkbenchSkillSummary[];
  projectRootPath?: string;
  request: WorkbenchUserInputRequest;
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
      })
      : null
  ), [commandContext, knownSkills, projectRootPath]);

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

export default function ThreadUserInputRequest (props: InteractiveThreadUserInputRequestProps | HistoryThreadUserInputRequestProps) {
  const { mode, request } = props;
  const isHistoryMode = mode === "history";
  const useCompactSingleQuestionDisplay = shouldUseCompactSingleQuestionDisplay(request);
  const compactQuestion = useCompactSingleQuestionDisplay ? request.questions[0] : null;
  const requestTitle = compactQuestion?.question.trim() || request.title;
  const requestSummary = useCompactSingleQuestionDisplay ? "" : request.summary.trim();
  const historyProps = mode === "history" ? props : null;
  const interactiveProps = mode === "history" ? null : props;
  const highlightSources = props.highlightSources;
  const interactiveDraft = interactiveProps?.draft ?? null;
  const onInteractiveDraftChange = interactiveProps?.onDraftChange;
  const onInteractiveDraftClear = interactiveProps?.onDraftClear;
  const [selectedValues, setSelectedValues] = useState<Record<string, string[]>>(interactiveDraft?.selectedValues ?? {});
  const [customValues, setCustomValues] = useState<Record<string, string>>(interactiveDraft?.customValues ?? {});
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const hydratedDraftKeyRef = useRef("");
  const hydratedRequestIdRef = useRef("");
  const onInteractiveDraftChangeRef = useRef(onInteractiveDraftChange);
  const onInteractiveDraftClearRef = useRef(onInteractiveDraftClear);

  onInteractiveDraftChangeRef.current = onInteractiveDraftChange;
  onInteractiveDraftClearRef.current = onInteractiveDraftClear;

  useEffect(() => {
    if (isHistoryMode) {
      return;
    }

    const requestChanged = hydratedRequestIdRef.current !== request.id;
    const draftKey = `${request.id}:${interactiveDraft?.updatedAt ?? 0}`;
    if (requestChanged) {
      hydratedRequestIdRef.current = request.id;
      hydratedDraftKeyRef.current = draftKey;
      setSelectedValues(interactiveDraft?.selectedValues ?? {});
      setCustomValues(interactiveDraft?.customValues ?? {});
    } else if (hydratedDraftKeyRef.current !== draftKey) {
      hydratedDraftKeyRef.current = draftKey;
      const hasLocalDraft = hasSelectedDraftValues(selectedValues)
        || Object.values(customValues).some((value) => value.trim());
      if (!hasLocalDraft) {
        setSelectedValues(interactiveDraft?.selectedValues ?? {});
        setCustomValues(interactiveDraft?.customValues ?? {});
      }
    }
    setError("");
    setIsSubmitting(false);
  }, [customValues, interactiveDraft, isHistoryMode, request.id, selectedValues]);

  useEffect(() => {
    if (isHistoryMode) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      const hasSelectedValues = hasSelectedDraftValues(selectedValues);
      const hasCustomValues = Object.values(customValues).some((value) => value.trim());
      if (!hasSelectedValues && !hasCustomValues) {
        onInteractiveDraftClearRef.current?.();
        return;
      }

      onInteractiveDraftChangeRef.current?.({
        customValues,
        selectedValues,
        updatedAt: Date.now(),
      });
    }, 260);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [customValues, isHistoryMode, selectedValues]);

  const resetAnswers = () => {
    setSelectedValues({});
    setCustomValues({});
    setError("");
    setIsSubmitting(false);
    onInteractiveDraftClearRef.current?.();
  };

  const handleSubmit = async () => {
    if (isHistoryMode || isSubmitting) {
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

    setIsSubmitting(true);
    setError("");
    try {
      await interactiveProps?.onSubmit({ answers });
      onInteractiveDraftClearRef.current?.();
    } catch (submissionError) {
      setError(submissionError instanceof Error ? submissionError.message : "Unable to submit that response.");
      setIsSubmitting(false);
    }
  };

  const handleLastQuestionKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (isHistoryMode || isSubmitting || event.key !== "Enter" || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing) {
      return;
    }

    if (isMobileTextInputEnvironment()) {
      return;
    }

    event.preventDefault();
    void handleSubmit();
  };

  return (
    <div className="space-y-4 px-1 py-1">
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
          <button
            type="button"
            onClick={() => {
              resetAnswers();
            }}
            className="rounded-full border border-[color-mix(in_srgb,var(--text)_10%,transparent)] px-3 py-2 text-[0.76em] font-medium text-text transition hover:bg-[color-mix(in_srgb,var(--text)_4%,transparent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
          >
            Clear answers
          </button>
        )}
      </div>

      <ThreadApprovalCommandSummary
        knownSkills={props.knownSkills}
        projectRootPath={props.projectRootPath}
        request={request}
      />

      <div className="space-y-3">
        {request.questions.map((question, index) => {
          const isLastQuestion = index === request.questions.length - 1;
          const { headerText, questionText } = formatQuestionDisplay(question, index);
          const answerValues = isHistoryMode
            ? deriveAnsweredValues(question, historyProps?.response ?? null)
            : {
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
              <div className="mt-3 space-y-2">
                {question.options.map((option, index) => {
                  const optionId = `${request.id}:${question.id}:option:${index}`;
                  const isChecked = selectedQuestionValues.includes(option.label);
                  const optionDescription = option.description.trim();

                  const optionCardClassName = joinClasses(
                    "flex w-full items-start gap-3 rounded-[0.95rem] border px-3 py-2.5 text-left transition",
                    isChecked
                      ? "border-[color-mix(in_srgb,var(--text)_22%,transparent)] bg-[color-mix(in_srgb,var(--text)_5%,transparent)]"
                      : isHistoryMode
                        ? "border-[color-mix(in_srgb,var(--text)_10%,transparent)]"
                        : "border-[color-mix(in_srgb,var(--text)_10%,transparent)] hover:bg-[color-mix(in_srgb,var(--text)_3%,transparent)]",
                  );
                  const optionMarker = (
                    <span
                      id={optionId}
                      aria-hidden="true"
                      className={joinClasses(
                        "mt-1 inline-flex h-4 w-4 shrink-0 border transition",
                        isSingleChoice ? "rounded-full" : "rounded-[0.28rem]",
                        isChecked
                          ? "border-[color-mix(in_srgb,var(--text)_40%,transparent)] bg-[color-mix(in_srgb,var(--text)_86%,var(--bg)_14%)]"
                          : "border-[color-mix(in_srgb,var(--text)_22%,transparent)] bg-transparent",
                      )}
                    />
                  );
                  const optionBody = (
                    <>
                      {optionMarker}
                      <span className="min-w-0">
                        <span className="block text-[0.86em] font-medium leading-[1.5] text-text">
                          {option.label}
                        </span>
                        {optionDescription ? (
                          <span className="mt-0.5 block text-[0.78em] leading-[1.55] text-muted">
                            {optionDescription}
                          </span>
                        ) : null}
                      </span>
                    </>
                  );

                  if (isHistoryMode) {
                    return (
                      <div
                        key={optionId}
                        aria-pressed={isChecked}
                        className={optionCardClassName}
                      >
                        {optionBody}
                      </div>
                    );
                  }

                  return (
                    <button
                      type="button"
                      key={optionId}
                      aria-pressed={isChecked}
                      className={optionCardClassName}
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
                    >
                      {optionBody}
                    </button>
                  );
                })}
                {isHistoryMode ? (
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
                    spellCheck={!question.isSecret}
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
                  />
                )}
              </div>
            </section>
          );
        })}
      </div>

      {!isHistoryMode ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            {interactiveProps?.leadingActions}
          </div>
          <div className="flex flex-wrap items-center justify-end gap-3">
            <button
              type="button"
              onClick={() => {
                void handleSubmit();
              }}
              disabled={isSubmitting}
              className={joinClasses(
                "justify-self-end",
                "rounded-full px-4 py-2 text-[0.84em] font-medium transition",
                "bg-[color:color-mix(in_srgb,var(--text)_92%,var(--bg)_8%)] text-[var(--bg)]",
                "hover:opacity-92 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:color-mix(in_srgb,var(--text)_22%,transparent)]",
                isSubmitting && "cursor-not-allowed opacity-45",
              )}
            >
              {isSubmitting ? "Submitting..." : request.submitLabel}
            </button>
            {interactiveProps?.actions}
          </div>
        </div>
      ) : null}

      {!isHistoryMode && error ? (
        <p className="m-0 text-[0.84em] leading-[1.6] text-danger">{error}</p>
      ) : null}
    </div>
  );
}
