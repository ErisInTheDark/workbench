/*
 * Exports:
 * - WorkbenchFormatCommandControllerOptions: injected editor mode and formatting delegates for rich-editor toolbar and key command handling. Keywords: workbench, format, command, toolbar, keydown, controller, dependencies.
 * - WorkbenchFormatCommandController: public surface for rich-editor format shortcuts and toolbar commands. Keywords: workbench, format, command, toolbar, keydown, controller.
 * - default WorkbenchFormatCommandController: create the editor-owned formatting command controller for rich-editor inline and block formatting actions. Keywords: workbench, format, command, toolbar, keydown, rich editor, default export.
 */

import {
    toggleRootBlockList,
    toggleRootBlockTag,
    type BlockFormatTag,
    type ListFormatDependencies,
    type ListFormatTag,
} from "../dom/mutation/block-format-dom";
import type { EditorMode } from "../WorkbenchEditorClient";
import type { PendingInlineFormatKey } from "./WorkbenchInlineFormatController";

type WrapSelectionTagName = keyof HTMLElementTagNameMap | "comment";
type ToggleInlineFormatKey = "bold" | "italic" | "comment" | "del" | "ins";

export interface WorkbenchFormatCommandControllerOptions {
  editor: HTMLDivElement;
  getMode: () => EditorMode;
  clearPendingInlineFormats: () => void;
  listFormat: ListFormatDependencies;
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

interface WorkbenchFormatCommandController {
  applyToolbarCommand: (command: string) => void;
  handleFormatKeyDown: (event: KeyboardEvent) => boolean;
}

function WorkbenchFormatCommandController(
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

  /** Run a block-level edit, then put the selection back on the same (moved) text nodes before the run is canonicalised. */
  function runBlockCommand(apply: (selection: Selection) => void) {
    if (options.getMode() !== "rich") {
      return;
    }

    const selection = window.getSelection();
    if (!selection?.rangeCount || !options.editor.contains(selection.getRangeAt(0).commonAncestorContainer)) {
      return;
    }

    const { startContainer, startOffset, endContainer, endOffset } = selection.getRangeAt(0);
    options.syncEditorAfterStructuralChange(() => {
      options.clearPendingInlineFormats();
      apply(selection);
      if (options.editor.contains(startContainer) && options.editor.contains(endContainer)) {
        const range = document.createRange();
        range.setStart(startContainer, startOffset);
        range.setEnd(endContainer, endOffset);
        selection.removeAllRanges();
        selection.addRange(range);
      }
    });
  }

  function toggleBlock(tag: BlockFormatTag) {
    runBlockCommand((selection) => {
      toggleRootBlockTag(options.editor, selection.getRangeAt(0), tag);
    });
  }

  function toggleList(tag: ListFormatTag) {
    runBlockCommand((selection) => {
      toggleRootBlockList(options.editor, selection, tag, options.listFormat);
    });
  }

  function applyToolbarCommand(command: string) {
    switch (command) {
      case "bold":
        wrapSelection("strong");
        break;
      case "italic":
        wrapSelection("em");
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
      case "h2":
        toggleBlock(command);
        break;
      case "unordered-list":
        toggleList("ul");
        break;
      case "ordered-list":
        toggleList("ol");
        break;
      case "quote":
        toggleBlock("blockquote");
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
      wrapSelection("strong");
      return true;
    }

    if (event.key.toLowerCase() === "i") {
      event.preventDefault();
      wrapSelection("em");
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

export default WorkbenchFormatCommandController;
