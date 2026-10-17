/*
 * Exports:
 * - default FlushTextArea: multi-line plain text that reads as text, grows with its content and reports every change
 *   as it is typed. Enter (without Shift) or Escape leaves the field.
 */
"use client";

import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";

export default function FlushTextArea({
  ariaLabel,
  className = "",
  focusOnMount = false,
  onChange,
  onEscape,
  onLeave,
  placeholder,
  value,
}: {
  ariaLabel: string;
  className?: string;
  /** Take focus with the caret at the end once mounted, such as when typing moved into a just-created field. */
  focusOnMount?: boolean;
  onChange: (value: string) => void;
  onEscape?: () => void;
  /** The field's text when focus leaves it. */
  onLeave?: (value: string) => void;
  placeholder?: string;
  value: string;
}) {
  // While focused the typed text is shown as typed; the owner may store a normalized form of it.
  const [typed, setTyped] = useState<string | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const shown = typed ?? value;

  useEffect(() => {
    const element = textarea.current;
    if (!focusOnMount || !element) return;
    element.focus({ preventScroll: true });
    element.setSelectionRange(element.value.length, element.value.length);
  }, [focusOnMount]);

  useLayoutEffect(() => {
    const element = textarea.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${element.scrollHeight}px`;
  }, [shown]);

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if ((event.key === "Enter" && !event.shiftKey) || event.key === "Escape") {
      event.preventDefault();
      event.currentTarget.blur();
      if (event.key === "Escape") onEscape?.();
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
      onBlur={(event) => {
        setTyped(null);
        onLeave?.(event.currentTarget.value);
      }}
      onChange={(event) => {
        setTyped(event.target.value);
        onChange(event.target.value);
      }}
      onKeyDown={handleKeyDown}
    />
  );
}
