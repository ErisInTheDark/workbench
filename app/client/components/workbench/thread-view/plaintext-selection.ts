/*
 * Exports:
 * - capturePlaintextSelection: measure a DOM selection against rendered controlled plaintext.
 * - restorePlaintextSelection: restore UTF-16 positions after a controlled voice update.
 */
import type { VoiceSelection } from "workbench-shared/workbench/voice/voice-document";
import { getNodePathFromEditor } from "../../../workbench/dom/selection/selection-dom";

export function capturePlaintextSelection(element: HTMLElement, value: string): VoiceSelection | null {
  const selection = window.getSelection();
  if (!selection?.rangeCount) return null;
  const range = selection.getRangeAt(0);
  if (!element.contains(range.startContainer) || !element.contains(range.endContainer)) return null;
  const startPath = getNodePathFromEditor(element, range.startContainer);
  const endPath = getNodePathFromEditor(element, range.endContainer);
  if (!startPath || !endPath) return null;
  const clone = element.cloneNode(true) as HTMLElement;
  clone.removeAttribute("id");
  clone.removeAttribute("data-placeholder");
  clone.inert = true;
  clone.setAttribute("aria-hidden", "true");
  clone.style.cssText = `position:fixed;left:-100000px;top:0;opacity:0;pointer-events:none;white-space:pre-wrap;width:${element.getBoundingClientRect().width}px`;
  const nodeAt = (parts: number[]) => parts.reduce<Node>((node, index) => node.childNodes[index], clone);
  const startNode = nodeAt(startPath);
  const endNode = nodeAt(endPath);
  const marker = `voice-${crypto.randomUUID()}`;
  const first = `${marker}-start`;
  const last = `${marker}-end`;
  const end = document.createRange();
  end.setStart(endNode, range.endOffset);
  end.collapse(true);
  end.insertNode(document.createTextNode(last));
  const start = document.createRange();
  start.setStart(startNode, range.startOffset);
  start.collapse(true);
  start.insertNode(document.createTextNode(first));
  document.body.appendChild(clone);
  try {
    const rendered = clone.innerText.replace(/\r\n/gu, "\n");
    const from = rendered.indexOf(first);
    const to = rendered.indexOf(last) - first.length;
    const text = rendered.replace(first, "").replace(last, "");
    // Empty contenteditables may contain browser-owned line-break scaffolding.
    const canonical = text.replace(/\n/gu, "") ? text : "";
    if (canonical !== value || from < 0 || to < from) throw new Error("The editor selection no longer matches its text. Focus the field and try again.");
    return value ? { start: from, end: to } : { start: 0, end: 0 };
  } finally { clone.remove(); }
}

export function restorePlaintextSelection(element: HTMLElement, text: string, position: VoiceSelection) {
  element.textContent = text;
  const node = element.firstChild ?? element;
  const range = document.createRange();
  range.setStart(node, Math.min(position.start, text.length));
  range.setEnd(node, Math.min(position.end, text.length));
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}
