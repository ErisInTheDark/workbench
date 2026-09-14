/*
 * Exports:
 * - RichInputBlockNormalizationResult: summary of rule-owned rich-input block repairs. Keywords: workbench, rich input, markdown, paste, normalize.
 * - normalizeRichInputBlocksOutsideSelection: apply hard-rule markdown block normalizers to non-selected rich editor blocks. Keywords: workbench, rich input, markdown, paste, selection, normalize.
 */

import {
    ensureListItemHasEditableContent,
    ensureParagraphHasEditableContent,
} from "../dom/mutation/rich-input-dom";
import {
    isIntentionalListBreakParagraph,
    isSingleBreakParagraph,
} from "../dom/query/list-dom";
import {
    deleteLeadingTextFromElement,
} from "../dom/query/text-position-dom";

export interface RichInputBlockNormalizationResult {
  normalizedBlockCount: number;
}

type BlockNormalizationScope = "root" | "list";

interface BlockNormalizationCandidate {
  element: HTMLElement;
  scope: BlockNormalizationScope;
}

type BlockNormalizer = (candidate: BlockNormalizationCandidate) => boolean;

function isRootBlockCandidate(element: Element): element is HTMLElement {
  return element instanceof HTMLElement
    && /^(p|div|h1|h2|h3|h4|h5|h6|blockquote)$/i.test(element.tagName);
}

function isNestedListCodeCandidate(element: Element, editor: HTMLElement): element is HTMLElement {
  return element instanceof HTMLElement
    && /^(p|div)$/i.test(element.tagName)
    && Boolean(element.closest("li"))
    && editor.contains(element.closest("li"));
}

function readPlainBlockText(element: HTMLElement) {
  let text = "";

  function appendNodeText(node: Node) {
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent ?? "";
      return;
    }

    if (node instanceof HTMLBRElement) {
      text += "\n";
      return;
    }

    for (const child of Array.from(node.childNodes)) {
      appendNodeText(child);
    }
  }

  appendNodeText(element);
  return text.replaceAll("\u00a0", " ");
}

function isSelectionOccupiedBlock(element: HTMLElement, selectionRange: Range | null) {
  if (!selectionRange) {
    return false;
  }

  try {
    return selectionRange.intersectsNode(element);
  } catch {
    return true;
  }
}

function isSingleBreakBlock(element: HTMLElement) {
  return isSingleBreakParagraph(element);
}

function isIntentionalListBreakBlock(element: HTMLElement) {
  return isIntentionalListBreakParagraph(element);
}

function collectNormalizationCandidates(editor: HTMLElement, selectionRange: Range | null) {
  const candidates: BlockNormalizationCandidate[] = [];
  const seen = new Set<HTMLElement>();

  for (const child of Array.from(editor.children)) {
    if (!isRootBlockCandidate(child)) {
      continue;
    }

    const element = child;
    const isUnavailableBlock = isSelectionOccupiedBlock(element, selectionRange)
      || isSingleBreakBlock(element)
      || isIntentionalListBreakBlock(element)
      || element.dataset.blockComment === "true";
    if (
      isUnavailableBlock
    ) {
      continue;
    }

    candidates.push({ element, scope: "root" });
    seen.add(element);
  }

  for (const child of Array.from(editor.querySelectorAll("li p, li div"))) {
    if (!isNestedListCodeCandidate(child, editor)) {
      continue;
    }

    const element = child;
    const isUnavailableBlock = seen.has(element)
      || isSelectionOccupiedBlock(element, selectionRange)
      || isSingleBreakBlock(element)
      || isIntentionalListBreakBlock(element)
      || element.dataset.blockComment === "true"
      || element.closest("blockquote, pre");
    if (
      isUnavailableBlock
    ) {
      continue;
    }

    candidates.push({ element, scope: "list" });
    seen.add(element);
  }

  return candidates;
}

function replaceWithPlainTextElement(source: HTMLElement, tagName: keyof HTMLElementTagNameMap, text: string) {
  const replacement = source.ownerDocument.createElement(tagName);
  if (text) {
    replacement.textContent = text;
  } else {
    replacement.append(source.ownerDocument.createElement("br"));
  }
  source.replaceWith(replacement);
  return replacement;
}

function normalizeQuoteBlock({ element, scope }: BlockNormalizationCandidate) {
  if (scope !== "root" || element.tagName === "BLOCKQUOTE") {
    return false;
  }

  const text = readPlainBlockText(element);
  if (!/^>\s?/.test(text)) {
    return false;
  }

  const quoteText = text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/^>\s?/, ""))
    .join("\n");
  replaceWithPlainTextElement(element, "blockquote", quoteText);
  return true;
}

function parseFence(text: string) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const opener = lines[0]?.match(/^( {0,3})(`{3,}|~{3,})(.*)$/);
  if (!opener) {
    return null;
  }

  const fenceMarker = opener[2];
  const fenceCharacter = fenceMarker[0];
  const fenceLength = fenceMarker.length;
  const closePattern = new RegExp(`^ {0,3}${fenceCharacter}{${fenceLength},}\\s*$`);
  const closingIndex = lines.findIndex((line, index) => index > 0 && closePattern.test(line));
  if (closingIndex === -1) {
    return null;
  }

  const trailingLines = lines.slice(closingIndex + 1);
  if (trailingLines.some((line) => line.trim())) {
    return null;
  }

  return {
    code: lines.slice(1, closingIndex).join("\n"),
    language: opener[3].trim().toLowerCase(),
  };
}

function normalizeFencedCodeBlock({ element }: BlockNormalizationCandidate) {
  const parsedFence = parseFence(readPlainBlockText(element));
  if (!parsedFence) {
    return false;
  }

  const pre = element.ownerDocument.createElement("pre");
  if (parsedFence.language) {
    pre.dataset.language = parsedFence.language;
  }

  const code = element.ownerDocument.createElement("code");
  code.textContent = parsedFence.code;
  pre.append(code);
  element.replaceWith(pre);
  return true;
}

function normalizeHorizontalRuleBlock({ element, scope }: BlockNormalizationCandidate) {
  if (scope !== "root") {
    return false;
  }

  const text = readPlainBlockText(element);
  if (!/^ {0,3}([-*_])(?:\s*\1){2,}\s*$/.test(text)) {
    return false;
  }

  element.replaceWith(element.ownerDocument.createElement("hr"));
  return true;
}

function insertListItemAtBlockPosition(block: HTMLElement, item: HTMLLIElement, listTagName: "ol" | "ul") {
  const previousList = block.previousElementSibling?.tagName.toLowerCase() === listTagName
    ? block.previousElementSibling as HTMLOListElement | HTMLUListElement
    : null;
  const nextList = block.nextElementSibling?.tagName.toLowerCase() === listTagName
    ? block.nextElementSibling as HTMLOListElement | HTMLUListElement
    : null;

  if (previousList) {
    previousList.append(item);
    block.remove();

    if (nextList) {
      while (nextList.firstChild) {
        previousList.append(nextList.firstChild);
      }
      nextList.remove();
    }
    return;
  }

  if (nextList) {
    nextList.prepend(item);
    block.remove();
    return;
  }

  const list = block.ownerDocument.createElement(listTagName);
  list.append(item);
  block.replaceWith(list);
}

function normalizeListItemBlock({ element, scope }: BlockNormalizationCandidate) {
  if (scope !== "root" || !/^(p|div)$/i.test(element.tagName)) {
    return false;
  }

  const match = readPlainBlockText(element).match(/^([-*+]|\d+[.)])\s+/);
  if (!match) {
    return false;
  }

  if (!deleteLeadingTextFromElement(element, match[0].length)) {
    return false;
  }

  const item = element.ownerDocument.createElement("li");
  while (element.firstChild) {
    item.append(element.firstChild);
  }

  item.normalize();
  ensureListItemHasEditableContent(item);
  insertListItemAtBlockPosition(element, item, /^\d+[.)]$/.test(match[1]) ? "ol" : "ul");
  return true;
}

function normalizeHeadingBlock({ element, scope }: BlockNormalizationCandidate) {
  if (scope !== "root" || element.tagName === "BLOCKQUOTE") {
    return false;
  }

  const match = readPlainBlockText(element).match(/^(#{1,6})[ \t]+/);
  if (!match) {
    return false;
  }

  if (!deleteLeadingTextFromElement(element, match[0].length)) {
    return false;
  }

  const heading = element.ownerDocument.createElement(`h${match[1].length}`) as HTMLHeadingElement;
  while (element.firstChild) {
    heading.append(element.firstChild);
  }

  heading.normalize();
  ensureParagraphHasEditableContent(heading);
  element.replaceWith(heading);
  return true;
}

const BLOCK_NORMALIZERS: readonly BlockNormalizer[] = [
  normalizeQuoteBlock,
  normalizeFencedCodeBlock,
  normalizeHorizontalRuleBlock,
  normalizeListItemBlock,
  normalizeHeadingBlock,
];

export function normalizeRichInputBlocksOutsideSelection(editor: HTMLElement): RichInputBlockNormalizationResult {
  const selection = window.getSelection();
  const selectionRange = selection?.rangeCount && editor.contains(selection.anchorNode) && editor.contains(selection.focusNode)
    ? selection.getRangeAt(0)
    : null;
  let normalizedBlockCount = 0;

  for (const candidate of collectNormalizationCandidates(editor, selectionRange)) {
    if (!candidate.element.isConnected) {
      continue;
    }

    for (const normalizeBlock of BLOCK_NORMALIZERS) {
      if (normalizeBlock(candidate)) {
        normalizedBlockCount += 1;
        break;
      }
    }
  }

  return { normalizedBlockCount };
}
