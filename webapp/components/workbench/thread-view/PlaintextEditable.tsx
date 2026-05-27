/*
 * Exports:
 * - default PlaintextEditable: contenteditable plaintext input with overlays and optional mention suggestions. Keywords: composer, questionnaire, mentions, autocomplete.
 * - isMobileTextInputEnvironment: detect soft-keyboard-oriented input contexts for Enter-key behavior. Keywords: mobile, keyboard, input.
 * - useMobileTextInputEnvironment: subscribe to mobile text-input media query changes. Keywords: mobile, keyboard, hook.
 * - Local helpers: caret measurement/restoration, highlight rendering, and mention popup rendering. Keywords: contenteditable, caret, highlights.
 */
"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type CompositionEvent, type KeyboardEvent, type ReactNode } from "react";

import {
  buildInlineMentionSuggestions,
  type InlineMentionHighlight,
  type InlineMentionHighlightSources,
  type InlineMentionSuggestion,
} from "../../../lib/workbench/thread/inline-mention-highlights";
import { getInlineMentionMarkClassName, getInlineMentionOverlayClassName } from "../../../lib/workbench/thread/inline-mention-styles";

function joinClasses (...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

function normalizePlaintextEditableValue (value: string) {
  return value.replace(/\r\n/g, "\n");
}

const MOBILE_TEXT_INPUT_MEDIA_QUERY = "(hover: none) and (pointer: coarse)";

export function isMobileTextInputEnvironment () {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia(MOBILE_TEXT_INPUT_MEDIA_QUERY).matches;
}

export function useMobileTextInputEnvironment () {
  const [isMobileTextInput, setIsMobileTextInput] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }

    const mediaQuery = window.matchMedia(MOBILE_TEXT_INPUT_MEDIA_QUERY);
    const applyMatch = () => {
      setIsMobileTextInput(mediaQuery.matches);
    };

    applyMatch();
    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", applyMatch);
    } else {
      mediaQuery.addListener(applyMatch);
    }

    return () => {
      if (typeof mediaQuery.removeEventListener === "function") {
        mediaQuery.removeEventListener("change", applyMatch);
      } else {
        mediaQuery.removeListener(applyMatch);
      }
    };
  }, []);

  return isMobileTextInput;
}

function getEditableCaretOffset (element: HTMLElement) {
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

function restoreEditableCaretOffset (element: HTMLElement, offset: number | null) {
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

function setEditableValueAndCaret (element: HTMLElement, value: string, caretOffset: number) {
  element.textContent = value;
  restoreEditableCaretOffset(element, caretOffset);
}

function renderHighlightContent (value: string, highlights: InlineMentionHighlight[]) {
  const content: ReactNode[] = [];
  let cursor = 0;
  highlights.forEach((highlight, index) => {
    if (highlight.start > cursor) {
      content.push(value.slice(cursor, highlight.start));
    }

    content.push(
      <span
        key={`${highlight.kind}:${highlight.start}:${highlight.end}:${index}`}
        className={getInlineMentionOverlayClassName(highlight.kind)}
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

function InlineMentionSuggestionsPopup ({
  activeIndex,
  onSelect,
  suggestions,
}: {
  activeIndex: number;
  onSelect: (suggestion: InlineMentionSuggestion) => void;
  suggestions: InlineMentionSuggestion[];
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const activeElement = containerRef.current?.querySelector("[data-inline-mention-suggestion-active='true']");
    activeElement?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  if (!suggestions.length) {
    return null;
  }

  return (
    <div
      ref={containerRef}
      className="explorer-scrollbar grid grid-cols-[auto_1fr] max-h-56 overflow-y-auto rounded-[0.85rem] border border-[color-mix(in_srgb,var(--text)_10%,transparent)] bg-[color-mix(in_srgb,var(--bg)_96%,transparent)] p-1.5 shadow-lg backdrop-blur"
      role="listbox"
    >
      {suggestions.map((suggestion, index) => {
        const isActive = index === activeIndex;
        return (
          <div
            key={`${suggestion.candidate.kind}:${suggestion.candidate.path}`}
            aria-selected={isActive}
            className={joinClasses(
              "col-span-2 grid grid-cols-subgrid min-w-0 items-center justify-between gap-3 rounded-[0.65rem] px-2.5 py-2 text-[0.82em] leading-[1.35]",
              isActive
                ? getInlineMentionMarkClassName(suggestion.candidate.kind)
                : "text-text",
            )}
            data-inline-mention-suggestion-active={isActive ? "true" : undefined}
            onMouseDown={(event) => {
              event.preventDefault();
              onSelect(suggestion);
            }}
            role="option"
          >
            <span className="min-w-0 truncate font-mono">
              {suggestion.replacementText}
            </span>
            {suggestion.candidate.description ? (
              <span className="truncate text-[0.92em] text-muted">
                {suggestion.candidate.description}
              </span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
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
  mentionSources = null,
  mentionSuggestionsPlacement = "above",
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
  mentionSources?: InlineMentionHighlightSources | null;
  mentionSuggestionsPlacement?: "above" | "below";
  readOnly?: boolean;
  spellCheck?: boolean;
  value: string;
}) {
  const elementRef = useRef<HTMLDivElement>(null);
  const isComposingRef = useRef(false);
  const [caretOffset, setCaretOffset] = useState<number | null>(null);
  const [activeSuggestionIndex, setActiveSuggestionIndex] = useState(0);
  const suggestions = useMemo(() => (
    mentionSources && !readOnly && !disabled
      ? buildInlineMentionSuggestions(value, caretOffset, mentionSources)
      : []
  ), [caretOffset, disabled, mentionSources, readOnly, value]);
  const activeSuggestion = suggestions[activeSuggestionIndex] ?? suggestions[0] ?? null;

  useLayoutEffect(() => {
    setActiveSuggestionIndex(0);
  }, [suggestions.length, suggestions[0]?.replacementText]);

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

  const updateCaretOffset = () => {
    const element = elementRef.current;
    setCaretOffset(element ? getEditableCaretOffset(element) : null);
  };

  const acceptSuggestion = (suggestion: InlineMentionSuggestion) => {
    const nextValue = `${value.slice(0, suggestion.start)}${suggestion.replacementText}${value.slice(suggestion.end)}`;
    const nextCaretOffset = suggestion.start + suggestion.replacementText.length;
    const element = elementRef.current;
    if (element) {
      setEditableValueAndCaret(element, nextValue, nextCaretOffset);
    }
    setCaretOffset(nextCaretOffset);
    onChange?.(nextValue);
  };

  const suggestionsPopup = suggestions.length ? (
    <div
      className={joinClasses(
        "absolute right-0 left-0 z-30",
        mentionSuggestionsPlacement === "above" ? "bottom-full mb-2" : "top-full mt-2",
      )}
    >
      <InlineMentionSuggestionsPopup
        activeIndex={activeSuggestionIndex}
        onSelect={acceptSuggestion}
        suggestions={suggestions}
      />
    </div>
  ) : null;

  return (
    <div className="relative">
      {mentionSuggestionsPlacement === "above" ? suggestionsPopup : null}
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
          updateCaretOffset();
          onCompositionEnd?.(event);
        }}
        onCompositionStart={(event) => {
          isComposingRef.current = true;
          onCompositionStart?.(event);
        }}
        onInput={(event) => {
          setCaretOffset(getEditableCaretOffset(event.currentTarget));
          onChange?.(normalizePlaintextEditableValue(event.currentTarget.innerText));
        }}
        onKeyDown={(event) => {
          if (activeSuggestion && !event.nativeEvent.isComposing) {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              const direction = event.key === "ArrowDown" ? 1 : -1;
              setActiveSuggestionIndex((current) => (
                (current + direction + suggestions.length) % suggestions.length
              ));
              return;
            }

            if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey && !isMobileTextInputEnvironment())) {
              event.preventDefault();
              acceptSuggestion(activeSuggestion);
              return;
            }

            if (event.key === "Escape") {
              event.preventDefault();
              setCaretOffset(null);
              return;
            }
          }

          onKeyDown?.(event);
        }}
        onPaste={onPaste}
        onClick={updateCaretOffset}
        onKeyUp={updateCaretOffset}
      />
      {mentionSuggestionsPlacement === "below" ? suggestionsPopup : null}
    </div>
  );
}
