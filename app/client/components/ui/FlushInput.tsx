/*
 * Exports:
 * - default FlushInput: a one-line text field that reads as plain text, edits a draft of its value and commits it on
 *   blur or Enter; Escape restores the value.
 */
"use client";

import { useRef, useState, type KeyboardEvent } from "react";

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
    if (!cancelled.current && draft !== null && draft !== value) onCommit(draft);
    cancelled.current = false;
    setDraft(null);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter") {
      event.preventDefault();
      event.currentTarget.blur();
    } else if (event.key === "Escape") {
      event.preventDefault();
      cancelled.current = true;
      event.currentTarget.blur();
    }
  };

  return (
    <input
      type="text"
      aria-label={ariaLabel}
      disabled={disabled}
      maxLength={maxLength}
      placeholder={placeholder}
      spellCheck={false}
      value={draft ?? value}
      className={`
        min-w-0 outline-none placeholder:text-fg/45
        ${className}
      `}
      onBlur={commit}
      onChange={(event) => setDraft(normalize(event.target.value))}
      onKeyDown={handleKeyDown}
    />
  );
}
