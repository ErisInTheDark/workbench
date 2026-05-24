"use client";

import { useLayoutEffect, useRef, type ClipboardEvent, type CompositionEvent, type KeyboardEvent, type ReactNode } from "react";

import type { InlineMentionHighlight } from "../../../lib/workbench/thread/inline-mention-highlights";

function joinClasses (...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

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

function renderHighlightContent(value: string, highlights: InlineMentionHighlight[]) {
  const content: ReactNode[] = [];
  let cursor = 0;
  highlights.forEach((highlight, index) => {
    if (highlight.start > cursor) {
      content.push(value.slice(cursor, highlight.start));
    }

    content.push(
      <span
        key={`${highlight.kind}:${highlight.start}:${highlight.end}:${index}`}
        className={joinClasses(
          "relative isolate",
          "before:absolute before:inset-x-[-0.12em] before:inset-y-[-0.04em] before:rounded-[0.28em] before:ring-1 before:ring-inset before:content-['']",
          highlight.kind === "skill"
            ? "before:bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] before:ring-[color-mix(in_srgb,var(--accent)_24%,transparent)]"
            : "before:bg-[color-mix(in_srgb,var(--success)_14%,transparent)] before:ring-[color-mix(in_srgb,var(--success)_24%,transparent)]",
        )}
      >
        {value.slice(highlight.start, highlight.end)}
      </span>,
    );
    cursor = highlight.end;
  });

  if (cursor < value.length) {
    content.push(value.slice(cursor));
  }

  return content.length ? content : "\u00a0";
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
  highlights = [],
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
  highlights?: InlineMentionHighlight[];
  readOnly?: boolean;
  spellCheck?: boolean;
  value: string;
}) {
  const elementRef = useRef<HTMLDivElement>(null);
  const isComposingRef = useRef(false);

  useLayoutEffect(() => {
    const element = elementRef.current;
    if (!element || isComposingRef.current) {
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
    <div className="relative">
      <div
        aria-hidden="true"
        className={joinClasses(
          className,
          "pointer-events-none absolute inset-0 z-20 !text-transparent",
          "!m-0",
          "whitespace-pre-wrap break-words [overflow-wrap:anywhere]",
          "[&_*]:!text-transparent",
          highlights.length === 0 && "hidden",
        )}
      >
        {renderHighlightContent(value, highlights)}
      </div>
      <div
        id={id}
        ref={elementRef}
        aria-disabled={disabled || undefined}
        aria-label={ariaLabel}
        aria-multiline="true"
        aria-readonly={readOnly || undefined}
        className={joinClasses(className, "relative z-10")}
        contentEditable={readOnly || disabled ? false : "plaintext-only"}
        data-empty={value ? "false" : "true"}
        data-placeholder={placeholder ?? ""}
        role="textbox"
        spellCheck={spellCheck}
        suppressContentEditableWarning
        tabIndex={readOnly || disabled ? -1 : 0}
        onCompositionEnd={(event) => {
          isComposingRef.current = false;
          onCompositionEnd?.(event);
        }}
        onCompositionStart={(event) => {
          isComposingRef.current = true;
          onCompositionStart?.(event);
        }}
        onInput={(event) => {
          onChange?.(normalizePlaintextEditableValue(event.currentTarget.innerText));
        }}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
      />
    </div>
  );
}
