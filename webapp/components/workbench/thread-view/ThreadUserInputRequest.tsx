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

export default function ThreadUserInputRequest ({
  onClear,
  onSubmit,
  request,
}: {
  onClear: () => void;
  onSubmit: (response: WorkbenchUserInputResponse) => Promise<void>;
  request: WorkbenchUserInputRequest;
}) {
  const [selectedValues, setSelectedValues] = useState<Record<string, string>>({});
  const [customValues, setCustomValues] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    setSelectedValues({});
    setCustomValues({});
    setError("");
    setIsSubmitting(false);
  }, [request.id]);

  const handleSubmit = async () => {
    if (isSubmitting) {
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
      await onSubmit({ answers });
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
        <button
          type="button"
          onClick={onClear}
          className="rounded-full border border-[color-mix(in_srgb,var(--text)_10%,transparent)] px-3 py-2 text-[0.76em] font-medium text-text transition hover:bg-[color-mix(in_srgb,var(--text)_4%,transparent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
        >
          Clear preview
        </button>
      </div>

      <div className="space-y-3">
        {request.questions.map((question, index) => {
          const { headerText, questionText } = formatQuestionDisplay(question, index);
          const selectedValue = selectedValues[question.id] ?? "";
          const customValue = customValues[question.id] ?? "";

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

                  return (
                    <button
                      type="button"
                      key={optionId}
                      aria-pressed={isChecked}
                      className={joinClasses(
                        "flex w-full items-start gap-3 rounded-[0.95rem] border px-3 py-2.5 text-left transition",
                        isChecked
                          ? "border-[color-mix(in_srgb,var(--text)_22%,transparent)] bg-[color-mix(in_srgb,var(--text)_5%,transparent)]"
                          : "border-[color-mix(in_srgb,var(--text)_10%,transparent)] hover:bg-[color-mix(in_srgb,var(--text)_3%,transparent)]",
                      )}
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
                    </button>
                  );
                })}
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
              </div>
            </section>
          );
        })}
      </div>

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

      {error ? (
        <p className="m-0 text-[0.84em] leading-[1.6] text-danger">{error}</p>
      ) : null}
    </div>
  );
}
