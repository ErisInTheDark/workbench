/*
 * Exports:
 * - WorkbenchMarkTagControllerOptions: editor surface and the structural mutation hook the controller drives.
 * - WorkbenchMarkTagController: apply mark tags to the selection and read the tag under it.
 * - default WorkbenchMarkTagController: own mark tags: words carry at most one tag, applying a tag to text that already
 *   wholly carries it takes it off, and a caret acts on its tagged run or else its word.
 */

import { closestCodeBlock } from "../dom/mutation/code-block-dom";
import { REVIEW_ATTRIBUTES } from "../markdown/review-markup";
import {
    flattenInlineContent,
    normalizeInlineLeaves,
    rebuildInlineRunContainer,
    type InlineLeaf,
    type InlineMark,
} from "./inline-leaves";
import { getInlineRunContainer, getInlineRunContainersInRange } from "./inline-run-containers";

export interface WorkbenchMarkTagControllerOptions {
  editor: HTMLDivElement;
  runStructuralMutation: (mutate: () => void, hooks?: { afterSelectionRestore?: () => void }) => void;
}

export interface WorkbenchMarkTagController {
  /** Tag the selection, or the caret's tagged run or word; false when there was nothing to tag. */
  apply: (name: string) => boolean;
  /** The tag of the text the selection starts in. */
  getActive: () => string | null;
}

const WORD_CHARACTER = /[\p{L}\p{N}\p{M}_'’-]/u;
const MARK_TAG_SELECTOR = `u[${REVIEW_ATTRIBUTES.markTag}]`;

type TextLeaf = Extract<InlineLeaf, { type: "text" }>;

function tagOf(marks: readonly InlineMark[]) {
  const tag = marks.find((mark): mark is Extract<InlineMark, { tag: "u" }> => mark.tag === "u");
  return tag?.name ?? null;
}

function retag(leaf: TextLeaf, name: string | null): TextLeaf {
  const marks = leaf.marks.filter((mark) => mark.tag !== "u");
  return { ...leaf, marks: name ? [...marks, { tag: "u", name }] : marks };
}

/** Text of a run container with each text node's offset, so offsets map back to DOM points. */
function readRunText(container: HTMLElement) {
  const nodes: Array<{ node: Text; start: number }> = [];
  let length = 0;
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    nodes.push({ node, start: length });
    length += node.data.length;
  }
  return { nodes, text: nodes.map(({ node }) => node.data).join("") };
}

function offsetOf(container: HTMLElement, node: Node, offset: number) {
  const before = document.createRange();
  before.selectNodeContents(container);
  before.setEnd(node, offset);
  return before.toString().length;
}

function pointAt(nodes: ReturnType<typeof readRunText>["nodes"], offset: number, preferEnd: boolean) {
  const entry = preferEnd
    ? nodes.find(({ node, start }) => offset > start && offset <= start + node.data.length)
    : nodes.find(({ node, start }) => offset >= start && offset < start + node.data.length);
  const fallback = entry ?? nodes.at(-1);
  return fallback ? { node: fallback.node, offset: Math.min(offset - fallback.start, fallback.node.data.length) } : null;
}

function rangeBetween(container: HTMLElement, start: number, end: number) {
  const { nodes } = readRunText(container);
  const from = pointAt(nodes, start, false);
  const to = pointAt(nodes, end, true);
  if (!from || !to) return null;
  const range = document.createRange();
  range.setStart(from.node, from.offset);
  range.setEnd(to.node, to.offset);
  return range;
}

function WorkbenchMarkTagController(options: WorkbenchMarkTagControllerOptions): WorkbenchMarkTagController {
  const { editor } = options;

  function closestTag(node: Node | null, container: HTMLElement) {
    const element = node instanceof Element ? node : node?.parentElement;
    const tag = element?.closest<HTMLElement>(MARK_TAG_SELECTOR);
    return tag && container.contains(tag) ? tag.getAttribute(REVIEW_ATTRIBUTES.markTag) : null;
  }

  /** The caret's contiguous run of one tag, or its word; text offsets within its run container. */
  function caretTarget(container: HTMLElement, range: Range) {
    const { nodes, text } = readRunText(container);
    const caret = offsetOf(container, range.startContainer, range.startOffset);
    const current = closestTag(range.startContainer, container);
    if (current) {
      const tagged = nodes.map(({ node }) => closestTag(node, container) === current);
      const own = nodes.findIndex(({ node }) => node === range.startContainer);
      const at = own >= 0 ? own : Math.max(0, nodes.findIndex(({ node, start }, index) =>
        tagged[index] && caret >= start && caret <= start + node.data.length));
      let first = at;
      let last = at;
      while (first > 0 && tagged[first - 1]) first -= 1;
      while (last < nodes.length - 1 && tagged[last + 1]) last += 1;
      const end = nodes[last]!;
      return { caret, end: end.start + end.node.data.length, start: nodes[first]!.start };
    }

    let start = caret;
    let end = caret;
    while (start > 0 && WORD_CHARACTER.test(text[start - 1]!)) start -= 1;
    while (end < text.length && WORD_CHARACTER.test(text[end]!)) end += 1;
    return start === end ? null : { caret, end, start };
  }

  function select(from: { container: HTMLElement; offset: number }, to: { container: HTMLElement; offset: number }) {
    const start = pointAt(readRunText(from.container).nodes, from.offset, false);
    const end = pointAt(readRunText(to.container).nodes, to.offset, true);
    const selection = window.getSelection();
    if (!start || !end || !selection) return;
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  /** A run's leaves with those inside the text span `[start, end)` split off and flagged. */
  function splitLeaves(container: HTMLElement, start: number, end: number) {
    const leaves: Array<{ leaf: InlineLeaf; selected: boolean }> = [];
    let position = 0;
    for (const leaf of flattenInlineContent(container.childNodes)) {
      if (leaf.type !== "text") {
        leaves.push({ leaf, selected: false });
        continue;
      }
      const from = Math.max(start, position) - position;
      const to = Math.min(end, position + leaf.text.length) - position;
      position += leaf.text.length;
      if (to <= from) {
        leaves.push({ leaf, selected: false });
        continue;
      }
      const piece = (text: string, selected: boolean) => text ? [{ leaf: { ...leaf, text }, selected }] : [];
      leaves.push(...piece(leaf.text.slice(0, from), false), ...piece(leaf.text.slice(from, to), true),
        ...piece(leaf.text.slice(to), false));
    }
    return leaves;
  }

  /**
   * Text offsets, not DOM markers, carry the selection through the rebuild: tagging never changes text, and the editor's
   * canonicalisation after a mutation consumes any selection markers it finds.
   */
  function tagRange(range: Range, name: string, caret: { container: HTMLElement; offset: number } | null) {
    const containers = getInlineRunContainersInRange(editor, range);
    const first = containers.find((container) => container.contains(range.startContainer)) ?? containers[0];
    const last = containers.findLast((container) => container.contains(range.endContainer)) ?? containers.at(-1);
    if (!first || !last) return false;
    const start = { container: first, offset: first.contains(range.startContainer) ? offsetOf(first, range.startContainer, range.startOffset) : 0 };
    const end = { container: last, offset: last.contains(range.endContainer) ? offsetOf(last, range.endContainer, range.endOffset) : readRunText(last).text.length };

    const runs = containers.map((container) => ({
      container,
      leaves: splitLeaves(container, container === first ? start.offset : 0, container === last ? end.offset : Infinity),
    }));
    const words = runs.flatMap(({ leaves }) => leaves)
      .flatMap(({ leaf, selected }) => selected && leaf.type === "text" && /\S/u.test(leaf.text) ? [leaf] : []);
    if (!words.length) return false;

    const next = words.every((leaf) => tagOf(leaf.marks) === name) ? null : name;
    options.runStructuralMutation(() => {
      for (const { container, leaves } of runs) {
        rebuildInlineRunContainer(container, normalizeInlineLeaves(leaves.map(({ leaf, selected }) =>
          selected && leaf.type === "text" ? retag(leaf, next) : leaf)));
      }
    }, {
      afterSelectionRestore: () => {
        if (caret) select(caret, caret);
        else select(start, end);
      },
    });
    return true;
  }

  function apply(name: string) {
    const selection = window.getSelection();
    if (!selection?.rangeCount) return false;
    const range = selection.getRangeAt(0);
    if (!editor.contains(range.commonAncestorContainer) || closestCodeBlock(editor, range.commonAncestorContainer)) {
      return false;
    }
    if (!range.collapsed) return tagRange(range, name, null);

    const container = getInlineRunContainer(editor, range.startContainer);
    const target = container ? caretTarget(container, range) : null;
    const targetRange = container && target ? rangeBetween(container, target.start, target.end) : null;
    return Boolean(container && target && targetRange
      && tagRange(targetRange, name, { container, offset: target.caret }));
  }

  function getActive() {
    const selection = window.getSelection();
    if (!selection?.rangeCount || !editor.contains(selection.anchorNode)) return null;
    const { startContainer } = selection.getRangeAt(0);
    const container = getInlineRunContainer(editor, startContainer);
    return container ? closestTag(startContainer, container) : null;
  }

  return { apply, getActive };
}

export default WorkbenchMarkTagController;
