/*
 * Exports:
 * - default PlaintextEditable: plaintext input with autofocus, overlays and mention suggestions.
 * - PlaintextEditableHandle: focus the editor at a model-text offset.
 * - threadPlaintextEditableClassName: shared Tailwind styling for thread text editors.
 */
"use client";

import { useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type CompositionEvent, type CSSProperties, type FocusEvent, type KeyboardEvent, type ReactNode, type Ref } from "react";
import { createPortal } from "react-dom";

import {
  buildInlineMentionSuggestions,
  type InlineMentionHighlight,
  type InlineMentionHighlightSources,
  type InlineMentionSuggestion,
} from "../../../workbench/thread/inline-mention-highlights";
import { getInlineMentionMarkClassName, getInlineMentionOverlayClassName } from "../../../workbench/thread/inline-mention-styles";
import { isMobileTextInputEnvironment } from "./mobile-text-input-environment";
import VoiceInputControl, { useVoiceInput } from "../voice/VoiceInputControl";
import { capturePlaintextSelection, restorePlaintextSelection } from "./plaintext-selection";
import type { VoiceSelection } from "workbench-shared/workbench/voice/voice-document";

export interface PlaintextEditableHandle { focus(offset?: number): void }

export const threadPlaintextEditableClassName = [
  "block whitespace-pre-wrap wrap-anywhere [word-break:break-word]",
  "coarse-touch:text-[max(1rem,1em)]",
  "data-[empty=true]:before:content-[attr(data-placeholder)]",
  "data-[empty=true]:before:pointer-events-none",
  "data-[empty=true]:before:text-[color:color-mix(in_srgb,var(--text)_var(--muted-strength),var(--editable-fg-bg,var(--fg-bg,var(--bg))))]",
].join(" ");

function joinClasses (...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

function normalizePlaintextEditableValue (value: string) {
  const normalizedValue = value.replace(/\r\n/g, "\n");
  return normalizedValue.replace(/\n/g, "") ? normalizedValue : "";
}

const INLINE_MENTION_SUGGESTIONS_VIEWPORT_GUTTER_PX = 8;
const INLINE_MENTION_SUGGESTIONS_ANCHOR_GAP_PX = 8;

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

function getInlineMentionSuggestionsPortalStyle (
  anchor: HTMLElement,
  placement: "above" | "below",
): CSSProperties {
  const anchorRect = anchor.getBoundingClientRect();
  const viewportWidth = window.visualViewport?.width ?? document.documentElement.clientWidth ?? window.innerWidth;
  const availableWidth = Math.max(
    0,
    viewportWidth - INLINE_MENTION_SUGGESTIONS_VIEWPORT_GUTTER_PX * 2,
  );
  const width = Math.min(Math.max(anchorRect.width, 0), availableWidth);
  const maxLeft = Math.max(
    INLINE_MENTION_SUGGESTIONS_VIEWPORT_GUTTER_PX,
    viewportWidth - width - INLINE_MENTION_SUGGESTIONS_VIEWPORT_GUTTER_PX,
  );
  const left = Math.min(
    Math.max(anchorRect.left, INLINE_MENTION_SUGGESTIONS_VIEWPORT_GUTTER_PX),
    maxLeft,
  );
  const top = placement === "above"
    ? anchorRect.top - INLINE_MENTION_SUGGESTIONS_ANCHOR_GAP_PX
    : anchorRect.bottom + INLINE_MENTION_SUGGESTIONS_ANCHOR_GAP_PX;

  return {
    left,
    top,
    transform: placement === "above" ? "translateY(-100%)" : undefined,
    width,
  };
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
      className="scrollbar-hover-reveal grid grid-cols-[auto_1fr] max-h-56 overflow-y-auto rounded-[0.85rem] border border-[color-mix(in_srgb,var(--text)_10%,transparent)] bg-[color-mix(in_srgb,var(--bg)_96%,transparent)] [--fg-bg:color-mix(in_srgb,var(--bg)_96%,var(--app-bg-solid))] p-1.5 shadow-lg backdrop-blur"
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
              <span className="truncate text-[0.92em] text-fg/muted">
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
  autoFocus = false,
  className,
  disabled = false,
  id,
  onBlur,
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
  ref,
  spellCheck = false,
  value,
}: {
  ariaLabel?: string;
  autoFocus?: boolean;
  className?: string;
  disabled?: boolean;
  id?: string;
  onBlur?: (event: FocusEvent<HTMLDivElement>) => void;
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
  ref?: Ref<PlaintextEditableHandle>;
  spellCheck?: boolean;
  value: string;
}) {
  const elementRef = useRef<HTMLDivElement>(null);
  const savedVoiceSelection = useRef<{ text: string } & ({ selection: VoiceSelection } | { error: Error }) | null>(null);
  const pendingVoiceSelection = useRef<{ text: string; selection: VoiceSelection } | null>(null);
  const voice = useVoiceInput(value, onChange, !disabled && !readOnly, {
    read() {
      const current = elementRef.current ? capturePlaintextSelection(elementRef.current, value) : null;
      if (current) return current;
      const saved = savedVoiceSelection.current;
      if (saved?.text === value) {
        if ("error" in saved) throw saved.error;
        return saved.selection;
      }
      return { start: value.length, end: value.length };
    },
    accept(text, selection) { pendingVoiceSelection.current = { text, selection }; },
  });
  useImperativeHandle(ref, () => ({
    focus(offset) {
      const element = elementRef.current;
      if (!element || disabled || readOnly || voice.locked) return;
      // Use canonical plaintext so an offset also works after browser-created multiline nodes.
      element.textContent = value;
      element.focus();
      restoreEditableCaretOffset(element, Math.max(0, offset ?? value.length));
    },
  }), [disabled, readOnly, value, voice.locked]);
  const containerRef = useRef<HTMLDivElement>(null);
  const isComposingRef = useRef(false);
  const syncVoiceFontSize = () => {
    if (voice.visible && elementRef.current) {
      const fontSize = getComputedStyle(elementRef.current).fontSize;
      if (containerRef.current?.style.getPropertyValue("--voice-field-font-size") !== fontSize) {
        containerRef.current?.style.setProperty("--voice-field-font-size", fontSize);
      }
    }
  };
  useLayoutEffect(syncVoiceFontSize);
  useLayoutEffect(() => {
    if (!voice.visible || !elementRef.current) return;
    const observer = new ResizeObserver(syncVoiceFontSize);
    observer.observe(elementRef.current);
    window.addEventListener("resize", syncVoiceFontSize);
    return () => { observer.disconnect(); window.removeEventListener("resize", syncVoiceFontSize); };
  }, [voice.visible]);
  const [caretOffset, setCaretOffset] = useState<number | null>(null);
  const [activeSuggestionIndex, setActiveSuggestionIndex] = useState(0);
  const [suggestionsPortalHost, setSuggestionsPortalHost] = useState<HTMLElement | null>(null);
  const [suggestionsPortalStyle, setSuggestionsPortalStyle] = useState<CSSProperties | null>(null);
  const suggestions = useMemo(() => (
    mentionSources && !readOnly && !disabled
      ? buildInlineMentionSuggestions(value, caretOffset, mentionSources)
      : []
  ), [caretOffset, disabled, mentionSources, readOnly, value]);
  const activeSuggestion = suggestions[activeSuggestionIndex] ?? suggestions[0] ?? null;

  useLayoutEffect(() => {
    if (!voice.locked) return;
    const form = elementRef.current?.closest("form");
    if (!form) return;
    const preventSubmit = (event: Event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    form.addEventListener("submit", preventSubmit, true);
    return () => form.removeEventListener("submit", preventSubmit, true);
  }, [voice.locked]);

  useEffect(() => {
    setSuggestionsPortalHost(document.body);
  }, []);

  useLayoutEffect(() => {
    setActiveSuggestionIndex(0);
  }, [suggestions.length, suggestions[0]?.replacementText]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!suggestions.length || !container) {
      setSuggestionsPortalStyle(null);
      return;
    }

    const updateSuggestionsPortalStyle = () => {
      setSuggestionsPortalStyle(getInlineMentionSuggestionsPortalStyle(container, mentionSuggestionsPlacement));
    };

    updateSuggestionsPortalStyle();
    window.addEventListener("resize", updateSuggestionsPortalStyle);
    window.addEventListener("scroll", updateSuggestionsPortalStyle, true);
    window.visualViewport?.addEventListener("resize", updateSuggestionsPortalStyle);
    window.visualViewport?.addEventListener("scroll", updateSuggestionsPortalStyle);

    return () => {
      window.removeEventListener("resize", updateSuggestionsPortalStyle);
      window.removeEventListener("scroll", updateSuggestionsPortalStyle, true);
      window.visualViewport?.removeEventListener("resize", updateSuggestionsPortalStyle);
      window.visualViewport?.removeEventListener("scroll", updateSuggestionsPortalStyle);
    };
  }, [caretOffset, mentionSuggestionsPlacement, suggestions.length, suggestions[0]?.replacementText, value]);

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

  useLayoutEffect(() => {
    const pending = pendingVoiceSelection.current;
    const element = elementRef.current;
    if (voice.locked || !pending || !element) return;
    pendingVoiceSelection.current = null;
    if (pending.text !== value) return;
    savedVoiceSelection.current = pending;
    if (document.activeElement === element || containerRef.current?.contains(document.activeElement)) {
      element.focus();
      restorePlaintextSelection(element, value, pending.selection);
    }
  }, [value, voice.locked]);

  useLayoutEffect(() => {
    const element = elementRef.current;
    if (!autoFocus || disabled || readOnly || !element) {
      return;
    }

    const nextCaretOffset = element.textContent?.length ?? 0;
    element.focus();
    restoreEditableCaretOffset(element, nextCaretOffset);
    setCaretOffset(nextCaretOffset);
  }, [autoFocus, disabled, readOnly]);

  const updateCaretOffset = () => {
    const element = elementRef.current;
    setCaretOffset(element ? getEditableCaretOffset(element) : null);
  };

  const acceptSuggestion = (suggestion: InlineMentionSuggestion) => {
    if (voice.locked) return;
    const nextValue = `${value.slice(0, suggestion.start)}${suggestion.replacementText}${value.slice(suggestion.end)}`;
    const nextCaretOffset = suggestion.start + suggestion.replacementText.length;
    const element = elementRef.current;
    if (element) {
      setEditableValueAndCaret(element, nextValue, nextCaretOffset);
    }
    setCaretOffset(nextCaretOffset);
    onChange?.(nextValue);
  };

  const suggestionsPopup = !voice.locked && suggestions.length ? (
    <div
      className={joinClasses(
        "fixed z-[80]",
        !suggestionsPortalStyle && "invisible",
      )}
      style={suggestionsPortalStyle ?? undefined}
    >
      <InlineMentionSuggestionsPopup
        activeIndex={activeSuggestionIndex}
        onSelect={acceptSuggestion}
        suggestions={suggestions}
      />
    </div>
  ) : null;
  const suggestionsPopupPortal = suggestionsPopup && suggestionsPortalHost
    ? createPortal(suggestionsPopup, suggestionsPortalHost)
    : null;

  return (
    <>
      <div ref={containerRef} className="group/voice-field relative" onPointerEnter={syncVoiceFontSize} onFocusCapture={syncVoiceFontSize}>
        <VoiceInputControl voice={{ ...voice, begin: () => { if (!isComposingRef.current) voice.begin(); } }} />
        <div
          aria-hidden="true"
          className={joinClasses(
            className,
            "pointer-events-none absolute inset-0 z-20 !text-transparent",
            "!m-0",
            "whitespace-pre-wrap break-words [overflow-wrap:anywhere]",
            "[&_*]:!text-transparent",
            highlights.length === 0 && "hidden",
            voice.visible && "pr-[calc(var(--voice-field-font-size)*2)]",
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
          aria-readonly={readOnly || voice.locked || undefined}
          className={joinClasses(className, "relative z-10", voice.visible && "pr-[calc(var(--voice-field-font-size)*2)]")}
          contentEditable={readOnly || disabled || voice.locked ? false : "plaintext-only"}
          data-empty={value ? "false" : "true"}
          data-placeholder={placeholder ?? ""}
          role="textbox"
          spellCheck={spellCheck}
          suppressContentEditableWarning
          tabIndex={readOnly || disabled ? -1 : 0}
          onBlur={event => {
            if (!voice.locked && voice.visible) {
              try {
                const selection = capturePlaintextSelection(event.currentTarget, value);
                if (selection) savedVoiceSelection.current = { text: value, selection };
              } catch (error) {
                savedVoiceSelection.current = { text: value, error: error instanceof Error ? error : new Error("Unable to retain field selection.") };
                console.warn("[voice] unable to retain field selection", error instanceof Error ? error.message : "selection failed");
              }
            }
            onBlur?.(event);
          }}
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
            if (voice.locked) { event.currentTarget.textContent = value; return; }
            const nextValue = normalizePlaintextEditableValue(event.currentTarget.innerText);
            if (!nextValue) {
              event.currentTarget.replaceChildren();
              setCaretOffset(0);
            } else {
              setCaretOffset(getEditableCaretOffset(event.currentTarget));
            }
            onChange?.(nextValue);
          }}
          onKeyDown={(event) => {
            if (voice.locked) {
              event.preventDefault();
              event.stopPropagation();
              if (event.key === "Escape") voice.cancel();
              return;
            }
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
          onPaste={event => { if (voice.locked) { event.preventDefault(); return; } onPaste?.(event); }}
          onClick={updateCaretOffset}
          onKeyUp={updateCaretOffset}
        />
      </div>
      {suggestionsPopupPortal}
    </>
  );
}
