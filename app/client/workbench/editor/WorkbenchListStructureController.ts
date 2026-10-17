/*
 * Exports:
 * - WorkbenchListStructureControllerOptions: injected editor DOM helpers and callbacks needed for list structural key handling.
 * - WorkbenchListStructureController: public structural keydown handler surface for rich-editor list edits.
 * - default WorkbenchListStructureController: bind Tab, Backspace and Enter list behaviour without owning broader editor history or formatting logic.
 */

import {
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
}

interface WorkbenchListStructureController {
  handleListStructureKeyDown: (event: KeyboardEvent) => boolean;
}

function WorkbenchListStructureController(
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
  } = options;

  function moveItems(move: (items: HTMLLIElement[]) => HTMLLIElement[], items: HTMLLIElement[], collapsed: boolean) {
    let movedItems: HTMLLIElement[] = [];
    syncEditorAfterStructuralChange(() => {
      movedItems = move(items);
      editor.focus();
    }, {
      afterDomMutation: () => {
        if (movedItems.length) {
          restoreListItemSelection(movedItems, { collapsed, getListItemTextContainer });
        }
      },
    });
    return true;
  }

  function breakOutOfListItem(listItem: HTMLLIElement) {
    if (!isTopLevelListItem(listItem)) {
      return moveItems(outdentListItems, [listItem], true);
    }

    let paragraph: HTMLElement | null = null;
    syncEditorAfterStructuralChange(() => {
      paragraph = unwrapTopLevelListItemToParagraph(listItem);
      editor.focus();
    }, {
      afterDomMutation: () => {
        if (paragraph) {
          restoreParagraphSelection(paragraph);
        }
      },
    });
    return true;
  }

  function handleListTab(event: KeyboardEvent) {
    const selection = window.getSelection();
    if (!selection) {
      return false;
    }

    const selectedItems = getSelectedListItems(selection);
    if (!selectedItems.length || (selection.isCollapsed && !isSelectionAtListItemStart(selection, selectedItems[0]!))) {
      return false;
    }

    event.preventDefault();
    return moveItems(event.shiftKey ? outdentListItems : indentListItems, selectedItems, selection.isCollapsed);
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
    if (event.key === "Tab") {
      return handleListTab(event);
    }

    if (event.key === "Backspace") {
      return handleListItemBackspace(event);
    }

    if (event.key === "Enter") {
      return handleEmptyListItemEnter(event);
    }

    return false;
  }

  return {
    handleListStructureKeyDown,
  };
}

export default WorkbenchListStructureController;
