/*
 * Exports:
 * - InlineMark / InlineLeaf: the flat inline model of one run: text, breaks, selection markers and comment thread atoms,
 *   each carrying its full mark set. * - getInlineMarkForElement / createInlineMarkElement: map mark elements to marks and back.
 * - areInlineMarksEqual / areInlineMarkListsEqual / normalizeInlineMarks: compare and canonically order mark sets.
 * - flattenInlineContent: read DOM inline content into leaves.
 * - normalizeInlineLeaves / normalizeInlineLeavesForCanonicalRuns / normalizeInlineLeavesForSerialization: merge leaves,
 *   moving boundary whitespace out of marks where the target form needs it.
 * - rebuildInlineRunContainer: write leaves back as canonical DOM, one nested mark chain per run.
 * - createInlineSelectionMarker / restoreSelectionToMarkers / restoreCaretToMarker: carry a selection through rebuilds.
 * - serializeInlineRunContainerForMarkupSignature: canonical structure of a run for save-guard comparison.
 */

import { isCommentThreadElement, readThreadComments, REVIEW_ATTRIBUTES } from "../markdown/review-markup";

/** `u` is a mark tag: suggest-mode annotation naming one configured tag. */
export type InlineMark =
  | { tag: "a"; href: string }
  | { tag: "u"; name: string }
  | { tag: "code" | "del" | "em" | "ins" | "mark" | "strong" };

const MARK_TAG_ATTRIBUTE = REVIEW_ATTRIBUTES.markTag;

export type InlineLeaf =
  | { type: "text"; marks: InlineMark[]; text: string }
  | { type: "break"; marks: InlineMark[] }
  | { type: "atom"; element: HTMLElement; marks: InlineMark[] }
  | { type: "marker"; role: "caret" | "selection-start" | "selection-end"; marks?: InlineMark[] };

const INLINE_MARK_RANK: Record<InlineMark["tag"], number> = {
  a: 0,
  u: 1,
  mark: 2,
  del: 3,
  ins: 4,
  em: 5,
  strong: 6,
  code: 7,
};

export function getInlineMarkForElement(element: Element): InlineMark | null {
  switch (element.tagName.toLowerCase()) {
    case "strong":
    case "b":
      return { tag: "strong" };
    case "em":
    case "i":
      return { tag: "em" };
    case "code":
      return { tag: "code" };
    case "del":
    case "s":
    case "strike":
      return { tag: "del" };
    case "ins":
      return { tag: "ins" };
    case "mark":
      return { tag: "mark" };
    case "a":
      return { tag: "a", href: element.getAttribute("href") ?? "" };
    case "u": {
      // Plain underlines (pasted from word processors) have no markdown form and drop to text.
      const name = element.getAttribute(MARK_TAG_ATTRIBUTE);
      return name ? { tag: "u", name } : null;
    }
    default:
      return null;
  }
}

export function createInlineMarkElement(mark: InlineMark) {
  const element = document.createElement(mark.tag);
  if (mark.tag === "a") {
    element.setAttribute("href", mark.href);
  } else if (mark.tag === "u") {
    element.setAttribute(MARK_TAG_ATTRIBUTE, mark.name);
    element.title = mark.name;
  }
  return element;
}

function markDetail(mark: InlineMark) {
  return mark.tag === "a" ? mark.href : mark.tag === "u" ? mark.name : "";
}

export function areInlineMarksEqual(left: InlineMark, right: InlineMark) {
  return left.tag === right.tag && markDetail(left) === markDetail(right);
}

export function areInlineMarkListsEqual(left: readonly InlineMark[], right: readonly InlineMark[]) {
  return left.length === right.length
    && left.every((mark, index) => areInlineMarksEqual(mark, right[index]!));
}

export function normalizeInlineMarks(marks: readonly InlineMark[]) {
  const normalized = [...marks].sort((left, right) => {
    const rankDifference = INLINE_MARK_RANK[left.tag] - INLINE_MARK_RANK[right.tag];
    if (rankDifference !== 0) {
      return rankDifference;
    }

    return markDetail(left).localeCompare(markDetail(right));
  });

  const deduped: InlineMark[] = [];
  for (const mark of normalized) {
    const previousMark = deduped.at(-1);
    if (!previousMark || !areInlineMarksEqual(previousMark, mark)) {
      deduped.push(mark);
    }
  }

  return deduped;
}

function leafMarks(leaf: InlineLeaf) {
  return leaf.type === "marker" ? leaf.marks ?? [] : leaf.marks;
}

function appendInlineLeaf(leaves: InlineLeaf[], nextLeaf: InlineLeaf) {
  const normalizedLeaf: InlineLeaf = nextLeaf.type === "marker"
    ? { ...nextLeaf, marks: nextLeaf.marks ? normalizeInlineMarks(nextLeaf.marks) : undefined }
    : { ...nextLeaf, marks: normalizeInlineMarks(nextLeaf.marks) };

  if (normalizedLeaf.type !== "text" || !normalizedLeaf.text) {
    leaves.push(normalizedLeaf);
    return;
  }

  const previousLeaf = leaves.at(-1);
  if (previousLeaf?.type === "text" && areInlineMarkListsEqual(previousLeaf.marks, normalizedLeaf.marks)) {
    previousLeaf.text += normalizedLeaf.text;
    return;
  }

  leaves.push(normalizedLeaf);
}

export function flattenInlineContent(nodes: Iterable<Node>, marks: InlineMark[] = [], leaves: InlineLeaf[] = []) {
  for (const node of nodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      appendInlineLeaf(leaves, { type: "text", marks: [...marks], text: node.textContent ?? "" });
      continue;
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
      continue;
    }

    const element = node as HTMLElement;
    const markerRole = element.dataset.inlineSelectionMarker;
    if (markerRole === "caret" || markerRole === "selection-start" || markerRole === "selection-end") {
      leaves.push({ type: "marker", role: markerRole, marks: [...marks] });
      continue;
    }

    if (isCommentThreadElement(element)) {
      leaves.push({ type: "atom", element, marks: [...marks] });
      continue;
    }

    if (element.tagName === "BR") {
      leaves.push({ type: "break", marks: [...marks] });
      continue;
    }

    const mark = getInlineMarkForElement(element);
    flattenInlineContent(element.childNodes, mark ? [...marks, mark] : marks, leaves);
  }

  return leaves;
}

/**
 * A thread atom belongs to the marks running through it: the ones its neighbours share. Code never holds one, since a
 * comment inside a code span is literal text.
 */
function settleAtomMarks(leaves: InlineLeaf[]) {
  const neighbourMarks = (from: number, step: 1 | -1) => {
    for (let index = from + step; index >= 0 && index < leaves.length; index += step) {
      const leaf = leaves[index]!;
      if (leaf.type === "text" || leaf.type === "break") return leaf.marks;
    }
    return [];
  };

  return leaves.map((leaf, index): InlineLeaf => {
    if (leaf.type !== "atom") return leaf;
    const after = neighbourMarks(index, 1);
    const marks = neighbourMarks(index, -1)
      .filter((mark) => mark.tag !== "code" && after.some((other) => areInlineMarksEqual(mark, other)));
    return { ...leaf, marks };
  });
}

function stripSingularTrailingBreak(leaves: InlineLeaf[]) {
  const lastLeaf = leaves.at(-1);
  if (lastLeaf?.type === "break" && leaves.at(-2)?.type !== "break") {
    leaves.pop();
  }
}

/** Markdown delimiters cannot hug whitespace, so marked text gives its edge whitespace to an unmarked neighbour. */
function normalizeInlineLeafBoundaries(leaf: InlineLeaf): InlineLeaf[] {
  if (
    leaf.type !== "text"
    || leaf.marks.length === 0
    || leaf.text.length === 0
    || leaf.marks.some((mark) => mark.tag === "ins" || mark.tag === "del")
  ) {
    return [leaf];
  }

  const leadingWhitespace = leaf.text.match(/^[ \t ]+/)?.[0] ?? "";
  const trailingWhitespace = leaf.text.match(/[ \t ]+$/)?.[0] ?? "";
  const contentEnd = leaf.text.length - trailingWhitespace.length;
  const coreText = leaf.text.slice(leadingWhitespace.length, Math.max(leadingWhitespace.length, contentEnd));
  const parts: InlineLeaf[] = [];

  if (leadingWhitespace) parts.push({ type: "text", marks: [], text: leadingWhitespace });
  if (coreText) parts.push({ ...leaf, text: coreText });
  if (trailingWhitespace) parts.push({ type: "text", marks: [], text: trailingWhitespace });
  return parts;
}

function mergeLeaves(leaves: Iterable<InlineLeaf>) {
  const result: InlineLeaf[] = [];
  for (const leaf of leaves) appendInlineLeaf(result, leaf);
  return result;
}

export function normalizeInlineLeaves(leaves: InlineLeaf[]) {
  return mergeLeaves(settleAtomMarks(mergeLeaves(leaves)));
}

export function normalizeInlineLeavesForCanonicalRuns(leaves: InlineLeaf[]) {
  return mergeLeaves(settleAtomMarks(mergeLeaves(leaves.flatMap(normalizeInlineLeafBoundaries))));
}

export function normalizeInlineLeavesForSerialization(leaves: InlineLeaf[]) {
  const result = normalizeInlineLeavesForCanonicalRuns(leaves);
  stripSingularTrailingBreak(result);
  return result;
}

export function createInlineSelectionMarker(role: "caret" | "selection-start" | "selection-end") {
  const marker = document.createElement("span");
  marker.hidden = true;
  marker.dataset.pendingInlineCaret = role === "caret" ? "true" : "false";
  marker.dataset.inlineSelectionMarker = role;
  return marker;
}

function appendCanonicalInlineLeaf(container: HTMLElement, leaf: InlineLeaf) {
  const marks = leafMarks(leaf);
  let contentNode: Node;

  if (leaf.type === "marker") {
    contentNode = createInlineSelectionMarker(leaf.role);
  } else if (leaf.type === "break") {
    contentNode = document.createElement("br");
  } else if (leaf.type === "atom") {
    contentNode = leaf.element;
  } else {
    contentNode = document.createTextNode(leaf.text);
  }

  if (marks.length) {
    const existingRun = getDeepestMatchingMarkedRun(container.lastChild, marks);
    if (existingRun) {
      existingRun.append(contentNode);
      return;
    }

    for (let index = marks.length - 1; index >= 0; index -= 1) {
      const wrapper = createInlineMarkElement(marks[index]!);
      wrapper.append(contentNode);
      contentNode = wrapper;
    }
    container.append(contentNode);
    return;
  }

  if (leaf.type === "text") {
    const wrapper = document.createElement("span");
    wrapper.append(contentNode);
    contentNode = wrapper;
  }

  container.append(contentNode);
}

function getDeepestMatchingMarkedRun(node: Node | null, marks: InlineMark[]) {
  if (!(node instanceof HTMLElement) || !marks.length) {
    return null;
  }

  let current: HTMLElement | null = node;
  for (let index = 0; index < marks.length; index += 1) {
    if (!current) {
      return null;
    }

    const currentMark = getInlineMarkForElement(current);
    if (!currentMark || !areInlineMarksEqual(currentMark, marks[index]!)) {
      return null;
    }

    if (index === marks.length - 1) {
      return Array.from(current.children).some((child) => getInlineMarkForElement(child)) ? null : current;
    }

    const childElements: HTMLElement[] = Array.from(current.children).filter((child): child is HTMLElement => child instanceof HTMLElement);
    if (childElements.length !== 1) {
      return null;
    }

    current = childElements[0]!;
  }

  return null;
}

export function rebuildInlineRunContainer(container: HTMLElement, leaves: InlineLeaf[]) {
  container.replaceChildren();

  for (const leaf of leaves) {
    if (leaf.type === "text" && leaf.text.length === 0) {
      continue;
    }

    appendCanonicalInlineLeaf(container, leaf);
  }

  if (!container.childNodes.length) {
    container.append(document.createElement("br"));
  }
}

export function restoreSelectionToMarkers(startMarker: HTMLElement, endMarker: HTMLElement | null) {
  const selection = window.getSelection();
  if (!selection || !startMarker.parentNode) {
    startMarker.remove();
    endMarker?.remove();
    return;
  }

  const range = document.createRange();
  range.setStartBefore(startMarker);

  if (endMarker?.parentNode) {
    range.setEndBefore(endMarker);
  } else {
    range.collapse(true);
  }

  startMarker.remove();
  endMarker?.remove();
  selection.removeAllRanges();
  selection.addRange(range);
}

export function restoreCaretToMarker(marker: HTMLElement) {
  const selection = window.getSelection();
  if (!selection || !marker.parentNode) {
    marker.remove();
    return;
  }

  const range = document.createRange();
  const parentElement = marker.parentElement;
  if (parentElement && getInlineMarkForElement(parentElement)) {
    range.setStart(parentElement, Math.max(0, Array.from(parentElement.childNodes).indexOf(marker)));
  } else {
    range.setStartBefore(marker);
  }
  range.collapse(true);
  marker.remove();
  selection.removeAllRanges();
  selection.addRange(range);
}

function normalizeInlineLeavesForMarkupSignature(leaves: InlineLeaf[], trimTrailingWhitespace: boolean) {
  const mergedLeaves = normalizeInlineLeavesForSerialization(leaves);
  // Whitespace just before a line break never renders, so it is not structure either.
  for (let index = mergedLeaves.length - 2; index >= 0; index -= 1) {
    const leaf = mergedLeaves[index]!;
    if (leaf.type === "text" && mergedLeaves[index + 1]!.type === "break") {
      leaf.text = leaf.text.replace(/[ \t ]+$/g, "");
      if (!leaf.text) {
        mergedLeaves.splice(index, 1);
      }
    }
  }

  let leadingBreakCount = 0;
  while (mergedLeaves[0]?.type === "break") {
    mergedLeaves.shift();
    leadingBreakCount += 1;
  }

  let trailingBreakCount = 0;
  while (mergedLeaves.at(-1)?.type === "break") {
    mergedLeaves.pop();
    trailingBreakCount += 1;
  }

  if (trimTrailingWhitespace) {
    // Block-edge whitespace is invisible and markdown drops it from headings and list items, so it is not structure.
    const firstLeaf = mergedLeaves[0];
    if (firstLeaf?.type === "text") {
      firstLeaf.text = firstLeaf.text.replace(/^[ \t ]+/g, "");
      if (!firstLeaf.text) mergedLeaves.shift();
    }

    const lastLeaf = mergedLeaves.at(-1);
    if (lastLeaf?.type === "text") {
      lastLeaf.text = lastLeaf.text.replace(/[ \t ]+$/g, "");
      if (!lastLeaf.text) mergedLeaves.pop();
    }
  }

  return { leaves: mergedLeaves, leadingBreakCount, trailingBreakCount };
}

function wrapMarkupSignatureContent(content: string, mark: InlineMark) {
  if (!content) {
    return "";
  }

  if (mark.tag === "a") {
    const href = mark.href ? ` href=${JSON.stringify(mark.href)}` : "";
    return `<a${href}>${content}</a>`;
  }

  if (mark.tag === "u") {
    return `<u ${MARK_TAG_ATTRIBUTE}=${JSON.stringify(mark.name)}>${content}</u>`;
  }

  return `<${mark.tag}>${content}</${mark.tag}>`;
}

/** Thread atoms compare by their notes; where markdown places them among marks is not structure. */
export function serializeCommentThreadForMarkupSignature(element: HTMLElement) {
  const comments = readThreadComments(element).map(({ author, body }) => ({ author, body }));
  return `<thread ${JSON.stringify(comments)}>`;
}

function serializeInlineLeafForMarkupSignature(leaf: InlineLeaf) {
  if (leaf.type === "marker") {
    return "";
  }

  if (leaf.type === "atom") {
    return serializeCommentThreadForMarkupSignature(leaf.element);
  }

  let content = leaf.type === "break"
    ? "<br>"
    : `text(${JSON.stringify(leaf.text.replaceAll(" ", " "))})`;

  for (let index = leaf.marks.length - 1; index >= 0; index -= 1) {
    content = wrapMarkupSignatureContent(content, leaf.marks[index]!);
  }

  return content;
}

export function serializeInlineRunContainerForMarkupSignature(element: HTMLElement, trimTrailingWhitespace: boolean) {
  const normalized = normalizeInlineLeavesForMarkupSignature(flattenInlineContent(element.childNodes), trimTrailingWhitespace);

  return {
    leadingBreakCount: normalized.leadingBreakCount,
    content: normalized.leaves.map(serializeInlineLeafForMarkupSignature).filter(Boolean).join(""),
    trailingBreakCount: normalized.trailingBreakCount,
  };
}
