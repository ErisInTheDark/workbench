/*
 * Exports:
 * - CaretAnchor: the words around a caret and roughly how far into the document it sits.
 * - captureRichCaretAnchor / captureSourceCaretAnchor: read the anchor of the rich editor's or markdown source's caret.
 * - findRichAnchorPoint / findSourceAnchorOffset: where the same words sit in the other view, nearest the same depth.
 *
 * Switching between rich and source views keeps the caret beside the same words; markup that one view shows and the
 * other hides is left out of the match.
 */

export interface CaretAnchor {
  /** Plain words after the caret on its line, markup left out. */
  after: string;
  /** Plain words before the caret on its line, markup left out. */
  before: string;
  /** How far into the document the caret sits, from 0 to 1. */
  depth: number;
}

const ANCHOR_LENGTH = 32;
const MIN_MATCH = 3;
const SOURCE_LINE_MARKERS = /^ {0,3}(?:#{1,6}[ \t]+|>[ \t]?|[-*+][ \t]+|\d+[.)][ \t]+)*/u;
const SOURCE_MARKUP = /<\/?(?:del|ins|mark)>|<!--[\s\S]*?-->|\\(?=[^\n])|[*_`~]/gu;

function plain(text: string) {
  return text.replaceAll(" ", " ");
}

function textNodes(root: Node) {
  const walker = root.ownerDocument!.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text);
  return nodes;
}

export function captureRichCaretAnchor(editor: HTMLElement): CaretAnchor | null {
  const selection = editor.ownerDocument.getSelection();
  if (!selection?.rangeCount || !editor.contains(selection.anchorNode)) return null;
  const range = selection.getRangeAt(0);
  let block: Node | null = range.startContainer;
  while (block && block.parentNode !== editor) block = block.parentNode;
  if (!(block instanceof HTMLElement)) return null;
  const before = editor.ownerDocument.createRange();
  before.selectNodeContents(block);
  before.setEnd(range.startContainer, range.startOffset);
  const after = editor.ownerDocument.createRange();
  after.selectNodeContents(block);
  after.setStart(range.startContainer, range.startOffset);
  const index = Array.prototype.indexOf.call(editor.children, block) as number;
  return {
    after: plain(after.toString()).split("\n")[0]!.slice(0, ANCHOR_LENGTH),
    before: (plain(before.toString()).split("\n").at(-1) ?? "").slice(-ANCHOR_LENGTH),
    depth: editor.children.length > 1 ? index / (editor.children.length - 1) : 0,
  };
}

export function captureSourceCaretAnchor(text: string, offset: number): CaretAnchor {
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
  const lineEnd = text.indexOf("\n", offset);
  const before = text.slice(lineStart, offset).replace(SOURCE_LINE_MARKERS, "").replace(SOURCE_MARKUP, "");
  const after = text.slice(offset, lineEnd === -1 ? text.length : lineEnd).replace(SOURCE_MARKUP, "");
  return {
    after: plain(after).slice(0, ANCHOR_LENGTH),
    before: plain(before).slice(-ANCHOR_LENGTH),
    depth: text.length ? offset / text.length : 0,
  };
}

function nearestOccurrence(haystack: string, needle: string, target: number) {
  let best = -1;
  for (let index = haystack.indexOf(needle); index >= 0; index = haystack.indexOf(needle, index + 1)) {
    if (best < 0 || Math.abs(index - target) < Math.abs(best - target)) best = index;
  }
  return best;
}

/**
 * Where the caret goes in another view's text: after the longest tail of the words before it, else before the longest
 * head of the words after it, at the occurrence nearest the anchor's depth.
 */
function findAnchorOffset(haystack: string, anchor: CaretAnchor) {
  const target = anchor.depth * haystack.length;
  for (let length = anchor.before.length; length >= Math.min(MIN_MATCH, anchor.before.length) && length > 0; length -= 1) {
    const needle = anchor.before.slice(-length);
    const found = needle.trim() ? nearestOccurrence(haystack, needle, target) : -1;
    if (found >= 0) return found + needle.length;
  }
  for (let length = anchor.after.length; length >= Math.min(MIN_MATCH, anchor.after.length) && length > 0; length -= 1) {
    const needle = anchor.after.slice(0, length);
    const found = needle.trim() ? nearestOccurrence(haystack, needle, target) : -1;
    if (found >= 0) return found;
  }
  return null;
}

export function findSourceAnchorOffset(text: string, anchor: CaretAnchor) {
  const found = findAnchorOffset(plain(text), anchor);
  if (found !== null) return found;
  const near = Math.round(anchor.depth * text.length);
  return text.lastIndexOf("\n", near - 1) + 1;
}

export function findRichAnchorPoint(editor: HTMLElement, anchor: CaretAnchor) {
  const nodes = textNodes(editor);
  const found = findAnchorOffset(plain(nodes.map((node) => node.data).join("")), anchor);
  if (found === null) {
    const blocks = editor.children;
    const block = blocks[Math.round(anchor.depth * Math.max(0, blocks.length - 1))];
    return block ? { node: block as Node, offset: 0 } : null;
  }
  let remaining = found;
  for (const node of nodes) {
    if (remaining <= node.length) return { node: node as Node, offset: remaining };
    remaining -= node.length;
  }
  return null;
}
