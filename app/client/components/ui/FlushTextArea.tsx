/*
 * Exports:
 * - default FlushTextArea: multi-line plain text that reads as text and grows with its content. Enter commits its
 *   draft (Shift+Enter breaks the line) and Escape restores the value. `edit` mode also commits on blur; `submit` mode
 *   clears after each commit and stays focused, for writing new entries.
 */
"use client";

import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";

export default function FlushTextArea({
  ariaLabel,
  autoFocus = false,
  className = "",
  mode = "edit",
  onCommit,
  onEscape,
  placeholder,
  value = "",
}: {
  ariaLabel: string;
  autoFocus?: boolean;
  className?: string;
  mode?: "edit" | "submit";
  onCommit: (value: string) => void;
  /** Runs after Escape has restored the value. */
  onEscape?: () => void;
  placeholder?: string;
  value?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const cancelled = useRef(false);
  const shown = draft ?? value;

  useEffect(() => {
    if (autoFocus) textarea.current?.focus({ preventScroll: true });
  }, [autoFocus]);

  useLayoutEffect(() => {
    const element = textarea.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${element.scrollHeight}px`;
  }, [shown]);

  const commit = () => {
    if (!cancelled.current && draft !== null && draft !== value) onCommit(draft);
    cancelled.current = false;
    setDraft(null);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (mode === "edit") event.currentTarget.blur();
      else commit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      if (mode === "edit") {
        cancelled.current = true;
        event.currentTarget.blur();
      } else {
        setDraft(null);
      }
      onEscape?.();
    }
  };

  return (
    <textarea
      ref={textarea}
      rows={1}
      aria-label={ariaLabel}
      placeholder={placeholder}
      value={shown}
      className={`
        block w-full resize-none overflow-hidden outline-none placeholder:text-fg/45
        ${className}
      `}
      onBlur={mode === "edit" ? commit : undefined}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={handleKeyDown}
    />
  );
}
