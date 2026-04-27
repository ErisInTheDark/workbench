/*
 * Exports:
 * - CaretRenderContext: caret styling and geometry derived from active inline formats. Keywords: workbench, inline format, caret, selection.
 * - PendingInlineFormatKey: supported inline format toggles used by toolbar and keyboard flows. Keywords: workbench, inline format, pending, marks.
 * - WorkbenchInlineFormatControllerOptions: minimal DOM and callback dependencies for inline format coordination. Keywords: workbench, inline format, controller, dependencies.
 * - WorkbenchInlineFormatController: public surface for pending inline format state, inline selection toggles, and canonicalization. Keywords: workbench, inline format, controller, canonicalization.
 * - createWorkbenchInlineFormatController: create the inline format controller used by the main workbench coordinator. Keywords: workbench, inline format, pending, selection.
 * - restoreCaretToMarker: restore a collapsed selection after inline marker rewrites. Keywords: workbench, inline format, caret, marker.
 * - serializeInlineNodes: serialize inline DOM nodes back to markdown using canonical inline leaves. Keywords: workbench, inline format, markdown, serialization.
 * - serializeInlineRunContainerForMarkupSignature: normalize an inline run for rich-text round-trip markup signatures. Keywords: workbench, inline format, markup, save guard.
 */

import {
    escapeMarkdownText,
    formatInlineCommentMarkdown,
} from "./comment-markdown";
import type { EditHistorySelection } from "./edit-history";
import { selectInsertedNodes } from "./selection-dom";

export interface CaretRenderContext {
  bold: boolean;
  italic: boolean;
  kind: "comment" | "default" | "code" | "del" | "ins";
  rect: DOMRect;
}

export type PendingInlineFormatKey = "bold" | "italic" | "code" | "comment" | "del" | "ins";

interface PendingInlineFormats {
  bold: boolean;
  code: boolean;
  comment: boolean;
  del: boolean;
  ins: boolean;
  italic: boolean;
}

interface InlineMark {
  href?: string;
  tag: "a" | "code" | "comment" | "del" | "em" | "ins" | "strong";
}

type InlineLeaf =
  | { type: "text"; marks: InlineMark[]; text: string }
  | { type: "break"; marks: InlineMark[] }
  | { type: "marker"; role: "caret" | "selection-start" | "selection-end"; marks?: InlineMark[] };

export interface WorkbenchInlineFormatControllerOptions {
  captureEditorSelection: () => EditHistorySelection | null;
  deleteTextImmediatelyBeforeSelection: (
    selection: Selection,
    container: HTMLElement,
    characterCount: number,
  ) => boolean;
  editor: HTMLDivElement;
  getEditorHasFocus: () => boolean;
  getInlineExpansionContainer: (node: Node | null) => HTMLElement | null;
  getTextBeforeSelectionInElement: (selection: Selection, element: HTMLElement) => string;
  getInlineRunContainer: (node: Node | null) => HTMLElement | null;
  getIsComposing: () => boolean;
  isInlineRunContainer: (element: HTMLElement) => boolean;
  refreshStatusMessage: () => void;
  syncCurrentDraftBuffer: () => void;
  syncEditorAfterStructuralChange: () => void;
  updateCustomCaret: () => void;
  updateHistorySelection: (selection: EditHistorySelection | null) => void;
  updateInlineToolbars: () => void;
}

export interface WorkbenchInlineFormatController {
  canonicalizeAllInlineRunContainers: (root: ParentNode) => void;
  clearPendingInlineFormats: () => void;
  getCaretInlineContext: (range: Range) => CaretRenderContext | null;
  handlePendingInlineBeforeInput: (event: InputEvent) => boolean;
  handleSelectionChange: () => void;
  maybeActivateInlineCommentShortcut: (event: Event) => null;
  maybeClearPendingInlineFormatsForKey: (event: KeyboardEvent) => void;
  toggleInlineFormatSelection: (
    selection: Selection,
    range: Range,
    formatKey: "bold" | "italic" | "comment" | "del" | "ins",
  ) => void;
  togglePendingInlineFormat: (format: PendingInlineFormatKey) => boolean;
}

const INLINE_FORMAT_ORDER: Array<{ key: PendingInlineFormatKey; tagName: keyof HTMLElementTagNameMap }> = [
  { key: "bold", tagName: "strong" },
  { key: "italic", tagName: "em" },
  { key: "code", tagName: "code" },
  { key: "comment", tagName: "span" },
  { key: "del", tagName: "del" },
  { key: "ins", tagName: "ins" },
];

const INLINE_MARK_RANK: Record<InlineMark["tag"], number> = {
  a: 0,
  comment: 1,
  del: 2,
  ins: 3,
  em: 4,
  strong: 5,
  code: 6,
};

export function createWorkbenchInlineFormatController(
  options: WorkbenchInlineFormatControllerOptions,
): WorkbenchInlineFormatController {
  let pendingInlineFormats: PendingInlineFormats | null = null;
  let preservePendingInlineFormatSelectionChanges = 0;

  function getClosestInlineFormatElement(
    node: Node | null,
    format: PendingInlineFormatKey,
  ) {
    let current: Node | null = node;

    while (current && current !== options.editor) {
      if (current instanceof HTMLElement && elementMatchesInlineFormat(current, format)) {
        return current;
      }
      current = current.parentNode;
    }

    return null;
  }

  function createEmptyPendingInlineFormats(): PendingInlineFormats {
    return {
      bold: false,
      code: false,
      comment: false,
      del: false,
      ins: false,
      italic: false,
    };
  }

  function getInlineFormatStateFromNode(node: Node | null): PendingInlineFormats {
    const formats = createEmptyPendingInlineFormats();

    for (const format of INLINE_FORMAT_ORDER) {
      formats[format.key] = Boolean(
        getClosestInlineFormatElement(node, format.key),
      );
    }

    return formats;
  }

  function getInlineMarksFromPendingFormats(formats: PendingInlineFormats) {
    return normalizeInlineMarks(
      INLINE_FORMAT_ORDER
        .filter((format) => formats[format.key])
        .map((format) => getInlineMarkForFormat(format.key)),
    );
  }

  function arePendingInlineFormatsEqual(
    left: PendingInlineFormats | null,
    right: PendingInlineFormats | null,
  ) {
    if (!left || !right) {
      return left === right;
    }

    return left.bold === right.bold
      && left.italic === right.italic
      && left.code === right.code
      && left.comment === right.comment
      && left.del === right.del
      && left.ins === right.ins;
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

    return hasAdjacentEmptyPendingInlineWrapper(range, pendingInlineFormats);
  }

  function hasAdjacentEmptyPendingInlineWrapper(range: Range, formats: PendingInlineFormats) {
    return findAdjacentInlineWrapper(range, formats, { requireEmpty: true }) !== null;
  }

  function findAdjacentInlineWrapper(
    range: Range,
    formats: PendingInlineFormats,
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

    const nonWhitespaceText = (node.textContent ?? "").replaceAll("\u00a0", "").trim();
    if (requireEmpty && nonWhitespaceText.length > 0) {
      return null;
    }

    const childElements = Array.from(node.children).filter((child): child is HTMLElement => child instanceof HTMLElement);
    const nonElementChildren = Array.from(node.childNodes).filter((child) => child.nodeType !== Node.ELEMENT_NODE);
    if (requireEmpty && nonElementChildren.some((child) => (child.textContent ?? "").replaceAll("\u00a0", "").trim().length > 0)) {
      return null;
    }

    if (!childElements.length) {
      return [mark];
    }

    if (childElements.length !== 1) {
      return null;
    }

    const childMarks = getMarksFromInlineWrapper(childElements[0], { requireEmpty });
    if (!childMarks) {
      return null;
    }

    return normalizeInlineMarks([mark, ...childMarks]);
  }

  function moveCaretIntoAdjacentPendingInlineWrapper(formats: PendingInlineFormats) {
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
      if (childElements.length !== 1) {
        break;
      }

      const childMarks = getMarksFromInlineWrapper(childElements[0], { requireEmpty: false });
      if (!childMarks) {
        break;
      }

      deepestWrapper = childElements[0];
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
  }

  function togglePendingInlineFormat(format: PendingInlineFormatKey) {
    const selection = window.getSelection();
    if (!selection?.rangeCount || !selection.isCollapsed || !options.editor.contains(selection.anchorNode)) {
      return false;
    }

    const baseFormats = pendingInlineFormats ?? getInlineFormatStateFromNode(selection.getRangeAt(0).startContainer);
    const nextFormats = { ...baseFormats, [format]: !baseFormats[format] } satisfies PendingInlineFormats;
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
    return true;
  }

  function materializePendingInlineFormatsAtCaret(formats: PendingInlineFormats) {
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
      flattenInlineContent(targetContainer.childNodes).map((leaf) => {
        if (leaf.type === "marker" && leaf.role === "caret") {
          return {
            ...leaf,
            marks: markerMarks,
          } satisfies InlineLeaf;
        }

        return leaf;
      }),
    );

    rebuildInlineRunContainer(targetContainer, rebuiltLeaves);
    preservePendingInlineFormatSelectionChanges = Math.max(preservePendingInlineFormatSelectionChanges, 2);
    restoreCaretToMarker(targetContainer.querySelector<HTMLElement>('[data-inline-selection-marker="caret"]') ?? marker);
    return true;
  }

  function shouldClearPendingInlineFormatsForKey(event: KeyboardEvent) {
    if (event.metaKey || event.ctrlKey || event.altKey) {
      return false;
    }

    return [
      "ArrowLeft",
      "ArrowRight",
      "ArrowUp",
      "ArrowDown",
      "Home",
      "End",
      "PageUp",
      "PageDown",
    ].includes(event.key);
  }

  function createInlineMarkElement(mark: InlineMark) {
    if (mark.tag === "comment") {
      const element = document.createElement("span");
      element.dataset.inlineComment = "true";
      return element;
    }

    const element = document.createElement(mark.tag);
    if (mark.tag === "a") {
      element.setAttribute("href", mark.href ?? "");
    }
    return element;
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
        const formatKey = INLINE_FORMAT_ORDER.find((format) => elementMatchesInlineFormat(currentElement, format.key))?.key;

        if (formatKey) {
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

    insertionRange.insertNode(rootNode);
    const caretMarker = createInlineSelectionMarker("caret");
    textNode.parentNode?.insertBefore(caretMarker, textNode.nextSibling);
    rootNode.parentNode?.normalize();
    preservePendingInlineFormatSelectionChanges = 2;
    restoreCaretToMarker(caretMarker);
    options.syncEditorAfterStructuralChange();
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

  function maybeActivateInlineCommentShortcut(event: Event) {
    if (!(event instanceof InputEvent)) {
      return null;
    }

    if (event.inputType !== "insertText" || event.data !== "!") {
      return null;
    }

    const selection = window.getSelection();
    if (!selection?.rangeCount || !selection.isCollapsed) {
      return null;
    }

    const container = options.getInlineExpansionContainer(selection.getRangeAt(0).startContainer);
    if (!container || !options.editor.contains(container) || container.dataset.blockComment === "true") {
      return null;
    }

    const beforeText = options.getTextBeforeSelectionInElement(selection, container);
    if (!beforeText.endsWith("<!")) {
      return null;
    }

    if (!options.deleteTextImmediatelyBeforeSelection(selection, container, 2)) {
      return null;
    }

    const baseFormats = pendingInlineFormats ?? getInlineFormatStateFromNode(selection.getRangeAt(0).startContainer);
    pendingInlineFormats = {
      ...baseFormats,
      comment: true,
    };
    materializePendingInlineFormatsAtCaret(pendingInlineFormats);
    options.updateCustomCaret();
    return null;
  }

  function getCollapsedRangeRect(range: Range) {
    const directRect = range.getBoundingClientRect();
    if (directRect.height > 0) {
      return directRect;
    }

    const rects = range.getClientRects();
    if (rects.length > 0 && rects[0].height > 0) {
      return rects[0];
    }

    const marker = document.createElement("span");
    marker.textContent = "\u200b";
    marker.dataset.caretMeasure = "true";
    marker.style.position = "relative";
    marker.style.display = "inline-block";
    marker.style.width = "0";
    marker.style.overflow = "hidden";
    marker.style.pointerEvents = "none";
    marker.style.lineHeight = "inherit";

    const measurementRange = range.cloneRange();
    measurementRange.insertNode(marker);
    const markerRect = marker.getBoundingClientRect();
    marker.remove();
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    return markerRect;
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
      kind: formats.del ? "del" : formats.ins ? "ins" : formats.comment ? "comment" : formats.code ? "code" : "default",
      rect,
    };
  }

  function handleSelectionChange() {
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

  function maybeClearPendingInlineFormatsForKey(event: KeyboardEvent) {
    if (pendingInlineFormats && shouldClearPendingInlineFormatsForKey(event)) {
      clearPendingInlineFormats();
    }
  }

  function canonicalizeInlineRunContainer(container: HTMLElement) {
    const leaves = normalizeInlineLeaves(flattenInlineContent(container.childNodes));
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
      canonicalizeInlineRunContainer(targetContainer);
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

    canonicalizeInlineRunContainer(targetContainer);
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
      if (candidateContainer === activeSelectionContainer) {
        continue;
      }

      canonicalizeInlineRunContainer(candidateContainer);
    }

    if (activeSelectionContainer && (root === options.editor || (root instanceof Node && root.contains(activeSelectionContainer)))) {
      canonicalizeInlineRunsForSelectionContainer(activeSelectionContainer);
    }
  }

  function toggleInlineFormatSelection(
    selection: Selection,
    range: Range,
    formatKey: "bold" | "italic" | "comment" | "del" | "ins",
  ) {
    const container = options.getInlineRunContainer(range.commonAncestorContainer) ?? options.getInlineRunContainer(range.startContainer);
    if (
      container
      && container.contains(range.startContainer)
      && container.contains(range.endContainer)
    ) {
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

        if (phase === "before") {
          beforeLeaves.push(leaf);
        } else if (phase === "selected") {
          selectedLeaves.push(leaf);
        } else {
          afterLeaves.push(leaf);
        }
      }

      const selectedSemanticLeaves = selectedLeaves.filter((leaf): leaf is Extract<InlineLeaf, { type: "text" }> => {
        return leaf.type === "text" && /[^\t \u00a0]/.test(leaf.text);
      });

      const targetMark = getInlineMarkForFormat(formatKey);
      const shouldRemove = selectedSemanticLeaves.length > 0 && selectedSemanticLeaves.every((leaf) => {
        return leaf.marks.some((mark) => areInlineMarksEqual(mark, targetMark));
      });

      const updatedSelectedLeaves = selectedLeaves.map((leaf) => {
        if (leaf.type !== "text") {
          return leaf;
        }

        const nextMarks = shouldRemove
          ? leaf.marks.filter((mark) => !areInlineMarksEqual(mark, targetMark))
          : [...leaf.marks, targetMark];

        return {
          ...leaf,
          marks: nextMarks,
        } satisfies InlineLeaf;
      });

      const rebuiltLeaves = normalizeInlineLeaves([
        ...beforeLeaves,
        { type: "marker", role: "selection-start" } satisfies InlineLeaf,
        ...updatedSelectedLeaves,
        { type: "marker", role: "selection-end" } satisfies InlineLeaf,
        ...afterLeaves,
      ]);

      rebuildInlineRunContainer(container, rebuiltLeaves);
      preservePendingInlineFormatSelectionChanges = Math.max(preservePendingInlineFormatSelectionChanges, 2);
      restoreSelectionToMarkers(
        container.querySelector<HTMLElement>('[data-inline-selection-marker="selection-start"]') ?? startMarker,
        container.querySelector<HTMLElement>('[data-inline-selection-marker="selection-end"]') ?? endMarker,
      );
      options.syncEditorAfterStructuralChange();
      return;
    }

    const startFormatElement = getClosestInlineFormatElement(range.startContainer, formatKey);
    const shouldUnwrap = selectionContainsOnlyInlineFormat(range, formatKey, options.editor);

    if (
      shouldUnwrap
      && startFormatElement
      && startFormatElement.contains(range.commonAncestorContainer)
    ) {
      unwrapSelectionFromSingleFormatElement(
        selection,
        range,
        startFormatElement,
        getInlineFormatTagNames(formatKey) ?? [startFormatElement.tagName],
        options.editor,
      );
      options.syncEditorAfterStructuralChange();
      return;
    }

    const extractedFragment = range.extractContents();
    unwrapInlineFormatElements(extractedFragment, formatKey);

    if (shouldUnwrap) {
      const insertedNodes = Array.from(extractedFragment.childNodes);
      const fallbackRange = document.createRange();
      fallbackRange.setStart(range.startContainer, range.startOffset);
      fallbackRange.collapse(true);
      range.insertNode(extractedFragment);
      removeEmptyInlineFormatElementsForFormat(formatKey, options.editor);
      selectInsertedNodes(selection, insertedNodes, fallbackRange);
      options.syncEditorAfterStructuralChange();
      return;
    }

    const wrapper = createInlineMarkElement(getInlineMarkForFormat(formatKey));
    wrapper.append(extractedFragment);
    range.insertNode(wrapper);
    removeEmptyInlineFormatElementsForFormat(formatKey, options.editor);
    selection.removeAllRanges();
    const nextRange = document.createRange();
    nextRange.selectNodeContents(wrapper);
    selection.addRange(nextRange);
    options.syncEditorAfterStructuralChange();
  }

  return {
    canonicalizeAllInlineRunContainers,
    clearPendingInlineFormats,
    getCaretInlineContext,
    handlePendingInlineBeforeInput,
    handleSelectionChange,
    maybeActivateInlineCommentShortcut,
    maybeClearPendingInlineFormatsForKey,
    toggleInlineFormatSelection,
    togglePendingInlineFormat,
  };
}

export function restoreCaretToMarker(marker: HTMLElement) {
  const selection = window.getSelection();
  if (!selection || !marker.parentNode) {
    marker.remove();
    return;
  }

  const range = document.createRange();
  const parentElement = marker.parentElement;
  const parentMark = parentElement ? getInlineMarkForElement(parentElement) : null;
  if (parentElement && parentMark) {
    const markerIndex = Array.from(parentElement.childNodes).indexOf(marker);
    range.setStart(parentElement, Math.max(0, markerIndex));
  } else {
    range.setStartBefore(marker);
  }
  range.collapse(true);
  marker.remove();
  selection.removeAllRanges();
  selection.addRange(range);
}

export function serializeInlineRunContainerForMarkupSignature(
  element: HTMLElement,
  trimTrailingWhitespace: boolean,
) {
  const normalized = normalizeInlineLeavesForMarkupSignature(
    flattenInlineContent(element.childNodes),
    trimTrailingWhitespace,
  );

  return {
    leadingBreakCount: normalized.leadingBreakCount,
    content: normalized.leaves
      .map((leaf) => serializeInlineLeafForMarkupSignature(leaf))
      .filter(Boolean)
      .join(""),
    trailingBreakCount: normalized.trailingBreakCount,
  };
}

export function serializeInlineNodes(nodes: ArrayLike<Node>) {
  return normalizeInlineLeavesForSerialization(
    flattenInlineContent(Array.from(nodes)),
  )
    .map((leaf) => serializeInlineLeafToMarkdown(leaf))
    .join("");
}

function createInlineSelectionMarker(role: "caret" | "selection-start" | "selection-end") {
  const marker = document.createElement("span");
  marker.hidden = true;
  marker.dataset.pendingInlineCaret = role === "caret" ? "true" : "false";
  marker.dataset.inlineSelectionMarker = role;
  return marker;
}

function restoreSelectionToMarkers(
  startMarker: HTMLElement,
  endMarker: HTMLElement | null,
) {
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

function normalizeInlineLeavesForMarkupSignature(
  leaves: InlineLeaf[],
  trimTrailingWhitespace: boolean,
) {
  const mergedLeaves = normalizeInlineLeavesForSerialization(leaves);
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

  if (!trimTrailingWhitespace) {
    return {
      leaves: mergedLeaves,
      leadingBreakCount,
      trailingBreakCount,
    };
  }

  const lastLeaf = mergedLeaves.at(-1);
  if (!lastLeaf || lastLeaf.type !== "text") {
    return {
      leaves: mergedLeaves,
      leadingBreakCount,
      trailingBreakCount,
    };
  }

  const trimmedText = lastLeaf.text.replace(/[ \t\u00a0]+$/g, "");
  if (trimmedText === lastLeaf.text) {
    return {
      leaves: mergedLeaves,
      leadingBreakCount,
      trailingBreakCount,
    };
  }

  if (trimmedText) {
    lastLeaf.text = trimmedText;
    return {
      leaves: mergedLeaves,
      leadingBreakCount,
      trailingBreakCount,
    };
  }

  mergedLeaves.pop();
  return {
    leaves: mergedLeaves,
    leadingBreakCount,
    trailingBreakCount,
  };
}

function wrapMarkupSignatureContent(content: string, mark: InlineMark) {
  if (!content) {
    return "";
  }

  if (mark.tag === "comment") {
    return `<span data-inline-comment=true>${content}</span>`;
  }

  if (mark.tag === "a") {
    const href = mark.href ? ` href=${JSON.stringify(mark.href)}` : "";
    return `<a${href}>${content}</a>`;
  }

  return `<${mark.tag}>${content}</${mark.tag}>`;
}

function serializeInlineLeafForMarkupSignature(leaf: InlineLeaf) {
  if (leaf.type === "marker") {
    return "";
  }

  let content = leaf.type === "break"
    ? "<br>"
    : `text(${JSON.stringify(leaf.text.replaceAll("\u00a0", " "))})`;

  for (let index = leaf.marks.length - 1; index >= 0; index -= 1) {
    content = wrapMarkupSignatureContent(content, leaf.marks[index]);
  }

  return content;
}

function serializeInlineLeafToMarkdown(leaf: InlineLeaf) {
  if (leaf.type === "marker") {
    return "";
  }

  let content = leaf.type === "break"
    ? "\n"
    : escapeMarkdownText(leaf.text);

  for (let index = leaf.marks.length - 1; index >= 0; index -= 1) {
    content = wrapMarkdownWithInlineMark(content, leaf.marks[index]);
  }

  return content;
}

function createInlineMarkElement(mark: InlineMark) {
  if (mark.tag === "comment") {
    const element = document.createElement("span");
    element.dataset.inlineComment = "true";
    return element;
  }

  const element = document.createElement(mark.tag);
  if (mark.tag === "a") {
    element.setAttribute("href", mark.href ?? "");
  }
  return element;
}

function wrapMarkdownWithInlineMark(content: string, mark: InlineMark) {
  switch (mark.tag) {
    case "strong":
      return `__${content}__`;
    case "em":
      return content.includes("*") ? `_${content}_` : `*${content}*`;
    case "code":
      return `\`${content.replaceAll("`", "\\`")}\``;
    case "comment":
      return formatInlineCommentMarkdown(content);
    case "a":
      return `[${content || mark.href || ""}](${mark.href ?? ""})`;
    case "del":
      return `<del>${content}</del>`;
    case "ins":
      return `<ins>${content}</ins>`;
    default:
      return content;
  }
}

function getInlineFormatTagNames(format: string) {
  switch (format) {
    case "italic":
    case "em":
    case "i":
      return ["EM", "I"] as const;
    case "bold":
    case "strong":
    case "b":
      return ["STRONG", "B"] as const;
    case "code":
      return ["CODE"] as const;
    case "comment":
      return ["SPAN"] as const;
    case "del":
    case "s":
    case "strike":
      return ["DEL", "S", "STRIKE"] as const;
    case "ins":
      return ["INS"] as const;
    default:
      return null;
  }
}

function isInlineCommentElement(element: Element | null): element is HTMLElement {
  return element instanceof HTMLElement
    && element.tagName === "SPAN"
    && element.dataset.inlineComment === "true";
}

function getInlineMarkForElement(element: Element): InlineMark | null {
  if (isInlineCommentElement(element)) {
    return { tag: "comment" };
  }

  const tag = element.tagName.toLowerCase();
  switch (tag) {
    case "strong":
      return { tag: "strong" };
    case "em":
      return { tag: "em" };
    case "code":
      return { tag: "code" };
    case "del":
      return { tag: "del" };
    case "ins":
      return { tag: "ins" };
    case "a":
      return { tag: "a", href: element.getAttribute("href") ?? "" };
    default:
      return null;
  }
}

function getInlineMarkForFormat(format: PendingInlineFormatKey): InlineMark {
  switch (format) {
    case "bold":
      return { tag: "strong" };
    case "italic":
      return { tag: "em" };
    case "code":
      return { tag: "code" };
    case "comment":
      return { tag: "comment" };
    case "del":
      return { tag: "del" };
    case "ins":
      return { tag: "ins" };
    default:
      return { tag: "strong" };
  }
}

function areInlineMarksEqual(left: InlineMark, right: InlineMark) {
  return left.tag === right.tag && left.href === right.href;
}

function areInlineMarkListsEqual(left: InlineMark[], right: InlineMark[]) {
  return left.length === right.length
    && left.every((mark, index) => areInlineMarksEqual(mark, right[index]));
}

function normalizeInlineMarks(marks: InlineMark[]) {
  const normalized = [...marks].sort((left, right) => {
    const rankDifference = INLINE_MARK_RANK[left.tag] - INLINE_MARK_RANK[right.tag];
    if (rankDifference !== 0) {
      return rankDifference;
    }

    if (left.tag === "a" && right.tag === "a") {
      return (left.href ?? "").localeCompare(right.href ?? "");
    }

    return 0;
  });

  const deduped: InlineMark[] = [];

  for (const mark of normalized) {
    const previousMark = deduped.at(-1);
    if (previousMark && areInlineMarksEqual(previousMark, mark)) {
      continue;
    }

    deduped.push(mark);
  }

  return deduped;
}

function normalizeInlineLeaves(leaves: InlineLeaf[]) {
  const commentPaddedLeaves = normalizeInlineCommentPadding(leaves);
  const result: InlineLeaf[] = [];

  for (const leaf of commentPaddedLeaves) {
    appendInlineLeaf(result, leaf);
  }

  return result;
}

function normalizeInlineLeavesForSerialization(leaves: InlineLeaf[]) {
  const boundaryNormalizedLeaves: InlineLeaf[] = [];

  for (const leaf of leaves) {
    for (const normalizedLeaf of normalizeInlineLeafBoundaries(leaf)) {
      appendInlineLeaf(boundaryNormalizedLeaves, normalizedLeaf);
    }
  }

  const commentPaddedLeaves = normalizeInlineCommentPadding(boundaryNormalizedLeaves);
  const result: InlineLeaf[] = [];

  for (const leaf of commentPaddedLeaves) {
    appendInlineLeaf(result, leaf);
  }

  stripSingularTrailingBreak(result);
  return result;
}

function stripSingularTrailingBreak(leaves: InlineLeaf[]) {
  const lastLeaf = leaves.at(-1);
  if (!lastLeaf || lastLeaf.type !== "break") {
    return;
  }

  const previousLeaf = leaves.at(-2);
  if (previousLeaf?.type === "break") {
    return;
  }

  leaves.pop();
}

function normalizeInlineLeafBoundaries(leaf: InlineLeaf) {
  if (
    leaf.type !== "text"
    || leaf.marks.length === 0
    || leaf.text.length === 0
    || leaf.marks.some((mark) => mark.tag === "ins" || mark.tag === "del")
  ) {
    return [leaf];
  }

  const parts: InlineLeaf[] = [];
  const leadingWhitespaceMatch = leaf.text.match(/^[ \t\u00a0]+/);
  const trailingWhitespaceMatch = leaf.text.match(/[ \t\u00a0]+$/);
  const leadingWhitespace = leadingWhitespaceMatch?.[0] ?? "";
  const trailingWhitespace = trailingWhitespaceMatch?.[0] ?? "";
  const contentStart = leadingWhitespace.length;
  const contentEnd = leaf.text.length - trailingWhitespace.length;
  const coreText = leaf.text.slice(contentStart, Math.max(contentStart, contentEnd));

  if (leadingWhitespace) {
    parts.push({
      type: "text",
      marks: [],
      text: leadingWhitespace,
    });
  }

  if (coreText) {
    parts.push({
      ...leaf,
      text: coreText,
    });
  }

  if (trailingWhitespace) {
    parts.push({
      type: "text",
      marks: [],
      text: trailingWhitespace,
    });
  }

  return parts.length ? parts : [];
}

function leafHasCommentMark(leaf: InlineLeaf) {
  const marks = leaf.type === "marker" ? leaf.marks ?? [] : leaf.marks;
  return marks.some((mark) => mark.tag === "comment");
}

function isTextLeafWithVisibleContent(leaf: InlineLeaf | undefined): leaf is Extract<InlineLeaf, { type: "text" }> {
  return !!leaf && leaf.type === "text" && /[^\t \u00a0]/.test(leaf.text);
}

function ensureSinglePlainSpaceBeforeComment(result: InlineLeaf[], commentStartIndex: number) {
  const previousLeaf = result[commentStartIndex - 1];
  if (!previousLeaf || previousLeaf.type !== "text") {
    return commentStartIndex;
  }

  if (previousLeaf.marks.length > 0) {
    if (/[^\t \u00a0]/.test(previousLeaf.text)) {
      result.splice(commentStartIndex, 0, {
        type: "text",
        marks: [],
        text: " ",
      });
      return commentStartIndex + 1;
    }
    return commentStartIndex;
  }

  previousLeaf.text = previousLeaf.text.replace(/[ \t\u00a0]+$/g, "");
  if (previousLeaf.text.length === 0) {
    result.splice(commentStartIndex - 1, 1);
    commentStartIndex -= 1;
  }

  const updatedPreviousLeaf = result[commentStartIndex - 1];
  if (isTextLeafWithVisibleContent(updatedPreviousLeaf)) {
    result.splice(commentStartIndex, 0, {
      type: "text",
      marks: [],
      text: " ",
    });
    return commentStartIndex + 1;
  }

  return commentStartIndex;
}

function ensureSinglePlainSpaceAfterComment(result: InlineLeaf[], commentEndIndex: number) {
  const nextLeaf = result[commentEndIndex + 1];
  if (!nextLeaf || nextLeaf.type !== "text") {
    return;
  }

  if (nextLeaf.marks.length > 0) {
    if (/[^\t \u00a0]/.test(nextLeaf.text)) {
      result.splice(commentEndIndex + 1, 0, {
        type: "text",
        marks: [],
        text: " ",
      });
    }
    return;
  }

  nextLeaf.text = nextLeaf.text.replace(/^[ \t\u00a0]+/g, "");
  if (nextLeaf.text.length === 0) {
    result.splice(commentEndIndex + 1, 1);
  }

  const updatedNextLeaf = result[commentEndIndex + 1];
  if (isTextLeafWithVisibleContent(updatedNextLeaf)) {
    result.splice(commentEndIndex + 1, 0, {
      type: "text",
      marks: [],
      text: " ",
    });
  }
}

function normalizeInlineCommentPadding(leaves: InlineLeaf[]) {
  const result = [...leaves];
  let index = 0;

  while (index < result.length) {
    if (!leafHasCommentMark(result[index])) {
      index += 1;
      continue;
    }

    let segmentStart = index;
    let segmentEnd = index;
    while (segmentEnd + 1 < result.length && leafHasCommentMark(result[segmentEnd + 1])) {
      segmentEnd += 1;
    }

    segmentStart = ensureSinglePlainSpaceBeforeComment(result, segmentStart);
    segmentEnd = segmentStart;
    while (segmentEnd + 1 < result.length && leafHasCommentMark(result[segmentEnd + 1])) {
      segmentEnd += 1;
    }
    ensureSinglePlainSpaceAfterComment(result, segmentEnd);

    index = segmentEnd + 1;
  }

  return result;
}

function appendInlineLeaf(leaves: InlineLeaf[], nextLeaf: InlineLeaf) {
  const normalizedLeaf = nextLeaf.type === "marker"
    ? {
      ...nextLeaf,
      marks: nextLeaf.marks ? normalizeInlineMarks(nextLeaf.marks) : undefined,
    } satisfies InlineLeaf
    : { ...nextLeaf, marks: normalizeInlineMarks(nextLeaf.marks) } satisfies InlineLeaf;

  if (normalizedLeaf.type !== "text" || !normalizedLeaf.text) {
    leaves.push(normalizedLeaf);
    return;
  }

  const previousLeaf = leaves.at(-1);
  if (
    previousLeaf?.type === "text"
    && areInlineMarkListsEqual(previousLeaf.marks, normalizedLeaf.marks)
  ) {
    previousLeaf.text += normalizedLeaf.text;
    return;
  }

  leaves.push(normalizedLeaf);
}

function flattenInlineContent(nodes: Iterable<Node>, marks: InlineMark[] = [], leaves: InlineLeaf[] = []) {
  for (const node of nodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      appendInlineLeaf(leaves, {
        type: "text",
        marks: [...marks],
        text: node.textContent ?? "",
      });
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

    if (element.tagName === "BR") {
      leaves.push({ type: "break", marks: [...marks] });
      continue;
    }

    const mark = getInlineMarkForElement(element);
    if (mark) {
      flattenInlineContent(element.childNodes, [...marks, mark], leaves);
      continue;
    }

    flattenInlineContent(element.childNodes, marks, leaves);
  }

  return leaves;
}

function appendCanonicalInlineLeaf(container: HTMLElement, leaf: InlineLeaf) {
  const marks = leaf.type === "marker" ? leaf.marks ?? [] : leaf.marks;
  let contentNode: Node;

  if (leaf.type === "marker") {
    contentNode = createInlineSelectionMarker(leaf.role);
  } else if (leaf.type === "break") {
    contentNode = document.createElement("br");
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
      const wrapper = createInlineMarkElement(marks[index]);
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
    if (!currentMark || !areInlineMarksEqual(currentMark, marks[index])) {
      return null;
    }

    if (index === marks.length - 1) {
      return current;
    }

    const childElements = Array.from(current.children).filter((child): child is HTMLElement => child instanceof HTMLElement);
    if (childElements.length !== 1) {
      return null;
    }

    current = childElements[0];
  }

  return null;
}

function rebuildInlineRunContainer(container: HTMLElement, leaves: InlineLeaf[]) {
  container.replaceChildren();

  if (!leaves.length) {
    container.append(document.createElement("br"));
    return;
  }

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

function elementMatchesInlineFormat(element: HTMLElement, format: PendingInlineFormatKey) {
  if (format === "comment") {
    return isInlineCommentElement(element);
  }

  const tagNames = getInlineFormatTagNames(format);
  return Boolean(tagNames && (tagNames as readonly string[]).includes(element.tagName));
}

function createInlineElementFromFragment(source: HTMLElement, fragment: DocumentFragment) {
  if (!fragment.childNodes.length) {
    return null;
  }

  const element = source.cloneNode(false) as HTMLElement;
  element.append(fragment);
  return element;
}

function getInlineFormatSelector(format: PendingInlineFormatKey) {
  switch (format) {
    case "bold":
      return "strong, b";
    case "italic":
      return "em, i";
    case "code":
      return "code";
    case "comment":
      return 'span[data-inline-comment="true"]';
    case "del":
      return "del, s, strike";
    case "ins":
      return "ins";
    default:
      return "";
  }
}

function unwrapElementsByTagNames(root: ParentNode, tagNames: readonly string[]) {
  if (!("querySelectorAll" in root) || !tagNames.length) {
    return;
  }

  const selector = tagNames.map((tagName) => tagName.toLowerCase()).join(", ");
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

function unwrapInlineFormatElements(
  root: ParentNode,
  format: PendingInlineFormatKey,
) {
  if (!("querySelectorAll" in root)) {
    return;
  }

  const selector = getInlineFormatSelector(format);
  if (!selector) {
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

function removeEmptyInlineFormatElements(
  tagNames: readonly string[],
  editor: ParentNode,
  root: ParentNode = editor,
) {
  if (!("querySelectorAll" in root) || !tagNames.length) {
    return;
  }

  const protectedElements = getProtectedEmptyInlineFormatElements(editor, root);
  const selector = tagNames.map((tagName) => tagName.toLowerCase()).join(", ");
  for (const element of Array.from(root.querySelectorAll<HTMLElement>(selector))) {
    if (protectedElements.has(element)) {
      continue;
    }

    if ((element.textContent ?? "").replaceAll("\u00a0", "").length > 0) {
      continue;
    }

    element.remove();
  }
}

function removeEmptyInlineFormatElementsForFormat(
  format: PendingInlineFormatKey,
  editor: ParentNode,
  root: ParentNode = editor,
) {
  if (!("querySelectorAll" in root)) {
    return;
  }

  const selector = getInlineFormatSelector(format);
  if (!selector) {
    return;
  }

  const protectedElements = getProtectedEmptyInlineFormatElements(editor, root);
  for (const element of Array.from(root.querySelectorAll<HTMLElement>(selector))) {
    if (protectedElements.has(element)) {
      continue;
    }

    if ((element.textContent ?? "").replaceAll("\u00a0", "").length > 0) {
      continue;
    }

    element.remove();
  }
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
  const maybePushSelectedNode = (node: Node) => {
    if (!editor.contains(node) || !rangeIntersectsNodeSafely(range, node)) {
      return;
    }

    if (node.nodeType === Node.TEXT_NODE) {
      if ((node.textContent ?? "").length > 0) {
        selectedNodes.push(node);
      }
      return;
    }

    if (node instanceof HTMLBRElement) {
      selectedNodes.push(node);
    }
  };

  maybePushSelectedNode(root);
  const walker = document.createTreeWalker(
    root,
    NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
    {
      acceptNode(node) {
        if (!editor.contains(node)) {
          return NodeFilter.FILTER_REJECT;
        }

        if (!rangeIntersectsNodeSafely(range, node)) {
          return NodeFilter.FILTER_REJECT;
        }

        if (node.nodeType === Node.TEXT_NODE) {
          return (node.textContent ?? "").length > 0
            ? NodeFilter.FILTER_ACCEPT
            : NodeFilter.FILTER_REJECT;
        }

        if (node instanceof HTMLBRElement) {
          return NodeFilter.FILTER_ACCEPT;
        }

        return NodeFilter.FILTER_SKIP;
      },
    },
  );

  let currentNode = walker.nextNode();
  while (currentNode) {
    selectedNodes.push(currentNode);
    currentNode = walker.nextNode();
  }

  if (!selectedNodes.length) {
    return false;
  }

  return selectedNodes.every((node) => {
    let current: Node | null = node.parentNode;

    while (current && current !== editor) {
      if (current instanceof HTMLElement && elementMatchesInlineFormat(current, format)) {
        return true;
      }
      current = current.parentNode;
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
  unwrapElementsByTagNames(selectedFragment, tagNames);

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

