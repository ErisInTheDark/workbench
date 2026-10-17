/*
 * Exports:
 * - FormatCommand: the editor commands that format text or blocks.
 * - isFormatCommand: narrow an editor command to a format command.
 * - WorkbenchFormatCommandControllerOptions: injected editor mode and formatting delegates.
 * - WorkbenchFormatCommandController: run format commands against the live selection.
 * - default WorkbenchFormatCommandController: create the editor-owned formatting command controller.
 */

import {
    toggleRootBlockList,
    toggleRootBlockTag,
    type BlockFormatTag,
    type ListFormatDependencies,
    type ListFormatTag,
} from "../dom/mutation/block-format-dom";
import type { EditorMode } from "../WorkbenchEditorClient";
import type { EditorCommand } from "./editor-commands";
import type { PendingInlineFormatKey } from "./WorkbenchInlineFormatController";

export type FormatCommand = Exclude<EditorCommand, "comment" | "undo" | "redo">;

export function isFormatCommand(command: EditorCommand): command is FormatCommand {
  return command !== "comment" && command !== "undo" && command !== "redo";
}

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
  toggleInlineFormatSelection: (selection: Selection, range: Range, formatKey: Exclude<PendingInlineFormatKey, "code">) => void;
  togglePendingInlineFormat: (format: PendingInlineFormatKey) => boolean;
}

interface WorkbenchFormatCommandController {
  applyFormatCommand: (command: FormatCommand) => void;
}

type FormatAction =
  | { kind: "inline"; format: PendingInlineFormatKey }
  | { kind: "block"; tag: BlockFormatTag }
  | { kind: "list"; tag: ListFormatTag };

const FORMAT_ACTIONS: Record<FormatCommand, FormatAction> = {
  bold: { kind: "inline", format: "bold" },
  italic: { kind: "inline", format: "italic" },
  "inline-code": { kind: "inline", format: "code" },
  del: { kind: "inline", format: "del" },
  ins: { kind: "inline", format: "ins" },
  h1: { kind: "block", tag: "h1" },
  h2: { kind: "block", tag: "h2" },
  h3: { kind: "block", tag: "h3" },
  quote: { kind: "block", tag: "blockquote" },
  "unordered-list": { kind: "list", tag: "ul" },
  "ordered-list": { kind: "list", tag: "ol" },
};

function WorkbenchFormatCommandController(
  options: WorkbenchFormatCommandControllerOptions,
): WorkbenchFormatCommandController {
  function toggleInlineFormat(format: PendingInlineFormatKey) {
    const selection = window.getSelection();
    if (!selection?.rangeCount) {
      return;
    }

    if (selection.isCollapsed) {
      options.togglePendingInlineFormat(format);
      return;
    }

    const range = selection.getRangeAt(0);
    if (!options.editor.contains(range.commonAncestorContainer)) {
      return;
    }

    options.clearPendingInlineFormats();
    if (format === "code") {
      options.toggleCodeSelection(selection, range);
    } else {
      options.toggleInlineFormatSelection(selection, range, format);
    }
  }

  /** Run a block-level edit, then put the selection back on the same (moved) text nodes before the run is canonicalised. */
  function runBlockCommand(apply: (selection: Selection) => void) {
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

  function applyFormatCommand(command: FormatCommand) {
    if (options.getMode() !== "rich") {
      return;
    }

    const action = FORMAT_ACTIONS[command];
    switch (action.kind) {
      case "inline":
        toggleInlineFormat(action.format);
        return;
      case "block":
        runBlockCommand((selection) => {
          toggleRootBlockTag(options.editor, selection.getRangeAt(0), action.tag);
        });
        return;
      case "list":
        runBlockCommand((selection) => {
          toggleRootBlockList(options.editor, selection, action.tag, options.listFormat);
        });
        return;
    }
  }

  return {
    applyFormatCommand,
  };
}

export default WorkbenchFormatCommandController;
