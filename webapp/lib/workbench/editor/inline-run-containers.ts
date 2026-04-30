/*
 * Exports:
 * - isInlineRunContainer: classify editor child blocks that should be treated as inline runs for serialization and inline formatting. Keywords: workbench, editor, inline run, classification.
 * - getInlineRunContainer: walk from a node to the nearest inline-run container within the editor root. Keywords: workbench, editor, inline run, selection.
 */

import {
    hasDirectBlockLikeChildren,
} from "../dom/mutation/structured-block-dom";
import {
    getDirectChildDetailsElement,
    getDirectChildListElements,
} from "../dom/query/list-dom";

export function isInlineRunContainer(editor: HTMLElement, element: HTMLElement) {
  if (element === editor) {
    return false;
  }

  if (element.dataset.summaryText === "true") {
    return true;
  }

  if (/^(p|h1|h2|h3|h4|h5|h6|blockquote)$/i.test(element.tagName)) {
    return true;
  }

  if (element.tagName === "DIV") {
    return !hasDirectBlockLikeChildren(element);
  }

  if (element.tagName === "LI") {
    return !getDirectChildDetailsElement(element) && getDirectChildListElements(element).length === 0;
  }

  return false;
}

export function getInlineRunContainer(editor: HTMLElement, node: Node | null) {
  let current: Node | null = node;

  while (current && current !== editor) {
    if (current instanceof HTMLElement && isInlineRunContainer(editor, current)) {
      return current;
    }

    current = current.parentNode;
  }

  return null;
}