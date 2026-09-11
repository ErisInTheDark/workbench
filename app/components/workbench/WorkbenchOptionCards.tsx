/*
 * Exports:
 * - WorkbenchOptionCard: selectable card with optional contained editing, content and actions.
 * - default WorkbenchOptionCards: radio/checkbox-style option row group.
 */

"use client";

import type { ReactNode } from "react";

import { WorkbenchCheckboxMarker } from "./WorkbenchCheckbox";
import { workbenchOptionHoverClassName, workbenchOptionSelectedClassName } from "./workbench-class-names";

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
  actions?: ReactNode;
  ariaLabel?: string;
  children?: ReactNode;
  className?: string;
  description?: string;
  density?: "normal" | "tight";
  disabled?: boolean;
  isChecked: boolean;
  isHistoryMode?: boolean;
  isSingleChoice?: boolean;
  label: ReactNode;
  labelEditor?: ReactNode;
  markerId?: string;
  onClick?: () => void;
  presentation?: "card" | "compact-card" | "compact-inline";
  showMarker?: boolean;
};

function joinClasses (...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

export function WorkbenchOptionCard ({
  actions,
  ariaLabel,
  children,
  className,
  description = "",
  density = "normal",
  disabled = false,
  isChecked,
  isHistoryMode = false,
  isSingleChoice = true,
  label,
  labelEditor,
  markerId,
  onClick,
  presentation = "card",
  showMarker = true,
}: WorkbenchOptionCardProps) {
  const optionDescription = description.trim();
  const compactInline = presentation === "compact-inline";
  const compactPresentation = presentation !== "card";
  const isComposed = !isHistoryMode && Boolean(actions || labelEditor || children);
  const optionCardClassName = joinClasses(
    compactInline
      ? "flex w-full min-w-0 items-center gap-2 border-0 bg-transparent px-0 py-1 text-left transition"
      : presentation === "compact-card"
        ? "flex w-full min-w-0 items-center gap-2 rounded-[0.75rem] border px-2 py-1.5 text-left transition"
        : joinClasses(
          "flex w-full rounded-[0.95rem] border px-3 text-left transition",
          density === "tight" ? "min-h-11 items-center py-1" : "items-start py-2.5",
          density === "tight" && isComposed ? "gap-1" : "gap-3",
        ),
    !compactInline && (isChecked
      ? workbenchOptionSelectedClassName
      : isHistoryMode || disabled
        ? "border-[color-mix(in_srgb,var(--text)_10%,transparent)]"
        : `border-[color-mix(in_srgb,var(--text)_10%,transparent)] ${workbenchOptionHoverClassName}`),
    compactInline && !isHistoryMode && !disabled && "hover:text-text",
    disabled && "cursor-not-allowed opacity-45",
    className,
  );
  const optionMarker = showMarker && !compactPresentation && isSingleChoice ? (
    <span
      id={markerId}
      aria-hidden="true"
      className={joinClasses(
        "inline-flex size-4 shrink-0 rounded-full border transition",
        density === "tight" ? "" : "mt-1",
        isChecked
          ? "border-[color-mix(in_srgb,var(--text)_40%,transparent)] bg-[color-mix(in_srgb,var(--text)_86%,var(--bg)_14%)]"
          : "border-[color-mix(in_srgb,var(--text)_22%,transparent)] bg-transparent",
      )}
    />
  ) : showMarker ? (
    <WorkbenchCheckboxMarker checked={isChecked} className={compactInline ? undefined : "mt-1"} disabled={disabled} />
  ) : null;
  const optionBody = (
    <>
      {optionMarker}
      <span className={compactPresentation ? "flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden" : "min-w-0"}>
        <span className={compactPresentation
          ? "shrink-0 truncate text-[0.84em] font-medium leading-[1.4] text-text"
          : "block text-[0.86em] font-medium leading-[1.5] text-text"}
        >
          {label}
        </span>
        {optionDescription ? (
          compactPresentation ? (
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

  if (isComposed) {
    return <div className={joinClasses(optionCardClassName, "flex-col", density === "tight" && "justify-center")} data-workbench-option-presentation={presentation}>
      <div className={`flex w-full min-w-0 gap-2 ${density === "tight" ? "items-center" : "items-start"}`}>
        {labelEditor ? <div className={`flex min-w-0 flex-1 gap-3 ${density === "tight" ? "items-center" : "items-start"}`}>
          <button
            type="button"
            aria-label={ariaLabel ?? (typeof label === "string" ? label : undefined)}
            aria-pressed={showMarker ? isChecked : undefined}
            disabled={disabled}
            onClick={onClick}
            className="shrink-0 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
          >{optionMarker}</button>
          <div className="min-w-0 flex-1">{labelEditor}</div>
        </div> : <button
          type="button"
          aria-label={ariaLabel}
          aria-pressed={showMarker ? isChecked : undefined}
          disabled={disabled}
          onClick={onClick}
          className={`
            flex min-w-0 flex-1 gap-3 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft
            ${density === "tight" ? "items-center" : "items-start"}
          `}
        >{optionBody}</button>}
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </div>
      {children ? <div className="w-full min-w-0 pl-7">{children}</div> : null}
    </div>;
  }

  if (isHistoryMode) {
    return (
      <div
        aria-label={ariaLabel}
        aria-pressed={showMarker ? isChecked : undefined}
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
      aria-label={ariaLabel}
      aria-pressed={showMarker ? isChecked : undefined}
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
