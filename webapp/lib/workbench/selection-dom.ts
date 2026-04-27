/*
 * Exports:
 * - selectInsertedNodes: restore selection across inserted DOM nodes or a fallback caret range after structural edits. Keywords: workbench, selection, range, dom, inline format, code format.
 */

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