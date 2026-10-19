/*
 * Exports:
 * - default PlaintextEditable: plaintext input with autofocus, overlays, portal-isolated mention suggestions and an optional single-line mode.
 * - PlaintextEditableHandle: focus, insert or apply guarded in-place text edits.
 * - PlaintextHighlight: one overlay range and its classes.
 * - threadPlaintextEditableClassName: shared Tailwind styling for thread text editors.
 */
"use client";

import { useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type CompositionEvent, type FocusEvent, type KeyboardEvent, type ReactNode, type Ref } from "react";
import { createPortal } from "react-dom";

import {
  buildInlineMentionSuggestions,
  type InlineMentionHighlightSources,
  type InlineMentionSuggestion,
} from "../../../workbench/thread/inline-mention-highlights";
import { getInlineMentionMarkClassName, getInlineMentionOverlayClassName } from "../../../workbench/thread/inline-mention-styles";
import { getCollapsedRangeRect } from "../../../workbench/dom/layout/viewport-metrics";
import { isMobileTextInputEnvironment } from "./mobile-text-input-environment";
import {
  getInlineMentionSuggestionsPortalStyle,
  type InlineMentionSuggestionsPortalStyle,
} from "./plaintext-editable-suggestion-geometry";
import VoiceInputControl, { useVoiceInput } from "../voice/VoiceInputControl";
import { capturePlaintextSelection, restorePlaintextSelection } from "./plaintext-selection";
import type { VoiceSelection } from "workbench-shared/workbench/voice/voice-document";
import { attachmentReferenceDragType, attachmentReferences, type AttachmentTextEdit } from "workbench-shared/workbench/thread/attachment-references";
import { applyPlaintextEdits, mapPlaintextOffset, selectPlaintextRange } from "./plaintext-edits";
import { getCaretRangeFromPoint } from "../../../workbench/dom/selection/selection-dom";

export interface PlaintextEditableHandle {
  focus(offset?: number): void;
  canEdit(): boolean;
  applyEdits(expectedText: string, edits: readonly AttachmentTextEdit[]): boolean;
  insertText(text: string): void;
}

export interface PlaintextHighlight {
  start: number;
  end: number;
  className: string;
}

export const threadPlaintextEditableClassName = `
  block whitespace-pre-wrap wrap-anywhere [word-break: break-word]
  coarse-touch:text-[max(1rem,1em)]
  data-[empty=true]:before:(
    content-[attr(data-placeholder)] pointer-events-none text-fg/muted
  )
`;

function joinClasses (...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

function normalizePlaintextEditableValue (value: string) {
  const normalizedValue = value.replace(/\r\n/g, "\n");
  return normalizedValue.replace(/\n/g, "") ? normalizedValue : "";
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

function getEditableSelectionRange (element: HTMLElement) {
  const selection = window.getSelection?.();
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!element.contains(range.startContainer) || !element.contains(range.endContainer)) return null;
  const prefix = range.cloneRange();
  prefix.selectNodeContents(element);
  prefix.setEnd(range.startContainer, range.startOffset);
  const start = prefix.toString().length;
  return { start, end: start + range.toString().length };
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

function renderHighlightContent (value: string, highlights: readonly PlaintextHighlight[]) {
  const content: ReactNode[] = [];
  let cursor = 0;
  highlights.forEach((highlight, index) => {
    if (highlight.start > cursor) {
      content.push(value.slice(cursor, highlight.start));
    }

    content.push(
      <span
        key={`${highlight.start}:${highlight.end}:${index}`}
        className={highlight.className}
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

function getEditableCaretRect (element: HTMLElement) {
  const selection = window.getSelection?.();
  if (!selection || selection.rangeCount === 0 || !selection.isCollapsed) {
    return null;
  }

  const range = selection.getRangeAt(0);
  return element.contains(range.startContainer) ? getCollapsedRangeRect(range) : null;
}

function InlineMentionSuggestionLabel ({ suggestion }: { suggestion: InlineMentionSuggestion }) {
  if (suggestion.candidate.kind === "skill") {
    return suggestion.replacementText;
  }

  const path = suggestion.candidate.path;
  const filenameStart = path.lastIndexOf("/") + 1;
  const extensionStart = path.lastIndexOf(".");
  const stemEnd = extensionStart > filenameStart ? extensionStart : path.length;
  return (
    <>
      <span className="text-fg/muted">{path.slice(0, filenameStart)}</span>
      {path.slice(filenameStart, stemEnd)}
      <span className="text-fg/muted">{path.slice(stemEnd)}</span>
    </>
  );
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
      className="scrollbar-hover-reveal grid grid-cols-[auto 1fr] max-h-56 overflow-y-auto rounded-[0.85rem] border border-[color-mix(in srgb, var(--text) 10%, transparent)] bg-[color-mix(in srgb, var(--bg) 96%, transparent)] [--fg-bg: color-mix(in srgb, var(--bg) 96%, var(--app-bg-solid))] p-1.5 shadow-lg backdrop-blur"
      onClick={event => event.stopPropagation()}
      onContextMenu={event => event.stopPropagation()}
      onMouseDown={event => event.stopPropagation()}
      onPointerDown={event => event.stopPropagation()}
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
              <InlineMentionSuggestionLabel suggestion={suggestion} />
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
  attachmentCount,
  className,
  disabled = false,
  id,
  onBlur,
  onSelectionChange,
  onChange,
  onEditError,
  onCompositionEnd,
  onCompositionStart,
  onKeyDown,
  onPaste,
  placeholder,
  highlights: suppliedHighlights = [],
  highlightText = false,
  mentionSources = null,
  mentionSuggestionsPlacement = "above",
  readOnly = false,
  ref,
  singleLine = false,
  spellCheck = false,
  value,
}: {
  ariaLabel?: string;
  autoFocus?: boolean;
  attachmentCount?: number;
  className?: string;
  disabled?: boolean;
  id?: string;
  onBlur?: (event: FocusEvent<HTMLDivElement>) => void;
  /** Model-text selection after clicks, key presses, input and drag-selection; null when focus is elsewhere. */
  onSelectionChange?: (range: { start: number; end: number } | null) => void;
  onChange?: (value: string) => void;
  onEditError?: (error: Error) => void;
  onCompositionEnd?: (event: CompositionEvent<HTMLDivElement>) => void;
  onCompositionStart?: (event: CompositionEvent<HTMLDivElement>) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
  onPaste?: (event: ClipboardEvent<HTMLDivElement>) => void;
  placeholder?: string;
  /** Sorted, non-overlapping ranges drawn by the overlay. */
  highlights?: readonly PlaintextHighlight[];
  /** Draw the text itself from the overlay so highlight classes may colour it; otherwise highlights are marks behind real text. */
  highlightText?: boolean;
  mentionSources?: InlineMentionHighlightSources | null;
  mentionSuggestionsPlacement?: "above" | "below";
  readOnly?: boolean;
  ref?: Ref<PlaintextEditableHandle>;
  /** One line: Enter goes to `onKeyDown` instead of breaking the line, line breaks are stripped, and there is no dictation. */
  singleLine?: boolean;
  spellCheck?: boolean;
  value: string;
}) {
  const elementRef = useRef<HTMLDivElement>(null);
  const retainedSelection = useRef<{ text: string; selection: VoiceSelection } | null>(null);
  const applyingEdits = useRef(false);
  const references = attachmentCount === undefined ? [] : attachmentReferences(value);
  const highlights = [
    ...suppliedHighlights.filter(highlight => !references.some(reference => reference.start < highlight.end && reference.end > highlight.start)),
    ...references.map(reference => ({
      start: reference.start, end: reference.end,
      className: reference.number !== null && reference.number <= (attachmentCount ?? 0)
        ? getInlineMentionOverlayClassName("attachment")
        : `${getInlineMentionOverlayClassName("attachment")} bg-danger/15 underline decoration-danger`,
    })),
  ].sort((left, right) => left.start - right.start);
  const savedVoiceSelection = useRef<{ text: string } & ({ selection: VoiceSelection } | { error: Error }) | null>(null);
  const pendingVoiceSelection = useRef<{ text: string; selection: VoiceSelection } | null>(null);
  // Without a change handler the voice control stays hidden, which is how single-line fields opt out of dictation.
  const voice = useVoiceInput(value, singleLine ? undefined : onChange, !disabled && !readOnly && !singleLine, {
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
  const canEdit = () => Boolean(elementRef.current && !disabled && !readOnly && !voice.locked && !isComposingRef.current);
  const applyEdits = (expectedText: string, edits: readonly AttachmentTextEdit[]) => {
    if (!canEdit() || expectedText !== value) return false;
    applyingEdits.current = true;
    try {
      applyPlaintextEdits(elementRef.current!, expectedText, edits);
      const retained = retainedSelection.current;
      if (retained?.text === expectedText) retainedSelection.current = {
        text: elementRef.current!.innerText,
        selection: {
          start: mapPlaintextOffset(retained.selection.start, edits),
          end: mapPlaintextOffset(retained.selection.end, edits),
        },
      };
      return true;
    } catch (error) {
      if (!onEditError) throw error;
      onEditError(error instanceof Error ? error : new Error("Unable to edit the attachment reference."));
      return false;
    } finally { applyingEdits.current = false; }
  };
  const insertText = (text: string) => {
    const element = elementRef.current;
    if (!element || !canEdit()) return;
    applyingEdits.current = true;
    try {
      const retained = retainedSelection.current;
      const selection = capturePlaintextSelection(element, value)
        ?? (retained?.text === value ? retained.selection : null)
        ?? { start: value.length, end: value.length };
      const next = applyPlaintextEdits(element, value, [{ ...selection, text }]);
      const caret = selection.start + text.length;
      element.focus();
      selectPlaintextRange(element, next, caret);
      retainedSelection.current = { text: next, selection: { start: caret, end: caret } };
      setCaretOffset(caret);
      onChange?.(next);
    } catch (error) {
      if (!onEditError) throw error;
      onEditError(error instanceof Error ? error : new Error("Unable to insert the attachment reference."));
    } finally { applyingEdits.current = false; }
  };
  useImperativeHandle(ref, () => ({
    canEdit,
    applyEdits,
    insertText,
    focus(offset) {
      const element = elementRef.current;
      if (!element || disabled || readOnly || voice.locked) return;
      element.focus();
      selectPlaintextRange(element, value, Math.max(0, Math.min(value.length, offset ?? value.length)));
    },
  }), [disabled, readOnly, value, voice.locked, onChange, onEditError]);
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
  const [suggestionsPortalStyle, setSuggestionsPortalStyle] = useState<InlineMentionSuggestionsPortalStyle | null>(null);
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
    const element = elementRef.current;
    if (!suggestions.length || !container || !element) {
      setSuggestionsPortalStyle(null);
      return;
    }

    const updateSuggestionsPortalStyle = () => {
      const fieldRect = container.getBoundingClientRect();
      setSuggestionsPortalStyle(getInlineMentionSuggestionsPortalStyle(
        fieldRect,
        getEditableCaretRect(element) ?? fieldRect,
        mentionSuggestionsPlacement,
        window.visualViewport?.width ?? document.documentElement.clientWidth ?? window.innerWidth,
      ));
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
    if (onSelectionChange) onSelectionChange(element ? getEditableSelectionRange(element) : null);
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
            "pointer-events-none absolute inset-0 z-20",
            !highlightText && "!text-transparent [& *]:!text-transparent",
            "!m-0",
            "whitespace-pre-wrap break-words [overflow-wrap:anywhere]",
            highlights.length === 0 && !highlightText && "hidden",
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
          aria-multiline={!singleLine}
          aria-readonly={readOnly || voice.locked || undefined}
          className={joinClasses(className, "relative z-10", highlightText && "!text-transparent caret-text",
            voice.visible && "pr-[calc(var(--voice-field-font-size)*2)]")}
          contentEditable={readOnly || disabled || voice.locked ? false : "plaintext-only"}
          data-empty={value ? "false" : "true"}
          data-placeholder={placeholder ?? ""}
          role="textbox"
          spellCheck={spellCheck}
          suppressContentEditableWarning
          tabIndex={readOnly || disabled ? -1 : 0}
          onBlur={event => {
            const retained = capturePlaintextSelection(event.currentTarget, value);
            retainedSelection.current = retained ? { text: value, selection: retained } : null;
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
            if (applyingEdits.current) return;
            if (voice.locked) { event.currentTarget.textContent = value; return; }
            if (singleLine && /[\r\n]/u.test(event.currentTarget.innerText)) {
              // Pasted or dropped line breaks never reach the model; the DOM is rewritten so the caret stays put.
              const caret = getEditableCaretOffset(event.currentTarget);
              const before = event.currentTarget.innerText.slice(0, caret ?? undefined).replace(/\r?\n/gu, "").length;
              setEditableValueAndCaret(event.currentTarget, event.currentTarget.innerText.replace(/\r?\n/gu, ""), before);
            }
            const nextValue = normalizePlaintextEditableValue(event.currentTarget.innerText);
            if (!nextValue) {
              event.currentTarget.replaceChildren();
              setCaretOffset(0);
            } else {
              setCaretOffset(getEditableCaretOffset(event.currentTarget));
            }
            onChange?.(nextValue);
            if (onSelectionChange) onSelectionChange(getEditableSelectionRange(event.currentTarget));
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

            if (singleLine && event.key === "Enter") event.preventDefault();
            onKeyDown?.(event);
          }}
          onPaste={event => { if (voice.locked) { event.preventDefault(); return; } onPaste?.(event); }}
          onDragOver={event => {
            if (attachmentCount === undefined || !event.dataTransfer.types.includes(attachmentReferenceDragType)) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = canEdit() ? "copy" : "none";
          }}
          onDrop={event => {
            if (attachmentCount === undefined || !event.dataTransfer.types.includes(attachmentReferenceDragType)) return;
            event.preventDefault();
            if (!canEdit()) return;
            const number = Number(event.dataTransfer.getData(attachmentReferenceDragType));
            if (!Number.isSafeInteger(number) || number < 1 || number > attachmentCount) return;
            const range = getCaretRangeFromPoint(event.clientX, event.clientY);
            if (!range || !event.currentTarget.contains(range.startContainer)) return;
            const selection = window.getSelection();
            selection?.removeAllRanges();
            selection?.addRange(range);
            insertText(`#[attach:${number}]`);
          }}
          onClick={updateCaretOffset}
          onKeyUp={updateCaretOffset}
          onMouseUp={onSelectionChange ? updateCaretOffset : undefined}
        />
      </div>
      {suggestionsPopupPortal}
    </>
  );
}
