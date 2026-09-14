/*
 * Exports:
 * - getTextPositionAtOffset: walk text nodes to resolve a DOM boundary point for a character offset within a root. Keywords: workbench, text, offset, tree walker, range.
 * - getTextBeforeSelectionInElement: read normalized text from an element start up to the current selection boundary. Keywords: workbench, selection, text, prefix, element.
 * - deleteTextImmediatelyBeforeSelection: remove a fixed number of characters directly before the current selection boundary inside an element. Keywords: workbench, selection, delete, text, backspace.
 * - deleteLeadingTextFromElement: delete a fixed number of leading characters from an element using text-node offsets. Keywords: workbench, text, delete, prefix, element.
 */

export function getTextPositionAtOffset(root: Node, offset: number) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let remaining = offset;
  let currentNode = walker.nextNode();

  if (!currentNode) {
    return offset === 0 ? { node: root, offset: 0 } : null;
  }

  while (currentNode) {
    const textNode = currentNode as Text;
    const textLength = textNode.textContent?.length ?? 0;
    if (remaining <= textLength) {
      return { node: textNode, offset: remaining };
    }

    remaining -= textLength;
    currentNode = walker.nextNode();
  }

  return null;
}

export function getTextBeforeSelectionInElement(selection: Selection, element: HTMLElement) {
  if (!selection.rangeCount) {
    return "";
  }

  const range = selection.getRangeAt(0);
  if (!element.contains(range.startContainer)) {
    return "";
  }

  const beforeRange = document.createRange();
  beforeRange.selectNodeContents(element);
  beforeRange.setEnd(range.startContainer, range.startOffset);
  return beforeRange.toString().replaceAll("\u00a0", " ");
}

export function deleteTextImmediatelyBeforeSelection(selection: Selection, element: HTMLElement, characterCount: number) {
  if (!selection.rangeCount || characterCount <= 0) {
    return false;
  }

  const beforeText = getTextBeforeSelectionInElement(selection, element);
  if (beforeText.length < characterCount) {
    return false;
  }

  const startPosition = getTextPositionAtOffset(element, beforeText.length - characterCount);
  const endPosition = getTextPositionAtOffset(element, beforeText.length);
  if (!startPosition || !endPosition) {
    return false;
  }

  const range = document.createRange();
  range.setStart(startPosition.node, startPosition.offset);
  range.setEnd(endPosition.node, endPosition.offset);
  range.deleteContents();
  return true;
}

export function deleteLeadingTextFromElement(element: HTMLElement, characterCount: number) {
  const endPosition = getTextPositionAtOffset(element, characterCount);
  if (!endPosition) {
    return false;
  }

  const range = document.createRange();
  range.setStart(element, 0);
  range.setEnd(endPosition.node, endPosition.offset);
  range.deleteContents();
  return true;
}