/*
 * Exports:
 * - StructuredBlockStyleSyncOptions: injected inline cleanup hooks used when synchronizing structured block DOM. Keywords: workbench, block dom, list, comment, sync.
 * - getDirectChildSummaryTextElement: find the direct summary text wrapper inside a structured list-item summary. Keywords: workbench, list, summary, dom.
 * - ensureSummaryTextWrapper: create or return the direct summary text wrapper used for list-item summaries. Keywords: workbench, list, summary, wrapper.
 * - trimBoundaryBreaks: remove redundant leading and trailing BR nodes around otherwise meaningful block content. Keywords: workbench, block dom, br, cleanup.
 * - normalizeSummaryListArtifacts: lift stray list structures out of summary text into the owning details block. Keywords: workbench, list, summary, normalize.
 * - normalizeCommentBlockElement: canonicalize block comment markers on paragraph-like elements. Keywords: workbench, comment block, normalize, paragraph.
 * - removeAdjacentCommentSpacing: strip neighboring empty spacing nodes around a comment block paragraph. Keywords: workbench, comment block, spacing, cleanup.
 * - convertCommentBlockToParagraph: turn a block comment element back into a normal paragraph while preserving text. Keywords: workbench, comment block, paragraph, convert.
 * - normalizeListItemHierarchy: normalize a single list item into the details-plus-summary structured nesting form when needed. Keywords: workbench, list, hierarchy, details.
 * - normalizeNestedListHierarchy: normalize all list items under a root into structured nesting form. Keywords: workbench, list, hierarchy, normalize.
 * - mergeAdjacentSiblingLists: merge compatible sibling lists separated only by empty spacer nodes. Keywords: workbench, list, merge, cleanup.
 * - syncStructuredBlockStyles: run structured block normalization plus optional injected inline cleanup callbacks. Keywords: workbench, block dom, comment block, list, sync.
 * - isBlockLikeChildElement: detect child elements that force a container to behave as block content. Keywords: workbench, block dom, predicate, inline container.
 * - hasDirectBlockLikeChildren: detect whether a container contains direct block-like children. Keywords: workbench, block dom, predicate, container.
 */

import { parseBlockCommentBody } from "./comment-markdown";
import {
    getDirectChildDetailsElement,
    getDirectChildListElements,
    getDirectChildSummaryElement,
    isIntentionalListBreakParagraph,
    isListElement,
    isSingleBreakParagraph,
} from "./list-dom";
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

function setPlainBlockText(element: HTMLElement, text: string) {
  element.replaceChildren();
  if (text) {
    element.append(document.createTextNode(text));
    return;
  }

  element.append(document.createElement("br"));
}

export function normalizeCommentBlockElement(element: HTMLElement) {
  const parsedCommentBody = parseBlockCommentBody(element.textContent ?? "");
  if (parsedCommentBody !== null) {
    element.dataset.blockComment = "true";
    setPlainBlockText(element, parsedCommentBody);
    return;
  }

  if (element.dataset.blockComment === "true") {
    const textContent = element.textContent ?? "";
    if (!textContent.replaceAll("\u00a0", "").length) {
      setPlainBlockText(element, "");
    }
    return;
  }

  element.removeAttribute("data-block-comment");
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

function getNextMeaningfulSibling(node: ChildNode | null) {
  let current = node;

  while (current?.nodeType === Node.TEXT_NODE && !(current.textContent ?? "").trim()) {
    const nextSibling = current.nextSibling;
    current.remove();
    current = nextSibling;
  }

  return current;
}

export function mergeAdjacentSiblingLists(root: ParentNode) {
  const childElements = root instanceof Element || root instanceof DocumentFragment
    ? Array.from(root.children)
    : [];

  for (const childElement of childElements) {
    mergeAdjacentSiblingLists(childElement);
  }

  let current = getNextMeaningfulSibling(root.firstChild);

  while (current) {
    if (!isMergeableListElement(current)) {
      current = getNextMeaningfulSibling(current.nextSibling);
      continue;
    }

    const separator = getNextMeaningfulSibling(current.nextSibling);
    const nextList = isListMergeSeparatorNode(separator)
      ? getNextMeaningfulSibling(separator.nextSibling)
      : separator;

    if (isMergeableListElement(nextList) && nextList.tagName === current.tagName) {
      while (nextList.firstChild) {
        current.append(nextList.firstChild);
      }

      nextList.remove();
      if (separator && isListMergeSeparatorNode(separator)) {
        separator.remove();
      }
      continue;
    }

    current = getNextMeaningfulSibling(current.nextSibling);
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

export function syncStructuredBlockStyles(
  root: ParentNode,
  options: StructuredBlockStyleSyncOptions = {},
) {
  normalizeNestedListHierarchy(root);
  mergeAdjacentSiblingLists(root);
  options.canonicalizeInlineRunContainers?.(root);
  options.removeEmptyInlineFormattingArtifacts?.(root);

  for (const element of getStructuredBlockCandidates(root)) {
    if (!(element instanceof HTMLElement)) {
      continue;
    }

    const isCommentCandidate = /^(p|div)$/i.test(element.tagName);
    if (!isCommentCandidate) {
      element.removeAttribute("data-block-comment");
      element.removeAttribute("data-single-break");
      continue;
    }

    if (isSingleBreakParagraph(element)) {
      element.dataset.singleBreak = "true";
    } else {
      element.removeAttribute("data-single-break");
    }

    normalizeCommentBlockElement(element);
  }
}

export function removeAdjacentCommentSpacing(element: HTMLElement) {
  let previousNode = element.previousSibling;
  while (previousNode) {
    const nextPreviousNode = previousNode.previousSibling;
    if (previousNode.nodeType === Node.TEXT_NODE && !(previousNode.textContent ?? "").trim()) {
      previousNode.remove();
      previousNode = nextPreviousNode;
      continue;
    }

    if (
      previousNode instanceof HTMLBRElement
      || (previousNode instanceof HTMLElement && isSingleBreakParagraph(previousNode))
    ) {
      previousNode.remove();
      previousNode = nextPreviousNode;
      continue;
    }

    break;
  }

  let nextNode = element.nextSibling;
  while (nextNode) {
    const nextNextNode = nextNode.nextSibling;
    if (nextNode.nodeType === Node.TEXT_NODE && !(nextNode.textContent ?? "").trim()) {
      nextNode.remove();
      nextNode = nextNextNode;
      continue;
    }

    if (
      nextNode instanceof HTMLBRElement
      || (nextNode instanceof HTMLElement && isSingleBreakParagraph(nextNode))
    ) {
      nextNode.remove();
      nextNode = nextNextNode;
      continue;
    }

    break;
  }
}

export function convertCommentBlockToParagraph(paragraph: HTMLElement) {
  const commentBody = parseBlockCommentBody(paragraph.textContent ?? "") ?? (paragraph.textContent ?? "");
  paragraph.removeAttribute("data-block-comment");
  setPlainBlockText(paragraph, commentBody);
  removeAdjacentCommentSpacing(paragraph);
}

export function isBlockLikeChildElement(element: HTMLElement) {
  if (element.dataset.summaryText === "true") {
    return false;
  }

  if (/^(ul|ol|li|details|summary|pre|hr)$/i.test(element.tagName)) {
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