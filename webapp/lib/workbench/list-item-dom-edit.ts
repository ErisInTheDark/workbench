/*
 * Exports:
 * - getOrCreateDirectChildList: find or append a direct child list of the requested type without descending into nested content. Keywords: workbench, list, children, dom, nested.
 * - createListItemDomEditor: bind pure list-item DOM selection and mutation helpers for grouping, indent or outdent, and top-level breakout transforms. Keywords: workbench, list item, selection, indent, outdent, breakout, dom.
 */

import {
  getDirectChildDetailsElement,
  getDirectChildListElements,
  getDirectChildSummaryElement,
  isListElement,
  isSingleBreakParagraph,
} from "./list-dom";

type ListElement = HTMLUListElement | HTMLOListElement;

interface ListItemDomEditorDependencies {
  root: HTMLElement;
  ensureParagraphHasEditableContent: (paragraph: HTMLElement) => void;
  getDirectChildSummaryTextElement: (element: Element) => HTMLElement | null | undefined;
}

export function getOrCreateDirectChildList(element: Element, listTagName: string): ListElement {
  const existingList = getDirectChildListElements(element).find((list) => list.tagName === listTagName);
  if (existingList) {
    return existingList;
  }

  const nextList = document.createElement(listTagName.toLowerCase());
  element.append(nextList);
  return nextList as ListElement;
}

export function createListItemDomEditor({
  root,
  ensureParagraphHasEditableContent,
  getDirectChildSummaryTextElement,
}: ListItemDomEditorDependencies) {
  function getParentListElement(item: HTMLLIElement) {
    return item.parentElement instanceof HTMLUListElement || item.parentElement instanceof HTMLOListElement
      ? item.parentElement
      : null;
  }

  function getClosestListItem(node: Node | null) {
    let current: Node | null = node;

    while (current) {
      if (current instanceof HTMLLIElement && root.contains(current)) {
        return current;
      }
      current = current.parentNode;
    }

    return null;
  }

  function getSelectedListItems(selection: Selection) {
    if (!selection.rangeCount) {
      return [];
    }

    const range = selection.getRangeAt(0);
    if (selection.isCollapsed) {
      const listItem = getClosestListItem(range.startContainer);
      return listItem ? [listItem] : [];
    }

    const selectedItems = Array.from(root.querySelectorAll("li")).filter((item) => range.intersectsNode(item));
    return selectedItems.filter((item) => {
      return !selectedItems.some((other) => other !== item && item.contains(other));
    });
  }

  function getListItemTextContainer(item: HTMLLIElement) {
    const details = getDirectChildDetailsElement(item);
    if (!details) {
      return item;
    }

    const summary = getDirectChildSummaryElement(details);
    if (!summary) {
      return details;
    }

    return getDirectChildSummaryTextElement(summary) ?? summary;
  }

  function getOrCreateNestedListForItem(item: HTMLLIElement, listTagName: string) {
    const details = getDirectChildDetailsElement(item);
    if (details) {
      return getOrCreateDirectChildList(details, listTagName);
    }

    return getOrCreateDirectChildList(item, listTagName);
  }

  function splitListItemRunsByParent(selectedItems: HTMLLIElement[]) {
    const runs: HTMLLIElement[][] = [];
    let currentRun: HTMLLIElement[] = [];

    for (const item of selectedItems) {
      const parentList = getParentListElement(item);
      if (!parentList) {
        if (currentRun.length) {
          runs.push(currentRun);
          currentRun = [];
        }
        continue;
      }

      const previousItem = currentRun[currentRun.length - 1];
      const previousParentList = previousItem ? getParentListElement(previousItem) : null;
      const isConsecutiveSibling = previousItem?.nextElementSibling === item;

      if (!currentRun.length || (previousParentList === parentList && isConsecutiveSibling)) {
        currentRun.push(item);
        continue;
      }

      runs.push(currentRun);
      currentRun = [item];
    }

    if (currentRun.length) {
      runs.push(currentRun);
    }

    return runs;
  }

  function isSelectionAtListItemStart(selection: Selection, item: HTMLLIElement) {
    if (!selection.rangeCount || !selection.isCollapsed) {
      return false;
    }

    const range = selection.getRangeAt(0);
    const container = getListItemTextContainer(item);
    if (!container.contains(range.startContainer)) {
      return false;
    }

    const beforeRange = document.createRange();
    beforeRange.selectNodeContents(container);
    beforeRange.setEnd(range.startContainer, range.startOffset);
    return beforeRange.toString().replaceAll("\u00a0", " ").trim() === "";
  }

  function isTopLevelListItem(item: HTMLLIElement) {
    const parentList = getParentListElement(item);
    return Boolean(parentList && (!parentList.closest("li") || !root.contains(parentList.closest("li"))));
  }

  function createParagraphFromTopLevelListItem(item: HTMLLIElement, { preserveEmptyListBreak }: { preserveEmptyListBreak: boolean }) {
    const paragraph = document.createElement("p");
    const details = getDirectChildDetailsElement(item);

    if (details) {
      const summary = getDirectChildSummaryElement(details);
      const summaryText = summary
        ? getDirectChildSummaryTextElement(summary) ?? summary
        : null;

      if (summaryText) {
        while (summaryText.firstChild) {
          paragraph.append(summaryText.firstChild);
        }
      }
    } else {
      const contentNodes = Array.from(item.childNodes).filter((node) => {
        return !(node instanceof Element && isListElement(node));
      });

      for (const node of contentNodes) {
        paragraph.append(node);
      }
    }

    paragraph.normalize();
    ensureParagraphHasEditableContent(paragraph);

    if (preserveEmptyListBreak && isSingleBreakParagraph(paragraph)) {
      paragraph.dataset.listBreak = "true";
    }

    return paragraph;
  }

  function getNestedListBreakoutNodes(item: HTMLLIElement) {
    const details = getDirectChildDetailsElement(item);
    if (details) {
      return getDirectChildListElements(details);
    }

    return getDirectChildListElements(item);
  }

  function unwrapTopLevelListItemToParagraph(item: HTMLLIElement) {
    const parentList = getParentListElement(item);
    if (!parentList) {
      return null;
    }

    const previousSibling = item.previousElementSibling instanceof HTMLLIElement
      ? item.previousElementSibling
      : null;
    const nextSibling = item.nextElementSibling instanceof HTMLLIElement
      ? item.nextElementSibling
      : null;
    const preserveEmptyListBreak = Boolean(previousSibling && nextSibling);
    const paragraph = createParagraphFromTopLevelListItem(item, { preserveEmptyListBreak });
    const nestedBreakoutNodes = getNestedListBreakoutNodes(item);
    const trailingItems: HTMLLIElement[] = [];
    let trailingNode = item.nextElementSibling;

    while (trailingNode) {
      const nextTrailingNode = trailingNode.nextElementSibling;
      if (trailingNode instanceof HTMLLIElement) {
        trailingItems.push(trailingNode);
      }
      trailingNode = nextTrailingNode;
    }

    const trailingList = trailingItems.length
      ? document.createElement(parentList.tagName.toLowerCase()) as ListElement
      : null;

    if (trailingList) {
      for (const trailingItem of trailingItems) {
        trailingList.append(trailingItem);
      }
    }

    const insertionParent = parentList.parentNode;
    if (!insertionParent) {
      return paragraph;
    }

    const parentListNextSibling = parentList.nextSibling;
    item.remove();
    const hasLeadingItems = parentList.children.length > 0;
    if (!hasLeadingItems) {
      parentList.remove();
    }

    const insertionAnchor = hasLeadingItems
      ? parentList.nextSibling
      : parentListNextSibling;
    insertionParent.insertBefore(paragraph, insertionAnchor);

    let nextInsertionPoint = paragraph.nextSibling;
    for (const breakoutNode of nestedBreakoutNodes) {
      insertionParent.insertBefore(breakoutNode, nextInsertionPoint);
      nextInsertionPoint = breakoutNode.nextSibling;
    }

    if (trailingList) {
      insertionParent.insertBefore(trailingList, nextInsertionPoint);
    }

    return paragraph;
  }

  function outdentListItems(selectedItems: HTMLLIElement[]) {
    const movedItems: HTMLLIElement[] = [];

    for (const run of splitListItemRunsByParent(selectedItems)) {
      const firstItem = run[0];
      const lastItem = run[run.length - 1];
      const parentList = getParentListElement(firstItem);
      if (!parentList) {
        continue;
      }

      const parentItem = parentList.closest<HTMLLIElement>("li");
      if (!parentItem || !root.contains(parentItem)) {
        continue;
      }

      const ancestorList = getParentListElement(parentItem);
      if (!ancestorList) {
        continue;
      }

      const insertionPoint = parentItem.nextSibling;
      const trailingSiblings: HTMLLIElement[] = [];
      let trailingNode = lastItem.nextElementSibling;

      while (trailingNode) {
        const nextTrailingNode = trailingNode.nextElementSibling;
        if (trailingNode instanceof HTMLLIElement) {
          trailingSiblings.push(trailingNode);
        }
        trailingNode = nextTrailingNode;
      }

      for (const item of run) {
        ancestorList.insertBefore(item, insertionPoint);
        movedItems.push(item);
      }

      if (trailingSiblings.length) {
        const nestedList = getOrCreateNestedListForItem(lastItem, parentList.tagName);
        for (const trailingItem of trailingSiblings) {
          nestedList.append(trailingItem);
        }
      }

      if (!parentList.children.length) {
        parentList.remove();
      }
    }

    return movedItems;
  }

  function indentListItems(selectedItems: HTMLLIElement[]) {
    const movedItems: HTMLLIElement[] = [];

    for (const run of splitListItemRunsByParent(selectedItems)) {
      const firstItem = run[0];
      const parentList = getParentListElement(firstItem);
      if (!parentList) {
        continue;
      }

      const previousSibling = firstItem.previousElementSibling instanceof HTMLLIElement
        ? firstItem.previousElementSibling
        : null;
      if (!previousSibling) {
        continue;
      }

      const nestedList = getOrCreateNestedListForItem(previousSibling, parentList.tagName);
      for (const item of run) {
        nestedList.append(item);
        movedItems.push(item);
      }

      if (!parentList.children.length) {
        parentList.remove();
      }
    }

    return movedItems;
  }

  return {
    getClosestListItem,
    getListItemTextContainer,
    getSelectedListItems,
    indentListItems,
    isSelectionAtListItemStart,
    isTopLevelListItem,
    outdentListItems,
    unwrapTopLevelListItemToParagraph,
  };
}