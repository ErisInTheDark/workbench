/*
 * Exports:
 * - CODE_LINE_SENTINEL: the newline closing every editor code block, so a last empty line still renders.
 * - readCodeBlockText: the code a `pre` holds, lines kept and the sentinel left out.
 * - writeCodeBlockText: replace a `pre`'s code with one text node plus sentinel and put the caret at a code offset.
 * - getCodeBlockCaretOffset: the code offset of a range boundary inside a `pre`.
 * - closestCodeBlock: the `pre` holding a node inside the editor.
 * - normalizeCodeBlocks: rebuild every `pre` as `pre > code` holding its plain code, as markdown can only say that.
 * - ensureCodeBlockSentinels: give live code blocks back their sentinel after edits removed it.
 */

export const CODE_LINE_SENTINEL = "\n";

/** Text and line breaks in document order; formatting inside code has no markdown form. */
function collectCodeText(node: Node): string {
  if (node instanceof Text) return node.data;
  if (node instanceof HTMLBRElement) return "\n";
  let text = "";
  for (const child of Array.from(node.childNodes)) text += collectCodeText(child);
  return text;
}

export function readCodeBlockText(pre: Element) {
  const text = collectCodeText(pre).replaceAll(" ", " ");
  return text.endsWith(CODE_LINE_SENTINEL) ? text.slice(0, -CODE_LINE_SENTINEL.length) : text;
}

export function closestCodeBlock(editor: HTMLElement, node: Node | null) {
  for (let current: Node | null = node; current && current !== editor; current = current.parentNode) {
    if (current instanceof HTMLPreElement) return current;
  }
  return null;
}

export function getCodeBlockCaretOffset(pre: HTMLPreElement, container: Node, offset: number) {
  const before = pre.ownerDocument.createRange();
  before.selectNodeContents(pre);
  before.setEnd(container, offset);
  return collectCodeText(before.cloneContents()).length;
}

export function writeCodeBlockText(pre: HTMLPreElement, text: string, caretOffset: number | null) {
  const code = pre.ownerDocument.createElement("code");
  const node = pre.ownerDocument.createTextNode(`${text}${CODE_LINE_SENTINEL}`);
  code.append(node);
  pre.replaceChildren(code);
  if (caretOffset === null) return;
  const selection = pre.ownerDocument.getSelection();
  if (!selection) return;
  const range = pre.ownerDocument.createRange();
  range.setStart(node, Math.max(0, Math.min(caretOffset, text.length)));
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

function isCanonicalCodeBlock(pre: HTMLPreElement) {
  const code = pre.firstChild;
  return pre.childNodes.length === 1 && code instanceof HTMLElement && code.tagName === "CODE"
    && code.childNodes.length === 1 && code.firstChild instanceof Text && code.firstChild.data.endsWith(CODE_LINE_SENTINEL);
}

export function normalizeCodeBlocks(root: ParentNode) {
  for (const pre of Array.from(root.querySelectorAll("pre"))) {
    if (!isCanonicalCodeBlock(pre)) writeCodeBlockText(pre, readCodeBlockText(pre), null);
  }
}

export function ensureCodeBlockSentinels(root: ParentNode) {
  for (const pre of Array.from(root.querySelectorAll("pre"))) {
    if (collectCodeText(pre).endsWith(CODE_LINE_SENTINEL)) continue;
    const code = pre.querySelector("code") ?? pre;
    code.append(pre.ownerDocument.createTextNode(CODE_LINE_SENTINEL));
  }
}
