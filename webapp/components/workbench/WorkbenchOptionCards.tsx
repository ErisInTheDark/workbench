/*
 * Exports:
 * - WorkbenchOptionCard: reusable questionnaire option with card and compact-inline presentations. Keywords: settings, questionnaire, option, card, compact.
 * - default WorkbenchOptionCards: reusable radio/checkbox-style option row group. Keywords: settings, questionnaire, options, reusable.
 */

"use client";

import type { ReactNode } from "react";

import { WorkbenchCheckboxMarker } from "./WorkbenchCheckbox";

type WorkbenchOptionCardsProps<T extends string | boolean | number> = {
  ariaLabel: string;
  columns?: "one" | "two";
  disabled?: boolean;
  mode?: "checkbox" | "radio";
  onChange: (value: T) => void;
  options: Array<{
    description: string;
    label: ReactNode;
    value: T;
  }>;
  value: T;
};

type WorkbenchOptionCardProps = {
  className?: string;
  description?: string;
  disabled?: boolean;
  isChecked: boolean;
  isHistoryMode?: boolean;
  isSingleChoice?: boolean;
  label: ReactNode;
  markerId?: string;
  onClick?: () => void;
  presentation?: "card" | "compact-inline";
};

function joinClasses (...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

export function WorkbenchOptionCard ({
  className,
  description = "",
  disabled = false,
  isChecked,
  isHistoryMode = false,
  isSingleChoice = true,
  label,
  markerId,
  onClick,
  presentation = "card",
}: WorkbenchOptionCardProps) {
  const optionDescription = description.trim();
  const compactInline = presentation === "compact-inline";
  const optionCardClassName = joinClasses(
    compactInline
      ? "flex w-full min-w-0 items-center gap-2 border-0 bg-transparent px-0 py-1 text-left transition"
      : "flex w-full items-start gap-3 rounded-[0.95rem] border px-3 py-2.5 text-left transition",
    !compactInline && (isChecked
      ? "border-[color-mix(in_srgb,var(--text)_22%,transparent)] bg-[color-mix(in_srgb,var(--text)_5%,transparent)]"
      : isHistoryMode || disabled
        ? "border-[color-mix(in_srgb,var(--text)_10%,transparent)]"
        : "border-[color-mix(in_srgb,var(--text)_10%,transparent)] hover:bg-[color-mix(in_srgb,var(--text)_3%,transparent)]"),
    compactInline && !isHistoryMode && !disabled && "hover:text-text",
    disabled && "cursor-not-allowed opacity-45",
    className,
  );
  const optionBody = (
    <>
      {!compactInline && isSingleChoice ? (
        <span
          id={markerId}
          aria-hidden="true"
          className={joinClasses(
            "mt-1 inline-flex size-4 shrink-0 rounded-full border transition",
            isChecked
              ? "border-[color-mix(in_srgb,var(--text)_40%,transparent)] bg-[color-mix(in_srgb,var(--text)_86%,var(--bg)_14%)]"
              : "border-[color-mix(in_srgb,var(--text)_22%,transparent)] bg-transparent",
          )}
        />
      ) : (
        <WorkbenchCheckboxMarker checked={isChecked} className={compactInline ? undefined : "mt-1"} disabled={disabled} />
      )}
      <span className={compactInline ? "flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden" : "min-w-0"}>
        <span className={compactInline
          ? "max-w-[55%] shrink-0 truncate text-[0.84em] font-medium leading-[1.4] text-text"
          : "block text-[0.86em] font-medium leading-[1.5] text-text"}
        >
          {label}
        </span>
        {optionDescription ? (
          compactInline ? (
            <>
              <span className="shrink-0 text-[0.72em] text-muted" aria-hidden="true">·</span>
              <span className="min-w-0 flex-1 truncate text-[0.76em] leading-[1.4] text-muted">
                {optionDescription}
              </span>
            </>
          ) : (
            <span className="mt-0.5 block text-[0.78em] leading-[1.55] text-muted">
              {optionDescription}
            </span>
          )
        ) : null}
      </span>
    </>
  );

  if (isHistoryMode) {
    return (
      <div
        aria-pressed={isChecked}
        className={optionCardClassName}
        data-workbench-option-presentation={presentation}
      >
        {optionBody}
      </div>
    );
  }

  return (
    <button
      type="button"
      aria-pressed={isChecked}
      className={optionCardClassName}
      data-workbench-option-presentation={presentation}
      disabled={disabled}
      onClick={onClick}
    >
      {optionBody}
    </button>
  );
}

export default function WorkbenchOptionCards<T extends string | boolean | number> ({
  ariaLabel,
  columns = "two",
  disabled = false,
  mode = "radio",
  onChange,
  options,
  value,
}: WorkbenchOptionCardsProps<T>) {
  return (
    <div
      aria-label={ariaLabel}
      className={joinClasses(
        "grid gap-2",
        columns === "two" && "md:grid-cols-2",
      )}
      role={mode === "radio" ? "radiogroup" : "group"}
    >
      {options.map((option) => {
        const isSelected = value === option.value;
        return (
          <WorkbenchOptionCard
            key={String(option.value)}
            disabled={disabled}
            description={option.description}
            isChecked={isSelected}
            isSingleChoice={mode === "radio"}
            label={option.label}
            onClick={() => {
              onChange(option.value);
            }}
          />
        );
      })}
    </div>
  );
}
