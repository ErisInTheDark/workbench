/*
 * Exports:
 * - StructuredBlockStyleSyncOptions: injected inline cleanup hooks used when synchronizing structured block DOM. Keywords: workbench, block dom, list, comment, sync.
 * - getDirectChildSummaryTextElement: find the direct summary text wrapper inside a structured list-item summary. Keywords: workbench, list, summary, dom.
 * - ensureSummaryTextWrapper: create or return the direct summary text wrapper used for list-item summaries. Keywords: workbench, list, summary, wrapper.
 * - trimBoundaryBreaks: remove redundant leading and trailing BR nodes around otherwise meaningful block content. Keywords: workbench, block dom, br, cleanup.
 * - normalizeSummaryListArtifacts: lift stray list structures out of summary text into the owning details block. Keywords: workbench, list, summary, normalize.
 * - normalizeListItemHierarchy: normalize a single list item into the details-plus-summary structured nesting form when needed. Keywords: workbench, list, hierarchy, details.
 * - normalizeNestedListHierarchy: normalize all list items under a root into structured nesting form. Keywords: workbench, list, hierarchy, normalize.
 * - mergeAdjacentSiblingLists: merge compatible sibling lists separated only by empty spacer nodes. Keywords: workbench, list, merge, cleanup.
 * - normalizeDivBlocks: unwrap block-holding divs and turn inline-only divs into paragraphs, since markdown has no div. Keywords: workbench, div, paste, normalize.
 * - normalizeRootInlineBlocks: wrap direct root inline content into stable paragraph blocks for markdown round-trip comparison. Keywords: workbench, editor, root, inline, paragraph, save guard.
 * - syncStructuredBlockStyles: run structured block normalization plus optional injected inline cleanup callbacks; root paragraphs holding only comment threads become block threads and code blocks keep their line sentinel. Keywords: workbench, block dom, list, sync.
 * - isBlockLikeChildElement: detect child elements that force a container to behave as block content, block comment threads included. Keywords: workbench, block dom, predicate, inline container.
 * - hasDirectBlockLikeChildren: detect whether a container contains direct block-like children. Keywords: workbench, block dom, predicate, container.
 */

import {
    createCommentThreadElement,
    getCommentThreadKind,
    inheritSuggestionMembership,
    isCommentThreadElement,
    readThreadComments,
} from "../../markdown/review-markup";
import {
    getDirectChildDetailsElement,
    getDirectChildListElements,
    getDirectChildSummaryElement,
    isIntentionalListBreakParagraph,
    isListElement,
    isSingleBreakParagraph,
} from "../query/list-dom";
import { ensureCodeBlockSentinels } from "./code-block-dom";
import { getOrCreateDirectChildList } from "./list-item-dom-edit";

export interface StructuredBlockStyleSyncOptions {
  canonicalizeInlineRunContainers?: (root: ParentNode) => void;
  removeEmptyInlineFormattingArtifacts?: (root: ParentNode) => void;
}

export function getDirectChildSummaryTextElement(element: Element) {
  return Array.from(element.children).find((child): child is HTMLElement => child instanceof HTMLElement && child.dataset.summaryText === "true") ?? null;
}

export function ensureSummaryTextWrapper(summary: HTMLElement) {
  const existingWrapper = getDirectChildSummaryTextElement(summary);
  if (existingWrapper) {
    return existingWrapper;
  }

  const wrapper = document.createElement("span");
  wrapper.dataset.summaryText = "true";

  while (summary.firstChild) {
    wrapper.append(summary.firstChild);
  }

  if (!wrapper.childNodes.length) {
    wrapper.append(document.createElement("br"));
  }

  summary.append(wrapper);
  return wrapper;
}

export function trimBoundaryBreaks(container: HTMLElement) {
  const hasMeaningfulContent = Array.from(container.childNodes).some((node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      return Boolean((node.textContent ?? "").trim());
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
      return false;
    }

    return (node as Element).tagName !== "BR";
  });

  if (!hasMeaningfulContent) {
    return;
  }

  let firstMeaningfulNode = container.firstChild;
  while (
    firstMeaningfulNode?.nodeType === Node.TEXT_NODE
    && !(firstMeaningfulNode.textContent ?? "").trim()
  ) {
    firstMeaningfulNode = firstMeaningfulNode.nextSibling;
  }
  while (firstMeaningfulNode instanceof HTMLBRElement) {
    const nextNode = firstMeaningfulNode.nextSibling;
    firstMeaningfulNode.remove();
    firstMeaningfulNode = nextNode;
    while (
      firstMeaningfulNode?.nodeType === Node.TEXT_NODE
      && !(firstMeaningfulNode.textContent ?? "").trim()
    ) {
      firstMeaningfulNode = firstMeaningfulNode.nextSibling;
    }
  }

  let lastMeaningfulNode = container.lastChild;
  while (
    lastMeaningfulNode?.nodeType === Node.TEXT_NODE
    && !(lastMeaningfulNode.textContent ?? "").trim()
  ) {
    lastMeaningfulNode = lastMeaningfulNode.previousSibling;
  }
  while (lastMeaningfulNode instanceof HTMLBRElement) {
    const previousNode = lastMeaningfulNode.previousSibling;
    lastMeaningfulNode.remove();
    lastMeaningfulNode = previousNode;
    while (
      lastMeaningfulNode?.nodeType === Node.TEXT_NODE
      && !(lastMeaningfulNode.textContent ?? "").trim()
    ) {
      lastMeaningfulNode = lastMeaningfulNode.previousSibling;
    }
  }
}

function hasMeaningfulListItemContent(item: HTMLLIElement) {
  return (item.textContent ?? "").replaceAll("\u00a0", "").length > 0
    || item.querySelector("br, details, ul, ol, pre, blockquote, hr") !== null;
}

export function normalizeSummaryListArtifacts(details: HTMLDetailsElement, summaryText: HTMLElement) {
  const embeddedLists = Array.from(summaryText.querySelectorAll("ul, ol")).filter((list) => {
    const ancestorList = list.parentElement?.closest("ul, ol");
    return !ancestorList || !summaryText.contains(ancestorList);
  });

  for (const list of embeddedLists) {
    details.append(list);
  }

  const strayListItems = Array.from(summaryText.querySelectorAll("li")).filter((item) => !item.closest("ul, ol"));
  if (!strayListItems.length) {
    return;
  }

  const meaningfulItems = strayListItems.filter(hasMeaningfulListItemContent);
  for (const item of strayListItems) {
    if (!hasMeaningfulListItemContent(item)) {
      item.remove();
    }
  }

  if (!meaningfulItems.length) {
    return;
  }

  const targetList = getOrCreateDirectChildList(details, "UL");
  const insertionPoint = targetList.firstChild;
  for (const item of meaningfulItems) {
    targetList.insertBefore(item, insertionPoint);
  }
}

export function normalizeListItemHierarchy(item: HTMLLIElement) {
  const details = getDirectChildDetailsElement(item);
  const directLists = getDirectChildListElements(item);

  if (!details && !directLists.length) {
    return;
  }

  if (!details) {
    const nextDetails = document.createElement("details");
    nextDetails.open = true;
    const summary = document.createElement("summary");
    const summaryText = ensureSummaryTextWrapper(summary);
    const summaryNodes = Array.from(item.childNodes).filter((node) => {
      return !(node instanceof Element && directLists.some((list) => list === node));
    });

    for (const node of summaryNodes) {
      summaryText.append(node);
    }
    normalizeSummaryListArtifacts(nextDetails, summaryText);
    trimBoundaryBreaks(summaryText);

    if (!summaryText.childNodes.length) {
      summaryText.append(document.createElement("br"));
    }

    nextDetails.append(summary);
    for (const list of directLists) {
      nextDetails.append(list);
    }
    item.append(nextDetails);
    return;
  }

  const summary = getDirectChildSummaryElement(details) ?? document.createElement("summary");
  if (summary.parentElement !== details) {
    details.prepend(summary);
  }
  const summaryText = ensureSummaryTextWrapper(summary);

  const externalNodes = Array.from(item.childNodes).filter((node) => node !== details);
  for (const node of externalNodes) {
    summaryText.append(node);
  }

  const strayDetailNodes = Array.from(details.childNodes).filter((node) => {
    if (node === summary) {
      return false;
    }

    return !(node instanceof Element && isListElement(node));
  });
  for (const node of strayDetailNodes) {
    summaryText.append(node);
  }
  normalizeSummaryListArtifacts(details, summaryText);
  trimBoundaryBreaks(summaryText);

  const nestedLists = getDirectChildListElements(details);
  if (!nestedLists.length) {
    while (summaryText.firstChild) {
      item.insertBefore(summaryText.firstChild, details);
    }
    details.remove();
    if (!item.childNodes.length) {
      item.append(document.createElement("br"));
    }
    return;
  }

  if (!summaryText.childNodes.length) {
    summaryText.append(document.createElement("br"));
  }
}

export function normalizeNestedListHierarchy(root: ParentNode) {
  const listItems = root instanceof HTMLLIElement
    ? [root]
    : Array.from(root.querySelectorAll("li"));

  for (const item of listItems) {
    if (item instanceof HTMLLIElement) {
      normalizeListItemHierarchy(item);
    }
  }
}

function isMergeableListElement(node: Node | null): node is HTMLUListElement | HTMLOListElement {
  return node instanceof HTMLUListElement || node instanceof HTMLOListElement;
}

function isListMergeSeparatorNode(node: Node | null) {
  if (!node) {
    return false;
  }

  if (node instanceof HTMLBRElement) {
    return true;
  }

  return node instanceof HTMLElement
    && isSingleBreakParagraph(node)
    && !isIntentionalListBreakParagraph(node);
}

/** Containers whose direct children can be lists; inline content is never walked, so its spaces stay put. */
const LIST_HOLDER_TAGS = /^(DIV|UL|OL|LI|DETAILS|BLOCKQUOTE)$/;

function skipWhitespaceText(node: ChildNode | null) {
  let current = node;
  while (current?.nodeType === Node.TEXT_NODE && !(current.textContent ?? "").trim()) {
    current = current.nextSibling;
  }

  return current;
}

export function mergeAdjacentSiblingLists(root: ParentNode) {
  for (const childElement of Array.from(root.children)) {
    if (LIST_HOLDER_TAGS.test(childElement.tagName)) {
      mergeAdjacentSiblingLists(childElement);
    }
  }

  let current = skipWhitespaceText(root.firstChild);

  while (current) {
    if (!isMergeableListElement(current)) {
      current = skipWhitespaceText(current.nextSibling);
      continue;
    }

    const separator = skipWhitespaceText(current.nextSibling);
    const nextList = isListMergeSeparatorNode(separator)
      ? skipWhitespaceText(separator?.nextSibling ?? null)
      : separator;

    if (isMergeableListElement(nextList) && nextList.tagName === current.tagName) {
      while (current.nextSibling && current.nextSibling !== nextList) {
        current.nextSibling.remove();
      }
      while (nextList.firstChild) {
        current.append(nextList.firstChild);
      }

      nextList.remove();
      continue;
    }

    current = skipWhitespaceText(current.nextSibling);
  }
}

function getStructuredBlockCandidates(root: ParentNode) {
  if (root instanceof HTMLParagraphElement) {
    return [root];
  }

  if (root instanceof HTMLDivElement) {
    return Array.from(root.children);
  }

  if (!("querySelectorAll" in root)) {
    return [];
  }

  return Array.from(root.querySelectorAll("p, div"));
}

function isRootBreakNode(node: Node | null) {
  return node instanceof HTMLBRElement
    || (
      node instanceof HTMLElement
      && isSingleBreakParagraph(node)
      && !isIntentionalListBreakParagraph(node)
    );
}

function isRootBlockBoundaryNode(node: Node) {
  if (isRootBreakNode(node)) {
    return true;
  }

  return node instanceof HTMLElement && isBlockLikeChildElement(node);
}

function isSerializableRootInlineNode(node: Node) {
  if (node.nodeType === Node.TEXT_NODE) {
    return Boolean((node.textContent ?? "").trim());
  }

  if (!(node instanceof HTMLElement)) {
    return false;
  }

  return Boolean((node.textContent ?? "").trim() || node.querySelector("br, [data-comment-thread]") || isCommentThreadElement(node));
}

function isIgnorableRootWhitespaceNode(node: Node) {
  return node.nodeType === Node.TEXT_NODE && !(node.textContent ?? "").trim();
}

function getFirstRootContentNode(root: ParentNode) {
  let node = root.firstChild;
  while (node && (isIgnorableRootWhitespaceNode(node) || isRootBreakNode(node))) {
    node = node.nextSibling;
  }

  return node;
}

function getLastRootContentNode(root: ParentNode) {
  let node = root.lastChild;
  while (node && (isIgnorableRootWhitespaceNode(node) || isRootBreakNode(node))) {
    node = node.previousSibling;
  }

  return node;
}

/** Blank lines around comment lines are kept by markdown, so they stay at the document edges too. */
function isBlockCommentNode(node: Node | null) {
  return isCommentThreadElement(node);
}

function isRemovableRootEdgeNode(node: Node | null) {
  return isRootBreakNode(node) || (node !== null && isIgnorableRootWhitespaceNode(node));
}

function removeRootWhitespaceTextNodes(root: ParentNode) {
  for (const child of Array.from(root.childNodes)) {
    if (isIgnorableRootWhitespaceNode(child)) {
      child.remove();
    }
  }
}

function trimRootBreaksDroppedByMarkdown(root: ParentNode) {
  removeRootWhitespaceTextNodes(root);

  if (!isBlockCommentNode(getFirstRootContentNode(root))) {
    while (isRemovableRootEdgeNode(root.firstChild)) {
      root.firstChild?.remove();
    }
  }

  if (!isBlockCommentNode(getLastRootContentNode(root))) {
    while (isRemovableRootEdgeNode(root.lastChild)) {
      root.lastChild?.remove();
    }
  }
}

/** Markdown has no div: wrappers holding blocks are unwrapped and inline-only divs become paragraphs, deepest first. */
export function normalizeDivBlocks(root: ParentNode) {
  for (const div of Array.from(root.querySelectorAll("div")).reverse()) {
    if (!(div instanceof HTMLDivElement) || !div.parentNode) {
      continue;
    }

    if (hasDirectBlockLikeChildren(div)) {
      div.replaceWith(...Array.from(div.childNodes));
      continue;
    }

    const paragraph = div.ownerDocument.createElement("p");
    for (const attribute of div.getAttributeNames()) {
      paragraph.setAttribute(attribute, div.getAttribute(attribute) ?? "");
    }
    paragraph.append(...Array.from(div.childNodes));
    div.replaceWith(paragraph);
  }
}

export function normalizeRootInlineBlocks(root: ParentNode) {
  if (!(root instanceof HTMLElement || root instanceof DocumentFragment)) {
    return;
  }

  if (root instanceof HTMLElement && root.tagName !== "DIV") {
    return;
  }

  const ownerDocument = root instanceof Node ? root.ownerDocument : document;
  let inlineNodes: Node[] = [];

  function flushInlineNodes(beforeNode: Node | null) {
    if (!inlineNodes.length) {
      return;
    }

    const hasSerializableContent = inlineNodes.some(isSerializableRootInlineNode);
    if (!hasSerializableContent) {
      for (const node of inlineNodes) {
        node.parentNode?.removeChild(node);
      }
      inlineNodes = [];
      return;
    }

    const paragraph = ownerDocument.createElement("p");
    for (const node of inlineNodes) {
      if (isIgnorableRootWhitespaceNode(node)) {
        node.parentNode?.removeChild(node);
        continue;
      }

      paragraph.append(node);
    }
    root.insertBefore(paragraph, beforeNode);
    inlineNodes = [];
  }

  for (const child of Array.from(root.childNodes)) {
    if (isRootBlockBoundaryNode(child)) {
      flushInlineNodes(child);
      continue;
    }

    inlineNodes.push(child);
  }

  flushInlineNodes(null);
  trimRootBreaksDroppedByMarkdown(root);
}

/** Markdown can only write a block holding nothing but comments as comment lines, so such a block becomes a block thread. */
function convertCommentOnlyBlocks(root: ParentNode) {
  for (const block of Array.from(root.children)) {
    if (!(block instanceof HTMLParagraphElement) || (block.textContent ?? "").replaceAll(" ", "").trim()) {
      continue;
    }

    const threads = Array.from(block.querySelectorAll<HTMLElement>("[data-comment-thread]"));
    if (!threads.length || block.querySelector("hr, img")) {
      continue;
    }

    const thread = createCommentThreadElement(block.ownerDocument, "block", threads.flatMap(readThreadComments));
    inheritSuggestionMembership(block, thread);
    block.replaceWith(thread);
  }
}

export function syncStructuredBlockStyles(
  root: ParentNode,
  options: StructuredBlockStyleSyncOptions = {},
) {
  convertCommentOnlyBlocks(root);
  ensureCodeBlockSentinels(root);
  normalizeNestedListHierarchy(root);
  mergeAdjacentSiblingLists(root);
  options.canonicalizeInlineRunContainers?.(root);
  options.removeEmptyInlineFormattingArtifacts?.(root);

  for (const element of getStructuredBlockCandidates(root)) {
    if (!(element instanceof HTMLElement)) {
      continue;
    }

    if (/^(p|div)$/i.test(element.tagName) && isSingleBreakParagraph(element)) {
      element.dataset.singleBreak = "true";
    } else {
      element.removeAttribute("data-single-break");
    }
  }
}

export function isBlockLikeChildElement(element: HTMLElement) {
  if (element.dataset.summaryText === "true") {
    return false;
  }

  if (isCommentThreadElement(element) && getCommentThreadKind(element) === "block") {
    return true;
  }

  if (/^(ul|ol|li|details|summary|pre|hr|table)$/i.test(element.tagName)) {
    return true;
  }

  if (/^(p|div|h1|h2|h3|h4|h5|h6|blockquote)$/i.test(element.tagName)) {
    return true;
  }

  return false;
}

export function hasDirectBlockLikeChildren(element: HTMLElement) {
  return Array.from(element.children).some((child) => child instanceof HTMLElement && isBlockLikeChildElement(child));
}
