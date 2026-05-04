"use client";

import { useLayoutEffect, useRef, type ClipboardEvent, type CompositionEvent, type KeyboardEvent } from "react";

export default function PlaintextEditable ({
  ariaLabel,
  className,
  disabled = false,
  id,
  onChange,
  onCompositionEnd,
  onCompositionStart,
  onKeyDown,
  onPaste,
  placeholder,
  readOnly = false,
  spellCheck = true,
  value,
}: {
  ariaLabel?: string;
  className?: string;
  disabled?: boolean;
  id?: string;
  onChange?: (value: string) => void;
  onCompositionEnd?: (event: CompositionEvent<HTMLDivElement>) => void;
  onCompositionStart?: (event: CompositionEvent<HTMLDivElement>) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
  onPaste?: (event: ClipboardEvent<HTMLDivElement>) => void;
  placeholder?: string;
  readOnly?: boolean;
  spellCheck?: boolean;
  value: string;
}) {
  const elementRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!elementRef.current) {
      return;
    }

    if (elementRef.current.textContent !== value) {
      elementRef.current.textContent = value;
    }
  }, [value]);

  return (
    <div
      id={id}
      ref={elementRef}
      aria-disabled={disabled || undefined}
      aria-label={ariaLabel}
      aria-multiline="true"
      aria-readonly={readOnly || undefined}
      className={className}
      contentEditable={readOnly || disabled ? false : "plaintext-only"}
      data-empty={value ? "false" : "true"}
      data-placeholder={placeholder ?? ""}
      role="textbox"
      spellCheck={spellCheck}
      suppressContentEditableWarning
      tabIndex={readOnly || disabled ? -1 : 0}
      onCompositionEnd={onCompositionEnd}
      onCompositionStart={onCompositionStart}
      onInput={(event) => {
        onChange?.(event.currentTarget.innerText.replace(/\r\n/g, "\n"));
      }}
      onKeyDown={onKeyDown}
      onPaste={onPaste}
    />
  );
}
