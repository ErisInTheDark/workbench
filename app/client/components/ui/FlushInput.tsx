/*
 * Exports:
 * - default FlushInput: a one-line field that reads as plain text and sizes to its content; edits a draft of its value
 *   and commits the trimmed draft on blur or Enter, while Escape restores the value.
 */
"use client";

import { useRef, useState } from "react";
import PlaintextEditable from "../workbench/thread-view/PlaintextEditable";

export default function FlushInput({
  ariaLabel,
  className = "",
  disabled = false,
  maxLength,
  normalize = (value) => value,
  onCommit,
  placeholder,
  value,
}: {
  ariaLabel: string;
  className?: string;
  disabled?: boolean;
  maxLength?: number;
  /** Applied while typing, so the field only ever shows what can be stored. */
  normalize?: (value: string) => string;
  onCommit: (value: string) => void;
  placeholder?: string;
  value: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const cancelled = useRef(false);

  const commit = () => {
    const next = draft?.trim();
    if (!cancelled.current && next !== undefined && next !== value) onCommit(next);
    cancelled.current = false;
    setDraft(null);
  };

  return (
    <PlaintextEditable
      singleLine
      ariaLabel={ariaLabel}
      disabled={disabled}
      placeholder={placeholder}
      value={draft ?? value}
      className={`
        min-w-0 whitespace-pre-wrap break-words outline-none
        data-[empty=true]:before:pointer-events-none data-[empty=true]:before:text-fg/45
        data-[empty=true]:before:content-[attr(data-placeholder)]
        ${className}
      `}
      onBlur={commit}
      onChange={(next) => setDraft(normalize(maxLength === undefined ? next : next.slice(0, maxLength)))}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Enter") {
          event.currentTarget.blur();
        } else if (event.key === "Escape") {
          event.preventDefault();
          cancelled.current = true;
          event.currentTarget.blur();
        }
      }}
    />
  );
}
