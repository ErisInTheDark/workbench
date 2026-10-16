/*
 * Exports:
 * - mapPlaintextOffset: retain a selection endpoint across ordered text replacements.
 * - applyPlaintextEdits: replace only affected DOM ranges without rebuilding the editor.
 * - selectPlaintextRange: select rendered text offsets without replacing content.
 */
import { applyAttachmentTextEdits, type AttachmentTextEdit } from "workbench-shared/workbench/thread/attachment-references";
import { capturePlaintextSelection } from "./plaintext-selection";

export function mapPlaintextOffset(offset: number, edits: readonly AttachmentTextEdit[]) {
  let shift = 0;
  for (const edit of edits) {
    if (offset < edit.start) break;
    if (offset === edit.end) return edit.start + shift + edit.text.length;
    if (offset <= edit.end) return edit.start + shift + Math.min(offset - edit.start, edit.text.length);
    shift += edit.text.length - (edit.end - edit.start);
  }
  return offset + shift;
}

function textPoints(element: HTMLElement, expected: string) {
  const clone = element.cloneNode(true) as HTMLElement;
  clone.removeAttribute("id");
  clone.removeAttribute("data-placeholder");
  clone.inert = true;
  clone.setAttribute("aria-hidden", "true");
  clone.style.cssText = `position:fixed;left:-100000px;top:0;opacity:0;pointer-events:none;white-space:pre-wrap;width:${element.getBoundingClientRect().width}px`;
  const originals = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const copies = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
  const nodes: { node: Text; copy: Text; marker: string }[] = [];
  const prefix = `edit-${crypto.randomUUID()}-`;
  while (originals.nextNode() && copies.nextNode()) {
    nodes.push({ node: originals.currentNode as Text, copy: copies.currentNode as Text, marker: `${prefix}${nodes.length}!` });
  }
  for (const { copy, marker } of nodes) copy.data = marker + copy.data;
  document.body.appendChild(clone);
  try {
    let text = clone.innerText.replace(/\r\n/gu, "\n");
    const points: { node: Text; start: number; end: number }[] = [];
    for (const { node, marker } of nodes) {
      const start = text.indexOf(marker);
      if (start < 0) continue;
      text = text.slice(0, start) + text.slice(start + marker.length);
      points.push({ node, start, end: start + node.length });
    }
    if ((text.replace(/\n/gu, "") ? text : "") !== expected) {
      throw new Error("The editor text changed before its range edit.");
    }
    return (offset: number) => {
      const point = points.find(point => offset >= point.start && offset <= point.end);
      if (point) return { node: point.node as Node, offset: offset - point.start };
      if (offset === expected.length) return { node: element as Node, offset: element.childNodes.length };
      throw new Error("The text edit does not address an editable text position.");
    };
  } finally { clone.remove(); }
}

export function applyPlaintextEdits(element: HTMLElement, expected: string, edits: readonly AttachmentTextEdit[]) {
  const next = applyAttachmentTextEdits(expected, edits);
  if (!edits.length) return next;
  const selection = capturePlaintextSelection(element, expected);
  const pointAt = textPoints(element, expected);
  const ranges = edits.map(edit => {
    const start = pointAt(edit.start);
    const end = pointAt(edit.end);
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    return { edit, range };
  });
  for (const { edit, range } of ranges.reverse()) {
    if (range.startContainer === range.endContainer && range.startContainer.nodeType === Node.TEXT_NODE) {
      (range.startContainer as Text).replaceData(range.startOffset, range.endOffset - range.startOffset, edit.text);
    } else {
      element.focus();
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      if (!document.execCommand("insertText", false, edit.text)) {
        throw new Error("The browser could not apply the text edit.");
      }
    }
  }
  if (selection) {
    const nextPointAt = textPoints(element, next);
    const start = nextPointAt(mapPlaintextOffset(selection.start, edits));
    const end = nextPointAt(mapPlaintextOffset(selection.end, edits));
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    const current = window.getSelection();
    current?.removeAllRanges();
    current?.addRange(range);
  }
  return next;
}

export function selectPlaintextRange(element: HTMLElement, text: string, start: number, end = start) {
  const pointAt = textPoints(element, text);
  const from = pointAt(start);
  const to = pointAt(end);
  const range = document.createRange();
  range.setStart(from.node, from.offset);
  range.setEnd(to.node, to.offset);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}
