/*
 * Exports:
 * - getCaretRangeFromPoint: resolve a collapsed caret range from viewport coordinates when the browser exposes point-based caret APIs. Keywords: workbench, selection, caret, range, pointer.
 * - placeCaretInElement: focus the editor and place the caret inside a target element at a pointer position or its end fallback. Keywords: workbench, selection, caret, pointer, summary.
 * - getNodePathFromEditor: serialize a node location relative to the editor root as child indexes. Keywords: workbench, selection, path, editor, history.
 * - serializeSelectionPoint: convert a DOM boundary point into edit-history path data relative to the editor root. Keywords: workbench, selection, serialize, history, cursor.
 * - resolveSelectionPoint: map a stored edit-history path back to a live DOM boundary point inside the editor root. Keywords: workbench, selection, resolve, history, cursor.
 * - captureEditorSelection: snapshot the current live selection when both endpoints are inside the editor root. Keywords: workbench, selection, capture, history, editor.
 * - placeCaretAtEditorEnd: focus the editor and collapse the live selection to its trailing edge. Keywords: workbench, selection, caret, editor, collapse.
 * - restoreEditorSelection: restore a saved edit-history selection inside the editor or fall back to the editor end. Keywords: workbench, selection, restore, history, editor.
 * - restoreParagraphSelection: collapse the live selection to the start of a paragraph-like element after structural edits. Keywords: workbench, selection, paragraph, restore, collapse.
 * - restoreListItemSelection: restore selection across list items after structural list edits using an injected text-container resolver. Keywords: workbench, selection, list item, restore, injected.
 * - isSelectionAtElementStart: test whether a collapsed selection is effectively at the start of an element, ignoring whitespace-only content. Keywords: workbench, selection, boundary, element, start.
 * - isSelectionAtElementEnd: test whether a collapsed selection is effectively at the end of an element, ignoring whitespace-only content. Keywords: workbench, selection, boundary, element, end.
 * - selectInsertedNodes: restore selection across inserted DOM nodes or a fallback caret range after structural edits. Keywords: workbench, selection, range, dom, inline format, code format.
 */

import type { EditHistorySelection, EditHistorySelectionPoint } from "./edit-history";

export function getCaretRangeFromPoint(clientX: number, clientY: number) {
  if (typeof document.caretPositionFromPoint === "function") {
    const caretPosition = document.caretPositionFromPoint(clientX, clientY);
    if (!caretPosition) {
      return null;
    }

    const range = document.createRange();
    range.setStart(caretPosition.offsetNode, caretPosition.offset);
    range.collapse(true);
    return range;
  }

  if (typeof document.caretRangeFromPoint === "function") {
    return document.caretRangeFromPoint(clientX, clientY);
  }

  return null;
}

export function placeCaretInElement(editor: HTMLElement, container: HTMLElement, clientX: number, clientY: number) {
  editor.focus();
  const selection = window.getSelection();
  const range = getCaretRangeFromPoint(clientX, clientY);

  if (selection && range && container.contains(range.startContainer)) {
    selection.removeAllRanges();
    selection.addRange(range);
    return;
  }

  const fallbackRange = document.createRange();
  fallbackRange.selectNodeContents(container);
  fallbackRange.collapse(false);
  selection?.removeAllRanges();
  selection?.addRange(fallbackRange);
}

export function getNodePathFromEditor(editor: HTMLElement, node: Node) {
  const path: number[] = [];
  let current: Node | null = node;

  while (current && current !== editor) {
    const parentNode = current.parentNode;
    if (!parentNode) {
      return null;
    }

    const index = Array.prototype.indexOf.call(parentNode.childNodes, current) as number;
    if (index < 0) {
      return null;
    }

    path.unshift(index);
    current = parentNode;
  }

  return current === editor ? path : null;
}

export function serializeSelectionPoint(editor: HTMLElement, node: Node, offset: number): EditHistorySelectionPoint | null {
  if (node !== editor && !editor.contains(node)) {
    return null;
  }

  const path = node === editor ? [] : getNodePathFromEditor(editor, node);
  if (!path) {
    return null;
  }

  return {
    path,
    offset,
  };
}

export function resolveSelectionPoint(editor: HTMLElement, point: EditHistorySelectionPoint) {
  let current: Node = editor;

  for (const index of point.path) {
    if (index < 0 || index >= current.childNodes.length) {
      return null;
    }

    current = current.childNodes[index];
  }

  if (current.nodeType === Node.TEXT_NODE) {
    return {
      node: current,
      offset: Math.max(0, Math.min(point.offset, current.textContent?.length ?? 0)),
    };
  }

  return {
    node: current,
    offset: Math.max(0, Math.min(point.offset, current.childNodes.length)),
  };
}

function isNodeWithinEditor(editor: HTMLElement, node: Node | null) {
  return node === editor || (node !== null && editor.contains(node));
}

export function captureEditorSelection(editor: HTMLElement) {
  const selection = window.getSelection();
  if (
    !selection?.rangeCount
    || !isNodeWithinEditor(editor, selection.anchorNode)
    || !isNodeWithinEditor(editor, selection.focusNode)
  ) {
    return null;
  }

  const range = selection.getRangeAt(0);
  const start = serializeSelectionPoint(editor, range.startContainer, range.startOffset);
  const end = serializeSelectionPoint(editor, range.endContainer, range.endOffset);
  if (!start || !end) {
    return null;
  }

  return { start, end } satisfies EditHistorySelection;
}

export function placeCaretAtEditorEnd(editor: HTMLElement) {
  editor.focus();
  const selection = window.getSelection();
  if (!selection) {
    return;
  }

  const range = document.createRange();
  range.selectNodeContents(editor);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}

export function restoreEditorSelection(editor: HTMLElement, selectionSnapshot: EditHistorySelection | null) {
  if (!selectionSnapshot) {
    placeCaretAtEditorEnd(editor);
    return;
  }

  const start = resolveSelectionPoint(editor, selectionSnapshot.start);
  const end = resolveSelectionPoint(editor, selectionSnapshot.end);
  if (!start || !end) {
    placeCaretAtEditorEnd(editor);
    return;
  }

  editor.focus();
  const selection = window.getSelection();
  if (!selection) {
    return;
  }

  const range = document.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  selection.removeAllRanges();
  selection.addRange(range);
}

export function restoreParagraphSelection(paragraph: HTMLElement) {
  const selection = window.getSelection();
  if (!selection) {
    return;
  }

  const range = document.createRange();
  range.selectNodeContents(paragraph);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

export function restoreListItemSelection(
  items: HTMLLIElement[],
  {
    collapsed,
    getListItemTextContainer,
  }: {
    collapsed: boolean;
    getListItemTextContainer: (item: HTMLLIElement) => HTMLElement;
  },
) {
  if (!items.length) {
    return;
  }

  const firstContainer = getListItemTextContainer(items[0]);
  const lastContainer = getListItemTextContainer(items[items.length - 1]);
  const selection = window.getSelection();
  if (!selection) {
    return;
  }

  const range = document.createRange();
  range.setStart(firstContainer, 0);

  if (collapsed) {
    range.collapse(true);
  } else {
    range.setEnd(lastContainer, lastContainer.childNodes.length);
  }

  selection.removeAllRanges();
  selection.addRange(range);
}

export function isSelectionAtElementStart(selection: Selection, element: HTMLElement) {
  if (!selection.rangeCount || !selection.isCollapsed) {
    return false;
  }

  const range = selection.getRangeAt(0);
  if (!element.contains(range.startContainer)) {
    return false;
  }

  const beforeRange = document.createRange();
  beforeRange.selectNodeContents(element);
  beforeRange.setEnd(range.startContainer, range.startOffset);
  return beforeRange.toString().replaceAll("\u00a0", " ").trim() === "";
}

export function isSelectionAtElementEnd(selection: Selection, element: HTMLElement) {
  if (!selection.rangeCount || !selection.isCollapsed) {
    return false;
  }

  const range = selection.getRangeAt(0);
  if (!element.contains(range.startContainer)) {
    return false;
  }

  const afterRange = document.createRange();
  afterRange.selectNodeContents(element);
  afterRange.setStart(range.startContainer, range.startOffset);
  return afterRange.toString().replaceAll("\u00a0", " ").trim() === "";
}

export function selectInsertedNodes(selection: Selection, insertedNodes: Node[], fallbackRange: Range) {
  selection.removeAllRanges();

  if (!insertedNodes.length) {
    selection.addRange(fallbackRange);
    return;
  }

  const nextRange = document.createRange();
  const firstNode = insertedNodes[0];
  const lastNode = insertedNodes[insertedNodes.length - 1];

  if (insertedNodes.length === 1) {
    nextRange.selectNodeContents(firstNode);
  } else {
    nextRange.setStartBefore(firstNode);
    nextRange.setEndAfter(lastNode);
  }

  selection.addRange(nextRange);
}