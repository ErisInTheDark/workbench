"use client";

import { useEffect, useState } from "react";

import type {
  WorkbenchUserInputQuestion,
  WorkbenchUserInputRequest,
  WorkbenchUserInputResponse,
} from "../../../lib/types";

function joinClasses (...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

const MAX_HEADER_LENGTH = 36;
const MAX_HEADER_WORDS = 5;
const EMPTY_HISTORY_CUSTOM_TEXT_SPACER_CLASS = "w-full min-h-[2.45rem] rounded-lg px-3 py-2";

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

function deriveAnsweredValues (
  question: WorkbenchUserInputQuestion,
  response: WorkbenchUserInputResponse | null,
) {
  const answers = response?.answers[question.id]?.answers ?? [];
  const optionLabels = new Set(question.options.map((option) => option.label));
  const matchedOptions = answers.filter((answer) => optionLabels.has(answer));
  const unmatchedAnswers = answers.filter((answer) => !optionLabels.has(answer));

  return {
    customValue: [...matchedOptions.slice(1), ...unmatchedAnswers].join("\n\n"),
    selectedValue: matchedOptions[0] ?? "",
  };
}

type InteractiveThreadUserInputRequestProps = {
  mode: "live" | "preview";
  onClear: () => void;
  onSubmit: (response: WorkbenchUserInputResponse) => Promise<void>;
  request: WorkbenchUserInputRequest;
};

type HistoryThreadUserInputRequestProps = {
  mode: "history";
  request: WorkbenchUserInputRequest;
  response: WorkbenchUserInputResponse | null;
  statusLabel?: string;
};

export default function ThreadUserInputRequest (props: InteractiveThreadUserInputRequestProps | HistoryThreadUserInputRequestProps) {
  const { mode, request } = props;
  const isHistoryMode = mode === "history";
  const historyProps = mode === "history" ? props : null;
  const interactiveProps = mode === "history" ? null : props;
  const [selectedValues, setSelectedValues] = useState<Record<string, string>>({});
  const [customValues, setCustomValues] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (isHistoryMode) {
      return;
    }

    setSelectedValues({});
    setCustomValues({});
    setError("");
    setIsSubmitting(false);
  }, [isHistoryMode, request.id]);

  const resetAnswers = () => {
    setSelectedValues({});
    setCustomValues({});
    setError("");
    setIsSubmitting(false);
  };

  const handleSubmit = async () => {
    if (isHistoryMode || isSubmitting) {
      return;
    }

    const answers: WorkbenchUserInputResponse["answers"] = {};
    for (const question of request.questions) {
      const selectedValue = selectedValues[question.id];
      const customValue = customValues[question.id]?.trim();

      answers[question.id] = {
        answers: [
          ...(selectedValue ? [selectedValue] : []),
          ...(customValue ? [customValue] : []),
        ],
      };
    }

    setIsSubmitting(true);
    setError("");
    try {
      await interactiveProps?.onSubmit({ answers });
    } catch (submissionError) {
      setError(submissionError instanceof Error ? submissionError.message : "Unable to submit that response.");
      setIsSubmitting(false);
    }
  };

  return (
    <div className="space-y-4 px-1 py-1">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-2">
          <div className="space-y-1">
            <h3 className="m-0 text-[1.02em] font-semibold leading-[1.35] text-text">
              {request.title}
            </h3>
            <p className="m-0 max-w-3xl text-[0.88em] leading-[1.7] text-muted">
              {request.summary}
            </p>
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
              if (mode === "preview") {
                interactiveProps?.onClear();
                return;
              }

              resetAnswers();
            }}
            className="rounded-full border border-[color-mix(in_srgb,var(--text)_10%,transparent)] px-3 py-2 text-[0.76em] font-medium text-text transition hover:bg-[color-mix(in_srgb,var(--text)_4%,transparent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
          >
            {mode === "preview" ? "Clear preview" : "Clear answers"}
          </button>
        )}
      </div>

      <div className="space-y-3">
        {request.questions.map((question, index) => {
          const isLastQuestion = index === request.questions.length - 1;
          const { headerText, questionText } = formatQuestionDisplay(question, index);
          const answerValues = isHistoryMode
            ? deriveAnsweredValues(question, historyProps?.response ?? null)
            : {
              customValue: customValues[question.id] ?? "",
              selectedValue: selectedValues[question.id] ?? "",
            };
          const selectedValue = answerValues.selectedValue;
          const customValue = answerValues.customValue;

          return (
            <section
              key={question.id}
              className="mb-0"
            >
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
              <div className="mt-3 space-y-2">
                {question.options.map((option, index) => {
                  const optionId = `${request.id}:${question.id}:option:${index}`;
                  const isChecked = selectedValue === option.label;
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
                        "mt-1 inline-flex h-4 w-4 shrink-0 rounded-full border transition",
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
                          if (next[question.id] === option.label) {
                            delete next[question.id];
                          } else {
                            next[question.id] = option.label;
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
                    <textarea
                      id={`${request.id}:${question.id}:custom`}
                      value={customValue}
                      readOnly
                      rows={Math.max(1, customValue.split(/\r?\n/u).length)}
                      spellCheck={false}
                      className="rounded-lg w-full resize-none px-3 py-3 text-[0.84em] leading-[1.5] text-text outline-none placeholder:text-muted bg-[color-mix(in_srgb,var(--text)_4%,transparent)]"
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
                  <textarea
                    id={`${request.id}:${question.id}:custom`}
                    value={customValue}
                    onChange={(event) => {
                      setCustomValues((current) => ({
                        ...current,
                        [question.id]: event.target.value,
                      }));
                      if (error) {
                        setError("");
                      }
                    }}
                    rows={1}
                    spellCheck={!question.isSecret}
                    className="rounded-lg w-full resize-y px-3 py-2 text-[0.84em] leading-[1.5] text-text outline-none placeholder:text-muted
                    hover:py-3 hover:bg-[color-mix(in_srgb,var(--text)_4%,transparent)]
                    focus-visible:mt-2 focus-visible:mb-4 focus-visible:py-3 focus-visible:bg-[color-mix(in_srgb,var(--text)_4%,transparent)]
                    not-empty:mt-2 not-empty:mb-4 not-empty:py-3 not-empty:bg-[color-mix(in_srgb,var(--text)_4%,transparent)]
                    "
                  />
                )}
              </div>
            </section>
          );
        })}
      </div>

      {!isHistoryMode ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
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
        </div>
      ) : null}

      {!isHistoryMode && error ? (
        <p className="m-0 text-[0.84em] leading-[1.6] text-danger">{error}</p>
      ) : null}
    </div>
  );
}
