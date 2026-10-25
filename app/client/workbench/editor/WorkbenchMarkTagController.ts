/*
 * Exports:
 * - WorkbenchMarkTagControllerOptions: editor surface and the structural mutation hook the controller drives.
 * - WorkbenchMarkTagController: apply mark tags to the selection and read the tag under it.
 * - default WorkbenchMarkTagController: own mark tags: words carry at most one tag, applying a tag to text that already
 *   wholly carries it takes it off, and a caret acts on its tagged run or else its word.
 */

import { closestCodeBlock } from "../dom/mutation/code-block-dom";
import { REVIEW_ATTRIBUTES } from "../markdown/review-markup";
import type { InlineMark } from "./inline-leaves";
import { getInlineRunContainer } from "./inline-run-containers";
import {
    readRunText,
    rebuildRunSpan,
    runOffsetOf,
    runRange,
    selectRunPoints,
    spanOfRange,
    spanWords,
    wordAt,
    type RunPoint,
    type TextLeaf,
} from "./inline-run-text";

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

const MARK_TAG_SELECTOR = `u[${REVIEW_ATTRIBUTES.markTag}]`;

function tagOf(marks: readonly InlineMark[]) {
  const tag = marks.find((mark): mark is Extract<InlineMark, { tag: "u" }> => mark.tag === "u");
  return tag?.name ?? null;
}

function retag(leaf: TextLeaf, name: string | null): TextLeaf {
  const marks = leaf.marks.filter((mark) => mark.tag !== "u");
  return { ...leaf, marks: name ? [...marks, { tag: "u", name }] : marks };
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
    const caret = runOffsetOf(container, range.startContainer, range.startOffset);
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

    const word = wordAt(text, caret);
    return word ? { caret, ...word } : null;
  }

  /**
   * Text offsets, not DOM markers, carry the selection through the rebuild: tagging never changes text, and the editor's
   * canonicalisation after a mutation consumes any selection markers it finds.
   */
  function tagRange(range: Range, name: string, caret: RunPoint | null) {
    const span = spanOfRange(editor, range);
    const words = span ? spanWords(span) : [];
    if (!span || !words.length) return false;

    const next = words.every((leaf) => tagOf(leaf.marks) === name) ? null : name;
    options.runStructuralMutation(() => {
      rebuildRunSpan(span, (leaf) => retag(leaf, next));
    }, {
      afterSelectionRestore: () => {
        if (caret) selectRunPoints(caret);
        else selectRunPoints(span.start, span.end);
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
    const targetRange = container && target ? runRange(container, target.start, target.end) : null;
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
