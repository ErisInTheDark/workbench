"use client";

import { useLayoutEffect, useRef, type ClipboardEvent, type CompositionEvent, type KeyboardEvent } from "react";

function normalizePlaintextEditableValue(value: string) {
  return value.replace(/\r\n/g, "\n");
}

function getEditableCaretOffset(element: HTMLElement) {
  const selection = window.getSelection?.();
  if (!selection || selection.rangeCount === 0 || !selection.isCollapsed) {
    return null;
  }

  const range = selection.getRangeAt(0);
  if (!element.contains(range.startContainer)) {
    return null;
  }

  const prefixRange = range.cloneRange();
  prefixRange.selectNodeContents(element);
  prefixRange.setEnd(range.startContainer, range.startOffset);
  return prefixRange.toString().length;
}

function restoreEditableCaretOffset(element: HTMLElement, offset: number | null) {
  if (offset === null) {
    return;
  }

  const selection = window.getSelection?.();
  if (!selection) {
    return;
  }

  const textNode = element.firstChild ?? element;
  const textLength = textNode.textContent?.length ?? 0;
  const range = document.createRange();
  range.setStart(textNode, Math.min(offset, textLength));
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

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
    const element = elementRef.current;
    if (!element) {
      return;
    }

    const currentValue = normalizePlaintextEditableValue(element.innerText);
    if (currentValue === value) {
      return;
    }

    if (element.textContent !== value) {
      const caretOffset = document.activeElement === element ? getEditableCaretOffset(element) : null;
      element.textContent = value;
      restoreEditableCaretOffset(element, caretOffset);
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
        onChange?.(normalizePlaintextEditableValue(event.currentTarget.innerText));
      }}
      onKeyDown={onKeyDown}
      onPaste={onPaste}
    />
  );
}
