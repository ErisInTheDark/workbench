/*
 * Exports:
 * - WorkbenchListStructureControllerOptions: injected editor DOM helpers and callbacks needed for list and comment structural key handling. Keywords: workbench, list, comment, keydown, controller, dependency injection.
 * - WorkbenchListStructureController: public structural keydown handler surface for rich-editor list and comment edits. Keywords: workbench, list, comment, keydown, controller.
 * - createWorkbenchListStructureController: bind list and block-comment structural keydown behavior without owning broader editor history or formatting logic. Keywords: workbench, list, comment, structural edit, keydown.
 */

import { convertCommentBlockToParagraph } from "../dom/mutation/structured-block-dom";
import { getDirectEditorParagraph } from "../dom/query/direct-editor-paragraph";
import {
    isSelectionAtElementEnd,
    isSelectionAtElementStart,
    restoreListItemSelection,
    restoreParagraphSelection,
} from "../dom/selection/selection-dom";
import { serializeListItemMainText } from "../markdown/markdown-serialization";

export interface WorkbenchListStructureControllerOptions {
  editor: HTMLElement;
  getClosestListItem: (node: Node | null) => HTMLLIElement | null;
  getListItemTextContainer: (item: HTMLLIElement) => HTMLElement;
  getSelectedListItems: (selection: Selection) => HTMLLIElement[];
  indentListItems: (items: HTMLLIElement[]) => HTMLLIElement[];
  isSelectionAtListItemStart: (selection: Selection, item: HTMLLIElement) => boolean;
  isTopLevelListItem: (item: HTMLLIElement) => boolean;
  outdentListItems: (items: HTMLLIElement[]) => HTMLLIElement[];
  syncEditorAfterStructuralChange: (
    mutate: () => void,
    options?: { afterDomMutation?: () => void; afterSelectionRestore?: () => void },
  ) => void;
  unwrapTopLevelListItemToParagraph: (item: HTMLLIElement) => HTMLElement | null;
  updateFloatingToolbar: () => void;
}

export interface WorkbenchListStructureController {
  handleListStructureKeyDown: (event: KeyboardEvent) => boolean;
}

export function WorkbenchListStructureController(
  options: WorkbenchListStructureControllerOptions,
): WorkbenchListStructureController {
  const {
    editor,
    getClosestListItem,
    getListItemTextContainer,
    getSelectedListItems,
    indentListItems,
    isSelectionAtListItemStart,
    isTopLevelListItem,
    outdentListItems,
    syncEditorAfterStructuralChange,
    unwrapTopLevelListItemToParagraph,
    updateFloatingToolbar,
  } = options;

  function breakOutOfListItem(listItem: HTMLLIElement) {
    if (isTopLevelListItem(listItem)) {
      let paragraph: HTMLElement | null = null;
      syncEditorAfterStructuralChange(() => {
        paragraph = unwrapTopLevelListItemToParagraph(listItem);
        editor.focus();
      }, {
        afterDomMutation: () => {
          if (!paragraph) {
            return;
          }

          restoreParagraphSelection(paragraph);
          updateFloatingToolbar();
        },
      });
      return true;
    }

    syncEditorAfterStructuralChange(() => {
      document.execCommand("outdent", false);
      editor.focus();
    });
    return true;
  }

  function handleListTab(event: KeyboardEvent) {
    const selection = window.getSelection();
    if (!selection) {
      return false;
    }

    const selectedItems = getSelectedListItems(selection);
    if (!selectedItems.length) {
      return false;
    }

    if (selection.isCollapsed && !isSelectionAtListItemStart(selection, selectedItems[0])) {
      return false;
    }

    const shouldCollapseSelection = selection.isCollapsed;
    event.preventDefault();

    if (event.shiftKey) {
      let movedItems: HTMLLIElement[] = [];
      syncEditorAfterStructuralChange(() => {
        movedItems = outdentListItems(selectedItems);
        editor.focus();
      }, {
        afterDomMutation: () => {
          if (!movedItems.length) {
            return;
          }

          restoreListItemSelection(movedItems, {
            collapsed: shouldCollapseSelection,
            getListItemTextContainer,
          });
          updateFloatingToolbar();
        },
      });
      return true;
    }

    let movedItems: HTMLLIElement[] = [];
    syncEditorAfterStructuralChange(() => {
      movedItems = indentListItems(selectedItems);
      editor.focus();
    }, {
      afterDomMutation: () => {
        if (!movedItems.length) {
          return;
        }

        restoreListItemSelection(movedItems, {
          collapsed: shouldCollapseSelection,
          getListItemTextContainer,
        });
        updateFloatingToolbar();
      },
    });
    return true;
  }

  function handleListItemBackspace(event: KeyboardEvent) {
    const selection = window.getSelection();
    if (!selection?.rangeCount || !selection.isCollapsed) {
      return false;
    }

    const listItem = getClosestListItem(selection.getRangeAt(0).startContainer);
    if (!listItem || !isSelectionAtListItemStart(selection, listItem)) {
      return false;
    }

    event.preventDefault();
    return breakOutOfListItem(listItem);
  }

  function handleCommentBlockBackspace(event: KeyboardEvent) {
    const selection = window.getSelection();
    if (!selection?.rangeCount || !selection.isCollapsed) {
      return false;
    }

    const paragraph = getDirectEditorParagraph(editor, selection.getRangeAt(0).startContainer);
    if (!paragraph || paragraph.dataset.blockComment !== "true" || !isSelectionAtElementStart(selection, paragraph)) {
      return false;
    }

    event.preventDefault();
    syncEditorAfterStructuralChange(() => {
      convertCommentBlockToParagraph(paragraph);
    }, {
      afterDomMutation: () => {
        restoreParagraphSelection(paragraph);
        updateFloatingToolbar();
      },
    });
    return true;
  }

  function handleCommentBlockEnter(event: KeyboardEvent) {
    if (event.shiftKey) {
      return false;
    }

    const selection = window.getSelection();
    if (!selection?.rangeCount || !selection.isCollapsed) {
      return false;
    }

    const paragraph = getDirectEditorParagraph(editor, selection.getRangeAt(0).startContainer);
    if (!paragraph || paragraph.dataset.blockComment !== "true" || !isSelectionAtElementEnd(selection, paragraph)) {
      return false;
    }

    event.preventDefault();
    let nextParagraph: HTMLParagraphElement | null = null;
    syncEditorAfterStructuralChange(() => {
      nextParagraph = document.createElement("p");
      nextParagraph.append(document.createElement("br"));
      paragraph.parentNode?.insertBefore(nextParagraph, paragraph.nextSibling);
    }, {
      afterDomMutation: () => {
        if (!nextParagraph) {
          return;
        }

        restoreParagraphSelection(nextParagraph);
        updateFloatingToolbar();
      },
    });
    return true;
  }

  function handleEmptyListItemEnter(event: KeyboardEvent) {
    const selection = window.getSelection();
    if (!selection?.rangeCount || !selection.isCollapsed) {
      return false;
    }

    const listItem = getClosestListItem(selection.getRangeAt(0).startContainer);
    if (!listItem || serializeListItemMainText(listItem) !== "") {
      return false;
    }

    event.preventDefault();
    return breakOutOfListItem(listItem);
  }

  function handleListStructureKeyDown(event: KeyboardEvent) {
    if (event.key === "Tab" && handleListTab(event)) {
      return true;
    }

    if (event.key === "Backspace") {
      if (handleCommentBlockBackspace(event)) {
        return true;
      }
      if (handleListItemBackspace(event)) {
        return true;
      }
    }

    if (event.key === "Enter") {
      if (handleCommentBlockEnter(event)) {
        return true;
      }
      if (handleEmptyListItemEnter(event)) {
        return true;
      }
    }

    return false;
  }

  return {
    handleListStructureKeyDown,
  };
}