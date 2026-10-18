/*
 * Exports:
 * - WorkbenchSourceEditorControllerOptions: the source textarea and the editor pipeline it edits through.
 * - WorkbenchSourceEditorController: source-mode surface: render, read, selection, commands and formats.
 * - default WorkbenchSourceEditorController: edit a file's markdown text in a growing textarea, with the rich editor's
 *   toolbar commands, keybinds, history and suggest mode applied as markdown text edits.
 */

import type { ReviewMode } from "./WorkbenchSuggestionController";
import {
    captureSourceCaretAnchor,
    findSourceAnchorOffset,
    type CaretAnchor,
} from "../dom/selection/mode-caret-anchor";
import {
    applySourceCommand,
    continueSourceBlock,
    forkSourceSuggestion,
    indentSourceLines,
    readSourceFormats,
    type SourceCommand,
    type SourceFormats,
    type SourceText,
} from "../markdown/markdown-source-commands";
import type { MarkdownStyle } from "../markdown/markdown-style";
import type { EditHistorySelection } from "../state/edit-history";

export interface WorkbenchSourceEditorControllerOptions {
  getAuthor: () => string | null;
  getReviewMode: () => ReviewMode;
  getStyle: () => MarkdownStyle;
  onBlur: () => void;
  onFocus: () => void;
  /** Keys the rich editor would run as commands (shortcuts), sent on to the panel. */
  onKeyDown: (event: KeyboardEvent) => void;
  onSelectionChange: () => void;
  runInputMutation: (mutate: () => void) => void;
  runStructuralMutation: (mutate: () => void) => void;
  signal: AbortSignal;
  source: HTMLTextAreaElement;
  updateHistorySelection: (selection: EditHistorySelection | null) => void;
  undo: () => void;
  redo: () => void;
}

interface WorkbenchSourceEditorController {
  applyCommand: (command: SourceCommand) => void;
  captureAnchor: () => CaretAnchor;
  captureSelection: () => EditHistorySelection | null;
  getFormats: () => SourceFormats;
  isFocused: () => boolean;
  /** The markdown text, in the file's line endings. */
  read: () => string;
  render: (content: string) => void;
  restoreAnchor: (anchor: CaretAnchor | null) => void;
  restoreSelection: (selection: EditHistorySelection | null) => void;
  setEditable: (editable: boolean) => void;
  setFontSize: (fontSize: string) => void;
}

function WorkbenchSourceEditorController(options: WorkbenchSourceEditorControllerOptions): WorkbenchSourceEditorController {
  const { signal, source } = options;
  let lineEnding: "\n" | "\r\n" = "\n";

  function resize() {
    source.style.height = "auto";
    source.style.height = `${source.scrollHeight}px`;
  }

  function current(): SourceText {
    return { end: source.selectionEnd, start: source.selectionStart, text: source.value };
  }

  /** The textarea grows instead of scrolling, so the pane scrolls to keep a moved caret's line in view. */
  function revealCaret() {
    const lineHeight = Number.parseFloat(getComputedStyle(source).lineHeight) || 24;
    const line = source.value.slice(0, source.selectionStart).split("\n").length - 1;
    const top = source.getBoundingClientRect().top + Number.parseFloat(getComputedStyle(source).paddingTop || "0") + line * lineHeight;
    let pane: HTMLElement | null = source.parentElement;
    while (pane && !(pane.scrollHeight > pane.clientHeight && /auto|scroll/u.test(getComputedStyle(pane).overflowY))) {
      pane = pane.parentElement;
    }
    const scroller = pane ?? document.scrollingElement;
    if (!scroller) return;
    const viewport = pane?.getBoundingClientRect() ?? { bottom: window.innerHeight, top: 0 };
    if (top >= viewport.top + lineHeight * 2 && top + lineHeight <= viewport.bottom - lineHeight * 2) return;
    scroller.scrollTop += top - (viewport.top + (viewport.bottom - viewport.top) / 3);
  }

  function select(start: number, end = start, reveal = false) {
    source.focus({ preventScroll: true });
    source.setSelectionRange(start, end);
    if (reveal) revealCaret();
  }

  function write(next: SourceText) {
    source.value = next.text;
    resize();
    select(next.start, next.end);
  }

  function captureSelection(): EditHistorySelection {
    return { end: { offset: source.selectionEnd, path: [] }, source: true, start: { offset: source.selectionStart, path: [] } };
  }

  function edit(next: SourceText | null) {
    if (!next) return false;
    options.updateHistorySelection(captureSelection());
    options.runStructuralMutation(() => write(next));
    return true;
  }

  function applyCommand(command: SourceCommand) {
    edit(applySourceCommand(current(), command, { author: options.getAuthor(), style: options.getStyle() }));
  }

  function insertedText(event: InputEvent) {
    switch (event.inputType) {
      case "insertLineBreak":
      case "insertParagraph":
        return "\n";
      case "insertFromPaste":
      case "insertFromDrop":
      case "insertReplacementText":
        return (event.dataTransfer?.getData("text/plain") ?? event.data ?? "").replace(/\r\n?/gu, "\n");
      default:
        return event.inputType.startsWith("insert") ? event.data ?? "" : null;
    }
  }

  /** The edit an input would make, applied to forked text; deletions stay inside the new side they start in. */
  function applyInput(fork: SourceText, event: InputEvent, bounds: { end: number; start: number }): SourceText {
    const { end, start, text } = fork;
    const inserted = insertedText(event);
    if (inserted !== null) {
      const caret = start + inserted.length;
      return { end: caret, start: caret, text: `${text.slice(0, start)}${inserted}${text.slice(end)}` };
    }
    let from = start;
    let to = end;
    if (from === to && event.inputType === "deleteContentBackward" && from > bounds.start) from -= 1;
    if (from === to && event.inputType === "deleteContentForward" && to < bounds.end) to += 1;
    return { end: from, start: from, text: `${text.slice(0, from)}${text.slice(to)}` };
  }

  /** Suggest mode: the first edit of a block forks it into a suggestion, and lands in the new side. */
  function forkForSuggestion(event: InputEvent) {
    if (options.getReviewMode() !== "suggest" || event.isComposing || event.inputType.startsWith("history")) return false;
    if (!event.inputType.startsWith("insert") && !event.inputType.startsWith("delete")) return false;
    const fork = forkSourceSuggestion(current());
    if (!fork) return false;
    event.preventDefault();
    const newSide = fork.bounds;
    edit(applyInput(fork, event, newSide));
    return true;
  }

  source.addEventListener("beforeinput", (event) => {
    if (event.inputType === "historyUndo" || event.inputType === "historyRedo") {
      event.preventDefault();
      if (event.inputType === "historyUndo") options.undo();
      else options.redo();
      return;
    }
    if (forkForSuggestion(event)) return;
    options.updateHistorySelection(captureSelection());
  }, { signal });

  source.addEventListener("input", () => {
    resize();
    options.runInputMutation(() => {});
  }, { signal });

  source.addEventListener("keydown", (event) => {
    if (event.isComposing) return;
    if (event.key === "Tab" && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      edit(indentSourceLines(current(), event.shiftKey, options.getStyle().listIndent));
      return;
    }
    if (event.key === "Enter" && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey
      && options.getReviewMode() !== "suggest" && edit(continueSourceBlock(current()))) {
      event.preventDefault();
      return;
    }
    options.onKeyDown(event);
  }, { signal });

  for (const type of ["selectionchange", "select", "keyup", "pointerup"]) {
    source.addEventListener(type, () => {
      options.onSelectionChange();
    }, { signal });
  }
  source.addEventListener("focus", () => options.onFocus(), { signal });
  source.addEventListener("blur", () => options.onBlur(), { signal });
  window.addEventListener("resize", resize, { signal });

  return {
    applyCommand,
    captureAnchor: () => captureSourceCaretAnchor(source.value, source.selectionStart),
    captureSelection: () => document.activeElement === source ? captureSelection() : null,
    getFormats: () => readSourceFormats(current(), options.getStyle()),
    isFocused: () => document.activeElement === source,
    read: () => lineEnding === "\n" ? source.value : source.value.replaceAll("\n", "\r\n"),
    render: (content) => {
      lineEnding = content.includes("\r\n") ? "\r\n" : "\n";
      source.value = content.replaceAll("\r\n", "\n");
      resize();
    },
    restoreAnchor: (anchor) => {
      select(anchor ? findSourceAnchorOffset(source.value, anchor) : 0, undefined, true);
    },
    restoreSelection: (selection) => {
      if (selection?.source) select(selection.start.offset, selection.end.offset, true);
      else select(source.value.length, undefined, true);
    },
    setEditable: (editable) => {
      source.readOnly = !editable;
    },
    setFontSize: (fontSize) => {
      source.style.fontSize = fontSize;
      resize();
    },
  };
}

export default WorkbenchSourceEditorController;
