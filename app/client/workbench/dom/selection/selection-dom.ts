/*
 * Exports:
 * - getCaretRangeFromPoint: resolve a collapsed caret range from viewport coordinates when the browser exposes point-based caret APIs. Keywords: workbench, selection, caret, range, pointer.
 * - placeCaretInElement: focus the editor and place the caret inside a target element at a pointer position or its end fallback. Keywords: workbench, selection, caret, pointer, summary.
 * - getNodePathFromEditor: serialize a node location relative to the editor root as child indexes. Keywords: workbench, selection, path, editor, history.
 * - serializeSelectionPoint: convert a DOM boundary point into a block position plus character offset that survives re-rendering. Keywords: workbench, selection, serialize, history, cursor.
 * - resolveSelectionPoint: map a stored block position and character offset back to a live DOM boundary point. Keywords: workbench, selection, resolve, history, cursor.
 * - captureEditorSelection: snapshot the current live selection when both endpoints are inside the editor root. Keywords: workbench, selection, capture, history, editor.
 * - placeCaretAtEditorEnd: focus the editor and collapse the live selection to its trailing edge. Keywords: workbench, selection, caret, editor, collapse.
 * - restoreEditorSelection: restore a saved edit-history selection inside the editor or fall back to the editor end. Keywords: workbench, selection, restore, history, editor.
 * - restoreParagraphSelection: collapse the live selection to the start of a paragraph-like element after structural edits. Keywords: workbench, selection, paragraph, restore, collapse.
 * - restoreListItemSelection: restore selection across list items after structural list edits using an injected text-container resolver. Keywords: workbench, selection, list item, restore, injected.
 * - isSelectionAtElementStart: test whether a collapsed selection is effectively at the start of an element, ignoring whitespace-only content. Keywords: workbench, selection, boundary, element, start.
 * - isSelectionAtElementEnd: test whether a collapsed selection is effectively at the end of an element, ignoring whitespace-only content. Keywords: workbench, selection, boundary, element, end.
 * - selectInsertedNodes: restore selection across inserted DOM nodes or a fallback caret range after structural edits. Keywords: workbench, selection, range, dom, inline format, code format.
 */

import type { EditHistorySelection, EditHistorySelectionPoint } from "../../state/edit-history";

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
    const parentNode: ParentNode | null = current.parentNode;
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

const SELECTION_BLOCK_TAGS = /^(P|DIV|H[1-6]|BLOCKQUOTE|LI|PRE|SUMMARY|TD|TH)$/u;

function closestSelectionBlock(editor: HTMLElement, node: Node) {
  for (let current: Node | null = node; current && current !== editor; current = current.parentNode) {
    if (current instanceof HTMLElement && SELECTION_BLOCK_TAGS.test(current.tagName)) return current;
  }
  return editor;
}

/** Text, line breaks and non-editable atoms in document order; one atom or break counts as one character. */
function* selectionUnits(root: Node): Generator<Node> {
  for (let child = root.firstChild; child; child = child.nextSibling) {
    if (child instanceof Text || child instanceof HTMLBRElement
      || (child instanceof HTMLElement && child.getAttribute("contenteditable") === "false")) {
      yield child;
    } else {
      yield* selectionUnits(child);
    }
  }
}

function unitLength(unit: Node) {
  return unit instanceof Text ? unit.length : 1;
}

/**
 * Selection points name their block by element position and the characters before them inside it, so they survive
 * the editor re-rendering the same markdown with differently split text nodes (as undo and redo do).
 */
export function serializeSelectionPoint(editor: HTMLElement, node: Node, offset: number): EditHistorySelectionPoint | null {
  if (node !== editor && !editor.contains(node)) {
    return null;
  }

  const block = closestSelectionBlock(editor, node);
  const path: number[] = [];
  for (let current: Element = block; current !== editor; current = current.parentElement!) {
    path.unshift(Array.prototype.indexOf.call(current.parentElement!.children, current) as number);
  }

  const boundary = document.createRange();
  boundary.setStart(node, offset);
  let characters = 0;
  for (const unit of selectionUnits(block)) {
    if (unit === node) return { path, offset: characters + offset };
    const parent = unit.parentNode!;
    const end = unit instanceof Text ? [unit, unit.length] as const
      : [parent, Array.prototype.indexOf.call(parent.childNodes, unit) as number + 1] as const;
    if (boundary.comparePoint(end[0], end[1]) > 0) break;
    characters += unitLength(unit);
  }
  return { path, offset: characters };
}

export function resolveSelectionPoint(editor: HTMLElement, point: EditHistorySelectionPoint) {
  let block: Element = editor;
  for (const index of point.path) {
    const next = block.children[index];
    if (!next) return null;
    block = next;
  }

  let remaining = Math.max(0, point.offset);
  let last: Node | null = null;
  for (const unit of selectionUnits(block)) {
    if (unit instanceof Text) {
      if (remaining <= unit.length) return { node: unit as Node, offset: remaining };
    } else if (remaining === 0) {
      return { node: unit.parentNode!, offset: Array.prototype.indexOf.call(unit.parentNode!.childNodes, unit) as number };
    }
    remaining -= unitLength(unit);
    last = unit;
  }

  if (last instanceof Text) return { node: last as Node, offset: last.length };
  return { node: block as Node, offset: block.childNodes.length };
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

/** A source-mode selection names markdown offsets, not blocks, so it puts the caret at the end like a missing one. */
export function restoreEditorSelection(editor: HTMLElement, selectionSnapshot: EditHistorySelection | null) {
  if (!selectionSnapshot || selectionSnapshot.source) {
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
