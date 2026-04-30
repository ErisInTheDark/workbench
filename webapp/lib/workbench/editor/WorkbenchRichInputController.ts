/*
 * Exports:
 * - WorkbenchRichInputControllerOptions: injected editor element and mode access for rich-input transforms without coordinator ownership. Keywords: workbench, rich input, controller, options, mode.
 * - WorkbenchRichInputResult: structural rich-input transform result for list-item and block-comment interception. Keywords: workbench, rich input, result, list item, comment.
 * - WorkbenchRichInputController: public event handler surface for rich-editor input transforms. Keywords: workbench, rich input, controller, handle.
 * - default WorkbenchRichInputController: bind editor-owned rich-input transforms for list items and block comments. Keywords: workbench, rich input, controller, list item, block comment, default export.
 */

import {
    ensureListItemHasEditableContent,
    insertListItemAtParagraphPosition,
} from "../dom/mutation/rich-input-dom";
import { getDirectEditorParagraph } from "../dom/query/direct-editor-paragraph";
import {
    deleteLeadingTextFromElement,
    getTextBeforeSelectionInElement,
} from "../dom/query/text-position-dom";

export interface WorkbenchRichInputControllerOptions {
  editor: HTMLElement;
  getMode: () => "rich" | "plain";
}

export interface WorkbenchRichInputResult {
  transformedListItem: HTMLLIElement | null;
  commentCaretMarker: HTMLElement | null;
}

interface WorkbenchRichInputController {
  handleRichInput: (event: Event) => WorkbenchRichInputResult;
}

function WorkbenchRichInputController(
  options: WorkbenchRichInputControllerOptions,
): WorkbenchRichInputController {
  const { editor, getMode } = options;

  function maybeTransformParagraphIntoListItem(event: Event) {
    if (!(event instanceof InputEvent) || getMode() !== "rich") {
      return null;
    }

    if (event.inputType !== "insertText" || event.data !== " ") {
      return null;
    }

    const selection = window.getSelection();
    if (!selection?.rangeCount || !selection.isCollapsed) {
      return null;
    }

    const paragraph = getDirectEditorParagraph(editor, selection.getRangeAt(0).startContainer);
    if (!paragraph || paragraph.dataset.blockComment === "true") {
      return null;
    }

    const beforeText = getTextBeforeSelectionInElement(selection, paragraph);
    if (beforeText !== "- ") {
      return null;
    }

    if (!deleteLeadingTextFromElement(paragraph, 2)) {
      return null;
    }

    const item = document.createElement("li");
    while (paragraph.firstChild) {
      item.append(paragraph.firstChild);
    }

    item.normalize();
    ensureListItemHasEditableContent(item);
    insertListItemAtParagraphPosition(paragraph, item);
    return item;
  }

  function maybeExpandBlockCommentStarter(event: Event) {
    if (!(event instanceof InputEvent) || getMode() !== "rich") {
      return null;
    }

    if (event.inputType !== "insertText" || event.data !== "!") {
      return null;
    }

    const selection = window.getSelection();
    if (!selection?.rangeCount || !selection.isCollapsed) {
      return null;
    }

    const range = selection.getRangeAt(0);
    const paragraph = getDirectEditorParagraph(editor, range.startContainer);
    if (!paragraph || paragraph.dataset.blockComment === "true") {
      return null;
    }

    const beforeText = getTextBeforeSelectionInElement(selection, paragraph);
    if (beforeText !== "<!") {
      return null;
    }

    const marker = document.createElement("span");
    marker.dataset.commentCaret = "true";

    if (!deleteLeadingTextFromElement(paragraph, 2)) {
      return null;
    }

    paragraph.dataset.blockComment = "true";
    if (paragraph.firstChild) {
      paragraph.insertBefore(marker, paragraph.firstChild);
    } else {
      paragraph.append(marker, document.createElement("br"));
    }

    return marker;
  }

  function handleRichInput(event: Event): WorkbenchRichInputResult {
    const transformedListItem = maybeTransformParagraphIntoListItem(event);
    const commentCaretMarker = transformedListItem
      ? null
      : maybeExpandBlockCommentStarter(event);

    return {
      transformedListItem,
      commentCaretMarker,
    };
  }

  return {
    handleRichInput,
  };
}

export default WorkbenchRichInputController;