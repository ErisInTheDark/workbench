/*
 * Exports:
 * - RichInputTransformResult: normalized result for typed rich-input structural transforms. Keywords: workbench, rich input, transform, shortcut, result.
 * - runRichInputTransformers: run ordered typed shortcut transformers for rich markdown editing. Keywords: workbench, rich input, registry, markdown shortcut, transformer.
 */

import {
    ensureListItemHasEditableContent,
    insertListItemAtParagraphPosition,
    replaceParagraphWithHeading,
} from "../dom/mutation/rich-input-dom";
import { getDirectEditorParagraph } from "../dom/query/direct-editor-paragraph";
import {
    deleteLeadingTextFromElement,
    getTextBeforeSelectionInElement,
} from "../dom/query/text-position-dom";

export interface RichInputTransformResult {
  commentCaretMarker: HTMLElement | null;
  transformedBlock: HTMLElement | null;
  transformedListItem: HTMLLIElement | null;
}

interface RichInputTransformContext {
  event: InputEvent;
  paragraph: HTMLElement;
  selection: Selection;
}

type RichInputTransformer = (context: RichInputTransformContext) => RichInputTransformResult | null;

const EMPTY_RICH_INPUT_TRANSFORM_RESULT: RichInputTransformResult = {
  commentCaretMarker: null,
  transformedBlock: null,
  transformedListItem: null,
};

function transformHeadingShortcut({ paragraph, selection }: RichInputTransformContext): RichInputTransformResult | null {
  const beforeText = getTextBeforeSelectionInElement(selection, paragraph);
  const headingMatch = beforeText.match(/^(#{1,6}) $/);
  if (!headingMatch) {
    return null;
  }

  if (!deleteLeadingTextFromElement(paragraph, headingMatch[0].length)) {
    return null;
  }

  return {
    ...EMPTY_RICH_INPUT_TRANSFORM_RESULT,
    transformedBlock: replaceParagraphWithHeading(paragraph, headingMatch[1].length),
  };
}

function transformUnorderedListShortcut({ paragraph, selection }: RichInputTransformContext): RichInputTransformResult | null {
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
  return {
    ...EMPTY_RICH_INPUT_TRANSFORM_RESULT,
    transformedListItem: item,
  };
}

function transformBlockCommentShortcut({ event, paragraph, selection }: RichInputTransformContext): RichInputTransformResult | null {
  if (event.data !== "!") {
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

  return {
    ...EMPTY_RICH_INPUT_TRANSFORM_RESULT,
    commentCaretMarker: marker,
  };
}

const RICH_INPUT_TRANSFORMERS: RichInputTransformer[] = [
  transformHeadingShortcut,
  transformUnorderedListShortcut,
  transformBlockCommentShortcut,
];

export function runRichInputTransformers(
  event: InputEvent,
  {
    editor,
    getMode,
  }: {
    editor: HTMLElement;
    getMode: () => "rich" | "plain";
  },
): RichInputTransformResult {
  if (getMode() !== "rich" || event.inputType !== "insertText") {
    return EMPTY_RICH_INPUT_TRANSFORM_RESULT;
  }

  if (event.data !== " " && event.data !== "!") {
    return EMPTY_RICH_INPUT_TRANSFORM_RESULT;
  }

  const selection = window.getSelection();
  if (!selection?.rangeCount || !selection.isCollapsed) {
    return EMPTY_RICH_INPUT_TRANSFORM_RESULT;
  }

  const paragraph = getDirectEditorParagraph(editor, selection.getRangeAt(0).startContainer);
  if (!paragraph || paragraph.dataset.blockComment === "true") {
    return EMPTY_RICH_INPUT_TRANSFORM_RESULT;
  }

  const context: RichInputTransformContext = {
    event,
    paragraph,
    selection,
  };

  for (const transformer of RICH_INPUT_TRANSFORMERS) {
    const result = transformer(context);
    if (result) {
      return result;
    }
  }

  return EMPTY_RICH_INPUT_TRANSFORM_RESULT;
}
