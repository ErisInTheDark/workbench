/*
 * Exports:
 * - WorkbenchCodeFormatControllerOptions: injected DOM and cleanup hooks for inline code selection toggles. Keywords: workbench, code format, controller, selection, dependencies.
 * - WorkbenchCodeFormatController: public surface for inline code toggle behavior in the rich editor. Keywords: workbench, code format, controller, selection.
 * - createWorkbenchCodeFormatController: create the inline code formatting controller used by the main workbench coordinator. Keywords: workbench, code format, toggle, selection.
 */

import { selectInsertedNodes } from "./selection-dom";

export interface WorkbenchCodeFormatControllerOptions {
  editor: HTMLDivElement;
  getProtectedEmptyInlineFormatElements: (root: ParentNode) => Set<HTMLElement>;
  syncEditorAfterStructuralChange: () => void;
}

export interface WorkbenchCodeFormatController {
  toggleCodeSelection: (selection: Selection, range: Range) => void;
}

export function createWorkbenchCodeFormatController(
  options: WorkbenchCodeFormatControllerOptions,
): WorkbenchCodeFormatController {
  function unwrapCodeElements(root: DocumentFragment | Element) {
    const codeElements = Array.from(root.querySelectorAll("code"));

    for (const codeElement of codeElements) {
      const parent = codeElement.parentNode;
      if (!parent) {
        continue;
      }

      while (codeElement.firstChild) {
        parent.insertBefore(codeElement.firstChild, codeElement);
      }
      codeElement.remove();
    }
  }

  function removeEmptyCodeElements(root: ParentNode = options.editor) {
    if (!("querySelectorAll" in root)) {
      return;
    }

    const protectedElements = options.getProtectedEmptyInlineFormatElements(root);

    for (const codeElement of Array.from(root.querySelectorAll("code"))) {
      if (!(codeElement instanceof HTMLElement)) {
        continue;
      }

      if (protectedElements.has(codeElement)) {
        continue;
      }

      if ((codeElement.textContent ?? "").replaceAll("\u00a0", "").length > 0) {
        continue;
      }

      codeElement.remove();
    }
  }

  function getClosestCodeElement(node: Node | null) {
    let current: Node | null = node;

    while (current && current !== options.editor) {
      if (current instanceof HTMLElement && current.tagName === "CODE") {
        return current;
      }
      current = current.parentNode;
    }

    return null;
  }

  function createCodeElementFromFragment(source: HTMLElement, fragment: DocumentFragment) {
    if (!fragment.childNodes.length) {
      return null;
    }

    const codeElement = source.cloneNode(false) as HTMLElement;
    codeElement.append(fragment);
    return codeElement;
  }

  function unwrapSelectionFromSingleCodeElement(selection: Selection, range: Range, codeElement: HTMLElement) {
    const beforeRange = document.createRange();
    beforeRange.setStart(codeElement, 0);
    beforeRange.setEnd(range.startContainer, range.startOffset);
    const beforeFragment = beforeRange.cloneContents();

    const selectedFragment = range.cloneContents();
    unwrapCodeElements(selectedFragment);

    const afterRange = document.createRange();
    afterRange.setStart(range.endContainer, range.endOffset);
    afterRange.setEnd(codeElement, codeElement.childNodes.length);
    const afterFragment = afterRange.cloneContents();

    const replacement = document.createDocumentFragment();
    const insertedNodes: Node[] = [];
    const leadingCode = createCodeElementFromFragment(codeElement, beforeFragment);
    if (leadingCode) {
      replacement.append(leadingCode);
    }

    for (const node of Array.from(selectedFragment.childNodes)) {
      insertedNodes.push(node);
      replacement.append(node);
    }

    const trailingCode = createCodeElementFromFragment(codeElement, afterFragment);
    if (trailingCode) {
      replacement.append(trailingCode);
    }

    const fallbackRange = document.createRange();
    fallbackRange.setStartBefore(codeElement);
    fallbackRange.collapse(true);
    codeElement.replaceWith(replacement);
    removeEmptyCodeElements();
    selectInsertedNodes(selection, insertedNodes, fallbackRange);
    options.syncEditorAfterStructuralChange();
  }

  function fragmentContainsOnlyCodeText(fragment: DocumentFragment) {
    const walker = document.createTreeWalker(fragment, NodeFilter.SHOW_TEXT);
    const textNodes: Text[] = [];
    let currentNode = walker.nextNode();

    while (currentNode) {
      const textNode = currentNode as Text;
      if ((textNode.textContent ?? "").length > 0) {
        textNodes.push(textNode);
      }
      currentNode = walker.nextNode();
    }

    if (!textNodes.length) {
      return false;
    }

    return textNodes.every((textNode) => {
      let current: Node | null = textNode.parentNode;

      while (current && current !== fragment) {
        if (current instanceof HTMLElement && current.tagName === "CODE") {
          return true;
        }
        current = current.parentNode;
      }

      return false;
    });
  }

  function toggleCodeSelection(selection: Selection, range: Range) {
    const startCode = getClosestCodeElement(range.startContainer);
    const endCode = getClosestCodeElement(range.endContainer);
    if (startCode && startCode === endCode) {
      unwrapSelectionFromSingleCodeElement(selection, range, startCode);
      return;
    }

    const fragment = range.cloneContents();
    const shouldUnwrap = fragmentContainsOnlyCodeText(fragment);
    const extractedFragment = range.extractContents();

    if (shouldUnwrap) {
      unwrapCodeElements(extractedFragment);
      const insertedNodes = Array.from(extractedFragment.childNodes);
      const fallbackRange = document.createRange();
      fallbackRange.setStart(range.startContainer, range.startOffset);
      fallbackRange.collapse(true);
      range.insertNode(extractedFragment);
      removeEmptyCodeElements();
      selectInsertedNodes(selection, insertedNodes, fallbackRange);
      options.syncEditorAfterStructuralChange();
      return;
    }

    unwrapCodeElements(extractedFragment);
    const wrapper = document.createElement("code");
    wrapper.append(extractedFragment);
    range.insertNode(wrapper);
    removeEmptyCodeElements();
    selection.removeAllRanges();
    const nextRange = document.createRange();
    nextRange.selectNodeContents(wrapper);
    selection.addRange(nextRange);
    options.syncEditorAfterStructuralChange();
  }

  return {
    toggleCodeSelection,
  };
}