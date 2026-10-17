/*
 * Exports:
 * - CaretRenderContext: caret styling and geometry derived from active inline formats.
 * - PendingInlineFormatKey / InlineFormatState: inline formats toggled by toolbar and keyboard flows, and which are active.
 * - WorkbenchInlineFormatControllerOptions: minimal DOM and callback dependencies for inline format coordination.
 * - WorkbenchInlineFormatController: public surface for pending inline format state, inline selection toggles, and canonicalization.
 * - default WorkbenchInlineFormatController: create the inline format controller used by the editor client.
 */

import { getCollapsedRangeRect } from "../dom/layout/viewport-metrics";
import { selectInsertedNodes } from "../dom/selection/selection-dom";
import type { EditHistorySelection } from "../state/edit-history";
import {
    areInlineMarkListsEqual,
    areInlineMarksEqual,
    createInlineMarkElement,
    createInlineSelectionMarker,
    flattenInlineContent,
    getInlineMarkForElement,
    normalizeInlineLeaves,
    normalizeInlineLeavesForCanonicalRuns,
    normalizeInlineMarks,
    rebuildInlineRunContainer,
    restoreCaretToMarker,
    restoreSelectionToMarkers,
    type InlineLeaf,
    type InlineMark,
} from "./inline-leaves";

export interface CaretRenderContext {
  bold: boolean;
  italic: boolean;
  kind: "default" | "code" | "del" | "ins";
  rect: DOMRect;
}

export type PendingInlineFormatKey = "bold" | "italic" | "code" | "del" | "ins";
type SelectionFormatKey = Exclude<PendingInlineFormatKey, "code">;

export type InlineFormatState = Record<PendingInlineFormatKey, boolean>;

export interface WorkbenchInlineFormatControllerOptions {
  captureEditorSelection: () => EditHistorySelection | null;
  editor: HTMLDivElement;
  getEditorHasFocus: () => boolean;
  getInlineRunContainer: (node: Node | null) => HTMLElement | null;
  getIsComposing: () => boolean;
  isInlineRunContainer: (element: HTMLElement) => boolean;
  refreshStatusMessage: () => void;
  syncCurrentDraftBuffer: () => void;
  syncEditorAfterStructuralChange: (
    mutate: () => void,
    options?: { afterDomMutation?: () => void; afterSelectionRestore?: () => void },
  ) => void;
  updateCustomCaret: () => void;
  updateHistorySelection: (selection: EditHistorySelection | null) => void;
  updateInlineToolbars: () => void;
}

interface WorkbenchInlineFormatController {
  canonicalizeAllInlineRunContainers: (root: ParentNode) => void;
  clearPendingInlineFormats: () => void;
  getActiveInlineFormats: () => InlineFormatState;
  getCaretInlineContext: (range: Range) => CaretRenderContext | null;
  getProtectedEmptyInlineFormatElements: (root: ParentNode) => Set<HTMLElement>;
  handlePendingInlineBeforeInput: (event: InputEvent) => boolean;
  handleSelectionChange: () => void;
  maybeClearPendingInlineFormatsForKey: (event: KeyboardEvent) => void;
  removeEmptyInlineFormattingArtifacts: (root: ParentNode) => void;
  toggleInlineFormatSelection: (selection: Selection, range: Range, formatKey: SelectionFormatKey) => void;
  togglePendingInlineFormat: (format: PendingInlineFormatKey) => boolean;
}

const INLINE_FORMAT_ORDER: Array<{ key: PendingInlineFormatKey; tagName: keyof HTMLElementTagNameMap }> = [
  { key: "bold", tagName: "strong" },
  { key: "italic", tagName: "em" },
  { key: "code", tagName: "code" },
  { key: "del", tagName: "del" },
  { key: "ins", tagName: "ins" },
];

const NAVIGATION_KEYS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"]);

function WorkbenchInlineFormatController(
  options: WorkbenchInlineFormatControllerOptions,
): WorkbenchInlineFormatController {
  function getProtectedEmptyInlineFormatElementsForRoot(root: ParentNode) {
    return getProtectedEmptyInlineFormatElements(options.editor, root);
  }

  function removeEmptyInlineFormattingArtifacts(root: ParentNode = options.editor) {
    removeEmptyInlineFormatElements(["strong", "em", "code", "del", "ins", "mark"], options.editor, root);
  }

  let pendingInlineFormats: InlineFormatState | null = null;
  let preservePendingInlineFormatSelectionChanges = 0;
  let lastSelectionInlineRunContainer: HTMLElement | null = null;
  let selectionLeaveCanonicalizationIsRunning = false;

  function getClosestInlineFormatElement(node: Node | null, format: PendingInlineFormatKey) {
    let current: Node | null = node;

    while (current && current !== options.editor) {
      if (current instanceof HTMLElement && elementMatchesInlineFormat(current, format)) {
        return current;
      }
      current = current.parentNode;
    }

    return null;
  }

  function createEmptyInlineFormatState(): InlineFormatState {
    return { bold: false, code: false, del: false, ins: false, italic: false };
  }

  function getInlineFormatStateFromNode(node: Node | null): InlineFormatState {
    const formats = createEmptyInlineFormatState();
    for (const format of INLINE_FORMAT_ORDER) {
      formats[format.key] = Boolean(getClosestInlineFormatElement(node, format.key));
    }
    return formats;
  }

  function getInlineMarksFromPendingFormats(formats: InlineFormatState) {
    return normalizeInlineMarks(
      INLINE_FORMAT_ORDER
        .filter((format) => formats[format.key])
        .map((format) => getInlineMarkForFormat(format.key)),
    );
  }

  function arePendingInlineFormatsEqual(left: InlineFormatState | null, right: InlineFormatState | null) {
    if (!left || !right) {
      return left === right;
    }

    return INLINE_FORMAT_ORDER.every(({ key }) => left[key] === right[key]);
  }

  function getActiveInlineFormats(): InlineFormatState {
    const selection = window.getSelection();
    if (!selection?.rangeCount || !options.editor.contains(selection.anchorNode)) {
      return createEmptyInlineFormatState();
    }

    const range = selection.getRangeAt(0);
    if (selection.isCollapsed) {
      return pendingInlineFormats ?? getInlineFormatStateFromNode(range.startContainer);
    }

    const formats = createEmptyInlineFormatState();
    for (const { key } of INLINE_FORMAT_ORDER) {
      formats[key] = selectionContainsOnlyInlineFormat(range, key, options.editor);
    }
    return formats;
  }

  function shouldPreservePendingInlineFormatsForSelection() {
    if (!pendingInlineFormats) {
      return false;
    }

    const selection = window.getSelection();
    if (!selection?.rangeCount || !selection.isCollapsed || !options.editor.contains(selection.anchorNode)) {
      return false;
    }

    const range = selection.getRangeAt(0);
    const currentFormats = getInlineFormatStateFromNode(range.startContainer);
    if (arePendingInlineFormatsEqual(currentFormats, pendingInlineFormats)) {
      return true;
    }

    return findAdjacentInlineWrapper(range, pendingInlineFormats, { requireEmpty: true }) !== null;
  }

  function findAdjacentInlineWrapper(
    range: Range,
    formats: InlineFormatState,
    { requireEmpty }: { requireEmpty: boolean },
  ) {
    const targetContainer = options.getInlineRunContainer(range.startContainer);
    if (!targetContainer) {
      return null;
    }

    const pendingMarks = getInlineMarksFromPendingFormats(formats);
    if (!pendingMarks.length) {
      return null;
    }

    const candidateNodes: Node[] = [];
    if (range.startContainer instanceof Text) {
      if (range.startOffset === 0 && range.startContainer.previousSibling) {
        candidateNodes.push(range.startContainer.previousSibling);
      }
      if (range.startOffset === (range.startContainer.textContent?.length ?? 0) && range.startContainer.nextSibling) {
        candidateNodes.push(range.startContainer.nextSibling);
      }
    } else if (range.startContainer instanceof HTMLElement) {
      const beforeNode = range.startContainer.childNodes[range.startOffset - 1];
      const afterNode = range.startContainer.childNodes[range.startOffset];
      if (beforeNode) {
        candidateNodes.push(beforeNode);
      }
      if (afterNode) {
        candidateNodes.push(afterNode);
      }
    }

    return candidateNodes.find((node): node is HTMLElement => {
      if (!(node instanceof HTMLElement)) {
        return false;
      }

      const marks = getMarksFromInlineWrapper(node, { requireEmpty });
      return Boolean(marks && areInlineMarkListsEqual(marks, pendingMarks));
    }) ?? null;
  }

  function getMarksFromInlineWrapper(node: HTMLElement, { requireEmpty }: { requireEmpty: boolean }): InlineMark[] | null {
    const mark = getInlineMarkForElement(node);
    if (!mark) {
      return null;
    }

    const nonWhitespaceText = (node.textContent ?? "").replaceAll(" ", "").trim();
    if (requireEmpty && nonWhitespaceText.length > 0) {
      return null;
    }

    const childElements = Array.from(node.children).filter((child): child is HTMLElement => child instanceof HTMLElement);
    if (!childElements.length) {
      return [mark];
    }

    if (childElements.length !== 1) {
      return null;
    }

    const childMarks = getMarksFromInlineWrapper(childElements[0]!, { requireEmpty });
    return childMarks ? normalizeInlineMarks([mark, ...childMarks]) : null;
  }

  function moveCaretIntoAdjacentPendingInlineWrapper(formats: InlineFormatState) {
    const selection = window.getSelection();
    if (!selection?.rangeCount || !selection.isCollapsed || !options.editor.contains(selection.anchorNode)) {
      return false;
    }

    const range = selection.getRangeAt(0);
    const wrapper = findAdjacentInlineWrapper(range, formats, { requireEmpty: false });
    if (!wrapper) {
      return false;
    }

    let deepestWrapper: HTMLElement = wrapper;
    while (true) {
      const childElements = Array.from(deepestWrapper.children).filter((child): child is HTMLElement => child instanceof HTMLElement);
      if (childElements.length !== 1 || !getMarksFromInlineWrapper(childElements[0]!, { requireEmpty: false })) {
        break;
      }

      deepestWrapper = childElements[0]!;
    }

    const nextRange = document.createRange();
    const parentContainer = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;
    const wrapperBeforeCaret = parentContainer === wrapper.parentElement
      && range.startContainer instanceof Element
      && range.startContainer.childNodes[range.startOffset - 1] === wrapper;
    nextRange.setStart(deepestWrapper, wrapperBeforeCaret ? deepestWrapper.childNodes.length : 0);
    nextRange.collapse(true);
    preservePendingInlineFormatSelectionChanges = Math.max(preservePendingInlineFormatSelectionChanges, 2);
    selection.removeAllRanges();
    selection.addRange(nextRange);
    return true;
  }

  function clearPendingInlineFormats() {
    if (!pendingInlineFormats) {
      return;
    }

    pendingInlineFormats = null;
    preservePendingInlineFormatSelectionChanges = 0;
    options.updateCustomCaret();
    options.updateInlineToolbars();
  }

  function togglePendingInlineFormat(format: PendingInlineFormatKey) {
    const selection = window.getSelection();
    if (!selection?.rangeCount || !selection.isCollapsed || !options.editor.contains(selection.anchorNode)) {
      return false;
    }

    const baseFormats = pendingInlineFormats ?? getInlineFormatStateFromNode(selection.getRangeAt(0).startContainer);
    const nextFormats = { ...baseFormats, [format]: !baseFormats[format] } satisfies InlineFormatState;
    const activeFormatElement = getClosestInlineFormatElement(selection.getRangeAt(0).startContainer, format);

    if (!nextFormats[format] && activeFormatElement) {
      splitInlineFormatElementAtCaret(activeFormatElement);
      pendingInlineFormats = nextFormats;
      options.updateHistorySelection(options.captureEditorSelection());
      options.syncCurrentDraftBuffer();
      options.refreshStatusMessage();
      options.updateInlineToolbars();
      options.updateCustomCaret();
      return true;
    }

    pendingInlineFormats = nextFormats;
    materializePendingInlineFormatsAtCaret(nextFormats);
    options.updateCustomCaret();
    options.updateInlineToolbars();
    return true;
  }

  function materializePendingInlineFormatsAtCaret(formats: InlineFormatState) {
    const selection = window.getSelection();
    if (!selection?.rangeCount || !selection.isCollapsed || !options.editor.contains(selection.anchorNode)) {
      return false;
    }

    const targetContainer = options.getInlineRunContainer(selection.getRangeAt(0).startContainer);
    if (!targetContainer) {
      return false;
    }

    const range = selection.getRangeAt(0);
    if (!targetContainer.contains(range.startContainer) || !targetContainer.contains(range.endContainer)) {
      return false;
    }

    const marker = createInlineSelectionMarker("caret");
    range.insertNode(marker);
    const markerMarks = getInlineMarksFromPendingFormats(formats);
    const rebuiltLeaves = normalizeInlineLeaves(
      flattenInlineContent(targetContainer.childNodes).map((leaf): InlineLeaf => {
        return leaf.type === "marker" && leaf.role === "caret" ? { ...leaf, marks: markerMarks } : leaf;
      }),
    );

    rebuildInlineRunContainer(targetContainer, rebuiltLeaves);
    preservePendingInlineFormatSelectionChanges = Math.max(preservePendingInlineFormatSelectionChanges, 2);
    restoreCaretToMarker(targetContainer.querySelector<HTMLElement>('[data-inline-selection-marker="caret"]') ?? marker);
    return true;
  }

  function splitInlineFormatElementAtCaret(element: HTMLElement) {
    const selection = window.getSelection();
    if (!selection?.rangeCount || !selection.isCollapsed) {
      return false;
    }

    const range = selection.getRangeAt(0);
    if (!element.contains(range.startContainer)) {
      return false;
    }

    const beforeRange = document.createRange();
    beforeRange.setStart(element, 0);
    beforeRange.setEnd(range.startContainer, range.startOffset);
    const beforeFragment = beforeRange.cloneContents();

    const afterRange = document.createRange();
    afterRange.setStart(range.startContainer, range.startOffset);
    afterRange.setEnd(element, element.childNodes.length);
    const afterFragment = afterRange.cloneContents();

    const replacement = document.createDocumentFragment();
    const leadingElement = createInlineElementFromFragment(element, beforeFragment);
    if (leadingElement) {
      replacement.append(leadingElement);
    }

    const marker = document.createElement("span");
    marker.hidden = true;
    marker.dataset.pendingInlineCaret = "true";
    replacement.append(marker);

    const trailingElement = createInlineElementFromFragment(element, afterFragment);
    if (trailingElement) {
      replacement.append(trailingElement);
    }

    element.replaceWith(replacement);
    preservePendingInlineFormatSelectionChanges = 2;
    restoreCaretToMarker(marker);
    return true;
  }

  function insertTextWithPendingInlineFormats(text: string) {
    const selection = window.getSelection();
    if (!selection?.rangeCount || !selection.isCollapsed || !pendingInlineFormats) {
      return false;
    }

    moveCaretIntoAdjacentPendingInlineWrapper(pendingInlineFormats);

    const insertionSelection = window.getSelection();
    if (!insertionSelection?.rangeCount || !insertionSelection.isCollapsed) {
      return false;
    }

    const insertionRange = insertionSelection.getRangeAt(0);
    if (!options.editor.contains(insertionRange.startContainer)) {
      return false;
    }

    const activeAncestors: HTMLElement[] = [];
    let currentNode: Node | null = insertionRange.startContainer;
    while (currentNode && currentNode !== options.editor) {
      if (currentNode instanceof HTMLElement) {
        const currentElement = currentNode;
        if (INLINE_FORMAT_ORDER.some((format) => elementMatchesInlineFormat(currentElement, format.key))) {
          activeAncestors.push(currentElement);
        }
      }
      currentNode = currentNode.parentNode;
    }

    for (const ancestor of activeAncestors) {
      const formatKey = INLINE_FORMAT_ORDER.find((format) => elementMatchesInlineFormat(ancestor, format.key))?.key;
      if (formatKey && !pendingInlineFormats[formatKey]) {
        splitInlineFormatElementAtCaret(ancestor);
      }
    }

    const currentFormats = getInlineFormatStateFromNode(insertionRange.startContainer);
    const textNode = document.createTextNode(text);
    let rootNode: Node = textNode;

    for (const format of INLINE_FORMAT_ORDER) {
      if (pendingInlineFormats[format.key] && !currentFormats[format.key]) {
        const wrapper = createInlineMarkElement(getInlineMarkForFormat(format.key));
        wrapper.append(rootNode);
        rootNode = wrapper;
      }
    }

    // The caret is placed on the live text node before the mutation canonicalises the run, so the active-run
    // canonicaliser carries it through the rebuild; a marker held here would be detached by that rebuild.
    options.syncEditorAfterStructuralChange(() => {
      insertionRange.insertNode(rootNode);
      const caret = document.createRange();
      caret.setStart(textNode, textNode.length);
      caret.collapse(true);
      insertionSelection.removeAllRanges();
      insertionSelection.addRange(caret);
      preservePendingInlineFormatSelectionChanges = 2;
    });
    return true;
  }

  function handlePendingInlineBeforeInput(event: InputEvent) {
    if (
      !pendingInlineFormats
      || !["insertText", "insertReplacementText"].includes(event.inputType)
      || event.data === null
    ) {
      return false;
    }

    event.preventDefault();
    return insertTextWithPendingInlineFormats(event.data);
  }

  function getCaretInlineContext(range: Range): CaretRenderContext | null {
    if (
      !options.getEditorHasFocus()
      || options.getIsComposing()
      || !options.editor.contains(range.startContainer)
    ) {
      return null;
    }

    const rect = getCollapsedRangeRect(range);
    if (!rect.width && !rect.height) {
      return null;
    }

    const formats = pendingInlineFormats ?? getInlineFormatStateFromNode(range.startContainer);

    return {
      bold: formats.bold,
      italic: formats.italic,
      kind: formats.del ? "del" : formats.ins ? "ins" : formats.code ? "code" : "default",
      rect,
    };
  }

  function handleSelectionChange() {
    const selectionContainer = getSelectionInlineRunContainer();
    maybeCanonicalizePreviousSelectionContainer(selectionContainer);

    if (!pendingInlineFormats) {
      return;
    }

    if (preservePendingInlineFormatSelectionChanges > 0) {
      preservePendingInlineFormatSelectionChanges -= 1;
      return;
    }

    if (shouldPreservePendingInlineFormatsForSelection()) {
      options.updateCustomCaret();
      return;
    }

    clearPendingInlineFormats();
  }

  function getSelectionInlineRunContainer() {
    const selection = window.getSelection();
    if (!selection?.rangeCount || !options.editor.contains(selection.anchorNode)) {
      return null;
    }

    return options.getInlineRunContainer(selection.getRangeAt(0).startContainer);
  }

  function maybeCanonicalizePreviousSelectionContainer(selectionContainer: HTMLElement | null) {
    const previousContainer = lastSelectionInlineRunContainer;
    lastSelectionInlineRunContainer = selectionContainer;

    if (
      selectionLeaveCanonicalizationIsRunning
      || !previousContainer
      || previousContainer === selectionContainer
      || !options.editor.contains(previousContainer)
    ) {
      return;
    }

    selectionLeaveCanonicalizationIsRunning = true;
    try {
      options.syncEditorAfterStructuralChange(() => {
        canonicalizeInlineRunContainer(previousContainer);
      });
    } finally {
      selectionLeaveCanonicalizationIsRunning = false;
    }
  }

  function maybeClearPendingInlineFormatsForKey(event: KeyboardEvent) {
    if (pendingInlineFormats && !event.metaKey && !event.ctrlKey && !event.altKey && NAVIGATION_KEYS.has(event.key)) {
      clearPendingInlineFormats();
    }
  }

  function canonicalizeInlineRunContainer(
    container: HTMLElement,
    { preserveBoundaryWhitespace = false }: { preserveBoundaryWhitespace?: boolean } = {},
  ) {
    const leaves = preserveBoundaryWhitespace
      ? normalizeInlineLeaves(flattenInlineContent(container.childNodes))
      : normalizeInlineLeavesForCanonicalRuns(flattenInlineContent(container.childNodes));
    rebuildInlineRunContainer(container, leaves);
  }

  function canonicalizeInlineRunsForSelectionContainer(container?: HTMLElement | null) {
    const selection = window.getSelection();
    if (!selection?.rangeCount || !options.editor.contains(selection.anchorNode)) {
      return;
    }

    const targetContainer = container ?? options.getInlineRunContainer(selection.getRangeAt(0).startContainer);
    if (!targetContainer) {
      return;
    }

    const range = selection.getRangeAt(0);
    if (!targetContainer.contains(range.startContainer) || !targetContainer.contains(range.endContainer)) {
      return;
    }

    if (selection.isCollapsed) {
      const marker = createInlineSelectionMarker("caret");
      range.insertNode(marker);
      canonicalizeInlineRunContainer(targetContainer, { preserveBoundaryWhitespace: true });
      preservePendingInlineFormatSelectionChanges = Math.max(preservePendingInlineFormatSelectionChanges, 2);
      restoreCaretToMarker(targetContainer.querySelector<HTMLElement>('[data-inline-selection-marker="caret"]') ?? marker);
      return;
    }

    const endMarker = createInlineSelectionMarker("selection-end");
    const endRange = range.cloneRange();
    endRange.collapse(false);
    endRange.insertNode(endMarker);

    const startMarker = createInlineSelectionMarker("selection-start");
    const startRange = range.cloneRange();
    startRange.collapse(true);
    startRange.insertNode(startMarker);

    canonicalizeInlineRunContainer(targetContainer, { preserveBoundaryWhitespace: true });
    preservePendingInlineFormatSelectionChanges = Math.max(preservePendingInlineFormatSelectionChanges, 2);
    restoreSelectionToMarkers(
      targetContainer.querySelector<HTMLElement>('[data-inline-selection-marker="selection-start"]') ?? startMarker,
      targetContainer.querySelector<HTMLElement>('[data-inline-selection-marker="selection-end"]') ?? endMarker,
    );
  }

  function canonicalizeAllInlineRunContainers(root: ParentNode) {
    const activeSelectionContainer = root === options.editor
      ? options.getInlineRunContainer(window.getSelection()?.rangeCount ? window.getSelection()?.getRangeAt(0).startContainer ?? null : null)
      : null;

    const containers = root instanceof HTMLElement && root !== options.editor && options.isInlineRunContainer(root)
      ? [root]
      : "querySelectorAll" in root
        ? Array.from(root.querySelectorAll<HTMLElement>("p, div, h1, h2, h3, h4, h5, h6, blockquote, li, span[data-summary-text='true']"))
            .filter((element) => options.isInlineRunContainer(element))
        : [];

    for (const candidateContainer of containers) {
      if (candidateContainer !== activeSelectionContainer) {
        canonicalizeInlineRunContainer(candidateContainer);
      }
    }

    if (activeSelectionContainer && (root === options.editor || (root instanceof Node && root.contains(activeSelectionContainer)))) {
      canonicalizeInlineRunsForSelectionContainer(activeSelectionContainer);
    }
  }

  function toggleInlineFormatSelection(selection: Selection, range: Range, formatKey: SelectionFormatKey) {
    const container = options.getInlineRunContainer(range.commonAncestorContainer) ?? options.getInlineRunContainer(range.startContainer);
    if (container && container.contains(range.startContainer) && container.contains(range.endContainer)) {
      const startMarker = createInlineSelectionMarker("selection-start");
      const endMarker = createInlineSelectionMarker("selection-end");
      const endRange = range.cloneRange();
      endRange.collapse(false);
      endRange.insertNode(endMarker);
      const startRange = range.cloneRange();
      startRange.collapse(true);
      startRange.insertNode(startMarker);

      const leaves = flattenInlineContent(container.childNodes);
      const beforeLeaves: InlineLeaf[] = [];
      const selectedLeaves: InlineLeaf[] = [];
      const afterLeaves: InlineLeaf[] = [];
      let phase: "before" | "selected" | "after" = "before";

      for (const leaf of leaves) {
        if (leaf.type === "marker") {
          if (leaf.role === "selection-start") {
            phase = "selected";
          } else if (leaf.role === "selection-end") {
            phase = "after";
          }
          continue;
        }

        (phase === "before" ? beforeLeaves : phase === "selected" ? selectedLeaves : afterLeaves).push(leaf);
      }

      const selectedSemanticLeaves = selectedLeaves.filter((leaf): leaf is Extract<InlineLeaf, { type: "text" }> => {
        return leaf.type === "text" && /[^\t  ]/.test(leaf.text);
      });

      const targetMark = getInlineMarkForFormat(formatKey);
      const shouldRemove = selectedSemanticLeaves.length > 0 && selectedSemanticLeaves.every((leaf) => {
        return leaf.marks.some((mark) => areInlineMarksEqual(mark, targetMark));
      });

      const updatedSelectedLeaves = selectedLeaves.map((leaf): InlineLeaf => {
        if (leaf.type !== "text") {
          return leaf;
        }

        return {
          ...leaf,
          marks: shouldRemove
            ? leaf.marks.filter((mark) => !areInlineMarksEqual(mark, targetMark))
            : [...leaf.marks, targetMark],
        };
      });

      const rebuiltLeaves = normalizeInlineLeaves([
        ...beforeLeaves,
        { type: "marker", role: "selection-start" },
        ...updatedSelectedLeaves,
        { type: "marker", role: "selection-end" },
        ...afterLeaves,
      ]);

      options.syncEditorAfterStructuralChange(() => {
        rebuildInlineRunContainer(container, rebuiltLeaves);
        preservePendingInlineFormatSelectionChanges = Math.max(preservePendingInlineFormatSelectionChanges, 2);
      }, {
        afterDomMutation: () => {
          restoreSelectionToMarkers(
            container.querySelector<HTMLElement>('[data-inline-selection-marker="selection-start"]') ?? startMarker,
            container.querySelector<HTMLElement>('[data-inline-selection-marker="selection-end"]') ?? endMarker,
          );
        },
      });
      return;
    }

    const startFormatElement = getClosestInlineFormatElement(range.startContainer, formatKey);
    const shouldUnwrap = selectionContainsOnlyInlineFormat(range, formatKey, options.editor);

    if (shouldUnwrap && startFormatElement && startFormatElement.contains(range.commonAncestorContainer)) {
      options.syncEditorAfterStructuralChange(() => {
        unwrapSelectionFromSingleFormatElement(
          selection,
          range,
          startFormatElement,
          getInlineFormatTagNames(formatKey),
          options.editor,
        );
      });
      return;
    }

    const extractedFragment = range.extractContents();
    unwrapInlineFormatElements(extractedFragment, formatKey);

    if (shouldUnwrap) {
      const insertedNodes = Array.from(extractedFragment.childNodes);
      const fallbackRange = document.createRange();
      fallbackRange.setStart(range.startContainer, range.startOffset);
      fallbackRange.collapse(true);
      options.syncEditorAfterStructuralChange(() => {
        range.insertNode(extractedFragment);
        removeEmptyInlineFormatElementsForFormat(formatKey, options.editor);
      }, {
        afterDomMutation: () => {
          selectInsertedNodes(selection, insertedNodes, fallbackRange);
        },
      });
      return;
    }

    const wrapper = createInlineMarkElement(getInlineMarkForFormat(formatKey));
    options.syncEditorAfterStructuralChange(() => {
      wrapper.append(extractedFragment);
      range.insertNode(wrapper);
      removeEmptyInlineFormatElementsForFormat(formatKey, options.editor);
    }, {
      afterDomMutation: () => {
        selection.removeAllRanges();
        const nextRange = document.createRange();
        nextRange.selectNodeContents(wrapper);
        selection.addRange(nextRange);
      },
    });
  }

  return {
    canonicalizeAllInlineRunContainers,
    clearPendingInlineFormats,
    getActiveInlineFormats,
    getCaretInlineContext,
    getProtectedEmptyInlineFormatElements: getProtectedEmptyInlineFormatElementsForRoot,
    handlePendingInlineBeforeInput,
    handleSelectionChange,
    maybeClearPendingInlineFormatsForKey,
    removeEmptyInlineFormattingArtifacts,
    toggleInlineFormatSelection,
    togglePendingInlineFormat,
  };
}

const FORMAT_TAG_NAMES: Record<PendingInlineFormatKey, readonly string[]> = {
  bold: ["STRONG", "B"],
  code: ["CODE"],
  del: ["DEL", "S", "STRIKE"],
  ins: ["INS"],
  italic: ["EM", "I"],
};

const FORMAT_MARKS: Record<PendingInlineFormatKey, InlineMark> = {
  bold: { tag: "strong" },
  code: { tag: "code" },
  del: { tag: "del" },
  ins: { tag: "ins" },
  italic: { tag: "em" },
};

function getInlineFormatTagNames(format: PendingInlineFormatKey) {
  return FORMAT_TAG_NAMES[format];
}

function getInlineMarkForFormat(format: PendingInlineFormatKey): InlineMark {
  return FORMAT_MARKS[format];
}

function elementMatchesInlineFormat(element: HTMLElement, format: PendingInlineFormatKey) {
  return FORMAT_TAG_NAMES[format].includes(element.tagName);
}

function getInlineFormatSelector(format: PendingInlineFormatKey) {
  return FORMAT_TAG_NAMES[format].map((tagName) => tagName.toLowerCase()).join(", ");
}

function createInlineElementFromFragment(source: HTMLElement, fragment: DocumentFragment) {
  if (!fragment.childNodes.length) {
    return null;
  }

  const element = source.cloneNode(false) as HTMLElement;
  element.append(fragment);
  return element;
}

function unwrapElements(root: ParentNode, selector: string) {
  if (!("querySelectorAll" in root) || !selector) {
    return;
  }

  for (const element of Array.from(root.querySelectorAll(selector))) {
    const parent = element.parentNode;
    if (!parent) {
      continue;
    }

    while (element.firstChild) {
      parent.insertBefore(element.firstChild, element);
    }
    element.remove();
  }
}

function unwrapInlineFormatElements(root: ParentNode, format: PendingInlineFormatKey) {
  unwrapElements(root, getInlineFormatSelector(format));
}

function removeEmptyElementsMatching(selector: string, editor: ParentNode, root: ParentNode) {
  if (!("querySelectorAll" in root) || !selector) {
    return;
  }

  const protectedElements = getProtectedEmptyInlineFormatElements(editor, root);
  for (const element of Array.from(root.querySelectorAll<HTMLElement>(selector))) {
    if (protectedElements.has(element) || (element.textContent ?? "").replaceAll(" ", "").length > 0) {
      continue;
    }

    // A thread atom has no text; a mark holding one is its anchor, not an empty artifact.
    if (element.querySelector("[data-comment-thread]")) {
      continue;
    }

    element.remove();
  }
}

function removeEmptyInlineFormatElements(tagNames: readonly string[], editor: ParentNode, root: ParentNode = editor) {
  removeEmptyElementsMatching(tagNames.map((tagName) => tagName.toLowerCase()).join(", "), editor, root);
}

function removeEmptyInlineFormatElementsForFormat(format: PendingInlineFormatKey, editor: ParentNode, root: ParentNode = editor) {
  removeEmptyElementsMatching(getInlineFormatSelector(format), editor, root);
}

function getProtectedEmptyInlineFormatElements(editor: ParentNode, root: ParentNode) {
  const protectedElements = new Set<HTMLElement>();
  if (root !== editor) {
    return protectedElements;
  }

  const selection = window.getSelection();
  if (!selection?.rangeCount) {
    return protectedElements;
  }

  const boundaryNodes = [
    selection.anchorNode,
    selection.focusNode,
    selection.getRangeAt(0).startContainer,
    selection.getRangeAt(0).endContainer,
  ];

  for (const boundaryNode of boundaryNodes) {
    let current: Node | null = boundaryNode;
    while (current && current !== editor) {
      if (current instanceof HTMLElement && getInlineMarkForElement(current)) {
        protectedElements.add(current);
      }
      current = current.parentNode;
    }
  }

  return protectedElements;
}

function rangeIntersectsNodeSafely(range: Range, node: Node) {
  try {
    return range.intersectsNode(node);
  } catch {
    return false;
  }
}

function selectionContainsOnlyInlineFormat(range: Range, format: PendingInlineFormatKey, editor: HTMLDivElement) {
  const root = range.commonAncestorContainer;
  const selectedNodes: Node[] = [];

  if (editor.contains(root) && rangeIntersectsNodeSafely(range, root)) {
    if ((root.nodeType === Node.TEXT_NODE && (root.textContent ?? "").length > 0) || root instanceof HTMLBRElement) {
      selectedNodes.push(root);
    }
  }

  const walker = document.createTreeWalker(
    root,
    NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
    {
      acceptNode(node) {
        if (!editor.contains(node) || !rangeIntersectsNodeSafely(range, node)) {
          return NodeFilter.FILTER_REJECT;
        }

        if (node.nodeType === Node.TEXT_NODE) {
          return (node.textContent ?? "").length > 0 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        }

        return node instanceof HTMLBRElement ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      },
    },
  );

  for (let currentNode = walker.nextNode(); currentNode; currentNode = walker.nextNode()) {
    selectedNodes.push(currentNode);
  }

  if (!selectedNodes.length) {
    return false;
  }

  return selectedNodes.every((node) => {
    for (let current: Node | null = node.parentNode; current && current !== editor; current = current.parentNode) {
      if (current instanceof HTMLElement && elementMatchesInlineFormat(current, format)) {
        return true;
      }
    }

    return false;
  });
}

function unwrapSelectionFromSingleFormatElement(
  selection: Selection,
  range: Range,
  formatElement: HTMLElement,
  tagNames: readonly string[],
  editor: HTMLDivElement,
) {
  const beforeRange = document.createRange();
  beforeRange.setStart(formatElement, 0);
  beforeRange.setEnd(range.startContainer, range.startOffset);
  const beforeFragment = beforeRange.cloneContents();

  const selectedFragment = range.cloneContents();
  unwrapElements(selectedFragment, tagNames.map((tagName) => tagName.toLowerCase()).join(", "));

  const afterRange = document.createRange();
  afterRange.setStart(range.endContainer, range.endOffset);
  afterRange.setEnd(formatElement, formatElement.childNodes.length);
  const afterFragment = afterRange.cloneContents();

  const replacement = document.createDocumentFragment();
  const insertedNodes: Node[] = [];
  const leadingElement = createInlineElementFromFragment(formatElement, beforeFragment);
  if (leadingElement) {
    replacement.append(leadingElement);
  }

  for (const node of Array.from(selectedFragment.childNodes)) {
    insertedNodes.push(node);
    replacement.append(node);
  }

  const trailingElement = createInlineElementFromFragment(formatElement, afterFragment);
  if (trailingElement) {
    replacement.append(trailingElement);
  }

  const fallbackRange = document.createRange();
  fallbackRange.setStartBefore(formatElement);
  fallbackRange.collapse(true);
  formatElement.replaceWith(replacement);
  removeEmptyInlineFormatElements(tagNames, editor);
  selectInsertedNodes(selection, insertedNodes, fallbackRange);
}

export default WorkbenchInlineFormatController;
