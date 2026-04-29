/*
 * Exports:
 * - WorkbenchFormatCommandControllerOptions: injected editor mode and formatting delegates for rich-editor toolbar and key command handling. Keywords: workbench, format, command, toolbar, keydown, controller, dependencies.
 * - WorkbenchFormatCommandController: public surface for rich-editor format shortcuts and toolbar commands. Keywords: workbench, format, command, toolbar, keydown, controller.
 * - createWorkbenchFormatCommandController: create the editor-owned formatting command controller for rich-editor inline and block formatting actions. Keywords: workbench, format, command, toolbar, keydown, rich editor.
 */

import type { EditorMode } from "../WorkbenchEditorClient";
import type { PendingInlineFormatKey } from "./WorkbenchInlineFormatController";

type WrapSelectionTagName = keyof HTMLElementTagNameMap | "comment";
type ToggleInlineFormatKey = "bold" | "italic" | "comment" | "del" | "ins";

export interface WorkbenchFormatCommandControllerOptions {
  editor: HTMLDivElement;
  getMode: () => EditorMode;
  clearPendingInlineFormats: () => void;
  syncEditorAfterStructuralChange: (
    mutate: () => void,
    options?: { afterDomMutation?: () => void; afterSelectionRestore?: () => void },
  ) => void;
  toggleCodeSelection: (selection: Selection, range: Range) => void;
  toggleInlineFormatSelection: (
    selection: Selection,
    range: Range,
    formatKey: ToggleInlineFormatKey,
  ) => void;
  togglePendingInlineFormat: (format: PendingInlineFormatKey) => boolean;
}

export interface WorkbenchFormatCommandController {
  applyToolbarCommand: (command: string) => void;
  handleFormatKeyDown: (event: KeyboardEvent) => boolean;
}

export function WorkbenchFormatCommandController(
  options: WorkbenchFormatCommandControllerOptions,
): WorkbenchFormatCommandController {
  function wrapSelection(tagName: WrapSelectionTagName) {
    if (options.getMode() !== "rich") {
      return;
    }

    const selection = window.getSelection();
    if (!selection?.rangeCount) {
      return;
    }

    if (selection.isCollapsed) {
      const pendingFormatKey = tagName === "strong"
        ? "bold"
        : tagName === "em"
          ? "italic"
          : tagName === "code" || tagName === "comment" || tagName === "del" || tagName === "ins"
            ? tagName
            : null;

      if (pendingFormatKey && options.togglePendingInlineFormat(pendingFormatKey)) {
        return;
      }
      return;
    }

    const range = selection.getRangeAt(0);
    if (!options.editor.contains(range.commonAncestorContainer)) {
      return;
    }

    options.clearPendingInlineFormats();
    if (tagName === "code") {
      options.toggleCodeSelection(selection, range);
      return;
    }

    if (tagName === "strong") {
      options.toggleInlineFormatSelection(selection, range, "bold");
      return;
    }

    if (tagName === "em") {
      options.toggleInlineFormatSelection(selection, range, "italic");
      return;
    }

    if (tagName === "del") {
      options.toggleInlineFormatSelection(selection, range, "del");
      return;
    }

    if (tagName === "ins") {
      options.toggleInlineFormatSelection(selection, range, "ins");
      return;
    }

    if (tagName === "comment") {
      options.toggleInlineFormatSelection(selection, range, "comment");
      return;
    }

    const wrapper = document.createElement(tagName);
    options.syncEditorAfterStructuralChange(() => {
      wrapper.append(range.extractContents());
      range.insertNode(wrapper);
    }, {
      afterDomMutation: () => {
        selection.removeAllRanges();
        const nextRange = document.createRange();
        nextRange.selectNodeContents(wrapper);
        selection.addRange(nextRange);
      },
    });
  }

  function runEditorCommand(command: string, value: string | null = null) {
    if (options.getMode() !== "rich") {
      return;
    }

    if (command === "bold") {
      wrapSelection("strong");
      return;
    }

    if (command === "italic") {
      wrapSelection("em");
      return;
    }

    options.syncEditorAfterStructuralChange(() => {
      options.clearPendingInlineFormats();
      document.execCommand(command, false, value);
      options.editor.focus();
    });
  }

  function applyToolbarCommand(command: string) {
    switch (command) {
      case "bold":
        runEditorCommand("bold");
        break;
      case "italic":
        runEditorCommand("italic");
        break;
      case "inline-code":
        wrapSelection("code");
        break;
      case "comment":
        wrapSelection("comment");
        break;
      case "del":
        wrapSelection("del");
        break;
      case "ins":
        wrapSelection("ins");
        break;
      case "h1":
        runEditorCommand("formatBlock", "<h1>");
        break;
      case "h2":
        runEditorCommand("formatBlock", "<h2>");
        break;
      case "unordered-list":
        runEditorCommand("insertUnorderedList");
        break;
      case "ordered-list":
        runEditorCommand("insertOrderedList");
        break;
      case "quote":
        runEditorCommand("formatBlock", "<blockquote>");
        break;
      default:
        break;
    }
  }

  function handleFormatKeyDown(event: KeyboardEvent) {
    const isPrimaryModifier = event.metaKey || event.ctrlKey;
    if (!isPrimaryModifier) {
      return false;
    }

    if (event.key.toLowerCase() === "b") {
      event.preventDefault();
      runEditorCommand("bold");
      return true;
    }

    if (event.key.toLowerCase() === "i") {
      event.preventDefault();
      runEditorCommand("italic");
      return true;
    }

    if (event.code === "Backquote" && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      wrapSelection("code");
      return true;
    }

    if (event.shiftKey && event.key.toLowerCase() === "x") {
      event.preventDefault();
      wrapSelection("del");
      return true;
    }

    if (event.shiftKey && event.key.toLowerCase() === "a") {
      event.preventDefault();
      wrapSelection("ins");
      return true;
    }

    return false;
  }

  return {
    applyToolbarCommand,
    handleFormatKeyDown,
  };
}