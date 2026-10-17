/*
 * Exports:
 * - BlockFormatTag: root block tags the toolbar applies.
 * - ListFormatTag: list types the toolbar toggles.
 * - ListFormatDependencies: list-item helpers the list toggle reuses from the list editor.
 * - toggleRootBlockTag: switch the root blocks a range touches to a block tag, or back to paragraphs when all already use it.
 * - toggleRootBlockList: wrap touched root blocks in a list, retag touched lists to the requested type, or unwrap their items.
 */
import { inheritSuggestionMembership } from "../../markdown/review-markup";
import { isListElement } from "../query/list-dom";

export type BlockFormatTag = "h1" | "h2" | "h3" | "blockquote";
export type ListFormatTag = "ul" | "ol";

export interface ListFormatDependencies {
  getSelectedListItems: (selection: Selection) => HTMLLIElement[];
  isTopLevelListItem: (item: HTMLLIElement) => boolean;
  unwrapTopLevelListItemToParagraph: (item: HTMLLIElement) => HTMLElement | null;
}

const TEXT_BLOCK_TAGS = /^(P|DIV|H[1-6]|BLOCKQUOTE)$/;

function getTouchedRootChildren(root: HTMLElement, range: Range) {
  return Array.from(root.children).filter((child): child is HTMLElement => {
    return child instanceof HTMLElement && (child.contains(range.startContainer) || range.intersectsNode(child));
  });
}

function isTextBlock(element: HTMLElement) {
  return TEXT_BLOCK_TAGS.test(element.tagName);
}

/** Move an element's children into a fresh element of another tag; moved text nodes keep any saved selection valid. */
function retagElement(element: HTMLElement, tag: string) {
  const replacement = element.ownerDocument.createElement(tag);
  inheritSuggestionMembership(element, replacement);
  replacement.append(...Array.from(element.childNodes));
  element.replaceWith(replacement);
  return replacement;
}

export function toggleRootBlockTag(root: HTMLElement, range: Range, tag: BlockFormatTag) {
  const blocks = getTouchedRootChildren(root, range).filter(isTextBlock);
  const target = blocks.length && blocks.every((block) => block.tagName.toLowerCase() === tag) ? "p" : tag;
  return blocks.map((block) => block.tagName.toLowerCase() === target ? block : retagElement(block, target));
}

function wrapBlockRuns(blocks: HTMLElement[], listTag: ListFormatTag) {
  const items: HTMLLIElement[] = [];
  let list: HTMLElement | null = null;

  for (const block of blocks) {
    if (!list || list.nextElementSibling !== block) {
      list = block.ownerDocument.createElement(listTag);
      inheritSuggestionMembership(block, list);
      block.before(list);
    }

    const item = block.ownerDocument.createElement("li");
    item.append(...Array.from(block.childNodes));
    if (!item.childNodes.length) {
      item.append(block.ownerDocument.createElement("br"));
    }
    block.remove();
    list.append(item);
    items.push(item);
  }

  return items;
}

export function toggleRootBlockList(
  root: HTMLElement,
  selection: Selection,
  listTag: ListFormatTag,
  dependencies: ListFormatDependencies,
) {
  const range = selection.getRangeAt(0);
  const blocks = getTouchedRootChildren(root, range).filter(isTextBlock);
  if (blocks.length) {
    return wrapBlockRuns(blocks, listTag);
  }

  const items = dependencies.getSelectedListItems(selection);
  const lists = [...new Set(items.map((item) => item.parentElement).filter((list): list is HTMLElement => {
    return list instanceof HTMLElement && isListElement(list);
  }))];
  if (lists.every((list) => list.tagName.toLowerCase() === listTag)) {
    return items
      .filter(dependencies.isTopLevelListItem)
      .map(dependencies.unwrapTopLevelListItemToParagraph)
      .filter((paragraph): paragraph is HTMLElement => paragraph !== null);
  }

  return lists.map((list) => list.tagName.toLowerCase() === listTag ? list : retagElement(list, listTag));
}
