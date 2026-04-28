/*
 * Exports:
 * - createInitialWorkbenchEditorSnapshot: create the default editor snapshot used before the editor client is constructed. Keywords: workbench, editor, snapshot, initial state.
 * - WorkbenchEditorFormatCommandOptions: delayed formatting-command delegates injected after inline and code controllers exist. Keywords: workbench, editor, format, command, delegates.
 * - EditorMode: current editor rendering mode. Keywords: workbench, editor, mode.
 * - SaveGuardIssue: persisted editor save-guard mismatch details. Keywords: workbench, editor, save guard, mismatch.
 * - WorkbenchEditorState: owned editor shell state for file selection, status, dialogs, and diff gutter rendering. Keywords: workbench, editor, state, dialogs, diff gutter.
 * - WorkbenchEditorSnapshot: readonly projection of the editor shell state. Keywords: workbench, editor, snapshot.
 * - WorkbenchEditorListener: subscriber signature for editor shell changes. Keywords: workbench, editor, subscribe.
 * - WorkbenchEditorClientOptions: callbacks and injected structural-edit dependencies delegated back to the coordinator for editor behavior, project change-summary queries, and current/head content needed for diff gutter rendering. Keywords: workbench, editor, callbacks, structure, status, lifecycle, diff gutter.
 * - WorkbenchEditorClient: public surface for the editor shell client, including diff gutter refresh scheduling, delayed format-command configuration, and editor-owned structural input handling. Keywords: workbench, editor, client, diff gutter, format, list structure, rich input, dispose.
 * - createWorkbenchEditorClient: create the editor shell client that owns DOM refs, dialogs, diff gutter rendering, structural input wiring, delayed format-command setup, event listener cleanup, and deterministic status messages. Keywords: workbench, editor, DOM, status, structure, format, rich input, diff gutter, listeners.
 */

import type { ChangeSummary, SaveConflictPayload } from "../types";
import { MAX_EDITOR_FONT_SIZE, MIN_EDITOR_FONT_SIZE, persistFontSize, readStoredFontSize } from "./browser-state";
import {
    getNestedListElementsForItem,
    isIntentionalListBreakParagraph,
    isSingleBreakParagraph,
} from "./list-dom";
import { parseBlocks as parseMarkdownBlocks, type ParsedBlock } from "./markdown-render";
import { getEditorLineHeight } from "./viewport-metrics";
import type { WorkbenchDomElements } from "./workbench-dom";
import {
    createWorkbenchFormatCommandController,
    type WorkbenchFormatCommandController,
} from "./workbench-format-command-controller";
import {
    createWorkbenchListStructureController,
    type WorkbenchListStructureControllerOptions,
} from "./workbench-list-structure-controller";
import { createWorkbenchRichInputController } from "./workbench-rich-input-controller";

const DEFAULT_STATUS_MESSAGE = "Markdown files open as rich text. Save with Ctrl/Cmd+S.";
const DIRTY_STATUS_MESSAGE = "Unsaved changes.";
const PLAIN_TEXT_STATUS_MESSAGE = "Plain text file.";
const RICH_TEXT_SAVED_STATUS_MESSAGE = "Saved.";
const SAVE_GUARD_STATUS_MESSAGE = "Save blocked: markup mismatch. Check the console log.";
const THREAD_STATUS_MESSAGE = "Codex thread. Continue below.";
const WRITE_CONFLICT_STATUS_MESSAGE = "File changed on disk. Reload or overwrite to save.";

export type EditorMode = "rich" | "plain";

export interface SaveGuardIssue {
  markdown: string;
  currentMarkup: string;
  roundTripMarkup: string;
}

interface WorkbenchDiffGutterContent {
  currentContent: string;
  headContent: string | null;
}

type DiffMarkerSymbol = "+" | "-" | "*";

interface DiffRow {
  path: string;
  signature: string;
}

interface DiffRowAnchor {
  path: string;
  element: HTMLElement;
}

interface DeletedMarkerPlacement {
  afterPath: string | null;
  beforePath: string | null;
}

interface DiffAnchorMetrics {
  bottom: number;
  center: number;
  top: number;
}

export interface WorkbenchEditorState {
  currentPath: string;
  currentThreadId: string;
  dirty: boolean;
  fontSize: number;
  mode: EditorMode;
  pendingWriteConflict: SaveConflictPayload | null;
  saveIssue: SaveGuardIssue | null;
  statusMessage: string;
}

export interface WorkbenchEditorSnapshot {
  currentPath: string;
  currentThreadId: string;
  dirty: boolean;
  fontSize: number;
  mode: EditorMode;
  pendingWriteConflict: SaveConflictPayload | null;
  saveIssue: SaveGuardIssue | null;
  statusMessage: string;
}

export type WorkbenchEditorListener = (snapshot: WorkbenchEditorSnapshot) => void;

export interface WorkbenchEditorFormatCommandOptions {
  clearPendingInlineFormats: () => void;
  syncEditorAfterStructuralChange: () => void;
  toggleCodeSelection: (selection: Selection, range: Range) => void;
  toggleInlineFormatSelection: (
    selection: Selection,
    range: Range,
    formatKey: "bold" | "italic" | "comment" | "del" | "ins",
  ) => void;
  togglePendingInlineFormat: (format: "bold" | "italic" | "code" | "comment" | "del" | "ins") => boolean;
}

export interface WorkbenchEditorClientOptions {
  closeActiveDialog: () => boolean;
  getDiffGutterContent: () => WorkbenchDiffGutterContent;
  getProjectChangeSummary: (path: string) => ChangeSummary | null | undefined;
  handleCompositionEnd: () => void;
  handleCompositionStart: () => void;
  handleEditorBeforeInput: (event: InputEvent) => void;
  handleEditorBlur: () => void;
  handleEditorClick: (event: MouseEvent) => void;
  handleEditorFocus: () => void;
  handleEditorInput: (event: Event) => void;
  handleEditorKeyDown: (event: KeyboardEvent) => void;
  handleEditorPointerDown: () => void;
  handleEditorToggle: (event: Event) => void;
  handleOverwriteConflict: () => Promise<void>;
  handlePointerMove: (event: PointerEvent) => void;
  handleRefreshInlineToolbars: () => void;
  handleReloadConflict: () => Promise<void>;
  handleResetCurrentDraftToSaved: () => Promise<void>;
  handleResetCurrentFileToHead: () => Promise<void>;
  handleRevisionAction: (action: "accept" | "reject") => void;
  handleSaveCurrentFile: () => Promise<void>;
  handleSelectionChange: () => void;
  handleToolbarCommand: (command: string | undefined) => void;
  handleViewportChanged: () => void;
  isSaveButtonInvalid?: () => boolean;
  listStructure: Omit<WorkbenchListStructureControllerOptions, "editor">;
  shouldBlockBeforeUnload: () => boolean;
}

export interface WorkbenchEditorClient {
  applyToolbarCommand: (command: string) => void;
  changeFontSize: (delta: number) => void;
  clearSelectionView: () => void;
  configureFormatCommands: (options: WorkbenchEditorFormatCommandOptions) => void;
  dispose: () => void;
  getSnapshot: () => WorkbenchEditorSnapshot;
  handleFormatKeyDown: (event: KeyboardEvent) => boolean;
  handleRichInput: (event: Event) => { transformedListItem: HTMLLIElement | null; commentCaretMarker: HTMLElement | null };
  handleListStructureKeyDown: (event: KeyboardEvent) => boolean;
  hideResetDraftDialog: () => void;
  hideSaveConflictDialog: () => void;
  refreshStatusMessage: (message?: string) => void;
  scheduleDiffGutterRefresh: () => void;
  setCurrentFilePath: (path: string) => void;
  setCurrentThreadId: (threadId: string) => void;
  setDirty: (dirty: boolean) => void;
  setMode: (mode: EditorMode) => void;
  setPendingWriteConflict: (conflict: SaveConflictPayload | null) => void;
  setSaveButtonState: () => void;
  setSaveIssue: (issue: SaveGuardIssue | null) => void;
  setStatusMessage: (message: string) => void;
  showResetDraftDialog: () => void;
  showSaveConflict: (conflict: SaveConflictPayload) => void;
  showThreadPlaceholder: (label: string) => void;
  subscribe: (listener: WorkbenchEditorListener) => () => void;
}

export function createInitialWorkbenchEditorSnapshot(): WorkbenchEditorSnapshot {
  return {
    currentPath: "",
    currentThreadId: "",
    dirty: false,
    fontSize: readStoredFontSize(),
    mode: "rich",
    pendingWriteConflict: null,
    saveIssue: null,
    statusMessage: DEFAULT_STATUS_MESSAGE,
  };
}

function createInitialEditorState(): WorkbenchEditorState {
  return createInitialWorkbenchEditorSnapshot();
}

function appendParsedListDiffRows(
  block: Extract<ParsedBlock, { type: "ul" | "ol" }>,
  blockPath: string,
  depth: number,
  rows: DiffRow[],
) {
  block.items.forEach((item, index) => {
    const itemPath = `${blockPath}/item:${index}`;
    rows.push({
      path: itemPath,
      signature: `li|${block.type}|${depth}|${item.text}`,
    });

    item.children.forEach((child, childIndex) => {
      if (child.type !== "ul" && child.type !== "ol") {
        return;
      }

      appendParsedListDiffRows(child, `${itemPath}/child:${childIndex}`, depth + 1, rows);
    });
  });
}

function flattenMarkdownDiffRows(markdown: string | null) {
  const rows: DiffRow[] = [];
  let blockIndex = 0;

  for (const block of parseMarkdownBlocks(markdown ?? "")) {
    switch (block.type) {
      case "break":
      case "list-break":
        continue;
      case "ul":
      case "ol":
        appendParsedListDiffRows(block, `b${blockIndex}`, 0, rows);
        blockIndex += 1;
        continue;
      case "heading":
        rows.push({
          path: `b${blockIndex}`,
          signature: `heading|${block.level}|${block.text}`,
        });
        blockIndex += 1;
        continue;
      case "blockquote":
        rows.push({
          path: `b${blockIndex}`,
          signature: `blockquote|${block.text}`,
        });
        blockIndex += 1;
        continue;
      case "comment":
        rows.push({
          path: `b${blockIndex}`,
          signature: `comment|${block.text}`,
        });
        blockIndex += 1;
        continue;
      case "hr":
        rows.push({
          path: `b${blockIndex}`,
          signature: "hr|",
        });
        blockIndex += 1;
        continue;
      case "code":
        rows.push({
          path: `b${blockIndex}`,
          signature: `code|${block.language}|${block.text}`,
        });
        blockIndex += 1;
        continue;
      case "paragraph":
        rows.push({
          path: `b${blockIndex}`,
          signature: `paragraph|${block.text}`,
        });
        blockIndex += 1;
        continue;
      default:
        continue;
    }
  }

  return rows;
}

function isDiffTrackableBlockElement(element: Element) {
  return /^(p|div|h1|h2|h3|h4|h5|h6|blockquote|pre|hr)$/i.test(element.tagName);
}

function appendLiveListDiffAnchors(
  listElement: HTMLUListElement | HTMLOListElement,
  blockPath: string,
  anchors: DiffRowAnchor[],
) {
  Array.from(listElement.children)
    .filter((child): child is HTMLLIElement => child instanceof HTMLLIElement)
    .forEach((item, index) => {
      const itemPath = `${blockPath}/item:${index}`;
      anchors.push({
        path: itemPath,
        element: item,
      });

      getNestedListElementsForItem(item).forEach((childList, childIndex) => {
        appendLiveListDiffAnchors(childList, `${itemPath}/child:${childIndex}`, anchors);
      });
    });
}

function flattenLiveDiffAnchors(root: ParentNode) {
  const anchors: DiffRowAnchor[] = [];
  const childElements = root instanceof Element || root instanceof DocumentFragment
    ? Array.from(root.children)
    : [];
  let blockIndex = 0;

  for (const childElement of childElements) {
    if (
      childElement instanceof HTMLBRElement
      || isIntentionalListBreakParagraph(childElement)
      || (childElement instanceof HTMLElement && isSingleBreakParagraph(childElement))
    ) {
      continue;
    }

    if (childElement instanceof HTMLUListElement || childElement instanceof HTMLOListElement) {
      appendLiveListDiffAnchors(childElement, `b${blockIndex}`, anchors);
      blockIndex += 1;
      continue;
    }

    if (!isDiffTrackableBlockElement(childElement)) {
      continue;
    }

    anchors.push({
      path: `b${blockIndex}`,
      element: childElement as HTMLElement,
    });
    blockIndex += 1;
  }

  return anchors;
}

function diffRowsAgainstHead(headRows: DiffRow[], currentRows: DiffRow[]) {
  const rowCount = headRows.length;
  const columnCount = currentRows.length;
  const dp = Array.from(
    { length: rowCount + 1 },
    () => new Uint32Array(columnCount + 1),
  );

  for (let rowIndex = rowCount - 1; rowIndex >= 0; rowIndex -= 1) {
    for (let columnIndex = columnCount - 1; columnIndex >= 0; columnIndex -= 1) {
      if (headRows[rowIndex].signature === currentRows[columnIndex].signature) {
        dp[rowIndex][columnIndex] = dp[rowIndex + 1][columnIndex + 1] + 1;
      } else {
        dp[rowIndex][columnIndex] = Math.max(
          dp[rowIndex + 1][columnIndex],
          dp[rowIndex][columnIndex + 1],
        );
      }
    }
  }

  const operations: Array<
    | { type: "equal"; row: DiffRow }
    | { type: "insert"; row: DiffRow }
    | { type: "delete"; row: DiffRow }
  > = [];
  let rowIndex = 0;
  let columnIndex = 0;

  while (rowIndex < rowCount || columnIndex < columnCount) {
    if (
      rowIndex < rowCount
      && columnIndex < columnCount
      && headRows[rowIndex].signature === currentRows[columnIndex].signature
    ) {
      operations.push({ type: "equal", row: currentRows[columnIndex] });
      rowIndex += 1;
      columnIndex += 1;
      continue;
    }

    const canInsert = columnIndex < columnCount;
    const canDelete = rowIndex < rowCount;

    if (
      canInsert
      && (!canDelete || dp[rowIndex][columnIndex + 1] >= dp[rowIndex + 1][columnIndex])
    ) {
      operations.push({ type: "insert", row: currentRows[columnIndex] });
      columnIndex += 1;
      continue;
    }

    if (canDelete) {
      operations.push({ type: "delete", row: headRows[rowIndex] });
      rowIndex += 1;
    }
  }

  const currentMarkers = new Map<string, DiffMarkerSymbol>();
  const deletedPlacements: DeletedMarkerPlacement[] = [];
  let previousEqualPath: string | null = null;

  for (let operationIndex = 0; operationIndex < operations.length;) {
    const operation = operations[operationIndex];
    if (operation.type === "equal") {
      previousEqualPath = operation.row.path;
      operationIndex += 1;
      continue;
    }

    const insertedPaths: string[] = [];
    let deletedCount = 0;

    while (operationIndex < operations.length && operations[operationIndex].type !== "equal") {
      const currentOperation = operations[operationIndex];
      if (currentOperation.type === "insert") {
        insertedPaths.push(currentOperation.row.path);
      } else {
        deletedCount += 1;
      }
      operationIndex += 1;
    }

    const nextEqualPath = operationIndex < operations.length
      ? operations[operationIndex].row.path
      : null;

    if (insertedPaths.length && deletedCount) {
      insertedPaths.forEach((path) => {
        currentMarkers.set(path, "*");
      });
      continue;
    }

    if (insertedPaths.length) {
      insertedPaths.forEach((path) => {
        currentMarkers.set(path, "+");
      });
      continue;
    }

    if (deletedCount) {
      deletedPlacements.push({
        afterPath: previousEqualPath,
        beforePath: nextEqualPath,
      });
    }
  }

  return { currentMarkers, deletedPlacements };
}

function getAnchorMetrics(element: HTMLElement, editorShell: HTMLElement) {
  const rect = element.getClientRects()[0];
  if (!rect || rect.height === 0) {
    return null;
  }

  const shellRect = editorShell.getBoundingClientRect();
  const top = rect.top - shellRect.top;
  const bottom = rect.bottom - shellRect.top;

  return {
    top,
    center: top + (bottom - top) / 2,
    bottom,
  } satisfies DiffAnchorMetrics;
}

function resolveDeletedMarkerTop(
  placement: DeletedMarkerPlacement,
  anchorMetrics: Map<string, DiffAnchorMetrics>,
  lineHeight: number,
) {
  const previousMetrics = placement.afterPath
    ? anchorMetrics.get(placement.afterPath) ?? null
    : null;
  const nextMetrics = placement.beforePath
    ? anchorMetrics.get(placement.beforePath) ?? null
    : null;

  if (previousMetrics !== null && nextMetrics !== null) {
    const gapStart = previousMetrics.bottom;
    const gapEnd = nextMetrics.top;

    if (gapEnd > gapStart) {
      return gapStart + (gapEnd - gapStart) / 2;
    }

    return previousMetrics.bottom + (nextMetrics.top - previousMetrics.bottom) / 2;
  }

  if (nextMetrics !== null) {
    return Math.max(0, nextMetrics.top - lineHeight * 0.5);
  }

  if (previousMetrics !== null) {
    return previousMetrics.bottom + lineHeight * 0.5;
  }

  return Math.max(0, lineHeight * 0.5);
}

function createDiffMarker(symbol: DiffMarkerSymbol, top: number) {
  const marker = document.createElement("span");
  marker.className = "editor-diff-marker";
  marker.dataset.markerType = symbol === "+" ? "insert" : symbol === "-" ? "delete" : "modify";
  marker.style.top = `${Math.max(0, top)}px`;
  marker.append(createDiffMarkerIcon(symbol));
  return marker;
}

function createDiffMarkerIcon(symbol: DiffMarkerSymbol) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 20 20");
  svg.setAttribute("fill", "none");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("editor-diff-marker-icon");

  if (symbol === "*") {
    const asterisk = document.createElementNS("http://www.w3.org/2000/svg", "path");
    asterisk.setAttribute("d", "M10 4.35v11.3M5.15 7.15l9.7 5.7M14.85 7.15l-9.7 5.7");
    asterisk.setAttribute("stroke", "currentColor");
    asterisk.setAttribute("stroke-width", "2.25");
    asterisk.setAttribute("stroke-linecap", "round");
    asterisk.setAttribute("stroke-linejoin", "round");
    svg.append(asterisk);
    return svg;
  }

  const line = document.createElementNS("http://www.w3.org/2000/svg", "path");
  line.setAttribute("stroke", "currentColor");
  line.setAttribute("stroke-width", "2.45");
  line.setAttribute("stroke-linecap", "round");

  if (symbol === "+") {
    line.setAttribute("d", "M10 5.2v9.6M5.2 10h9.6");
  } else {
    line.setAttribute("d", "M5.2 10h9.6");
  }

  svg.append(line);
  return svg;
}

export function createWorkbenchEditorClient(
  elements: WorkbenchDomElements,
  options: WorkbenchEditorClientOptions,
): WorkbenchEditorClient {
  const listeners = new Set<WorkbenchEditorListener>();
  const state = createInitialEditorState();
  const abortController = new AbortController();
  const { signal } = abortController;
  const dialogs = [elements.saveConflictDialog.dialog, elements.resetDraftDialog.dialog] as const;
  const listStructureController = createWorkbenchListStructureController({
    editor: elements.editor,
    ...options.listStructure,
  });
  const richInputController = createWorkbenchRichInputController({
    editor: elements.editor,
    getMode: () => state.mode,
  });
  let formatCommandController: WorkbenchFormatCommandController | null = null;
  let diffRefreshFrameId: number | null = null;

  function getSnapshot(): WorkbenchEditorSnapshot {
    return {
      currentPath: state.currentPath,
      currentThreadId: state.currentThreadId,
      dirty: state.dirty,
      fontSize: state.fontSize,
      mode: state.mode,
      pendingWriteConflict: state.pendingWriteConflict,
      saveIssue: state.saveIssue,
      statusMessage: state.statusMessage,
    };
  }

  function emit() {
    const snapshot = getSnapshot();
    for (const listener of listeners) {
      listener(snapshot);
    }
  }

  function subscribe(listener: WorkbenchEditorListener) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  function applyEditorFontSize() {
    elements.editor.style.fontSize = `${state.fontSize}rem`;
  }

  function setSaveButtonState() {
    const isInvalid = options.isSaveButtonInvalid?.() ?? Boolean(state.saveIssue);
    elements.saveFileButton.dataset.invalid = isInvalid ? "true" : "false";
    elements.saveFileButton.disabled = !state.currentPath;
    elements.resetDraftButton.disabled = !state.currentPath;
  }

  function formatChangeSummary(change: ChangeSummary | null | undefined) {
    if (!change) {
      return "";
    }

    const parts = [];
    if (change.additions) {
      parts.push(`+${change.additions}`);
    }
    if (change.deletions) {
      parts.push(`-${change.deletions}`);
    }
    return parts.join(" ");
  }

  function getDeterministicStatusMessage() {
    if (!state.currentPath) {
      return state.currentThreadId ? THREAD_STATUS_MESSAGE : DEFAULT_STATUS_MESSAGE;
    }

    if (state.saveIssue) {
      return SAVE_GUARD_STATUS_MESSAGE;
    }

    if (state.pendingWriteConflict) {
      return WRITE_CONFLICT_STATUS_MESSAGE;
    }

    if (state.dirty) {
      return DIRTY_STATUS_MESSAGE;
    }

    const changeSummary = formatChangeSummary(options.getProjectChangeSummary(state.currentPath));
    if (changeSummary) {
      return `Pending changes ${changeSummary}`;
    }

    return state.mode === "rich" ? RICH_TEXT_SAVED_STATUS_MESSAGE : PLAIN_TEXT_STATUS_MESSAGE;
  }

  function setStatusMessage(message: string) {
    state.statusMessage = message;
    elements.statusLine.textContent = message;
    emit();
  }

  function refreshStatusMessage(message = "") {
    if (message) {
      setStatusMessage(message);
      return;
    }

    setStatusMessage(getDeterministicStatusMessage());
  }

  function renderDiffGutter() {
    elements.diffGutter.replaceChildren();

    if (!state.currentPath || state.mode !== "rich") {
      return;
    }

    const editorShell = elements.diffGutter.parentElement;
    if (!editorShell) {
      return;
    }

    const { currentContent, headContent } = options.getDiffGutterContent();
    const currentRows = flattenMarkdownDiffRows(currentContent);
    const headRows = flattenMarkdownDiffRows(headContent);
    const { currentMarkers, deletedPlacements } = diffRowsAgainstHead(headRows, currentRows);

    if (!currentMarkers.size && !deletedPlacements.length) {
      return;
    }

    const anchorMetrics = new Map<string, DiffAnchorMetrics>();
    for (const anchor of flattenLiveDiffAnchors(elements.editor)) {
      const metrics = getAnchorMetrics(anchor.element, editorShell);
      if (metrics === null) {
        continue;
      }

      anchorMetrics.set(anchor.path, metrics);
    }

    const markers: Array<{ symbol: DiffMarkerSymbol; top: number }> = [];

    for (const [path, symbol] of currentMarkers) {
      const metrics = anchorMetrics.get(path);
      if (!metrics) {
        continue;
      }

      markers.push({ symbol, top: metrics.center });
    }

    const lineHeight = getEditorLineHeight(elements.editor);
    for (const placement of deletedPlacements) {
      markers.push({
        symbol: "-",
        top: resolveDeletedMarkerTop(placement, anchorMetrics, lineHeight),
      });
    }

    markers
      .sort((left, right) => left.top - right.top)
      .forEach(({ symbol, top }) => {
        elements.diffGutter.append(createDiffMarker(symbol, top));
      });
  }

  function scheduleDiffGutterRefresh() {
    if (diffRefreshFrameId !== null) {
      window.cancelAnimationFrame(diffRefreshFrameId);
    }

    diffRefreshFrameId = window.requestAnimationFrame(() => {
      diffRefreshFrameId = null;
      renderDiffGutter();
    });
  }

  function handleListStructureKeyDown(event: KeyboardEvent) {
    if (!state.currentPath || state.mode !== "rich") {
      return false;
    }

    return listStructureController.handleListStructureKeyDown(event);
  }

  function handleRichInput(event: Event) {
    if (!state.currentPath) {
      return {
        transformedListItem: null,
        commentCaretMarker: null,
      };
    }

    return richInputController.handleRichInput(event);
  }

  function configureFormatCommands(formatCommandOptions: WorkbenchEditorFormatCommandOptions) {
    formatCommandController = createWorkbenchFormatCommandController({
      editor: elements.editor,
      getMode: () => state.mode,
      ...formatCommandOptions,
    });
  }

  function handleFormatKeyDown(event: KeyboardEvent) {
    return formatCommandController?.handleFormatKeyDown(event) ?? false;
  }

  function applyToolbarCommand(command: string) {
    formatCommandController?.applyToolbarCommand(command);
  }

  function hideDialog(dialog: HTMLDivElement) {
    dialog.hidden = true;
  }

  function showDialog(dialog: HTMLDivElement, focusTarget?: HTMLElement | null) {
    dialogs.forEach((currentDialog) => {
      if (currentDialog !== dialog) {
        hideDialog(currentDialog);
      }
    });

    dialog.hidden = false;
    if (focusTarget) {
      window.requestAnimationFrame(() => {
        focusTarget.focus();
      });
    }
  }

  function hideSaveConflictDialog() {
    hideDialog(elements.saveConflictDialog.dialog);
  }

  function hideResetDraftDialog() {
    hideDialog(elements.resetDraftDialog.dialog);
  }

  function showSaveConflict(conflict: SaveConflictPayload) {
    state.pendingWriteConflict = conflict;
    if (elements.saveConflictDialog.summary) {
      elements.saveConflictDialog.summary.textContent = "Reload from disk to discard your unsaved editor state, or overwrite anyway to write what is currently in the editor.";
    }
    if (elements.saveConflictDialog.expected) {
      elements.saveConflictDialog.expected.textContent = `Expected ${conflict.expectedUpdatedAt}`;
    }
    if (elements.saveConflictDialog.actual) {
      elements.saveConflictDialog.actual.textContent = `Disk now has ${conflict.actualUpdatedAt}`;
    }
    showDialog(elements.saveConflictDialog.dialog, elements.saveConflictDialog.keepEditing);
    setSaveButtonState();
    emit();
  }

  function showResetDraftDialog() {
    if (!state.currentPath) {
      return;
    }

    showDialog(elements.resetDraftDialog.dialog, elements.resetDraftDialog.cancel);
  }

  function clearSelectionView() {
    state.currentPath = "";
    state.currentThreadId = "";
    state.dirty = false;
    state.pendingWriteConflict = null;
    state.saveIssue = null;
    state.mode = "rich";
    elements.editor.textContent = "";
    elements.editor.scrollTop = 0;
    elements.editor.dataset.placeholder = "Select a markdown file to start editing.";
    elements.editor.setAttribute("contenteditable", "false");
    elements.filePathLabel.textContent = "Select a file";
    setSaveButtonState();
    refreshStatusMessage();
  }

  function showThreadPlaceholder(label: string) {
    state.currentPath = "";
    state.dirty = false;
    state.pendingWriteConflict = null;
    state.saveIssue = null;
    state.mode = "rich";
    elements.editor.dataset.placeholder = "Select a markdown file to start editing.";
    elements.editor.setAttribute("contenteditable", "false");
    elements.editor.textContent = "";
    elements.editor.scrollTop = 0;
    elements.filePathLabel.textContent = label || "Create new thread";
    setSaveButtonState();
    refreshStatusMessage();
  }

  function setCurrentFilePath(path: string) {
    state.currentPath = path;
    state.currentThreadId = "";
    elements.filePathLabel.textContent = path || "Select a file";
    if (path) {
      elements.editor.setAttribute("contenteditable", "true");
    }
    setSaveButtonState();
    emit();
  }

  function setCurrentThreadId(threadId: string) {
    state.currentThreadId = threadId;
    if (threadId) {
      state.currentPath = "";
    }
    emit();
  }

  function setDirty(dirty: boolean) {
    state.dirty = dirty;
    emit();
  }

  function setMode(mode: EditorMode) {
    state.mode = mode;
    elements.editor.dataset.placeholder = mode === "rich"
      ? "Select a markdown file to start editing."
      : "Plain text mode";
    emit();
  }

  function setPendingWriteConflict(conflict: SaveConflictPayload | null) {
    state.pendingWriteConflict = conflict;
    if (!conflict) {
      hideSaveConflictDialog();
    }
    setSaveButtonState();
    emit();
  }

  function setSaveIssue(issue: SaveGuardIssue | null) {
    state.saveIssue = issue;
    setSaveButtonState();
    emit();
  }

  function changeFontSize(delta: number) {
    const nextFontSize = Math.min(
      MAX_EDITOR_FONT_SIZE,
      Math.max(MIN_EDITOR_FONT_SIZE, Number((state.fontSize + delta).toFixed(2))),
    );
    if (nextFontSize === state.fontSize) {
      return;
    }

    state.fontSize = nextFontSize;
    persistFontSize(state.fontSize);
    applyEditorFontSize();
    emit();
  }

  const preserveToolbarSelection = (event: Event) => {
    event.preventDefault();
  };

  elements.saveFileButton.addEventListener("click", () => {
    void options.handleSaveCurrentFile();
  }, { signal });

  elements.resetDraftButton.addEventListener("click", () => {
    showResetDraftDialog();
  }, { signal });

  elements.zoomOutButton.addEventListener("click", () => {
    changeFontSize(-0.08);
  }, { signal });

  elements.zoomInButton.addEventListener("click", () => {
    changeFontSize(0.08);
  }, { signal });

  elements.saveConflictDialog.keepEditing?.addEventListener("click", () => {
    hideSaveConflictDialog();
    elements.editor.focus();
  }, { signal });

  elements.saveConflictDialog.reload?.addEventListener("click", () => {
    hideSaveConflictDialog();
    void options.handleReloadConflict();
  }, { signal });

  elements.saveConflictDialog.overwrite?.addEventListener("click", () => {
    hideSaveConflictDialog();
    void options.handleOverwriteConflict();
  }, { signal });

  elements.resetDraftDialog.cancel?.addEventListener("click", () => {
    hideResetDraftDialog();
    elements.editor.focus();
  }, { signal });

  elements.resetDraftDialog.resetToSaved?.addEventListener("click", () => {
    void options.handleResetCurrentDraftToSaved();
  }, { signal });

  elements.resetDraftDialog.resetToHead?.addEventListener("click", () => {
    void options.handleResetCurrentFileToHead();
  }, { signal });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && options.closeActiveDialog()) {
      return;
    }

    if (event.defaultPrevented) {
      return;
    }

    const isPrimaryModifier = event.metaKey || event.ctrlKey;
    if (!isPrimaryModifier || event.key.toLowerCase() !== "s") {
      return;
    }

    event.preventDefault();
    void options.handleSaveCurrentFile();
  }, { signal });

  elements.editor.addEventListener("input", (event) => {
    options.handleEditorInput(event);
  }, { signal });

  elements.editor.addEventListener("beforeinput", (event) => {
    if (event instanceof InputEvent) {
      options.handleEditorBeforeInput(event);
    }
  }, { signal });

  elements.editor.addEventListener("keydown", (event) => {
    options.handleEditorKeyDown(event);
  }, { signal });

  document.addEventListener("selectionchange", () => {
    options.handleSelectionChange();
  }, { signal });

  document.addEventListener("touchend", () => {
    options.handleRefreshInlineToolbars();
  }, { signal, passive: true });

  document.addEventListener("pointerup", () => {
    options.handleRefreshInlineToolbars();
  }, { signal });

  elements.editor.addEventListener("focus", () => {
    options.handleEditorFocus();
  }, { signal });

  elements.editor.addEventListener("blur", () => {
    options.handleEditorBlur();
  }, { signal });

  elements.editor.addEventListener("compositionstart", () => {
    options.handleCompositionStart();
  }, { signal });

  elements.editor.addEventListener("compositionend", () => {
    options.handleCompositionEnd();
  }, { signal });

  for (const dialog of dialogs) {
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) {
        hideDialog(dialog);
      }
    }, { signal });
  }

  elements.toolbars.floating.addEventListener("mousedown", preserveToolbarSelection, { signal });
  elements.toolbars.floating.addEventListener("pointerdown", preserveToolbarSelection, { signal });
  elements.toolbars.floating.addEventListener("touchstart", preserveToolbarSelection, { signal, passive: false });

  elements.toolbars.revisionHover.addEventListener("mousedown", preserveToolbarSelection, { signal });
  elements.toolbars.revisionHover.addEventListener("pointerdown", preserveToolbarSelection, { signal });
  elements.toolbars.revisionHover.addEventListener("touchstart", preserveToolbarSelection, { signal, passive: false });

  elements.toolbars.floating.addEventListener("click", (event) => {
    const button = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>("button[data-command]")
      : null;
    if (!button) {
      return;
    }

    elements.editor.focus();
    options.handleToolbarCommand(button.dataset.command);
  }, { signal });

  elements.toolbars.revisionAccept.addEventListener("click", () => {
    options.handleRevisionAction("accept");
  }, { signal });

  elements.toolbars.revisionReject.addEventListener("click", () => {
    options.handleRevisionAction("reject");
  }, { signal });

  elements.editor.addEventListener("click", (event) => {
    options.handleEditorClick(event);
  }, { signal });

  elements.editor.addEventListener("pointerdown", () => {
    options.handleEditorPointerDown();
  }, { signal });

  document.addEventListener("pointermove", (event) => {
    options.handlePointerMove(event);
  }, { signal });

  elements.editor.addEventListener("toggle", (event) => {
    options.handleEditorToggle(event);
  }, { capture: true, signal });

  window.addEventListener("resize", () => {
    options.handleViewportChanged();
  }, { signal });

  window.addEventListener("scroll", () => {
    options.handleViewportChanged();
  }, { signal });

  window.visualViewport?.addEventListener("resize", () => {
    options.handleRefreshInlineToolbars();
  }, { signal });

  window.visualViewport?.addEventListener("scroll", () => {
    options.handleRefreshInlineToolbars();
  }, { signal });

  window.addEventListener("beforeunload", (event) => {
    if (!options.shouldBlockBeforeUnload()) {
      return;
    }

    event.preventDefault();
    event.returnValue = "";
  }, { signal });

  applyEditorFontSize();
  setSaveButtonState();
  elements.statusLine.textContent = state.statusMessage;

  return {
    applyToolbarCommand,
    changeFontSize,
    clearSelectionView,
    configureFormatCommands,
    dispose: () => {
      if (diffRefreshFrameId !== null) {
        window.cancelAnimationFrame(diffRefreshFrameId);
      }
      listeners.clear();
      abortController.abort();
    },
    getSnapshot,
    handleFormatKeyDown,
    handleRichInput,
    handleListStructureKeyDown,
    hideResetDraftDialog,
    hideSaveConflictDialog,
    refreshStatusMessage,
    scheduleDiffGutterRefresh,
    setCurrentFilePath,
    setCurrentThreadId,
    setDirty,
    setMode,
    setPendingWriteConflict,
    setSaveButtonState,
    setSaveIssue,
    setStatusMessage,
    showResetDraftDialog,
    showSaveConflict,
    showThreadPlaceholder,
    subscribe,
  };
}